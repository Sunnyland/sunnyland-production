// Indigo printed check. Joins three sources per job (read by deploy/indigo_printed.py every 10 minutes):
//   printIQ            - which section is on which press, and the order quantity
//   Prinect Cockpit    - the imposition sent to the Indigo (copies per sheet, sheets per set, sides)
//   Production Center  - the sheets that actually went through the press for each queue entry
//
// Rules (agreed with production):
//   Sheets needed = order quantity / number-up from the Cockpit imposition (rounded up, times sheets per set).
//   A queue entry of 5 sheets or fewer while the job needs more is a proof. Bigger entries are production
//   batches and are added together. We print overs, so a job is printed once its batches reach the sheets needed.
//   Only an Indigo section is marked printed automatically, and only when all three sources agree.
//   Anything else (moved press, several Indigo sections, no imposition, colour counts that don't fit) goes to
//   production managers to confirm in the app: printed (they choose the section), a proof, or not this job.
//   Marking printed writes a printIQ note with the sheets, then finishes that section's Printing operation.
//   When one printing section of a job is finished and another is not, production is told what is still to print.
//
// Mode (in the Indigo agent settings): dryRun (default) records what would be written but writes nothing to printIQ;
// live writes; off stops the check.
import {openSync, closeSync, fstatSync, readFileSync, constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {need} from './core.mjs';
import {printIQJobKey} from './job-tickets.mjs';
import {prepareProductionAlerts, queueProductionAlerts} from './indigo-watch.mjs';

export const printedPath = '/var/lib/sunnyland-production/indigo-printed.json';
export const printedKind = 'indigoPrinted';
export const printedModes = ['off', 'dryRun', 'live'];
const staleMinutes = 40;
const otherSectionDays = 3;

export function readPrinted(file = printedPath) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || !(file === printedPath ? st.uid === 0 : [0, process.geteuid()].includes(st.uid)) || (st.mode & 0o027) || st.size > 16 * 1024 * 1024) return null;
    const snap = JSON.parse(readFileSync(fd, 'utf8'));
    if (snap.schema !== 1 || !Number.isFinite(Date.parse(snap.generatedAt)) || !Array.isArray(snap.jobs) || typeof snap.health !== 'object') return null;
    return snap;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export function printedSettings(config = {}) {
  const keys = Array.isArray(config.indigoPressKeys) && config.indigoPressKeys.length && config.indigoPressKeys.every(Number.isSafeInteger) ? config.indigoPressKeys : [64];
  const operator = typeof config.printiqOperator === 'string' && /^[\w .@-]{1,60}$/.test(config.printiqOperator.trim()) ? config.printiqOperator.trim() : 'Paul';
  return {mode: printedModes.includes(config.printedMode) ? config.printedMode : 'dryRun', indigoPressKeys: keys, proofSheets: 5, operator};
}

const total = values => Object.values(values ?? {}).reduce((a, b) => a + (Number.isSafeInteger(b) ? b : 0), 0);
const plural = (n, word) => `${n.toLocaleString('en-AU')} ${word}${n === 1 ? '' : 's'}`;
const localTime = stamp => new Date(stamp).toLocaleString('en-AU', {timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
const pressName = s => s.press || `press ${s.pressKey}`;
const sectionLabel = s => [s.name, pressName(s)].filter(Boolean).join(' · ');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/// Each colour separation is counted once per printed side, so it should be about sheets x 1 or sheets x 2.
export function separationSides(sheets, separations) {
  const counts = Object.values(separations ?? {}).filter(n => Number.isSafeInteger(n) && n > 0);
  if (!counts.length || !sheets) return {ok: true, sides: null};
  const near = (n, k) => Math.abs(n - sheets * k) <= Math.max(5, 0.05 * sheets * k);
  if (!counts.every(n => near(n, 1) || near(n, 2))) return {ok: false, sides: null};
  // Very small runs can't tell one side from two.
  return {ok: true, sides: counts.some(n => near(n, 2) && !near(n, 1)) ? 2 : counts.every(n => near(n, 1) && !near(n, 2)) ? 1 : null};
}

/// Pure: what one job's press output adds up to.
export function assessPrinted(snap, {settings = printedSettings(), ignored = new Set(), asProof = new Set()} = {}) {
  const iq = snap.printiq && !snap.printiq.error ? snap.printiq : null;
  const sections = (iq?.sections ?? []).map(s => ({...s, operationKey: String(s.operationKey), indigo: settings.indigoPressKeys.includes(s.pressKey)}));
  const entries = snap.entries.filter(e => !ignored.has(e.queueEntryId)).map(e => {
    const sheets = e.ticket ? total(e.ticket.sheets) : null;
    return {id: e.queueEntryId, part: e.part ?? null, submitted: e.submitted, sheets,
      media: Object.keys(e.ticket?.sheets ?? {}).join(', ') || e.imposition?.media || null,
      imposition: e.imposition ?? null, impositionState: e.impositionState, colours: e.ticket ? separationSides(sheets, e.ticket.separations) : null};
  });
  const read = entries.filter(e => e.sheets !== null && e.sheets > 0);
  const big = read.filter(e => e.sheets > settings.proofSheets && !asProof.has(e.id));
  const layouts = [...new Set(big.filter(e => e.imposition?.imposed && e.imposition.up > 0).map(e => `${e.imposition.up}/${e.imposition.sheetsPerSet || 1}`))];
  let up = null, perSet = 1, needed = null;
  if (layouts.length === 1) [up, perSet] = layouts[0].split('/').map(Number);
  if (up && iq?.quantity > 0) needed = Math.ceil(iq.quantity / up) * perSet;
  const isProof = e => asProof.has(e.id) || (e.sheets <= settings.proofSheets && (needed === null || needed > settings.proofSheets));
  const proofs = read.filter(isProof), batches = read.filter(e => !isProof(e));
  const printed = batches.reduce((n, e) => n + e.sheets, 0);
  const indigo = sections.filter(s => s.indigo);
  const base = {job: snap.job, quantity: iq?.quantity ?? null, up, sheetsPerSet: perSet, needed, printed,
    batches: batches.map(({colours, ...e}) => e), proofs: proofs.map(({colours, ...e}) => e), sections,
    printiqJobNo: iq?.printiqJobNo ?? snap.job, printiqStatus: iq?.status ?? null, target: null, reasons: []};
  const result = (state, extra = {}) => ({...base, state, ...extra});

  if (!read.length) return result('waiting', {reasons: entries.length ? ['Waiting for the press ticket from Production Center.'] : []});
  if (!batches.length) return result('proofs');
  if (snap.printiq?.error) return result('confirm', {reasons: [`printIQ could not be read for this job (${snap.printiq.error}).`]});
  if (!iq) return result('waiting', {reasons: ['Waiting for printIQ.']});
  if (/^(complete|completed|cancelled|canceled)$/i.test(iq.status || '')) return result('closed');
  if (batches.some(e => e.impositionState === 'looking') && !up) return result('waiting', {reasons: ['Looking for the Cockpit imposition on PPMS.']});

  const reasons = [];
  if (layouts.length > 1) reasons.push(`The production batches used different impositions (${layouts.map(l => l.split('/')[0] + '-up').join(' and ')}).`);
  else if (!up) reasons.push('No Prinect Cockpit imposition was found for the production run, so the sheets needed are unknown.');
  if (!(iq.quantity > 0)) reasons.push('printIQ has no order quantity for this job.');
  for (const e of batches) {
    if (e.colours && !e.colours.ok) reasons.push(`The colour counts for ${e.part ?? 'a batch'} don't fit ${plural(e.sheets, 'sheet')}.`);
    else if (e.colours?.sides && e.imposition?.sides && e.colours.sides !== e.imposition.sides)
      reasons.push(`${e.part ?? 'A batch'} printed ${e.colours.sides === 1 ? 'one side' : 'both sides'} but the imposition is ${e.imposition.sides === 1 ? 'one-sided' : 'two-sided'}.`);
  }
  if (!indigo.length) reasons.push(`printIQ has no Indigo section for this job (${sections.length ? 'it is routed to ' + [...new Set(sections.map(pressName))].join(', ') : 'no Printing sections found'}).`);
  else if (indigo.length > 1) reasons.push('printIQ has more than one Indigo section. Choose the one that was printed.');
  if (needed !== null && printed < needed) return result('part', {reasons});
  if (reasons.length) return result('confirm', {reasons});
  return result('ready', {target: indigo[0].operationKey});
}

function noteLines(record, section, actor) {
  const batch = e => `  ${localTime(e.submitted)}  ${e.part ?? 'batch'}: ${plural(e.sheets, 'sheet')}${e.media ? ' on ' + e.media : ''}`;
  return [
    `Indigo printed: ${plural(record.printed, 'sheet')} in ${plural(record.batches.length, 'batch')}`,
    ...record.batches.map(batch),
    record.needed ? `Sheets needed: ${record.needed.toLocaleString('en-AU')} (${record.quantity.toLocaleString('en-AU')} at ${record.up}-up${record.sheetsPerSet > 1 ? ', ' + record.sheetsPerSet + ' sheets a set' : ''}, from the Prinect imposition)` : 'Sheets needed: not worked out (no Prinect imposition)',
    ...(record.proofs.length ? [`Proofs not counted: ${record.proofs.map(e => `${e.part ?? 'proof'} ${plural(e.sheets, 'sheet')}`).join(', ')}`] : []),
    `Section finished: ${sectionLabel(section)}${section.indigo ? '' : ' (printed on the Indigo instead)'}`,
    actor ? `Confirmed by ${actor.name} in Sunnyland Production` : 'Checked automatically: printIQ, Prinect Cockpit and Production Center agree.'];
}

/// Records the job as printed. Live: queues the printIQ note, then the Printing-operation finish (each once only).
function markPrinted(store, record, section, {settings, actor = null, now}) {
  const lines = noteLines(record, section, actor);
  const done = {at: now.toISOString(), by: actor?.id ?? null, byName: actor?.name ?? 'Indigo agent', mode: settings.mode,
    operationKey: section.operationKey, sectionKey: section.sectionKey, section: sectionLabel(section), note: lines};
  if (settings.mode === 'live') {
    const key = `${record.job}:${section.operationKey}`;
    store.queue('printiq', record.job, {kind: 'indigo_printed', job: record.job, section: section.name ?? undefined, actor: actor?.id, lines}, 'indigo-printed:note:' + key);
    store.queue('printiq_finish', record.job, {kind: 'printing_finish', job: record.job, printiqJobNo: record.printiqJobNo,
      sectionKey: section.sectionKey, operationKey: Number(section.operationKey), operator: settings.operator, at: now.toISOString()}, 'indigo-printed:finish:' + key);
  }
  return done;
}

function confirmAlert(record) {
  const lines = [
    `${record.job}: the Indigo printed ${plural(record.printed, 'sheet')} in ${plural(record.batches.length, 'batch')}` + (record.needed ? ` (${record.needed.toLocaleString('en-AU')} needed).` : '.'),
    '', ...record.reasons, '',
    `printIQ: ${record.sections.length ? record.sections.map(sectionLabel).join('; ') : 'no Printing sections'}`,
    `Prinect imposition: ${record.up ? record.up + '-up' : 'not found'}`,
    `Production Center: ${record.batches.map(e => `${e.part ?? 'batch'} ${plural(e.sheets, 'sheet')}`).join(', ')}`,
    '', 'Was this the production run? Confirm it in Sunnyland Production: Print planning › Indigo planning agent › Needs confirming.'];
  return {key: `printed-confirm:${record.job}:${record.signature}`, audience: 'managers', push: true, job: record.job,
    subject: `${record.job}: confirm what the Indigo printed`, text: lines.join('\n')};
}

/// Finished Printing operations by job: from the app (operator Finish), staff checks and this agent.
function finishedOperations(store) {
  const done = new Map();
  const add = (job, key, at, source) => { const j = printIQJobKey(job) ?? job; if (key && at) done.set(`${j}/${key}`, {at, source}); };
  for (const op of store.all('operation')) if (op.state === 'completed' && op.printiqOperationKey) add(op.job, String(op.printiqOperationKey), op.updatedAt, 'app');
  for (const c of store.all('checkedPrintFinish')) if (c.active) add(c.job, String(c.operationKey), c.at, 'check');
  for (const r of store.all(printedKind)) if (r.done) add(r.job, r.done.operationKey, r.done.at, 'agent');
  return done;
}

/// When one printing section is finished and another of the same job isn't, tell production (once per finish).
function otherSectionAlerts(store, facts, now) {
  const finished = finishedOperations(store), alerts = [];
  const jobs = new Map();
  for (const r of store.all(printedKind)) jobs.set(r.job, r.sections.map(s => ({operationKey: String(s.operationKey), label: sectionLabel(s), press: pressName(s)})));
  for (const op of facts?.operations ?? []) {
    const j = printIQJobKey(op.job) ?? op.job, list = jobs.get(j) ?? [];
    if (!list.some(s => s.operationKey === op.operationKey)) list.push({operationKey: op.operationKey, label: [op.section, op.press].filter(Boolean).join(' · '), press: op.press});
    jobs.set(j, list);
  }
  for (const [job, sections] of jobs) {
    if (sections.length < 2) continue;
    const open = sections.filter(s => !finished.has(`${job}/${s.operationKey}`));
    if (!open.length) continue;
    for (const s of sections.filter(s => finished.has(`${job}/${s.operationKey}`))) {
      const f = finished.get(`${job}/${s.operationKey}`);
      if (now - Date.parse(f.at) > otherSectionDays * 86400000) continue;
      alerts.push({key: `printed-other:${job}:${s.operationKey}`, audience: 'managers', job,
        subject: `${job}: ${s.press} section printed, ${[...new Set(open.map(o => o.press))].join(' and ')} still to print`,
        text: `${job}: the ${s.label} section was finished ${localTime(f.at)}.\n\nStill to print:\n${open.map(o => '  ' + o.label).join('\n')}\n\nPlease schedule the remaining part.`});
    }
  }
  return alerts;
}

/// Runs every minute from the Indigo agent: assess every job in the latest snapshot, write or ask, and alert.
export function applyPrinted(store, {snapshot, now = new Date(), facts = null}) {
  prepareProductionAlerts(store);
  const config = store.get('indigoPlannerConfig', 'indigo') ?? {};
  const settings = printedSettings(config);
  const status = {id: 'latest', checkedAt: now.toISOString(), mode: settings.mode, snapshotAt: snapshot?.generatedAt ?? null,
    health: snapshot?.health ?? null, stale: !snapshot || now - Date.parse(snapshot.generatedAt) > staleMinutes * 60000};
  if (settings.mode === 'off') { store.put('indigoPrintedStatus', status); return {alerts: [], status}; }
  const alerts = [];
  store.db.exec('BEGIN IMMEDIATE');
  try {
    for (const snap of status.stale ? [] : snapshot.jobs) {
      const old = store.get(printedKind, snap.job);
      if (old?.done) continue;
      const a = assessPrinted(snap, {settings, ignored: new Set(old?.ignored ?? []), asProof: new Set(old?.asProof ?? [])});
      const signature = hash([a.state, a.printed, a.needed, a.batches.map(e => e.id), a.reasons, a.target]);
      const record = {...a, id: snap.job, signature, ignored: old?.ignored ?? [], asProof: old?.asProof ?? [],
        revision: (old?.revision ?? 0) + (old?.signature === signature ? 0 : 1), updatedAt: old?.signature === signature ? old.updatedAt : now.toISOString(), done: null};
      if (a.state === 'ready') record.done = markPrinted(store, record, a.sections.find(s => s.operationKey === a.target), {settings, now});
      if (a.state === 'confirm') alerts.push(confirmAlert(record));
      if (old?.signature !== signature || record.done) store.put(printedKind, record);
    }
    alerts.push(...otherSectionAlerts(store, facts, now));
    queueProductionAlerts(store, alerts, config);
    store.put('indigoPrintedStatus', status);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return {alerts, status};
}

/// A production manager's answer for a job the agent couldn't settle on its own.
export function decidePrinted(store, actor, body, {now = new Date()} = {}) {
  store.manager(actor);
  const record = store.require(printedKind, typeof body.job === 'string' ? body.job : '');
  need(record.revision === body.revision, 'This job changed. Refresh it first.', 409);
  need(!record.done, 'This job has already been recorded.', 409);
  need(['confirm', 'part', 'ready', 'proofs'].includes(record.state), 'There is nothing to confirm for this job yet.', 409);
  const settings = printedSettings(store.get('indigoPlannerConfig', 'indigo') ?? {});
  const ids = record.batches.map(e => e.id);
  let next;
  if (body.choice === 'printed') {
    const section = record.sections.find(s => s.operationKey === String(body.operationKey));
    need(section, 'Choose the printIQ section that was printed.');
    need(record.batches.length, 'There is no production batch to record.', 409);
    next = {...record, done: markPrinted(store, record, section, {settings, actor, now}), revision: record.revision + 1};
  } else if (body.choice === 'proof') {
    next = {...record, asProof: [...new Set([...record.asProof, ...ids])], state: 'proofs', signature: null, revision: record.revision + 1};
  } else {
    need(body.choice === 'notThisJob', 'Choose printed, proof or not this job.');
    next = {...record, ignored: [...new Set([...record.ignored, ...ids, ...record.proofs.map(e => e.id)])], state: 'waiting', signature: null, revision: record.revision + 1};
  }
  store.put(printedKind, next);
  store.audit(actor, 'indigo_printed_' + body.choice, record.job, {operationKey: body.operationKey ?? null, batches: ids, mode: settings.mode});
  return next;
}

/// For the agent screen: what needs confirming, what's part printed, and what was recorded recently.
export function printedDashboard(store, now = new Date()) {
  const records = store.all(printedKind);
  const recent = records.filter(r => r.done && now - Date.parse(r.done.at) < 3 * 86400000).sort((a, b) => b.done.at.localeCompare(a.done.at));
  const status = store.get('indigoPrintedStatus', 'latest');
  return {mode: printedSettings(store.get('indigoPlannerConfig', 'indigo') ?? {}).mode, status,
    confirm: records.filter(r => !r.done && r.state === 'confirm'), part: records.filter(r => !r.done && r.state === 'part'), recent: recent.slice(0, 30)};
}

// Production board: read-only pages for a screen at the press (Raspberry Pi in kiosk mode) and for phones.
//   /board/<key>        today: printing now, next (in the plan's order), done today, tomorrow, hours summary
//   /board/<key>/week   Monday to Saturday: each day's runs and maintenance with hours booked / left
// Colours: Not approved (grey) · Approved, not on the press (amber) · On the press (blue) · Printing now (bright blue)
//   · Part printed (teal) · Printed (green); orange outline = needs confirming; maintenance (purple-grey); held (striped).
// Sources are all local: the plan (agent + manager changes), the 10-minute watch (Cockpit approvals + Indigo queue)
// and the printed check. The board never calls printIQ, never changes anything and never touches SmartStream.
// Access is by a private link (/board/<key>) created on the server, so a screen needs no staff sign-in.
import {createHash, randomBytes} from 'node:crypto';
import {indigoCapacity, plantMinute, sequencePressDay} from './print-planning.mjs';
import {printIQJobKey} from './job-tickets.mjs';
import {finishDay, hiddenJobs} from './job-visibility.mjs';
import {jobLinks, maintenanceRows, openDays} from './press-plan.mjs';
import {qrSvg} from './qr.mjs';

export const boardPress = 'HP Indigo 7900';
const linkKind = 'boardLink';
const hash = key => createHash('sha256').update(key).digest('hex');
const jobKey = value => printIQJobKey(value) ?? value;
const watchStaleMinutes = 30;

/// Creates a board link. The key is shown once; only its hash is stored.
export function createBoardLink(store, {label, by = 'server'}) {
  if (typeof label !== 'string' || !label.trim() || label.length > 60) throw new Error('Give the screen a short name.');
  const key = randomBytes(24).toString('base64url');
  store.put(linkKind, {id: hash(key), label: label.trim(), createdBy: by, createdAt: new Date().toISOString(), revokedAt: null});
  return key;
}
export function revokeBoardLink(store, label) {
  const links = store.all(linkKind).filter(l => l.label === label && !l.revokedAt);
  for (const l of links) store.put(linkKind, {...l, revokedAt: new Date().toISOString()});
  return links.length;
}
export function boardLinkValid(store, key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(key)) return false;
  const link = store.get(linkKind, hash(key));
  return Boolean(link && !link.revokedAt);
}

const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = day => new Date(day + 'T00:00:00Z').getUTCDay();
/// Monday of the week containing `day` (Sunday belongs to the week before).
export const mondayOf = day => addDays(day, -((weekday(day) + 6) % 7));

/// What the Indigo queue says about a job: printing, queued, finished or nothing.
export function queueState(entry) {
  const s = String(entry?.status ?? '').toLowerCase();
  if (!entry) return null;
  if (/complet|done|finish/.test(s)) return 'completed';
  if (/abort|cancel|fail|delet/.test(s)) return 'aborted';
  if (/print|running|process|imaging/.test(s)) return 'printing';
  return 'queued';
}

const sheets = n => n.toLocaleString('en-AU');

/// Pure: status of one run from the watch, the printed check and manager changes.
function statusOf(run, {approvals, queueFor, printed}) {
  if (run.maintenance) return {key: 'maintenance', label: 'Maintenance', detail: run.name ?? ''};
  const job = jobKey(run.job), p = printed.get(job), qs = queueState(queueFor(job)), approval = approvals[job];
  const base = {confirm: p?.state === 'confirm' && !p.done, rush: Boolean(run.rush), late: run.late ? run.bestDispatch ?? true : null,
    manual: Boolean(run.managerOverride || (run.fixedStart !== null && run.fixedStart !== undefined))};
  if (run.held) return {...base, key: 'held', label: 'Held', detail: run.held.reason ?? ''};
  if (p?.done) return {...base, key: 'printed', label: 'Printed', detail: p.printed ? `${sheets(p.printed)} sheets` : ''};
  if (qs === 'printing') return {...base, key: 'printing', label: 'Printing now', detail: p?.printed ? `${sheets(p.printed)}${p.needed ? ' of ' + sheets(p.needed) : ''} sheets so far` : ''};
  if (p?.state === 'part') return {...base, key: 'part', label: 'Part printed', detail: `${sheets(p.printed)} of ${sheets(p.needed)} sheets`};
  if (p?.state === 'confirm') return {...base, key: 'part', label: 'Printed — needs confirming', detail: `${sheets(p.printed)} sheets`};
  if (qs === 'queued') return {...base, key: 'queued', label: 'On the press', detail: queueFor(job)?.stale ? 'Sent to the press; no finish reported yet' : 'In the Indigo queue'};
  if (qs === 'completed') return {...base, key: 'part', label: 'Printed — counting sheets', detail: 'Checked within 10 minutes'};
  if (run.onPress) return {...base, key: 'queued', label: 'On the press', detail: 'Marked by a manager'};
  if (approval?.approved) return {...base, key: 'approved', label: 'Approved — not on the press', detail: ''};
  return {...base, key: 'unapproved', label: run.provisional ? 'Not approved — pencilled in' : 'Not approved', detail: run.provisional ? 'Firms up when the artwork is approved' : ''};
}

/// Hours for one day: capacity, booked press time, maintenance and what is left.
export function dayHours(rows, day, now) {
  const cap = indigoCapacity([], day, boardPress);
  const booked = rows.filter(r => !r.maintenance && !r.held).reduce((t, r) => t + r.minutes, 0);
  const maintenance = rows.filter(r => r.maintenance).reduce((t, r) => t + r.minutes, 0);
  const hours = {capacity: cap.limitMinutes, booked, maintenance, left: cap.limitMinutes - booked - maintenance};
  if (day === finishDay(now.toISOString())) {
    const minute = plantMinute(now);
    hours.shiftLeft = Math.max(0, cap.printEnd - Math.max(minute, cap.printStart));
    hours.toPrint = rows.filter(r => !r.maintenance && !r.held && r.status?.key !== 'printed').reduce((t, r) => t + r.minutes, 0);
  }
  return hours;
}

/// Pure: one day's plan with statuses, in the plan's order.
/// One day's runs in press order. Today rolls forward: what's printing runs from when it was sent, everything not yet
/// printed starts from now (a missed pinned time no longer holds it), and printed runs no longer take press time.
/// Runs that no longer fit before the end of the print window are marked to move (the agent replans them).
function dayPlan({runs, blocks, day, ctx, hidden, now = null}) {
  const rows = [...runs.filter(r => r.day === day && !hidden(r.job, r.printiqId)), ...blocks.filter(b => b.day === day)]
    .map(r => ({...r, blocked: null, status: statusOf(r, ctx)}));
  const live = now && day === finishDay(now.toISOString());
  const minute = live ? Math.ceil(plantMinute(now) / 5) * 5 : null;
  const placed = live ? sequencePressDay(rows.filter(r => r.status.key !== 'printed').map(r => {
    if (r.maintenance) return r;
    if (r.status.key === 'printing') {
      const sent = Date.parse(ctx.queueFor(jobKey(r.job))?.last ?? '');
      const started = Number.isFinite(sent) ? Math.max(indigoStart, Math.min(minute, plantMinute(new Date(sent)))) : minute;
      const end = Math.max(started + r.minutes, minute + 5);
      return {...r, fixedStart: started, minutes: end - started};
    }
    const missed = r.fixedStart !== null && r.fixedStart !== undefined && r.fixedStart < minute;
    return {...r, fixedStart: missed ? null : r.fixedStart, missed, earliestStart: Math.max(r.earliestStart ?? 0, minute)};
  })).concat(rows.filter(r => r.status.key === 'printed').map(r => ({...r, start: null})))
    : sequencePressDay(rows);
  return placed.map(r => ({id: r.id, job: r.maintenance ? '' : jobKey(r.job),
    name: r.name ?? '', part: r.part ?? '', stock: r.stock ?? '', finishes: r.finishes ?? '', due: r.due ?? null,
    start: r.start ?? null, minutes: r.minutes, maintenance: Boolean(r.maintenance), held: Boolean(r.held),
    anyTime: Boolean(r.maintenance && r.fixedStart === null),
    status: live && r.start === null && !r.held && !r.maintenance && r.status.key !== 'printed'
      ? {...r.status, wontFit: true, detail: 'Won’t fit today — the agent moves it to the next day with room'} : r.status}));
}
const indigoStart = 7 * 60 + 45;

/// The job printing now: the newest "Running" entry sent in the last 8 hours. Production Pro sometimes never reports
/// a final status, so older "Running" entries (and all but the newest) only count as on the press.
const printingWindowHours = 8;
export function printingJob(watch, now = new Date()) {
  let best = null;
  for (const [job, q] of Object.entries(watch?.queue ?? {})) {
    if (queueState(q) !== 'printing' || !Number.isFinite(Date.parse(q.last)) || now - Date.parse(q.last) > printingWindowHours * 3600000) continue;
    if (!best || q.last > best[1].last) best = [job, q];
  }
  return best?.[0] ?? null;
}
const settle = (watch, now) => {
  const current = printingJob(watch, now);
  return Object.fromEntries(Object.entries(watch?.queue ?? {}).map(([job, q]) =>
    [job, queueState(q) === 'printing' && job !== current ? {...q, status: 'Sent', stale: true} : q]));
};

function context({watch, printed, links, now = new Date()}) {
  const queue = settle(watch, now);
  const rank = {printing: 0, queued: 1, completed: 2, aborted: 3};
  // Entries sent under a wrong job number count for the job a manager linked them to.
  const queueFor = job => [queue[job], ...[...links].filter(([, right]) => right === job).map(([wrong]) => queue[wrong])].filter(Boolean)
    .sort((a, b) => (rank[queueState(a)] ?? 9) - (rank[queueState(b)] ?? 9))[0] ?? null;
  return {approvals: watch?.approvals ?? {}, queueFor, printed};
}

function problemsOf(watch, now) {
  const problems = [];
  if (!watch) problems.push('Waiting for the first Indigo watch.');
  else {
    if ((now - Date.parse(watch.generatedAt)) / 60000 > watchStaleMinutes) problems.push('Approvals and press status are out of date: the 10-minute watch has stopped.');
    if (watch.health?.indigo && !watch.health.indigo.ok) problems.push('The Indigo (Production Pro) connection is down: press status may be wrong.');
    if (watch.health?.cockpit && !watch.health.cockpit.ok) problems.push('Prinect Cockpit approvals cannot be read.');
  }
  return problems;
}

/// Pure: the board for one day.
export function boardData({runs, blocks = [], watch, printed, links = new Map(), open = new Set(), day, now, hidden = () => false}) {
  const ctx = context({watch, printed, links, now});
  const indigo = runs.filter(r => !r.removed && r.press === boardPress);
  const mine = blocks.filter(b => b.press === boardPress);
  const plan = dayPlan({runs: indigo, blocks: mine, day, ctx, hidden, now});
  const work = plan.filter(r => !r.maintenance && !r.held);
  const active = work.filter(r => r.status.key !== 'printed');
  const done = work.filter(r => r.status.key === 'printed');
  const onPlan = new Set(plan.map(r => r.job));
  for (const p of printed.values()) {
    if (p.done && finishDay(p.done.at) === day && !onPlan.has(p.job) && !hidden(p.job))
      done.push({id: 'printed:' + p.job, job: p.job, name: '', part: p.done.section ?? '', stock: '', finishes: '', due: null, start: null,
        status: {key: 'printed', label: 'Printed', detail: `${sheets(p.printed)} sheets`}});
  }
  for (const [job, q] of Object.entries(settle(watch, now))) {
    const right = links.get(job) ?? job;
    if (onPlan.has(right) || hidden(right) || !['printing', 'queued'].includes(queueState(q)) || now - Date.parse(q.last) > 18 * 3600000) continue;
    onPlan.add(right);
    active.push({id: 'queue:' + right, job: right, name: '', part: '', stock: '', finishes: '', due: null, start: null,
      status: {key: queueState(q) === 'printing' ? 'printing' : 'queued', label: queueState(q) === 'printing' ? 'Printing now' : 'On the press',
        detail: job === right ? 'Not on today’s plan' : `Sent to the press as ${job}`}});
  }
  const tomorrowDay = [1, 2, 3, 4, 5, 6].map(n => addDays(day, n)).find(d => weekday(d) !== 0 && (weekday(d) !== 6 || open.has(d) ||
    indigo.some(r => r.day === d) || mine.some(b => b.day === d)));
  const tomorrow = dayPlan({runs: indigo, blocks: mine, day: tomorrowDay, ctx, hidden});
  return {day, tomorrowDay, now: now.toISOString(), hours: dayHours(plan, day, now),
    current: active.filter(r => r.status.key === 'printing'), next: active.filter(r => r.status.key !== 'printing'),
    maintenance: plan.filter(r => r.maintenance), held: plan.filter(r => r.held), done, tomorrow, tomorrowHours: dayHours(tomorrow, tomorrowDay, now),
    problems: problemsOf(watch, now), counts: {planned: work.length, printed: done.length, waitingApproval: active.filter(r => r.status.key === 'unapproved').length}};
}

/// Pure: Monday to Saturday of the week containing `day` (or the next week).
export function weekData({runs, blocks = [], watch, printed, links = new Map(), open = new Set(), day, now, hidden = () => false, next = false}) {
  const ctx = context({watch, printed, links, now});
  const monday = addDays(mondayOf(day), next ? 7 : 0);
  const indigo = runs.filter(r => !r.removed && r.press === boardPress), mine = blocks.filter(b => b.press === boardPress);
  const days = [0, 1, 2, 3, 4, 5].map(n => addDays(monday, n)).map(d => {
    const plan = dayPlan({runs: indigo, blocks: mine, day: d, ctx, hidden, now});
    return {day: d, today: d === day, past: d < day, saturday: weekday(d) === 6, open: weekday(d) !== 6 || open.has(d) || plan.length > 0,
      plan, hours: dayHours(plan, d, now)};
  });
  return {monday, next, now: now.toISOString(), days, problems: problemsOf(watch, now)};
}

// ---- Pages ----------------------------------------------------------------------------------------------------
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const clock = minutes => minutes == null ? '' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const hm = minutes => { const m = Math.abs(minutes), h = Math.floor(m / 60), r = m % 60; return (minutes < 0 ? '−' : '') + (h ? `${h}h${r ? String(r).padStart(2, '0') : ''}` : `${r}m`); };
const dayLabel = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-AU', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
const shortDay = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-AU', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});
const dueLabel = (due, day) => !due ? '' : due === day ? 'Due today' : due < day ? 'Overdue' : 'Due ' + shortDay(due);
const dispatchLabel = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-AU', {weekday: 'short', day: 'numeric', timeZone: 'UTC'});
const tags = s => (s.rush ? '<span class="tag rush">RUSH</span>' : '') + (s.late ? `<span class="tag late">LATE${typeof s.late === 'string' ? ' · dispatch ' + esc(dispatchLabel(s.late)) : ''}</span>` : '')
  + (s.manual ? '<span class="tag manual">MANUAL</span>' : '');

const style = `:root{--grey:#8a8f98;--amber:#f0a020;--blue:#2f6fde;--bright:#00a2ff;--teal:#13a89e;--green:#2e9e4f;--orange:#ff7a00;--maint:#8e7cc3}
*{box-sizing:border-box}body{margin:0;background:#101317;color:#eef1f4;font:clamp(14px,1.4vw,26px)/1.25 system-ui,-apple-system,Segoe UI,sans-serif}
a{color:#9cc3ff}header{display:flex;justify-content:space-between;align-items:baseline;gap:1em;padding:.6em 1em;background:#1a1f26}
h1{margin:0;font-size:1.5em}header .meta{color:#aab2bd}h2{margin:.8em 1em .3em;font-size:1em;text-transform:uppercase;letter-spacing:.08em;color:#aab2bd}
.hours{display:flex;flex-wrap:wrap;gap:.4em 1.4em;margin:.6em 1em 0;padding:.55em .9em;background:#1a1f26;border-radius:.45em}
.hours b{font-variant-numeric:tabular-nums}.over,.over b{color:#ff8a80}
ol{list-style:none;margin:0;padding:0 1em}.run{display:grid;grid-template-columns:4.2em 1fr 15em;gap:.8em;align-items:center;margin:.35em 0;padding:.55em .8em;
border-radius:.45em;background:#1c222a;border-left:.55em solid var(--grey)}
.run .job{font-weight:700}.run .name{font-weight:400;color:#cfd6de}.run .facts,.run .detail,.run .due{color:#aab2bd;font-size:.85em}.run .label{font-weight:700}
.run .when{color:#aab2bd;font-variant-numeric:tabular-nums}.due.late{color:#ff8a80;font-weight:700}
.tag{display:inline-block;margin-left:.4em;padding:0 .35em;border-radius:.25em;font-size:.7em;font-weight:700;vertical-align:middle}
.tag.rush{background:#ff3b30;color:#fff}.tag.late{background:#8b1a10;color:#ffd7d0}.tag.manual{background:#3a4350;color:#dfe5ec}
.unapproved{border-color:var(--grey)}.unapproved .label{color:#c3c8cf}
.approved{border-color:var(--amber)}.approved .label{color:var(--amber)}
.queued{border-color:var(--blue)}.queued .label{color:#7fa8ff}
.printing{border-color:var(--bright);background:#0f2a40}.printing .label{color:var(--bright)}
.part{border-color:var(--teal)}.part .label{color:#3fd1c4}
.printed{border-color:var(--green);opacity:.75}.printed .label{color:#5fd07f}
.maintenance{border-color:var(--maint);background:#211d2c}.maintenance .label{color:#b9a9ec}
.held{border-color:var(--grey);background:repeating-linear-gradient(135deg,#1c222a 0 .6em,#232a33 .6em 1.2em);opacity:.8}
.confirm{outline:.18em solid var(--orange);outline-offset:-.18em}
.big{font-size:1.35em;padding:.8em 1em}
.problem{margin:.6em 1em;padding:.6em .9em;border-radius:.4em;background:#5a1a12;color:#ffd7d0;font-weight:700}
.empty{margin:.4em 1em;color:#aab2bd}.legend{display:flex;flex-wrap:wrap;gap:.4em 1.2em;margin:.8em 1em 1.2em;color:#aab2bd;font-size:.8em}
.legend span::before{content:"";display:inline-block;width:.8em;height:.8em;margin-right:.35em;border-radius:.15em;background:var(--c)}
.week{display:grid;grid-template-columns:repeat(6,1fr);gap:.6em;padding:.6em 1em}.col{background:#161b21;border-radius:.5em;padding:.5em;min-width:0}
.col.today{outline:.15em solid #3d7bd9}.col.past{opacity:.6}.col.closed{opacity:.45}
.col h3{margin:0 0 .3em;font-size:1em}.col .sum{color:#aab2bd;font-size:.8em;margin-bottom:.4em}.col .sum b{color:#eef1f4}
.card{margin:.3em 0;padding:.35em .5em;border-radius:.35em;background:#1c222a;border-left:.4em solid var(--grey);font-size:.78em}
.card .job{font-weight:700}.card .facts{color:#aab2bd}.card.unapproved{border-color:var(--grey)}.card.approved{border-color:var(--amber)}
.card.queued{border-color:var(--blue)}.card.printing{border-color:var(--bright)}.card.part{border-color:var(--teal)}.card.printed{border-color:var(--green);opacity:.7}
.card.maintenance{border-color:var(--maint);background:#211d2c}.card.held{opacity:.6}
.shift{display:flex;flex-wrap:wrap;align-items:center;gap:.4em 1.2em;margin:.6em 1em 0;padding:.5em .9em;border-radius:.45em;background:#16302a;color:#d6efe6}
.shift form{margin:0 0 0 auto}button{font:inherit;padding:.3em .9em;border-radius:.35em;border:0;background:#3a4350;color:#eef1f4}
.handover{margin:.6em 1em 0;padding:.6em .9em;border-radius:.45em;background:#5a4210;color:#ffe7b3;font-weight:700}
.signin{display:flex;flex-wrap:wrap;gap:1.4em;align-items:center;margin:.8em 1em;padding:1em 1.2em;border-radius:.6em;background:#1d2733;outline:.2em solid #f0a020}
.signin h2{margin:0 0 .3em;color:#ffd27a;font-size:1.3em;text-transform:none;letter-spacing:0}.signin .code{font-size:3.4em;font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.signin p{margin:.3em 0;color:#cfd6de}.signin a.pin{display:inline-block;margin-top:.4em;padding:.45em 1em;border-radius:.4em;background:#3a4350;color:#fff;text-decoration:none;font-weight:700}
.pad{display:grid;grid-template-columns:repeat(3,4.2em);gap:.5em;margin:1em}.pad button{font-size:1.6em;padding:.5em 0;background:#26303b}.pad button.go{background:#2e9e4f}
.dots{margin:0 1em;font-size:2.4em;letter-spacing:.3em;min-height:1.3em}.err{margin:.4em 1em;color:#ff8a80;font-weight:700}`;

const legend = `<div class="legend"><span style="--c:var(--grey)">Not approved</span><span style="--c:var(--amber)">Approved, not on the press</span>
<span style="--c:var(--blue)">On the press</span><span style="--c:var(--bright)">Printing now</span><span style="--c:var(--teal)">Part printed</span>
<span style="--c:var(--green)">Printed</span><span style="--c:var(--orange)">Needs confirming</span><span style="--c:var(--maint)">Maintenance</span></div>`;

const page = (title, body, refresh = 60) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${refresh}"><title>${esc(title)}</title><style>${style}</style></head><body>${body}</body></html>`;

function row(r, day, big = false) {
  const facts = r.maintenance ? (r.anyTime ? `${hm(r.minutes)} · any time` : hm(r.minutes))
    : [r.part, r.stock, r.finishes && r.finishes !== 'None' ? r.finishes : ''].filter(Boolean).map(esc).join(' · ');
  const s = r.status;
  return `<li class="run ${s.key}${s.confirm ? ' confirm' : ''}${big ? ' big' : ''}">
<div class="when">${esc(clock(r.start))}</div>
<div class="what"><div class="job">${r.maintenance ? 'Maintenance' : esc(r.job)} <span class="name">${esc(r.name)}</span>${tags(s)}</div><div class="facts">${facts}</div></div>
<div class="state"><div class="label">${esc(s.label)}</div><div class="detail">${esc(s.detail)}</div><div class="due ${r.due && r.due <= day ? 'late' : ''}">${esc(dueLabel(r.due, day))}</div></div></li>`;
}

function hoursLine(h) {
  return `<div class="hours"><span>Capacity <b>${hm(h.capacity)}</b></span><span>Booked <b>${hm(h.booked)}</b></span>
${h.maintenance ? `<span>Maintenance <b>${hm(h.maintenance)}</b></span>` : ''}<span class="${h.left < 0 ? 'over' : ''}">Left to book <b>${hm(h.left)}</b></span>
${h.shiftLeft !== undefined ? `<span class="${h.toPrint > h.shiftLeft ? 'over' : ''}">Shift left <b>${hm(h.shiftLeft)}</b> · still to print <b>${hm(h.toPrint)}</b></span>` : ''}</div>`;
}

/// Today's board; refreshes itself every minute. No scripts, so it suits a kiosk browser.
export function renderBoard(data, {weekHref = 'week', shift = null, key = '', waiting = null, nav = ''} = {}) {
  const updated = new Date(data.now).toLocaleTimeString('en-AU', {hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne'});
  const list = (rows, big) => rows.length ? `<ol>${rows.map(r => row(r, data.day, big)).join('')}</ol>` : '';
  const next = [...data.next, ...data.maintenance];
  return page('Indigo board', `<header><h1>Indigo · ${esc(dayLabel(data.day))}</h1><div class="meta">${data.counts.printed} of ${data.counts.planned} printed · updated ${esc(updated)} · <a href="${esc(weekHref)}">Week</a>${nav}</div></header>
${shiftPanel(shift, key)}
${hoursLine(data.hours)}${waitingLine(waiting)}
${data.problems.map(p => `<div class="problem">${esc(p)}</div>`).join('')}
${data.current.length ? `<h2>Printing now</h2>${list(data.current, true)}` : ''}
<h2>Next</h2>${next.length ? list(next) : '<p class="empty">Nothing else on today’s plan.</p>'}
${data.held.length ? `<h2>Held</h2>${list(data.held)}` : ''}
${data.done.length ? `<h2>Done today</h2>${list(data.done)}` : ''}
${data.tomorrow.length ? `<h2>${esc(dayLabel(data.tomorrowDay))} · ${hm(data.tomorrowHours.booked)} booked, ${hm(data.tomorrowHours.left)} left</h2>${list(data.tomorrow.map(r => ({...r, start: r.maintenance ? r.start : null, due: null})))}` : ''}
${legend}`, !shift ? 60 : !shift.operator ? 15 : shift.warning ? 30 : 60);
}

const firstName = name => String(name ?? '').split(/\s+/)[0];
const ampm = minute => { const h = Math.floor(minute / 60), m = minute % 60; return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`; };
const untilLabel = iso => new Date(iso).toLocaleTimeString('en-AU', {hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne'}).replace(' ', '').toLowerCase();

/// How many Indigo jobs aren't on the plan (managers sort them out on the plan page).
function waitingLine(w) {
  if (!w || !(w.needs || w.artwork)) return '';
  return `<div class="hours">${w.needs ? `<span class="over"><b>${w.needs}</b> job${w.needs === 1 ? '' : 's'} not planned — a manager is checking</span>` : ''}${w.artwork ? `<span><b>${w.artwork}</b> waiting on artwork approval</span>` : ''}</div>`;
}

/// Who is at the press; while nobody is, the sign-in code, its QR code and the PIN button.
function shiftPanel(shift, key) {
  if (!shift) return '';
  if (shift.operator) {
    const w = shift.warning;
    return `<div class="shift"><span>Operator <b>${esc(shift.operator.name)}</b> · signed in until ${esc(untilLabel(shift.operator.until))}</span>
<form method="post" action="${esc(key)}/sign-out"><button>Sign out</button></form></div>
${w ? `<div class="handover">${esc(firstName(shift.operator.name))} is signed out at ${esc(ampm(w.ends))}.${w.next ? ` ${esc(firstName(w.next.name))} starts at ${esc(ampm(w.next.start))} and signs in then.` : ''}</div>` : ''}`;
  }
  const due = shift.onNow.length ? `On shift now: ${shift.onNow.map(s => `${firstName(s.name)} (${ampm(s.start)}–${ampm(s.end)})`).join(', ')}.`
    : shift.next ? `Next on shift: ${firstName(shift.next.name)} at ${ampm(shift.next.start)}.` : '';
  return `<section class="signin"><div>${qrSvg('SLP-PRESS:' + shift.code, {size: 220})}</div><div>
<h2>Nobody is signed in at the press</h2><div class="code">${esc(shift.code.slice(0, 3))} ${esc(shift.code.slice(3))}</div>
<p>Scan with Sunnyland Production, or type this code in the app.</p>${due ? `<p>${esc(due)}</p>` : ''}
<a class="pin" href="${esc(key)}/pin">Use my PIN</a></div></section>`;
}

/// The PIN pad: no scripts, each key posts back the digits so far.
export function renderPin({digits = '', error = '', key = ''} = {}) {
  const button = v => `<button name="k" value="${v}"${v === 'enter' ? ' class="go"' : ''}>${v === 'back' ? '⌫' : v === 'enter' ? 'OK' : v}</button>`;
  return page('Sign in at the press', `<header><h1>Sign in at the Indigo</h1><div class="meta"><a href="../${esc(key)}">Back to the board</a></div></header>
${error ? `<div class="err">${esc(error)}</div>` : ''}<div class="dots">${'●'.repeat(digits.length) || '&nbsp;'}</div>
<form method="post" action="pin"><input type="hidden" name="d" value="${esc(digits)}"><div class="pad">
${['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'enter'].map(button).join('')}</div></form>`, 120);
}

/// Monday-Saturday week page.
export function renderWeek(data, {todayHref = '.', otherHref = '?next=1', waiting = null, nav = ''} = {}) {
  const card = r => `<div class="card ${r.status.key}${r.status.confirm ? ' confirm' : ''}"><div class="job">${r.maintenance ? 'Maintenance' : esc(r.job)}${tags(r.status)}</div>
<div class="facts">${esc(r.maintenance ? `${r.name} · ${r.anyTime ? hm(r.minutes) + ' any time' : clock(r.start) + ', ' + hm(r.minutes)}` : [r.name, r.stock].filter(Boolean).join(' · '))}</div>
<div class="facts">${esc(r.status.label)}${r.maintenance ? '' : ' · ' + hm(r.minutes)}</div></div>`;
  const col = d => `<section class="col${d.today ? ' today' : ''}${d.past ? ' past' : ''}${d.open ? '' : ' closed'}"><h3>${esc(shortDay(d.day))}</h3>
${d.open ? `<div class="sum">Booked <b>${hm(d.hours.booked)}</b>${d.hours.maintenance ? ` · maint. <b>${hm(d.hours.maintenance)}</b>` : ''} · left <b class="${d.hours.left < 0 ? 'over' : ''}">${hm(d.hours.left)}</b></div>
${d.plan.map(card).join('') || '<div class="facts">Nothing booked</div>'}` : '<div class="sum">Not open (managers can open a Saturday)</div>'}</section>`;
  const first = data.days[0].day, last = data.days[5].day;
  return page('Indigo week', `<header><h1>Indigo week · ${esc(shortDay(first))} – ${esc(shortDay(last))}</h1>
<div class="meta"><a href="${esc(todayHref)}">Today</a> · <a href="${esc(otherHref)}">${data.next ? 'This week' : 'Next week'}</a>${nav}</div></header>
${waitingLine(waiting)}${data.problems.map(p => `<div class="problem">${esc(p)}</div>`).join('')}
<div class="week">${data.days.map(col).join('')}</div>${legend}`);
}

function inputs(store, {watch, now}) {
  return {runs: store.all('printPlanRun'), blocks: maintenanceRows(store), watch, links: jobLinks(store), open: openDays(store),
    printed: new Map(store.all('indigoPrinted').map(r => [jobKey(r.job), r])), day: finishDay(now.toISOString()), now, hidden: hiddenJobs(store)};
}
/// True while the Indigo is printing (fresh watch only).
export function pressPrinting(watch, now = new Date()) {
  if (!watch || (now - Date.parse(watch.generatedAt)) / 60000 > watchStaleMinutes) return false;
  return printingJob(watch, now) !== null;
}
export const boardFor = (store, {watch, now = new Date()}) => boardData(inputs(store, {watch, now}));
export const weekFor = (store, {watch, now = new Date(), next = false}) => weekData({...inputs(store, {watch, now}), next});

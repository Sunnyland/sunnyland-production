// Not planned: the Indigo jobs the hourly agent couldn't book, in plain words, with the manager's three answers:
//   place   - put it on a day by hand (minutes prefilled from the agent's estimate)
//   fix     - give the missing piece (run time, stock, due date); the agent books it on its next pass
//   ignore  - not an Indigo job / not needed / already printed; the agent stops raising it (undo any time)
// Fixes and ignores are kept per run/job and applied by planHourly. Each change asks the agent to replan now.
import {need, str} from './core.mjs';
import {finishDay, validDay} from './job-visibility.mjs';
import {earliestPressStart} from './print-planning.mjs';

export const fixKind = 'planFix', ignoreKind = 'planIgnore';
const press = 'HP Indigo 7900', awaiting = 'Awaiting current artwork approval';
const ignoreReasons = {notIndigo: 'Not an Indigo job', notNeeded: 'Not needed', printed: 'Already printed'};

/// Plain words for the agent's reasons, and what the manager can do about each.
const explain = [
  [/front and reverse print modes/, 'printIQ’s print mode for this section isn’t one the agent knows, so it can’t work out the run time.', 'minutes'],
  [/press sheet quantity/, 'printIQ has no press sheet count for this section.', 'minutes'],
  [/sheet size/, 'The press sheet isn’t SRA3 (450 × 320), so the agent has no rate for it.', 'minutes'],
  [/press option and rated speed/, 'printIQ names a press option the agent doesn’t know the speed of.', 'minutes'],
  [/required date, stock or run duration/, 'printIQ is missing the due date, the stock or the run time.', 'any'],
  [/Exact printIQ job unavailable/, 'The agent couldn’t read this exact job in printIQ.', 'place'],
  [/accepted Printing sections/, 'The job’s printing sections in printIQ don’t line up (check the routing).', 'place'],
  [/output needs reconciliation/, 'The Indigo has already printed some of this job; check what’s left before booking more.', 'place'],
  [/Operation already started/, 'The Printing operation is already started or finished in the app.', 'ignore'],
  [/local job status or hold/, 'The job is on hold or inactive in the app.', 'ignore'],
  [/No automatic slot|No room/, 'No day in the next two weeks has room.', 'place'],
  [/printIQ production status/, 'The printIQ status says hold, reject or proof required.', 'place'],
  [/Approval status changed/, 'The printIQ approval status changed since the artwork was approved.', 'place'],
  [/Not approved, and no room/, 'Not approved yet, and there’s no room before it’s due.', 'place'],
];
const booked = /^(Late:|Booked )|Existing Indigo booking|Existing manual release/;

/// The list for managers. `feed` is the hourly feed (for job names, due dates and estimates).
export function notPlanned(store, feed, now = new Date()) {
  const scan = store.get('indigoHourlyScan', 'latest');
  const jobs = new Map((feed?.jobs ?? []).map(j => [j.job, j]));
  const ignored = new Map(store.all(ignoreKind).filter(i => !i.removed).map(i => [i.job, i]));
  const runs = store.all('printPlanRun').filter(r => !r.removed && r.press === press);
  const onPlan = new Set(runs.map(r => r.job));
  const today = finishDay(now.toISOString());
  const needs = [], artwork = [], seen = new Set();
  for (const r of scan?.review ?? []) {
    if (booked.test(r.reason) || ignored.has(r.job) || onPlan.has(r.job)) continue;
    const job = jobs.get(r.job), run = job?.runs?.find(x => x.id === r.id) ?? job?.runs?.[0] ?? null;
    const key = r.job + ':' + (run?.id ?? r.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const fix = run ? store.get(fixKind, run.id) : null;
    const item = {id: run?.id ?? r.id, job: r.job, name: job?.name ?? '', part: run?.part ?? '', stock: fix?.stock ?? run?.stock ?? '',
      minutes: fix?.minutes ?? run?.minutes ?? null, due: job?.due ? finishDay(job.due) : null, rep: job?.rep?.name ?? null, reason: r.reason, fixed: Boolean(fix)};
    if (r.reason === awaiting) { artwork.push({...item, overdue: Boolean(item.due && item.due < today)}); continue; }
    const [, plain, action] = explain.find(([re]) => re.test(r.reason)) ?? [null, r.reason, 'place'];
    needs.push({...item, plain, action});
  }
  const byDue = (a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')) || a.job.localeCompare(b.job);
  return {asOf: scan?.asOf ?? null, needs: needs.sort(byDue), artwork: artwork.sort(byDue),
    ignored: [...ignored.values()].sort((a, b) => b.at.localeCompare(a.at)), counts: {needs: needs.length, artwork: artwork.length}};
}

/// Make the agent replan on its next minute tick (it skips a feed it has already planned).
function replan(store) {
  const scan = store.get('indigoHourlyScan', 'latest');
  if (scan) store.put('indigoHourlyScan', {...scan, generatedAt: ''});
}

/// Manager answers: {action:'place', id, job, day, minutes} · {action:'fix', id, job, minutes?, stock?, due?}
///                  {action:'ignore', job, why} · {action:'unignore', job}
export function notPlannedAction(store, actor, body, feed, now = new Date()) {
  store.manager(actor);
  const job = str(body?.job, 'job', 40);
  const feedJob = (feed?.jobs ?? []).find(j => j.job === job);
  switch (body.action) {
    case 'place': {
      need(validDay(body.day) && body.day >= finishDay(now.toISOString()), 'Choose today or a later day.');
      const minutes = Number(body.minutes);
      need(Number.isInteger(minutes) && minutes > 0 && minutes <= 600, 'Give the run time in minutes.');
      const item = feedJob?.runs?.find(r => r.id === body.id) ?? feedJob?.runs?.[0] ?? null;
      const id = item?.id ?? 'manual:' + job + ':' + body.day;
      const prior = store.get('printPlanRun', id);
      const run = {id, job, printiqId: feedJob?.printiqId ?? null, name: feedJob?.name ?? job, press, day: body.day, minutes,
        part: item?.part ?? '', stock: item?.stock ?? '', finishes: item?.finishes ?? '', due: feedJob?.due ? finishDay(feedJob.due) : null,
        operationKey: item?.operationKey ?? null, agentOperation: item?.operation ?? null, fixedStart: null,
        earliestStart: earliestPressStart(press, body.day, now), hourly: false, managerOverride: true, placedBy: actor.id,
        provisional: feedJob?.state === awaiting, revision: (prior?.revision ?? 0) + 1};
      store.put('printPlanRun', run);
      store.audit(actor, 'notPlanned:place', job, {day: body.day, minutes});
      return {placed: run};
    }
    case 'fix': {
      const id = str(body.id, 'run', 80);
      const fix = {id, job, at: now.toISOString(), by: actor.id};
      if (body.minutes !== undefined && body.minutes !== '') {
        const m = Number(body.minutes); need(Number.isInteger(m) && m > 0 && m <= 600, 'Give the run time in whole minutes.'); fix.minutes = m;
      }
      if (body.stock) fix.stock = str(body.stock, 'stock', 120);
      if (body.due) { need(validDay(body.due), 'Choose a due date.'); fix.due = body.due; }
      need(fix.minutes || fix.stock || fix.due, 'Give the run time, the stock or the due date.');
      store.put(fixKind, fix);
      store.audit(actor, 'notPlanned:fix', job, fix);
      replan(store);
      return {fix};
    }
    case 'ignore': {
      const why = ignoreReasons[body.why]; need(why, 'Choose why it isn’t planned.');
      const record = {id: job, job, why, name: feedJob?.name ?? '', at: now.toISOString(), by: actor.id, removed: false};
      store.put(ignoreKind, record);
      store.audit(actor, 'notPlanned:ignore', job, {why});
      replan(store);
      return {ignored: record};
    }
    case 'unignore': {
      const prior = store.get(ignoreKind, job); need(prior, 'That job isn’t ignored.', 404);
      store.put(ignoreKind, {...prior, removed: true});
      store.audit(actor, 'notPlanned:unignore', job, {});
      replan(store);
      return {unignored: job};
    }
    default: need(false, 'Unknown change.');
  }
}

/// For planHourly: a manager's fix for one run, and whether a job is ignored.
export const runFix = (store, id) => store.get(fixKind, id);
export const jobIgnored = (store, job) => { const i = store.get(ignoreKind, job); return Boolean(i && !i.removed); };

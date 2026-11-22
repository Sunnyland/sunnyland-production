// Manager controls on the press plan, alongside the agent's bookings (printPlanRun):
//   maintenance   - a block at a set time, or hours for the day at any time (kept free at the end of the day)
//   rush          - print next: first of the runs not yet started
//   hold          - off the plan (and out of the day's capacity) until released
//   onPress       - "it is on the press" when the Indigo feed hasn't shown it yet
//   link          - a job sent to the press under the wrong number counts for the right job
//   openSaturday  - lets the agent book that Saturday automatically (managers can always place runs by hand)
// Moving a run to another day and pinning a start time use the existing run editor (savePrintRun).
import {randomUUID} from 'node:crypto';
import {need, str} from './core.mjs';
import {validDay} from './job-visibility.mjs';
import {printIQJobKey} from './job-tickets.mjs';

export const blockKind = 'pressBlock', linkKind = 'pressJobLink', openDayKind = 'pressOpenDay';
const runKind = 'printPlanRun';
const presses = ['HP Indigo 7900', 'Ryobi 755', 'Heidelberg SM52'];
const jobKey = value => printIQJobKey(value) ?? null;

/// Maintenance as bookings: a set time is a fixed booking; "any time" hours have no start.
export function maintenanceRows(store) {
  return store.all(blockKind).filter(b => !b.removed).map(b => ({id: 'maintenance:' + b.id, job: '#maintenance', printiqId: null,
    name: b.reason, press: b.press, day: b.day, minutes: b.minutes, fixedStart: b.start, maintenance: true, earliestStart: null,
    part: '', stock: '', finishes: ''}));
}

/// Runs and maintenance as the planner sees them: held runs take no time; maintenance takes its minutes.
export function planBookings(store) {
  return [...store.all(runKind).filter(r => !r.held), ...maintenanceRows(store)];
}

/// Saturdays (or other non-working days) opened for automatic booking.
export function openDays(store) {
  return new Set(store.all(openDayKind).filter(d => d.open).map(d => d.id));
}

/// Wrong job number sent to the press -> the job it belongs to.
export function jobLinks(store) {
  return new Map(store.all(linkKind).filter(l => !l.removed).map(l => [l.id, l.job]));
}

const minutesOf = value => Number.isInteger(value) && value > 0 && value <= 600;
const startOf = value => value === null || (Number.isInteger(value) && value >= 0 && value < 1440);

export function pressPlanAction(store, actor, key, body) {
  store.manager(actor);
  return store.transaction(actor, key, {pressPlan: body}, () => {
    const at = new Date().toISOString(), by = actor.id;
    const run = () => {
      const r = store.get(runKind, body.id);
      need(r && !r.removed, 'Run unavailable. Refresh the plan.', 404);
      need(r.revision === body.revision, 'This run changed. Refresh the plan.', 409);
      return r;
    };
    const saveRun = (r, change) => {
      const next = {...r, ...change, managerOverride: true, revision: r.revision + 1};
      store.put(runKind, next); store.audit(actor, 'pressPlan:' + body.action, r.id, change); return next;
    };
    switch (body.action) {
      case 'rush': return saveRun(run(), {rush: body.rush === true ? {by, at} : null});
      case 'hold': {
        const r = run();
        return saveRun(r, body.held === true ? {held: {by, at, reason: str(body.reason, 'reason for the hold', 300)}} : {held: null});
      }
      case 'onPress': return saveRun(run(), {onPress: body.onPress === true ? {by, at} : null});
      case 'maintenance': {
        if (body.remove === true) {
          const b = store.get(blockKind, body.id); need(b && !b.removed, 'Maintenance entry unavailable.', 404);
          store.put(blockKind, {...b, removed: {by, at}}); store.audit(actor, 'pressPlan:maintenance-removed', b.id, {}); return {...b, removed: true};
        }
        need(presses.includes(body.press) && validDay(body.day), 'Choose a press and day.');
        need(minutesOf(body.minutes), 'Enter 1 to 600 minutes of maintenance.');
        need(startOf(body.start) && (body.start === null || body.start + body.minutes <= 1440), 'Choose a start time within the day, or leave it as any time.');
        const block = {id: randomUUID(), press: body.press, day: body.day, start: body.start, minutes: body.minutes,
          reason: str(body.reason, 'what the maintenance is', 160), by, at, removed: null};
        store.put(blockKind, block); store.audit(actor, 'pressPlan:maintenance', block.id, block); return block;
      }
      case 'link': {
        const wrong = jobKey(body.pressJob), right = jobKey(body.job);
        need(wrong && right && wrong !== right, 'Enter the job number used at the press and the job it belongs to.');
        if (body.remove === true) {
          const l = store.get(linkKind, wrong); need(l && !l.removed, 'No link for that job number.', 404);
          store.put(linkKind, {...l, removed: {by, at}}); store.audit(actor, 'pressPlan:unlink', wrong, {job: l.job}); return {id: wrong, removed: true};
        }
        const link = {id: wrong, job: right, by, at, removed: null};
        store.put(linkKind, link); store.audit(actor, 'pressPlan:link', wrong, {job: right}); return link;
      }
      case 'openSaturday': {
        need(validDay(body.day) && new Date(body.day + 'T00:00:00Z').getUTCDay() === 6, 'Choose a Saturday.');
        const day = {id: body.day, open: body.open === true, by, at};
        store.put(openDayKind, day); store.audit(actor, 'pressPlan:openSaturday', body.day, {open: day.open}); return day;
      }
      default: need(false, 'Unknown plan change.');
    }
  });
}

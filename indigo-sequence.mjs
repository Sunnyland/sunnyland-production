// How the Indigo agent orders work.
//
// 1. Finishing lead time. Each run's finishing operations (from the accepted printIQ routing) carry
//    printIQ's own time estimate. Their total is converted to plant working days, and the run must
//    print that many working days before its due date: its latest print day. Runs with more
//    finishing therefore print earlier.
// 2. Priority. Runs are taken in order of latest print day (least spare time first), then the run
//    with more finishing, then due date.
// 3. Daily press order. On each day, runs on the same paper run back to back (fewer stock changes),
//    paper groups are ordered by their most urgent run, and within a paper group runs that share
//    finishing operations sit together so finishing can batch them.
import {isPlantWorkday,validDay} from './job-visibility.mjs';

export const finishingDefaults = {
  // Finishing working time available per plant day, in minutes.
  finishingMinutesPerDay: 450,
  // Used when an operation has no printIQ time and matches no standard below.
  fallbackMinutesPerOperation: 120,
  // Standard minutes per finishing operation, matched by the start of the printIQ operation name
  // (longest match wins). printIQ's own estimates replace these when its Operations data is available.
  // A manager can override any of them in the planner settings.
  finishingStandards: {
    'guillotine pre-trim': 20, 'guillotine': 30, 'drying': 60, 'laminat': 120, 'fold': 60, 'crease': 60, 'score': 45,
    'handwork': 240, 'perfect bind': 240, 'saddle stitch': 120, 'stitch': 120, 'drill': 30, 'hole punch': 30,
    'round corner': 30, 'collat': 60, 'die cut': 120, 'kiss cut': 120, 'shrink wrap': 30, 'numbering': 60, 'padding': 120
  }
};
const normalized = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/// The finishing operation names of a run, from the structured list or the display text.
export function finishOperations(run) {
  if (Array.isArray(run.finishOps)) return run.finishOps.map(op => normalized(op.name ?? op)).filter(Boolean);
  return String(run.finishes ?? '').split(',').map(normalized).filter(name => name && name !== 'none');
}
/// Minutes for one operation: printIQ's estimate when given, else the standard for its name, else the fallback.
export function operationMinutes(op, settings = finishingDefaults) {
  if (Number.isFinite(op?.minutes) && op.minutes >= 0) return op.minutes;
  const name = normalized(op?.name ?? op);
  const standards = settings.finishingStandards ?? finishingDefaults.finishingStandards;
  const match = Object.keys(standards).filter(key => name.startsWith(normalized(key))).sort((a, b) => b.length - a.length)[0];
  return match ? standards[match] : settings.fallbackMinutesPerOperation;
}
/// Total finishing minutes for a run.
export function finishingMinutes(run, settings = finishingDefaults) {
  if (Number.isFinite(run.finishingMinutes) && run.finishingMinutes > 0) return Math.round(run.finishingMinutes);
  const ops = Array.isArray(run.finishOps) ? run.finishOps : finishOperations(run);
  return Math.round(ops.reduce((sum, op) => sum + operationMinutes(op, settings), 0));
}
/// Working days of finishing after the print day. Any finishing needs at least the next working day.
export function finishingLeadDays(run, settings = finishingDefaults) {
  const minutes = finishingMinutes(run, settings);
  return minutes > 0 ? Math.max(1, Math.ceil(minutes / settings.finishingMinutesPerDay)) : 0;
}
/// The working day `count` plant days before `day` (holidays and closures skipped).
export function workdaysBefore(day, count) {
  const date = new Date(day + 'T00:00:00Z');
  for (let left = count; left > 0;) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (isPlantWorkday(date.toISOString().slice(0, 10))) left--;
  }
  return date.toISOString().slice(0, 10);
}
/// The last day the run can print and still finish by its due date, or null without a due date.
export function latestPrintDay(run, settings = finishingDefaults) {
  if (!validDay(run.due)) return null;
  return workdaysBefore(run.due, finishingLeadDays(run, settings));
}
/// Adds the planning facts the agent uses and shows: finishing minutes, lead days and latest print day.
export function withFinishingPlan(run, settings = finishingDefaults) {
  return {...run, finishingMinutes: finishingMinutes(run, settings),
    finishingDays: finishingLeadDays(run, settings), latestPrintDay: latestPrintDay(run, settings)};
}
const opsKey = run => [...new Set(finishOperations(run))].sort().join('|') || '￿';
const urgency = run => [run.latestPrintDay ?? run.due ?? '9999-12-31', -(run.finishingMinutes ?? 0), run.due ?? '9999-12-31'];
const compareKeys = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
};
/// Priority across days: least spare time first, then more finishing, then due date.
export function byPriority(a, b) {
  return compareKeys(urgency(a), urgency(b)) || normalized(a.stock).localeCompare(normalized(b.stock)) ||
    opsKey(a).localeCompare(opsKey(b)) || String(a.job).localeCompare(String(b.job)) || String(a.id).localeCompare(String(b.id));
}
/// Order for one press day: paper groups by their most urgent run; shared finishing together inside a group.
export function indigoDayOrder(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = normalized(row.stock) || '￿';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.entries()].map(([stock, items]) => ({stock, items, lead: items.reduce((best, r) =>
    compareKeys(urgency(r), urgency(best)) < 0 ? r : best)}));
  ordered.sort((a, b) => compareKeys(urgency(a.lead), urgency(b.lead)) || a.stock.localeCompare(b.stock));
  return ordered.flatMap(group => group.items.sort((a, b) => opsKey(a).localeCompare(opsKey(b)) ||
    compareKeys(urgency(a), urgency(b)) || String(a.job).localeCompare(String(b.job)) || String(a.id).localeCompare(String(b.id))));
}
/// True when two runs share at least one finishing operation.
export function sharesFinishing(a, b) {
  const mine = new Set(finishOperations(a));
  return finishOperations(b).some(op => mine.has(op));
}

/// Planner settings: the defaults, with any valid manager overrides from the stored configuration.
export function plannerSettings(config = {}) {
  const number = v => Number.isFinite(v) && v >= 0 && v <= 10000;
  const overrides = Object.fromEntries(Object.entries(config?.finishingStandards ?? {}).filter(([k, v]) => typeof k === 'string' && k.trim() && number(v))
    .map(([k, v]) => [normalized(k), v]));
  return {
    finishingMinutesPerDay: number(config?.finishingMinutesPerDay) && config.finishingMinutesPerDay > 0 ? config.finishingMinutesPerDay : finishingDefaults.finishingMinutesPerDay,
    fallbackMinutesPerOperation: number(config?.fallbackMinutesPerOperation) ? config.fallbackMinutesPerOperation : finishingDefaults.fallbackMinutesPerOperation,
    finishingStandards: {...finishingDefaults.finishingStandards, ...overrides}
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {planHourly} from '../hourly-indigo.mjs';
import {choosePrintDay, sequencePressDay} from '../print-planning.mjs';
import {byPriority, plannerSettings, finishingLeadDays, finishingMinutes, indigoDayOrder, latestPrintDay, withFinishingPlan, workdaysBefore} from '../indigo-sequence.mjs';

const indigo = 'HP Indigo 7900';
const now = new Date('2026-11-22T20:00:00Z'); // Monday 23 November, 07:00 at the plant
const run = (id, extra = {}) => withFinishingPlan({id, job: 'J' + id, press: indigo, minutes: 30, due: '2026-11-27',
  stock: 'Silk 320x450', finishes: 'None', fixedStart: null, ...extra});

test('finishing minutes come from printIQ times, with a fallback only for untimed operations', () => {
  assert.equal(finishingMinutes({finishOps: [{name: 'Laminate', minutes: 90}, {name: 'Trim', minutes: 30}]}), 120);
  assert.equal(finishingMinutes({finishOps: [{name: 'Laminate', minutes: 90}, {name: 'Crease'}]}), 150);
  assert.equal(finishingMinutes({finishes: 'Laminate, Mystery step'}), 240);
  // Real printIQ names from the routing: standards by name, longest match first.
  assert.equal(finishingMinutes({finishOps: [{name: 'Guillotine Pre-Trim'}, {name: 'Guillotine'}, {name: 'Handwork Glue'}]}), 290);
  assert.equal(finishingMinutes({finishOps: [{name: 'Guillotine'}]}, plannerSettings({finishingStandards: {Guillotine: 45}})), 45);
  assert.equal(plannerSettings({finishingStandards: {Fold: -5}}).finishingStandards.fold, 60);
  // Names as printIQ writes them on current Indigo jobs.
  assert.equal(finishingMinutes({finishOps: [{name: 'Gloss Laminate'}, {name: 'Machine Collate'}, {name: 'Diecut using Platten / 35'},
    {name: 'Numbers from  17301'}, {name: 'Perforation '}, {name: 'Saddle Stitch (flat Sheet)'}]}), 120 + 60 + 120 + 60 + 45 + 120);
  // "Handwork Staple" is handwork (longest match), not a plain staple.
  assert.equal(finishingMinutes({finishOps: [{name: 'Handwork Staple'}]}), 240);
  assert.equal(finishingMinutes({finishes: 'None'}), 0);
  assert.equal(finishingLeadDays({finishOps: [{name: 'Trim', minutes: 20}]}), 1);
  assert.equal(finishingLeadDays({finishOps: [{name: 'Perfect bind', minutes: 900}]}), 2);
  assert.equal(finishingLeadDays({finishes: 'None'}), 0);
});

test('latest print day counts back plant working days, skipping weekends and holidays', () => {
  assert.equal(workdaysBefore('2026-11-30', 1), '2026-11-27');          // Monday back to Friday
  assert.equal(workdaysBefore('2026-11-04', 1), '2026-11-02');          // Melbourne Cup, 3 November
  assert.equal(latestPrintDay({due: '2026-11-27', finishOps: [{name: 'Bind', minutes: 500}]}), '2026-11-25');
  assert.equal(latestPrintDay({due: '2026-11-27', finishes: 'None'}), '2026-11-27');
  assert.equal(latestPrintDay({due: null}), null);
});

test('a job with more finishing prints before one with less, even when due later', () => {
  const light = run('light', {due: '2026-11-26', finishOps: [{name: 'Trim', minutes: 20}]});
  const heavy = run('heavy', {due: '2026-11-27', finishOps: [{name: 'Laminate', minutes: 400}, {name: 'Perfect bind', minutes: 500}]});
  assert.equal(heavy.latestPrintDay, '2026-11-25');
  assert.equal(light.latestPrintDay, '2026-11-25');
  assert.deepEqual([light, heavy].sort(byPriority).map(r => r.id), ['heavy', 'light']);
});

test('a press day runs the same paper together and keeps shared finishing next to each other', () => {
  const rows = [
    run('a', {stock: 'Gloss 300', finishes: 'Trim', due: '2026-11-27'}),
    run('b', {stock: 'Silk 150', finishes: 'Laminate, Trim', due: '2026-11-25'}),
    run('c', {stock: 'Gloss 300', finishes: 'Laminate', due: '2026-11-30'}),
    run('d', {stock: 'Silk 150', finishes: 'None', due: '2026-11-30'}),
    run('e', {stock: 'Silk 150', finishes: 'Laminate, Trim', due: '2026-11-30'})];
  const order = indigoDayOrder(rows).map(r => r.id);
  // Silk holds the most urgent run, so its group goes first; within each paper, shared finishing is adjacent.
  assert.deepEqual(order, ['b', 'e', 'd', 'c', 'a']);
  const placed = sequencePressDay(rows.map(r => ({...r, day: '2026-11-24'})));
  assert.deepEqual(placed.map(r => r.id), order);
});

test('the print day leaves the finishing time before the due date', () => {
  const target = run('t', {due: '2026-11-27', finishOps: [{name: 'Bind', minutes: 500}]});
  assert.equal(target.latestPrintDay, '2026-11-25');
  const full = ['2026-11-23', '2026-11-24'].map((day, i) => ({id: 'f' + i, job: 'J9' + i, press: indigo, day, minutes: 436, fixedStart: null, due: day, stock: 'X'}));
  assert.equal(choosePrintDay(target, full, now), '2026-11-25');
  const busy = [...full, {id: 'f2', job: 'J92', press: indigo, day: '2026-11-25', minutes: 436, fixedStart: null, due: '2026-11-25', stock: 'X'}];
  assert.throws(() => choosePrintDay(target, busy, now), /finishing before the due date/);
});

test('the hourly agent books by finishing lead time and flags a booking that cuts finishing short', t => {
  const s = new Store(); t.after(() => s.close());
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: true});
  const stamp = now.toISOString();
  const job = (no, due, runs) => ({job: no, state: 'open', due, name: 'Job ' + no, printiqId: Number(no.slice(1)), runs});
  const item = (id, finishOps, stock = 'Silk 320x450') => ({id, part: 'Text', stock, minutes: 40, operation: 'op-' + id, operationKey: id,
    finishes: finishOps.map(o => o.name).join(', ') || 'None', finishOps, finishingMinutes: finishOps.reduce((n, o) => n + o.minutes, 0)});
  planHourly(s, {schema: 3, asOf: stamp, generatedAt: stamp, history: [], jobs: [
    job('J700001', '2026-11-27', [item('heavy', [{name: 'Laminate', minutes: 300}, {name: 'Perfect bind', minutes: 400}])]),
    job('J700002', '2026-11-27', [item('light', [])]),
    job('J700003', '2026-11-24', [item('late', [{name: 'Bind', minutes: 900}])])]}, now);
  const heavy = s.get('printPlanRun', 'heavy'), light = s.get('printPlanRun', 'light'), late = s.get('printPlanRun', 'late');
  assert.equal(heavy.latestPrintDay, '2026-11-25');
  assert.ok(heavy.day <= '2026-11-25');
  assert.equal(heavy.finishingAtRisk, false);
  assert.equal(light.latestPrintDay, '2026-11-27');
  assert.equal(late.finishingAtRisk, true);
  assert.equal(late.day, '2026-11-23');
  assert.match(s.get('indigoHourlyScan', 'latest').review.find(r => r.id === 'late').reason, /less than the 2 working days/);
  // The next scan with the same facts changes nothing.
  const again = new Date(+now + 60000).toISOString();
  planHourly(s, {schema: 3, asOf: again, generatedAt: again, history: [], jobs: [
    job('J700001', '2026-11-27', [item('heavy', [{name: 'Laminate', minutes: 300}, {name: 'Perfect bind', minutes: 400}])]),
    job('J700002', '2026-11-27', [item('light', [])]),
    job('J700003', '2026-11-24', [item('late', [{name: 'Bind', minutes: 900}])])]}, new Date(+now + 60000));
  assert.equal(s.get('printPlanRun', 'heavy').revision, 1);
});

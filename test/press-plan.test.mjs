import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {choosePrintDay, sequencePressDay} from '../print-planning.mjs';
import {jobLinks, maintenanceRows, openDays, planBookings, pressPlanAction} from '../press-plan.mjs';
import {boardData, renderBoard, renderWeek, weekData} from '../board.mjs';
import {linkedJobs} from '../indigo-printed.mjs';

const press = 'HP Indigo 7900';
const now = new Date('2026-11-23T00:30:00Z'); // Monday 23 November, 11:30 at the plant
const day = '2026-11-23';
const run = (job, extra = {}) => ({id: 'r-' + job, job, printiqId: Number(job.slice(1)), name: 'Job ' + job, day, press, minutes: 60,
  fixedStart: null, earliestStart: null, part: 'Text', stock: 'Silk', finishes: 'Fold', due: '2026-11-27', revision: 1, ...extra});
const watch = (extra = {}) => ({schema: 1, generatedAt: now.toISOString(), approvals: {}, queue: {}, health: {indigo: {ok: true}, cockpit: {ok: true}}, ...extra});

function setup(t) {
  const s = new Store(); t.after(() => s.close());
  const manager = s.publicUser(s.user('manager@sunnyland.test', 'a-long-test-password', 'manager', 'Pat Manager'));
  const operator = s.publicUser(s.user('op@sunnyland.test', 'a-long-test-password', 'operator'));
  let n = 0; const act = (actor, body) => pressPlanAction(s, actor, 'k' + (n++), body);
  return {s, manager, operator, act};
}

test('only managers change the plan; each change is recorded and needs the current revision', t => {
  const {s, manager, operator, act} = setup(t);
  s.put('printPlanRun', run('J100'));
  assert.throws(() => act(operator, {action: 'rush', id: 'r-J100', revision: 1, rush: true}), /manager/);
  assert.throws(() => act(manager, {action: 'rush', id: 'r-J100', revision: 9, rush: true}), /changed/);
  const rushed = act(manager, {action: 'rush', id: 'r-J100', revision: 1, rush: true});
  assert.equal(rushed.rush.by, manager.id); assert.equal(rushed.managerOverride, true); assert.equal(rushed.revision, 2);
  assert.throws(() => act(manager, {action: 'hold', id: 'r-J100', revision: 2, held: true}), /reason/);
  const held = act(manager, {action: 'hold', id: 'r-J100', revision: 2, held: true, reason: 'Waiting for stock'});
  assert.equal(held.held.reason, 'Waiting for stock');
  assert.equal(planBookings(s).length, 0);
  assert.equal(act(manager, {action: 'hold', id: 'r-J100', revision: 3, held: false}).held, null);
  assert.ok(act(manager, {action: 'onPress', id: 'r-J100', revision: 4, onPress: true}).onPress);
  assert.ok(s.db.prepare("SELECT count(*) n FROM audit WHERE kind LIKE 'pressPlan:%'").get().n >= 4);
});

test('maintenance: a set time or hours for the day; Saturdays opened; job numbers linked', t => {
  const {s, manager, act} = setup(t);
  assert.throws(() => act(manager, {action: 'maintenance', press, day, start: null, minutes: 0, reason: 'Service'}), /1 to 600/);
  const block = act(manager, {action: 'maintenance', press, day, start: 480, minutes: 90, reason: 'HP service visit'});
  act(manager, {action: 'maintenance', press, day: '2026-11-24', start: null, minutes: 60, reason: 'Clean blankets'});
  assert.deepEqual(maintenanceRows(s).map(m => [m.day, m.fixedStart, m.minutes]), [[day, 480, 90], ['2026-11-24', null, 60]]);
  act(manager, {action: 'maintenance', id: block.id, remove: true});
  assert.equal(maintenanceRows(s).length, 1);
  assert.throws(() => act(manager, {action: 'openSaturday', day: '2026-11-27', open: true}), /Saturday/);
  act(manager, {action: 'openSaturday', day: '2026-11-28', open: true});
  assert.deepEqual([...openDays(s)], ['2026-11-28']);
  act(manager, {action: 'link', pressJob: '064599', job: 'J064559'});
  assert.deepEqual([...jobLinks(s)], [['J064599', 'J064559']]);
  act(manager, {action: 'link', pressJob: 'J064599', job: 'J064559', remove: true});
  assert.equal(jobLinks(s).size, 0);
  assert.throws(() => act(manager, {action: 'link', pressJob: 'J1', job: 'J1'}), /job number/);
});

test('the day plan: rush goes first, held takes no slot, maintenance blocks its time and any-time hours come off the end', () => {
  const rows = [run('J1'), run('J2', {rush: {by: 'm'}}), run('J3', {held: {reason: 'x'}}),
    {id: 'maintenance:a', job: '#maintenance', press, day, minutes: 60, fixedStart: 600, maintenance: true, stock: '', finishes: ''}];
  const placed = sequencePressDay(rows);
  const byId = Object.fromEntries(placed.map(r => [r.id, r]));
  assert.ok(byId['r-J2'].start < byId['r-J1'].start);
  assert.equal(byId['r-J3'].blocked, 'Held'); assert.equal(byId['r-J3'].start, null);
  assert.equal(byId['maintenance:a'].start, 600);
  for (const r of placed.filter(r => r.start !== null && !r.maintenance)) assert.ok(r.end <= 600 || r.start >= 660);
  // Seven hours of runs plus three hours "any time" maintenance: the last run no longer fits the window.
  const long = [...[1, 2, 3, 4, 5, 6, 7].map(i => run('J' + i)), {id: 'maintenance:b', job: '#maintenance', press, day, minutes: 180, fixedStart: null, maintenance: true, stock: '', finishes: ''}];
  const out = sequencePressDay(long);
  assert.equal(out.filter(r => !r.maintenance && r.start === null).length, 1);
  assert.equal(out.find(r => r.maintenance).start, null);
});

test('the agent books Saturday only when it is opened, and maintenance uses up a day', () => {
  const friday = new Date('2026-11-26T22:00:00Z'); // Friday 27 November, 09:00
  const job = {id: 'new', job: 'J9', press, minutes: 120, due: '2026-12-01', stock: 'Silk', finishes: 'Fold', fixedStart: null};
  const full = [{id: 'maintenance:f', job: '#maintenance', press, day: '2026-11-27', minutes: 430, fixedStart: null, maintenance: true}];
  assert.equal(choosePrintDay(job, full, friday), '2026-11-30');
  assert.equal(choosePrintDay(job, full, friday, new Set(['2026-11-28'])), '2026-11-28');
});

test('the board: hours booked and left, maintenance in the plan, held runs apart, rush and manual tags', () => {
  const runs = [run('J100', {minutes: 90}), run('J200', {rush: {by: 'm'}, minutes: 60}), run('J300', {held: {reason: 'No stock'}, minutes: 45}),
    run('J400', {fixedStart: 840, managerOverride: true, minutes: 30})];
  const blocks = [{id: 'maintenance:m', job: '#maintenance', name: 'Clean blankets', press, day, minutes: 60, fixedStart: null, maintenance: true}];
  const data = boardData({runs, blocks, watch: watch(), printed: new Map(), day, now});
  assert.deepEqual({...data.hours}, {capacity: 436, booked: 180, maintenance: 60, left: 196, shiftLeft: 320, toPrint: 180});
  assert.deepEqual(data.held.map(r => r.job), ['J300']);
  assert.equal(data.maintenance[0].anyTime, true);
  assert.equal(data.next[0].job, 'J200');
  assert.equal(data.next[0].status.rush, true);
  assert.equal(data.next.find(r => r.job === 'J400').status.manual, true);
  const html = renderBoard(data, {weekHref: 'KEY/week'});
  assert.match(html, /Capacity <b>7h16<\/b>[\s\S]*Booked <b>3h<\/b>[\s\S]*Maintenance <b>1h<\/b>[\s\S]*Left to book <b>3h16<\/b>/);
  assert.match(html, /RUSH[\s\S]*<h2>Held<\/h2>[\s\S]*No stock/);
  assert.match(html, /href="KEY\/week"/);
});

test('a job sent to the press under the wrong number shows on the right job, and its sheets count there', () => {
  const links = new Map([['J064599', 'J064559']]);
  const data = boardData({runs: [run('J064559')], watch: watch({queue: {J064599: {status: 'Printing', last: now.toISOString()}}}),
    printed: new Map(), links, day, now});
  assert.equal(data.current.map(r => r.job).join(), 'J064559');
  const merged = linkedJobs([{job: 'J064599', printiq: null, entries: [{queueEntryId: 'a'}]}, {job: 'J064559', printiq: {quantity: 1}, entries: [{queueEntryId: 'b'}]}], links);
  assert.deepEqual(merged.map(j => [j.job, j.entries.map(e => e.queueEntryId)]), [['J064559', ['b', 'a']]]);
});

test('week view: Monday to Saturday, Saturday closed unless opened or booked', () => {
  const runs = [run('J1'), run('J2', {day: '2026-11-25'}), run('J3', {day: '2026-11-30'})];
  const week = weekData({runs, blocks: [], watch: watch(), printed: new Map(), day: '2026-11-25', now});
  assert.deepEqual(week.days.map(d => d.day), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
  assert.deepEqual(week.days.map(d => d.open), [true, true, true, true, true, false]);
  assert.equal(week.days[2].today, true);
  assert.equal(weekData({runs, watch: watch(), printed: new Map(), day: '2026-11-25', now, open: new Set(['2026-11-28'])}).days[5].open, true);
  const next = weekData({runs, watch: watch(), printed: new Map(), day: '2026-11-25', now, next: true});
  assert.equal(next.days[0].plan[0].job, 'J3');
  const html = renderWeek(week, {todayHref: '../KEY', otherHref: '?next=1'});
  assert.match(html, /Indigo week · Mon,? 23 Nov – Sat,? 28 Nov/);
  assert.match(html, /Not open \(managers can open a Saturday\)/);
});

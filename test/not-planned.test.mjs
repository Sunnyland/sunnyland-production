import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core.mjs';
import {planHourly} from '../hourly-indigo.mjs';
import {notPlanned, notPlannedAction} from '../not-planned.mjs';
import {createBoardLink} from '../board.mjs';
import {createServer} from '../server.mjs';
import {addOperator, setPin} from '../shifts.mjs';

const now = new Date('2026-11-22T20:00:00Z'); // Monday 23 November, 07:00 at the plant
const later = n => new Date(+now + n * 60000);
const job = (no, extra = {}, run = {}) => ({job: no, state: 'open', due: '2026-11-26', name: 'Job ' + no, printiqId: Number(no.slice(1)), rep: {name: 'Sam', email: 'sam@x.test'},
  runs: [{id: 'run-' + no, part: 'Text', stock: '20415 320x450', minutes: 45, finishes: 'None', operation: 'op-' + no, operationKey: '1' + no.slice(1), ...run}], ...extra});
const feedAt = (jobs, at = now) => ({schema: 3, asOf: at.toISOString(), generatedAt: at.toISOString(), history: [], jobs});
function setup(t) {
  const s = new Store(); t.after(() => s.close());
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: true});
  const manager = s.publicUser(s.user('paul@x.test', 'a-long-test-password', 'manager', 'Paul'));
  const operator = s.publicUser(s.user('op@x.test', 'a-long-test-password', 'operator', 'Op'));
  const feed = feedAt([job('J000001'), job('J000002', {}, {minutes: null, estimateIssue: 'Check Indigo front and reverse print modes'}),
    job('J000003', {state: 'Awaiting current artwork approval', due: '2026-12-10'}), job('J000004', {state: 'Exact printIQ job unavailable', runs: []})]);
  planHourly(s, feed, now);
  return {s, manager, operator, feed};
}

test('the list explains each job in plain words and keeps artwork waits apart', t => {
  const {s, feed} = setup(t);
  const list = notPlanned(s, feed, now);
  assert.deepEqual(list.needs.map(i => [i.job, i.action]).sort(), [['J000002', 'minutes'], ['J000004', 'place']]);
  assert.ok(list.needs.find(i => i.job === 'J000002').plain.startsWith('printIQ’s print mode'));
  assert.deepEqual(list.artwork.map(i => i.job), ['J000003']);
  assert.ok(!list.needs.some(i => i.job === 'J000001'), 'booked jobs are not listed');
  assert.deepEqual(list.counts, {needs: 2, artwork: 1});
});

test('fix: a run time from a manager lets the agent book it on its next pass', t => {
  const {s, manager, operator, feed} = setup(t);
  assert.throws(() => notPlannedAction(s, operator, {action: 'fix', job: 'J000002', id: 'run-J000002', minutes: '50'}, feed, now), /manager/);
  notPlannedAction(s, manager, {action: 'fix', job: 'J000002', id: 'run-J000002', minutes: '50'}, feed, now);
  planHourly(s, feed, later(1));
  const run = s.get('printPlanRun', 'run-J000002');
  assert.equal(run.minutes, 50); assert.equal(run.managerFix, true); assert.ok(!run.removed);
  assert.ok(!notPlanned(s, feed, later(1)).needs.some(i => i.job === 'J000002'));
});

test('ignore takes a job off the list and the plan; undo brings it back', t => {
  const {s, manager, feed} = setup(t);
  notPlannedAction(s, manager, {action: 'ignore', job: 'J000001', why: 'notIndigo'}, feed, now);
  planHourly(s, feed, later(1));
  assert.equal(s.get('printPlanRun', 'run-J000001').removed, true);
  assert.equal(notPlanned(s, feed, later(1)).ignored[0].why, 'Not an Indigo job');
  notPlannedAction(s, manager, {action: 'unignore', job: 'J000001'}, feed, later(2));
  planHourly(s, feed, later(3));
  assert.ok(!s.get('printPlanRun', 'run-J000001').removed);
  assert.throws(() => notPlannedAction(s, manager, {action: 'ignore', job: 'J000001', why: 'whatever'}, feed, now), /why/);
});

test('place: a manager puts a job on a day by hand and the agent leaves it there', t => {
  const {s, manager, feed} = setup(t);
  const {placed} = notPlannedAction(s, manager, {action: 'place', job: 'J000004', id: '', day: '2026-11-24', minutes: '35'}, feed, now);
  assert.equal(placed.day, '2026-11-24'); assert.equal(placed.managerOverride, true); assert.equal(placed.minutes, 35);
  planHourly(s, feed, later(1));
  assert.equal(s.get('printPlanRun', placed.id).day, '2026-11-24');
  assert.ok(!notPlanned(s, feed, later(1)).needs.some(i => i.job === 'J000004'));
  assert.throws(() => notPlannedAction(s, manager, {action: 'place', job: 'J000004', day: '2026-11-20', minutes: '35'}, feed, now), /later day/);
});

test('planning page: a PIN signs in to a read-only view; the session cannot use the staff API', async t => {
  const {s, manager} = setup(t);
  const sadhir = addOperator(s, manager, 'Sadhir');
  setPin(s, manager, 'Sadhir', '4826');
  assert.equal(sadhir.email, null);
  const key = createBoardLink(s, {label: 'Indigo press'});
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  const feed = feedAt([job('J000002', {}, {minutes: null, estimateIssue: 'Check Indigo front and reverse print modes'}), job('J000004', {state: 'Exact printIQ job unavailable', runs: []})]);
  const server = createServer(s, {mediaDir: dir, allowedPeers: null, boardWatch: () => null, hourlyFeed: () => feed, clock: () => later(5)});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, cookie = '', origin = 'https://printcrm.sunnyland.com.au') => fetch(base + path, {method: 'POST', redirect: 'manual',
    body: new URLSearchParams(body), headers: {origin, ...(cookie ? {cookie} : {})}});
  assert.match(await (await fetch(base + '/plan')).text(), /Sign in with your PIN/);
  assert.equal((await fetch(base + '/plan/week', {redirect: 'manual'})).status, 303);
  let r = await post('/plan/login', {pin: '1357'});
  assert.equal(r.status, 303); assert.match(r.headers.get('location'), /^\.\.\/plan\?e=/);
  assert.match(await (await fetch(base + '/' + r.headers.get('location').slice(3))).text(), /didn’t match/);
  for (const p of ['/plan/', '/plan/login']) { const x = await fetch(base + p, {redirect: 'manual'}); assert.equal(x.status, 303); assert.equal(x.headers.get('location'), '../plan'); }
  r = await post('/plan/login', {pin: '4826'});
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '../plan');
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/); assert.doesNotMatch(r.headers.get('set-cookie'), /Path=/);
  const cookie = r.headers.get('set-cookie').split(';')[0], token = cookie.split('=')[1];
  let page = await (await fetch(base + '/plan', {headers: {cookie}})).text();
  assert.match(page, /Indigo · /); assert.match(page, /href="plan\/week"/); assert.match(page, /Not planned \(2\)/); assert.match(page, /Sign out Sadhir/);
  page = await (await fetch(base + '/plan/not-planned', {headers: {cookie}})).text();
  assert.match(page, /J000002/); assert.match(page, /print mode/); assert.doesNotMatch(page, /<form method="post" action="plan\/action"|name="action"/);
  page = await (await fetch(base + '/plan/week', {headers: {cookie}})).text();
  assert.match(page, /Indigo week/);
  assert.equal((await post('/plan/action', {action: 'ignore', job: 'J000004', why: 'notNeeded'}, cookie)).status, 404);
  assert.equal((await fetch(base + '/api/state', {headers: {authorization: 'Bearer ' + token}})).status, 401, 'a PIN session is not a staff session');
  // Managers still change the plan through the API (PrintCRM will call it).
  const {token: mt} = s.login('paul@x.test', 'a-long-test-password');
  r = await fetch(base + '/api/action?notPlanned=1', {method: 'POST', headers: {authorization: 'Bearer ' + mt, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'ignore', job: 'J000004', why: 'notNeeded'})});
  assert.equal(r.status, 200);
  const board = await (await fetch(`${base}/board/${key}`)).text();
  assert.match(board, /<b>1<\/b> job not planned — a manager is checking/);
  r = await post('/plan/logout', {}, cookie);
  assert.match(await (await fetch(base + '/plan', {headers: {cookie}})).text(), /Sign in with your PIN/);
});

test('"Origin: null" form posts work on the planning page and board, and are refused by the staff API', async t => {
  const {s, manager} = setup(t);
  addOperator(s, manager, 'Sadhir'); setPin(s, manager, 'Sadhir', '4826');
  const dir = mkdtempSync(join(tmpdir(), 'plan-'));
  const server = createServer(s, {mediaDir: dir, allowedPeers: null, boardWatch: () => null, hourlyFeed: () => null, clock: () => later(5)});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let r = await fetch(base + '/plan/login', {method: 'POST', redirect: 'manual', body: new URLSearchParams({pin: '4826'}), headers: {origin: 'null'}});
  assert.equal(r.status, 303);
  r = await fetch(base + '/api/login', {method: 'POST', body: '{}', headers: {origin: 'null', 'content-type': 'application/json'}});
  assert.equal(r.status, 403);
  r = await fetch(base + '/api/login', {method: 'POST', body: '{}', headers: {origin: 'not a url', 'content-type': 'application/json'}});
  assert.equal(r.status, 403);
});

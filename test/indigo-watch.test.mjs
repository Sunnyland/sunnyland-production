import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {applyWatch, drainProductionAlerts, watchAlerts, workdaysUntil} from '../indigo-watch.mjs';

const now = new Date('2026-11-22T23:00:00Z'); // Monday 23 November, 10:00 at the plant
const ago = minutes => new Date(+now - minutes * 60000).toISOString();
const healthy = {cockpit: {ok: true}, indigo: {ok: true, lastSuccessfulAt: ago(2)}};
const watchOf = (extra = {}) => ({schema: 1, generatedAt: ago(3), approvals: {}, queue: {}, unmatched: [], health: healthy, ...extra});
const rep = {name: 'Paul Cocks', email: 'paul@sunnyland.com.au'};
const run = (finishOps = []) => ({id: 'r', part: 'Text', stock: 'Silk', minutes: 30, finishes: finishOps.map(o => o.name).join(', ') || 'None', finishOps});
const job = (no, due, extra = {}) => ({job: no, name: 'Brochure', state: 'open', due, rep, runs: [run([{name: 'Guillotine'}])], ...extra});
const keys = result => result.alerts.map(a => a.key.split(':')[0]);

function setup(t) {
  const s = new Store(); t.after(() => s.close());
  const manager = s.publicUser(s.user('manager@sunnyland.test', 'a-long-test-password', 'manager'));
  s.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?)').run('11111111-1111-4111-8111-111111111111', 'ab'.repeat(32), manager.id, 'binding-1');
  return {s, manager};
}

test('working days until a date skip weekends and holidays', () => {
  assert.equal(workdaysUntil('2026-11-23', '2026-11-23'), 0);
  assert.equal(workdaysUntil('2026-11-27', '2026-11-30'), 1);
  assert.equal(workdaysUntil('2026-11-02', '2026-11-04'), 1); // Melbourne Cup on the 3rd
  assert.equal(workdaysUntil('2026-11-23', '2026-11-20'), -1);
});

test('an approved job must reach the Indigo within 30 minutes', () => {
  const feed = {jobs: [job('J064379', '2026-11-27')]};
  const approved = at => ({J064379: {approved: true, approvedAt: at}});
  assert.deepEqual(keys(watchAlerts({watch: watchOf({approvals: approved(ago(10))}), feed, now})), []);
  const late = watchAlerts({watch: watchOf({approvals: approved(ago(40))}), feed, now});
  assert.deepEqual(keys(late), ['indigo-missing']);
  assert.match(late.alerts[0].text, /has not reached the Indigo queue after 30 minutes/);
  // In the queue after approval: fine. An entry from before a re-approval doesn't count.
  const queued = watchAlerts({watch: watchOf({approvals: approved(ago(40)), queue: {J064379: {last: ago(20)}}}), feed, now});
  assert.deepEqual(keys(queued), []); assert.equal(queued.status.onIndigo, 1);
  assert.deepEqual(keys(watchAlerts({watch: watchOf({approvals: approved(ago(40)), queue: {J064379: {last: ago(600)}}}), feed, now})), ['indigo-missing']);
  // Jobs entered by prepress without the J still match.
  assert.deepEqual(keys(watchAlerts({watch: watchOf({approvals: approved(ago(40)), queue: {J064379: {last: ago(20)}}}), feed: {jobs: [job('064379', '2026-11-27')]}, now})), []);
});

test('unapproved jobs: reminder with one working day of slack, escalation when the deadline is gone', () => {
  const watch = watchOf();
  // Due Wednesday with Guillotine (one finishing day): latest print Tuesday, one day of slack.
  const soon = watchAlerts({watch, feed: {jobs: [job('J1', '2026-11-25')]}, now});
  assert.deepEqual(keys(soon), ['approval-reminder']);
  assert.equal(soon.alerts[0].audience, 'rep');
  assert.match(soon.alerts[0].subject, /by tomorrow/);
  // Due Tuesday with two days of finishing: latest print day was last Friday.
  const heavy = job('J2', '2026-11-24', {runs: [run([{name: 'Handwork Glue'}, {name: 'Perfect bind'}])]});
  const gone = watchAlerts({watch, feed: {jobs: [heavy]}, now});
  assert.deepEqual(keys(gone), ['approval-late']);
  assert.equal(gone.alerts[0].audience, 'rep+managers');
  // Plenty of time, closed jobs and other presses: nothing.
  assert.deepEqual(keys(watchAlerts({watch, feed: {jobs: [job('J3', '2026-12-04'), job('J4', '2026-11-24', {state: 'complete'}), job('J5', '2026-11-24', {runs: []})]}, now})), []);
  // No rep email: the reminder goes to managers.
  assert.equal(watchAlerts({watch, feed: {jobs: [job('J6', '2026-11-25', {rep: null})]}, now}).alerts[0].audience, 'managers');
  // No reminders at the weekend.
  assert.deepEqual(keys(watchAlerts({watch: {...watch, generatedAt: '2026-11-21T22:57:00Z'}, feed: {jobs: [job('J1', '2026-11-25')]}, now: new Date('2026-11-21T23:00:00Z')})), []);
});

test('connection problems, unnumbered queue entries and a stopped watch raise alerts', () => {
  const feed = {jobs: [job('J064379', '2026-11-27')]};
  const approvals = {J064379: {approved: true, approvedAt: ago(90)}};
  const down = watchAlerts({watch: watchOf({approvals, health: {cockpit: {ok: true}, indigo: {ok: false, reason: 'The Indigo has not reported for over 10 minutes.', lastSuccessfulAt: ago(45)}}}), feed, now});
  // While the Indigo feed is down, a missing job isn't blamed on prepress.
  assert.deepEqual(keys(down), ['indigo-down']);
  const cockpit = watchAlerts({watch: watchOf({health: {cockpit: {ok: false, reason: 'Prinect Cockpit approvals could not be read.'}, indigo: {ok: true}}}), feed: {jobs: [job('J1', '2026-11-25')]}, now});
  assert.deepEqual(keys(cockpit), ['cockpit-down']);
  const unnumbered = watchAlerts({watch: watchOf({unmatched: [{queueEntryId: 'q1', submitted: ago(5), nativeJobId: '000000', jobPartId: 'IP0.D', status: 'Running'}]}), feed: {jobs: []}, now});
  assert.deepEqual(keys(unnumbered), ['indigo-unnumbered']);
  assert.deepEqual(keys(watchAlerts({watch: watchOf({generatedAt: ago(45)}), feed: {jobs: []}, now})), ['watch-stale']);
  assert.match(watchAlerts({watch: null, feed, now}).status.problem, /Waiting/);
});

test('alerts are queued once per key to the right people, with iPhone notifications for managers', async t => {
  const {s} = setup(t);
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: true, revision: 1, prepressEmails: ['prepress1@sunnyland.test', 'prepress2@sunnyland.test']});
  const feed = {jobs: [job('J064379', '2026-11-27'), job('J1', '2026-11-25')]};
  const watch = watchOf({approvals: {J064379: {approved: true, approvedAt: ago(40)}}});
  const first = applyWatch(s, {watch, feed, now});
  const mail = s.db.prepare("SELECT body FROM outbox WHERE channel='mail' ORDER BY id").all().map(r => JSON.parse(r.body));
  assert.deepEqual(mail.map(m => m.to).sort(), ['manager@sunnyland.test', 'paul@sunnyland.com.au', 'prepress1@sunnyland.test', 'prepress2@sunnyland.test']);
  assert.ok(mail.every(m => m.kind === 'production_alert' && m.subject && m.text));
  assert.equal(first.sent.length, 4);
  assert.equal(s.db.prepare('SELECT count(*) n FROM production_alerts').get().n, 1);
  // The same situation a minute later sends nothing new.
  assert.equal(applyWatch(s, {watch, feed, now: new Date(+now + 60000)}).sent.length, 0);
  assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get().n, 4);
  const status = s.get('indigoWatch', 'latest');
  assert.equal(status.notOnIndigo[0].job, 'J064379');
  assert.equal(status.approvalWaiting[0].job, 'J1');
  // The push goes to the manager's iPhone with the alert's own wording.
  const pushes = [];
  await drainProductionAlerts(s, async (device, alert) => { pushes.push(alert); return {status: 200}; });
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /J064379 approved but not on the Indigo/);
  assert.equal(s.db.prepare("SELECT state FROM production_alerts").get().state, 'accepted');
});

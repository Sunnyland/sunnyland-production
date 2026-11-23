import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {clearBacklog, sendMailOutbox} from '../mail-worker.mjs';

const now = new Date('2026-11-23T05:00:00Z');
function setup(t) {
  const s = new Store(); t.after(() => s.close());
  const q = (id, job, subject, created = now.toISOString()) => s.db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?,?)')
    .run(id, 'mail', job, JSON.stringify({to: 'rep@x.test', kind: 'production_alert', job, subject, text: 'x'}), 'pending', null, created);
  q('indigo-agent:late-dispatch:J1:2026-11-25:rep@x.test', 'J1', 'J1 late');
  q('indigo-agent:late-dispatch:J2:2026-11-25:rep@x.test', 'J2', 'J2 late');
  q('indigo-agent:late-dispatch:J3:2026-11-25:rep@x.test', 'J3', 'J3 late');
  q('indigo-agent:approval-reminder:J4:2026-11-23:rep@x.test', 'J4', 'J4 approval');
  q('indigo-agent:printed-other:J5:rep@x.test', 'J5', 'J5 other section', new Date(+now - 72 * 3600000).toISOString());
  s.db.prepare("INSERT INTO outbox VALUES ('note','printiq','J1','{}','pending',NULL,?)").run(now.toISOString());
  s.put('printPlanRun', {id: 'r1', job: 'J1', late: true}); s.put('printPlanRun', {id: 'r2', job: 'J2', late: true}); s.put('printPlanRun', {id: 'r3', job: 'J3', late: false});
  s.put('indigoPrinted', {id: 'J2', job: 'J2', printed: 300});
  return s;
}
const states = s => Object.fromEntries(s.db.prepare('SELECT id,state FROM outbox').all().map(r => [r.id.split(':').slice(1, 3).join(':') || r.id, r.state]));

test('log mode records instead of sending; stale emails are cancelled with a reason; printIQ notes are left alone', async t => {
  const s = setup(t);
  const sent = [];
  const r = await sendMailOutbox(s, {mail: async row => { sent.push(row.id); return {state: 'accepted', receipt: {}}; }, mode: 'log', now, watch: {approvals: {J4: {approved: true}}}});
  assert.deepEqual(r, {sent: 0, logged: 1, cancelled: 4, failed: 0});
  assert.deepEqual(sent, []);
  const st = states(s);
  assert.equal(st['late-dispatch:J1'], 'logged'); assert.equal(st['late-dispatch:J2'], 'cancelled'); assert.equal(st['late-dispatch:J3'], 'cancelled');
  assert.equal(st['approval-reminder:J4'], 'cancelled'); assert.equal(st['printed-other:J5'], 'cancelled'); assert.equal(st.note, 'pending');
  const why = JSON.parse(s.db.prepare("SELECT receipt FROM outbox WHERE id LIKE '%J2%'").get().receipt).reason;
  assert.match(why, /Already printed/);
});

test('live mode sends what still applies; the backlog can be cleared as a record', async t => {
  const s = setup(t);
  const sent = [];
  await sendMailOutbox(s, {mail: async row => { sent.push(row.entity); return {state: 'accepted', receipt: {}}; }, mode: 'live', now, watch: {}});
  assert.deepEqual(sent.sort(), ['J1', 'J4']);
  const t2 = setup(t);
  assert.equal(clearBacklog(t2, new Date(+now + 1000).toISOString(), 'test'), 5);
  assert.equal(t2.db.prepare("SELECT count(*) n FROM outbox WHERE state='pending'").get().n, 1, 'only the printIQ note stays');
});

test('Mailgun: the right request, accepted on 200, rejected on 4xx, never resent after no answer', async t => {
  const {mailgunSender, message} = await import('../mail-worker.mjs');
  const row = {id: 'indigo-agent:late-dispatch:J1:2026-11-25:rep@x.test', body: JSON.stringify({to: 'rep@x.test', kind: 'production_alert', job: 'J1', subject: 'J1 late', text: 'Body'})};
  let seen;
  const ok = mailgunSender({apiKey: 'key-x', domain: 'mg.sunnyland.com.au', baseUrl: 'https://api.mailgun.net'},
    {fetchImpl: async (url, init) => { seen = {url, init}; return {ok: true, status: 200, json: async () => ({id: '<abc>'})}; }});
  assert.equal((await ok(row)).state, 'accepted');
  assert.equal(seen.url, 'https://api.mailgun.net/v3/mg.sunnyland.com.au/messages');
  assert.equal(seen.init.headers.Authorization, 'Basic ' + Buffer.from('api:key-x').toString('base64'));
  const body = new URLSearchParams(seen.init.body);
  assert.equal(body.get('from'), 'Sunnyland Production <production@sunnyland.com.au>'); assert.equal(body.get('to'), 'rep@x.test');
  assert.match(body.get('text'), /Body\n\nSent by the Sunnyland Production Indigo agent\./);
  const bad = mailgunSender({apiKey: 'k', domain: 'd.au', baseUrl: 'https://api.mailgun.net'}, {fetchImpl: async () => ({ok: false, status: 401})});
  assert.equal((await bad(row)).state, 'rejected');
  const down = mailgunSender({apiKey: 'k', domain: 'd.au', baseUrl: 'https://api.mailgun.net'}, {fetchImpl: async () => { throw new Error('offline'); }});
  assert.equal((await down(row)).state, 'uncertain');
  assert.equal(message({to: 'not an address', kind: 'production_alert', subject: 's', text: 't'}), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core.mjs';
import {planHourly} from '../hourly-indigo.mjs';
import {createServer} from '../server.mjs';

const now = new Date('2026-11-22T22:00:00Z'); // Monday 23 November, 09:00 at the plant
const key = 'k'.repeat(48);
const feed = {schema: 3, asOf: now.toISOString(), generatedAt: now.toISOString(), history: [], jobs: [
  {job: 'J000001', state: 'open', due: '2026-11-26', name: 'Wine list', customer: 'Trentham Estate', printiqId: 1, runs: [{id: 'r1', part: 'Text', stock: 'Silk 150 SRA3', minutes: 45, finishes: 'None', operation: 'o1', operationKey: '11'}]},
  {job: 'J000002', state: 'open', due: '2026-11-26', name: 'Report', printiqId: 2, runs: [{id: 'r2', part: 'Cover', stock: 'Silk 300 SRA3', minutes: null, estimateIssue: 'Check Indigo front and reverse print modes', finishes: 'None', operation: 'o2', operationKey: '12'}]}]};

async function setup(t, linkKey = () => key) {
  const s = new Store(); t.after(() => s.close());
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: true});
  planHourly(s, feed, now);
  const dir = mkdtempSync(join(tmpdir(), 'link-'));
  const server = createServer(s, {mediaDir: dir, allowedPeers: null, boardWatch: () => null, hourlyFeed: () => feed, clock: () => now, linkKey});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });
  return {s, base: `http://127.0.0.1:${server.address().port}/api/printcrm/plan`};
}
const who = {id: 'f3c1d2e4-0000-4000-8000-000000000001', name: 'Paul Cocks', email: 'paul@sunnyland.com.au'};
const headers = (k = key, w = who) => ({'x-printcrm-key': k, 'x-printcrm-user': Buffer.from(JSON.stringify(w)).toString('base64url'), 'content-type': 'application/json'});

test('PrintCRM reads the plan and the Not planned list with the private key, and acts as the named manager', async t => {
  const {s, base} = await setup(t);
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base, {headers: headers('x'.repeat(48))})).status, 403);
  assert.equal((await fetch(base, {headers: headers(key, {id: 'x'})})).status, 400);
  const r = await fetch(base, {headers: headers()});
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.plan.next[0].customer, 'Trentham Estate'); assert.equal(data.plan.next[0].name, 'Wine list');
  assert.deepEqual(data.notPlanned.needs.map(i => i.job), ['J000002']);
  assert.equal(data.days.length, 6);
  const fix = await fetch(base, {method: 'POST', headers: headers(), body: JSON.stringify({action: 'fix', job: 'J000002', id: 'r2', minutes: 40})});
  assert.equal(fix.status, 200);
  const audit = s.db.prepare("SELECT actor,kind FROM audit WHERE kind='notPlanned:fix'").get();
  assert.equal(audit.actor, 'printcrm:' + who.id);
});

test('without the key file the link is refused', async t => {
  const {base} = await setup(t, () => null);
  assert.equal((await fetch(base, {headers: headers()})).status, 503);
});

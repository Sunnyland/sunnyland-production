import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core.mjs';
import {createServer} from '../server.mjs';
import {markNewerVersions} from '../state-sync.mjs';

function fixture() {
  const s = new Store(), dir = mkdtempSync(join(tmpdir(), 'sunnyland-sync-'));
  const m = s.publicUser(s.user('manager@example.test', 'a-long-test-password', 'manager'));
  const r = s.publicUser(s.user('rep@example.test', 'a-long-test-password', 'rep'));
  const o = s.publicUser(s.user('operator@example.test', 'a-long-test-password'));
  for (let i = 0; i < 50; i++) s.put('stock', {id: String(10000 + i), name: 'Paper ' + i});
  let n = 0;
  const act = (type, data, actor = m) => s.action(actor, `k${++n}`, type, data);
  act('job', {id: 'J100', name: 'Test', rep: r.id, active: true, sections: [{id: 'text', name: 'Text', stocks: ['10000']}]});
  const server = createServer(s, {mediaDir: dir, push: null, iq: {jobsConfigured: false}});
  const token = s.login('manager@example.test', 'a-long-test-password').token;
  async function call(url, {headers = {}} = {}) {
    const req = Readable.from([]); req.method = 'GET'; req.url = url; req.socket = {remoteAddress: '127.0.0.1'};
    req.headers = {authorization: 'Bearer ' + token, ...headers};
    return await new Promise(resolve => {
      let status, ht; const chunks = [];
      const res = new Writable({write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); }});
      res.writeHead = (code, h) => { status = code; ht = h; };
      const finish = res.end.bind(res); res.end = b => { if (b !== undefined) chunks.push(Buffer.from(b)); return finish(); };
      res.on('finish', () => {
        const body = Buffer.concat(chunks);
        resolve({status, headers: ht, data: ht['Content-Type'] === 'application/json' ? JSON.parse(body) : body});
      });
      server.emit('request', req, res);
    });
  }
  return {s, m, r, o, act, call, dir};
}

test('full state carries a cursor; a changes-only refresh returns just the changed records', async () => {
  const f = fixture();
  const full = (await f.call('/api/state')).data;
  assert.equal(full.sync.delta, false);
  assert.equal(full.stock.length, 50);
  assert.match(full.sync.cursor, /^[0-9a-f]{8}\.\d+$/);

  const quiet = (await f.call('/api/state?since=' + full.sync.cursor)).data;
  assert.equal(quiet.sync.delta, true);
  assert.equal(quiet.stock.length, 0);
  assert.equal(quiet.jobs.length, 0);
  assert.deepEqual(quiet.sync.visibleIds.jobs, ['J100']);
  assert.equal(quiet.user.id, f.m.id);
  assert.ok(quiet.users.length >= 3);

  f.act('count', {id: 'P1', stock: '10000', owner: 'owned', sheets: 500, opened: false, packaging: 'wrapped', location: 'A1', reason: 'Count'});
  const next = (await f.call('/api/state?since=' + quiet.sync.cursor)).data;
  assert.deepEqual(next.lots.map(l => l.id), ['P1']);
  assert.equal(next.stock.length, 0);
  assert.notEqual(next.sync.cursor, quiet.sync.cursor);
});

test('a cursor from another service start or a malformed cursor gets the full state', async () => {
  const f = fixture();
  for (const since of ['00000000.5', 'nonsense', '']) {
    const state = (await f.call('/api/state?since=' + encodeURIComponent(since))).data;
    assert.equal(state.sync.delta, false, since);
    assert.equal(state.stock.length, 50);
  }
});

test('a new sample version re-sends its family with corrected newer-version flags', async () => {
  const f = fixture();
  f.s.put('media', {id: 'm1', owner: f.o.id});
  const first = f.act('sample', {job: 'J100', media: 'm1', title: 'Fold', note: 'v1'}, f.o);
  const cursor = (await f.call('/api/state')).data.sync.cursor;
  f.act('sample', {job: 'J100', media: 'm1', title: 'Fold', note: 'v2', family: first.family}, f.o);
  const delta = (await f.call('/api/state?since=' + cursor)).data;
  const flags = Object.fromEntries(delta.samples.map(s => [s.version, s.newerVersionExists]));
  assert.deepEqual(flags, {1: true, 2: false});
  assert.equal(delta.sync.visibleIds.samples.length, 2);
});

test('newer-version flags match the original every-pair comparison', () => {
  const samples = [{family: 'a', version: 1}, {family: 'a', version: 3}, {family: 'a', version: 2}, {family: 'b', version: 1}];
  const slow = samples.map(s => samples.some(n => n.family === s.family && n.version > s.version));
  assert.deepEqual(markNewerVersions(samples).map(s => s.newerVersionExists), slow);
});

test('staff media streams in full and honours byte ranges for video seeking', async () => {
  const f = fixture();
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  '), Buffer.alloc(200, 7)]);
  const id = '11111111-2222-4333-8444-555555555555';
  writeFileSync(join(f.dir, id), bytes);
  f.s.put('media', {id, owner: f.m.id, mime: 'video/quicktime', bytes: bytes.length});
  const whole = await f.call('/api/media/' + id);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.data, bytes);
  assert.equal(whole.headers['Accept-Ranges'], 'bytes');
  const part = await f.call('/api/media/' + id, {headers: {range: 'bytes=4-11'}});
  assert.equal(part.status, 206);
  assert.equal(part.data.toString(), 'ftypqt  ');
  assert.equal(part.headers['Content-Range'], `bytes 4-11/${bytes.length}`);
  assert.equal(part.headers['Cache-Control'], 'private, no-store');
});

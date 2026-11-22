import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {boardData, boardFor, boardLinkValid, createBoardLink, queueState, renderBoard, revokeBoardLink} from '../board.mjs';
import {createServer} from '../server.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const now = new Date('2026-11-23T00:30:00Z'); // Monday 23 November, 11:30 at the plant
const day = '2026-11-23';
const run = (job, extra = {}) => ({id: 'r-' + job, job, printiqId: Number(job.slice(1)), name: 'Brochure ' + job, day, press: 'HP Indigo 7900',
  minutes: 40, fixedStart: null, earliestStart: null, part: 'Text', stock: '113gsm Silk SRA3', finishes: 'Fold', due: '2026-11-25', ...extra});
const watch = (extra = {}) => ({schema: 1, generatedAt: new Date(+now - 4 * 60000).toISOString(), approvals: {}, queue: {},
  health: {indigo: {ok: true}, cockpit: {ok: true}}, ...extra});
const byJob = data => Object.fromEntries([...data.current, ...data.next, ...data.done].map(r => [r.job, r.status.key]));

test('the Indigo queue status words map to printing, queued, completed or aborted', () => {
  assert.equal(queueState({status: 'Printing'}), 'printing');
  assert.equal(queueState({status: 'Running'}), 'printing');
  assert.equal(queueState({status: 'Completed'}), 'completed');
  assert.equal(queueState({status: 'Aborted'}), 'aborted');
  assert.equal(queueState({status: 'Held'}), 'queued');
  assert.equal(queueState(null), null);
});

test('each run shows where the job really is, printing first and printed moving to Done today', () => {
  const printed = new Map([
    ['J500', {job: 'J500', state: 'part', printed: 500, needed: 850}],
    ['J600', {job: 'J600', state: 'ready', printed: 870, needed: 850, done: {at: now.toISOString(), section: 'Text · HP Indigo 7900'}}],
    ['J700', {job: 'J700', state: 'confirm', printed: 870, needed: 850}]]);
  const data = boardData({runs: [run('J100'), run('J200'), run('J300'), run('J400'), run('J500'), run('J600'), run('J700'),
    run('J800', {day: '2026-11-24'}), run('J900', {removed: true}), run('J950', {press: 'Ryobi 755'})],
    watch: watch({approvals: {J200: {approved: true}, J300: {approved: true}, J400: {approved: true}},
      queue: {J300: {status: 'Queued', last: now.toISOString()}, J400: {status: 'Printing', last: now.toISOString()},
        J990: {status: 'Running', last: new Date(+now - 2 * 3600000).toISOString()}, J991: {status: 'Running', last: new Date(+now - 65 * 3600000).toISOString()}}}),
    printed, day, now});
  assert.deepEqual(byJob(data), {J100: 'unapproved', J200: 'approved', J300: 'queued', J400: 'printing', J500: 'part', J600: 'printed',
    J700: 'part', J990: 'queued'});
  // Only the newest "Running" entry is printing; an older one is on the press; one from Friday is left off.
  assert.deepEqual(data.current.map(r => r.job), ['J400']);
  assert.equal(data.next.find(r => r.job === 'J990').status.label, 'On the press');
  assert.equal(data.done.map(r => r.job).join(), 'J600');
  assert.equal(data.next.find(r => r.job === 'J500').status.detail, '500 of 850 sheets');
  assert.equal(data.next.find(r => r.job === 'J700').status.confirm, true);
  assert.deepEqual(data.tomorrow.map(r => r.job), ['J800']);
  assert.deepEqual(data.counts, {planned: 7, printed: 1, waitingApproval: 1});
  assert.deepEqual(data.problems, []);
});

test('jobs entered without the J match, and source problems show as a red banner', () => {
  const data = boardData({runs: [run('J064238')], watch: watch({approvals: {J064238: {approved: true}}, generatedAt: new Date(+now - 3600000).toISOString(),
    health: {indigo: {ok: false}, cockpit: {ok: true}}}), printed: new Map(), day, now});
  assert.equal(data.next[0].status.key, 'approved');
  assert.match(data.problems.join(' '), /out of date[\s\S]*connection is down/);
  assert.match(boardData({runs: [], watch: null, printed: new Map(), day, now}).problems[0], /first Indigo watch/);
});

test('the page is plain HTML that refreshes itself and escapes job text', () => {
  const html = renderBoard(boardData({runs: [run('J100', {name: '<script>x</script>'}), run('J400')],
    watch: watch({queue: {J400: {status: 'Printing', last: now.toISOString()}}}), printed: new Map(), day, now}));
  assert.match(html, /<meta http-equiv="refresh" content="60">/);
  assert.match(html, /Indigo · Monday 23 November/);
  assert.match(html, /<h2>Printing now<\/h2>[\s\S]*J400[\s\S]*<h2>Next<\/h2>[\s\S]*J100/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('board links: valid until revoked, wrong keys get nothing', t => {
  const s = new Store(); t.after(() => s.close());
  const key = createBoardLink(s, {label: 'Indigo press'});
  assert.equal(boardLinkValid(s, key), true);
  assert.equal(boardLinkValid(s, key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A')), false);
  assert.equal(boardLinkValid(s, '../../etc'), false);
  assert.equal(revokeBoardLink(s, 'Indigo press'), 1);
  assert.equal(boardLinkValid(s, key), false);
});

test('the server shows the board only on a valid link, with no sign-in', async t => {
  const s = new Store(); t.after(() => s.close());
  s.put('printPlanRun', run('J100', {day: '2026-11-23'}));
  const key = createBoardLink(s, {label: 'Indigo press'});
  const dir = mkdtempSync(join(tmpdir(), 'sunnyland-board-'));
  const server = createServer(s, {mediaDir: dir, allowedPeers: null, boardWatch: () => watch(), clock: () => now});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await fetch(`${base}/board/${key}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/html/);
  assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await ok.text(), /J100/);
  const week = await fetch(`${base}/board/${key}/week`);
  assert.equal(week.status, 200);
  assert.match(await week.text(), /Indigo week/);
  assert.equal((await fetch(`${base}/board/${'x'.repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/board/`)).status, 404);
});

test('boardFor reads the stored plan and printed records', t => {
  const s = new Store(); t.after(() => s.close());
  s.put('printPlanRun', run('J100', {day: '2026-11-23'}));
  s.put('indigoPrinted', {id: 'J100', job: 'J100', state: 'part', printed: 200, needed: 850});
  assert.equal(boardFor(s, {watch: watch(), now}).next[0].status.label, 'Part printed');
});

test('today rolls forward: missed runs start from now, printing runs from when sent, printed runs take no time', () => {
  const at = new Date('2026-11-22T22:14:00Z'); // 09:14 at the plant
  const w = watch({generatedAt: at.toISOString(), queue: {J200: {status: 'Running', last: new Date(+at - 20 * 60000).toISOString()}}});
  const printed = new Map([['J300', {job: 'J300', state: 'ready', printed: 500, needed: 500, done: {at: at.toISOString()}}]]);
  const data = boardData({runs: [run('J100', {earliestStart: 465}), run('J200', {minutes: 60}), run('J300'), run('J400', {fixedStart: 480}),
    run('J500', {minutes: 400})], watch: w, printed, day, now: at});
  const start = Object.fromEntries([...data.current, ...data.next].map(r => [r.job, r.start]));
  assert.equal(start.J200, 9 * 60 - 6); // sent 08:54
  assert.ok(start.J100 >= 9 * 60 + 54 && start.J400 >= 9 * 60 + 54, 'missed runs start after the printing job ends');
  assert.equal(data.done.map(r => r.job).join(), 'J300');
  const j500 = data.next.find(r => r.job === 'J500');
  assert.equal(j500.start, null); assert.match(j500.status.detail, /Won’t fit today/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {applyPrinted, assessPrinted, decidePrinted, printedDashboard, separationSides} from '../indigo-printed.mjs';
import {PrintIQFinish, plantStamp} from '../printiq-finish.mjs';
import {drain} from '../worker.mjs';

const now = new Date('2026-11-23T01:00:00Z'); // Monday 23 November, 12:00 at the plant
const ryobi = {sectionKey: 901, quotedSectionKey: 11, operationKey: 5001, pressKey: 51, press: 'Ryobi W/T', name: '113gsm Silk Art printed CMYK x 2 sides'};
const indigo = {sectionKey: 902, quotedSectionKey: 12, operationKey: 5002, pressKey: 64, press: 'HP Indigo 7900', name: 'Cover 300gsm'};
const imposed = (up = 2, sides = 2) => ({up, sheetsPerSet: 1, sides, imposed: true, media: '113gsm Sovereign Silk WHITE LG'});
const entry = (id, part, sheets, extra = {}) => ({queueEntryId: id.padEnd(32, '0'), part, submitted: '2026-11-22T22:45:41+00:00', fromCockpit: true,
  ticket: {sheets: {'113gsm Sovereign Silk WHITE LG': sheets}, separations: {Cyan: sheets * 2, Magenta: sheets * 2 + 13, Yellow: sheets * 2 - 2, Black: sheets * 2}, requested: 1},
  imposition: imposed(), impositionState: 'found', ...extra});
const proof = id => entry(id, 'PP0.D', 1, {imposition: {up: null, imposed: false, sides: 2}, ticket: {sheets: {'100 Offset': 1}, separations: {Black: 2}}});
const job = (sections, entries, extra = {}) => ({job: 'J064238', printiq: {printiqJobNo: 'J064238', quantity: 1700, status: 'In Production', sections, readAt: now.toISOString()}, entries, ...extra});
const snapshot = jobs => ({schema: 1, generatedAt: new Date(+now - 5 * 60000).toISOString(), health: {}, jobs});

function setup(t, mode = 'dryRun') {
  const s = new Store(); t.after(() => s.close());
  const manager = s.publicUser(s.user('manager@sunnyland.test', 'a-long-test-password', 'manager', 'Pat Manager'));
  const operator = s.publicUser(s.user('op@sunnyland.test', 'a-long-test-password', 'operator'));
  s.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?)').run('11111111-1111-4111-8111-111111111111', 'ab'.repeat(32), manager.id, 'binding-1');
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: false, revision: 1, printedMode: mode});
  return {s, manager, operator};
}
const outbox = (s, channel) => s.db.prepare('SELECT * FROM outbox WHERE channel=? ORDER BY id').all(channel);
const mailKeys = s => outbox(s, 'mail').map(r => r.id.split(':')[1]);

test('colour separations are counted once per printed side', () => {
  assert.deepEqual(separationSides(870, {C: 1739, M: 1753, Y: 1738, K: 1739}), {ok: true, sides: 2});
  assert.deepEqual(separationSides(500, {C: 500, M: 500, Y: 500, K: 1000}), {ok: true, sides: 2}); // CMYK front, black back
  assert.deepEqual(separationSides(500, {C: 500, M: 500, Y: 500, K: 500}), {ok: true, sides: 1});
  assert.equal(separationSides(870, {C: 4325}).ok, false);
  assert.deepEqual(separationSides(1, {K: 2}), {ok: true, sides: null});
});

test('J064238: Indigo ran 870 sheets of an 850-sheet job routed to the Ryobi, so production must confirm', () => {
  const a = assessPrinted(job([ryobi], [proof('e01f'), entry('82f3', 'IP0.D', 870)]));
  assert.equal(a.state, 'confirm');
  assert.equal(a.needed, 850); assert.equal(a.printed, 870);
  assert.deepEqual(a.proofs.map(e => e.part), ['PP0.D']);
  assert.match(a.reasons.join(' '), /no Indigo section for this job \(it is routed to Ryobi W\/T\)/);
});

test('an Indigo section with everything in agreement is ready; batches add up and overs are fine', () => {
  const two = job([ryobi, indigo], [proof('a'), entry('b', 'IP0.D', 500), entry('c', 'IP0.D', 360)]);
  const a = assessPrinted(two);
  assert.equal(a.state, 'ready'); assert.equal(a.printed, 860); assert.equal(a.target, '5002');
  // Short of the sheets needed: part printed, nothing asked yet.
  assert.equal(assessPrinted(job([indigo], [entry('b', 'IP0.D', 500)])).state, 'part');
  // Only small runs: proofs.
  assert.equal(assessPrinted(job([indigo], [proof('a'), entry('b', 'IP0.D', 3)])).state, 'proofs');
  // Closed in printIQ: nothing to do.
  assert.equal(assessPrinted({...job([indigo], [entry('b', 'IP0.D', 900)]), printiq: {...job([indigo], []).printiq, status: 'Complete'}}).state, 'closed');
});

test('problems that need a person: no imposition, mixed impositions, colour counts, several Indigo sections', () => {
  const missing = assessPrinted(job([indigo], [entry('b', 'IP0.D', 900, {imposition: null, impositionState: 'missing'})]));
  assert.equal(missing.state, 'confirm'); assert.match(missing.reasons[0], /No Prinect Cockpit imposition/);
  assert.equal(assessPrinted(job([indigo], [entry('b', 'IP0.D', 900, {imposition: null, impositionState: 'looking'})])).state, 'waiting');
  const mixed = assessPrinted(job([indigo], [entry('b', 'IP0.D', 900), entry('c', 'IP1.D', 900, {imposition: imposed(4)})]));
  assert.match(mixed.reasons[0], /different impositions \(2-up and 4-up\)/);
  const colours = assessPrinted(job([indigo], [entry('b', 'IP0.D', 900, {ticket: {sheets: {x: 900}, separations: {C: 4325}}})]));
  assert.equal(colours.state, 'confirm'); assert.match(colours.reasons[0], /colour counts/);
  const oneSided = assessPrinted(job([indigo], [entry('b', 'IP0.D', 900, {ticket: {sheets: {x: 900}, separations: {C: 900, K: 900}}})]));
  assert.match(oneSided.reasons[0], /printed one side but the imposition is two-sided/);
  const several = assessPrinted(job([indigo, {...indigo, operationKey: 5003, sectionKey: 903}], [entry('b', 'IP0.D', 900)]));
  assert.match(several.reasons[0], /more than one Indigo section/);
});

test('dry run records what would be written and writes nothing to printIQ', t => {
  const {s} = setup(t, 'dryRun');
  applyPrinted(s, {snapshot: snapshot([job([indigo], [proof('a'), entry('b', 'IP0.D', 900)])]), now});
  const r = s.get('indigoPrinted', 'J064238');
  assert.equal(r.done.mode, 'dryRun'); assert.equal(r.done.operationKey, '5002');
  assert.match(r.done.note.join('\n'), /Indigo printed: 900 sheets in 1 batch[\s\S]*Sheets needed: 850 \(1,700 at 2-up[\s\S]*Proofs not counted: PP0.D 1 sheet[\s\S]*Checked automatically/);
  assert.equal(outbox(s, 'printiq').length + outbox(s, 'printiq_finish').length, 0);
  assert.equal(printedDashboard(s, now).recent.length, 1);
});

test('live: the note and the Printing-operation finish are queued once, and the other section is chased', t => {
  const {s} = setup(t, 'live');
  const snap = snapshot([job([ryobi, indigo], [entry('b', 'IP0.D', 900)])]);
  applyPrinted(s, {snapshot: snap, now});
  applyPrinted(s, {snapshot: snap, now: new Date(+now + 60000)});
  const finish = outbox(s, 'printiq_finish');
  assert.equal(finish.length, 1); assert.equal(outbox(s, 'printiq').length, 1);
  assert.deepEqual(JSON.parse(finish[0].body), {kind: 'printing_finish', job: 'J064238', printiqJobNo: 'J064238', sectionKey: 902, operationKey: 5002, operator: 'Paul', at: now.toISOString()});
  assert.equal(JSON.parse(outbox(s, 'printiq')[0].body).kind, 'indigo_printed');
  assert.deepEqual(mailKeys(s), ['printed-other']);
  assert.match(JSON.parse(outbox(s, 'mail')[0].body).subject, /HP Indigo 7900 section printed, Ryobi W\/T still to print/);
});

test('a Ryobi section finished in the app chases the Indigo part', t => {
  const {s, operator} = setup(t, 'dryRun');
  s.put('operation', {id: 'op1', job: 'J064500', section: 'text', printiqOperationKey: 7001, state: 'completed', updatedAt: new Date(+now - 3600000).toISOString(), actor: operator.id});
  const facts = {operations: [{job: 'J064500', operationKey: '7001', section: 'Text', press: 'Ryobi W/T'}, {job: 'J064500', operationKey: '7002', section: 'Cover', press: 'HP Indigo 7900'}]};
  applyPrinted(s, {snapshot: snapshot([]), now, facts});
  applyPrinted(s, {snapshot: snapshot([]), now, facts});
  assert.equal(outbox(s, 'mail').length, 1);
  assert.match(JSON.parse(outbox(s, 'mail')[0].body).text, /Text · Ryobi W\/T section was finished[\s\S]*Still to print:\n  Cover · HP Indigo 7900/);
});

test('needs confirming: managers are emailed and pushed once; they choose printed, proof or not this job', t => {
  const {s, manager, operator} = setup(t, 'live');
  const snap = snapshot([job([ryobi], [proof('e01f'), entry('82f3', 'IP0.D', 870)])]);
  applyPrinted(s, {snapshot: snap, now});
  applyPrinted(s, {snapshot: snap, now: new Date(+now + 60000)});
  assert.deepEqual(mailKeys(s), ['printed-confirm']);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM production_alerts').get().n, 1);
  assert.match(JSON.parse(outbox(s, 'mail')[0].body).text, /Indigo printed 870 sheets in 1 batch \(850 needed\)[\s\S]*Needs confirming/);
  const r = printedDashboard(s, now).confirm[0];
  assert.equal(r.job, 'J064238');
  assert.throws(() => decidePrinted(s, operator, {job: 'J064238', revision: r.revision, choice: 'printed', operationKey: '5001'}), /manager/);
  assert.throws(() => decidePrinted(s, manager, {job: 'J064238', revision: r.revision + 1, choice: 'printed', operationKey: '5001'}), /changed/);
  assert.throws(() => decidePrinted(s, manager, {job: 'J064238', revision: r.revision, choice: 'printed', operationKey: '9'}), /Choose the printIQ section/);
  const done = decidePrinted(s, manager, {job: 'J064238', revision: r.revision, choice: 'printed', operationKey: '5001'});
  assert.equal(done.done.byName, 'Pat Manager');
  assert.match(done.done.note.join('\n'), /Section finished: .*Ryobi W\/T \(printed on the Indigo instead\)[\s\S]*Confirmed by Pat Manager/);
  assert.equal(JSON.parse(outbox(s, 'printiq_finish')[0].body).operationKey, 5001);
  assert.throws(() => decidePrinted(s, manager, {job: 'J064238', revision: done.revision, choice: 'proof'}), /already been recorded/);
  applyPrinted(s, {snapshot: snap, now: new Date(+now + 120000)});
  assert.equal(outbox(s, 'printiq_finish').length, 1);
});

test('marked as a proof or not this job: the batches stop counting', t => {
  const {s, manager} = setup(t, 'live');
  const snap = snapshot([job([ryobi], [entry('82f3', 'IP0.D', 870)])]);
  applyPrinted(s, {snapshot: snap, now});
  let r = s.get('indigoPrinted', 'J064238');
  decidePrinted(s, manager, {job: 'J064238', revision: r.revision, choice: 'proof'});
  applyPrinted(s, {snapshot: snap, now: new Date(+now + 60000)});
  assert.equal(s.get('indigoPrinted', 'J064238').state, 'proofs');
  // A new production batch later is assessed again.
  const later = snapshot([job([ryobi], [entry('82f3', 'IP0.D', 870), entry('9999', 'IP0.D', 900)])]);
  applyPrinted(s, {snapshot: later, now: new Date(+now + 120000)});
  r = s.get('indigoPrinted', 'J064238');
  assert.equal(r.state, 'confirm'); assert.equal(r.printed, 900);
  decidePrinted(s, manager, {job: 'J064238', revision: r.revision, choice: 'notThisJob'});
  applyPrinted(s, {snapshot: later, now: new Date(+now + 180000)});
  assert.equal(s.get('indigoPrinted', 'J064238').state, 'waiting');
  assert.equal(outbox(s, 'printiq_finish').length, 0);
});

test('a stale snapshot or mode off changes nothing', t => {
  const {s} = setup(t, 'off');
  const snap = snapshot([job([indigo], [entry('b', 'IP0.D', 900)])]);
  applyPrinted(s, {snapshot: snap, now});
  assert.equal(s.get('indigoPrinted', 'J064238'), null);
  s.put('indigoPlannerConfig', {id: 'indigo', revision: 2, printedMode: 'live'});
  applyPrinted(s, {snapshot: {...snap, generatedAt: new Date(+now - 3600000).toISOString()}, now});
  assert.equal(s.get('indigoPrinted', 'J064238'), null);
  assert.equal(s.get('indigoPrintedStatus', 'latest').stale, true);
});

const event = {kind: 'printing_finish', job: 'J064238', printiqJobNo: 'J064238', sectionKey: 901, operationKey: 5001, operator: 'Paul', at: now.toISOString()};
const finisher = fetcher => new PrintIQFinish({base: 'https://sunnyland.printiq.com', appName: 'Sunnyland', appKey: 'k&1', enabled: true, fetcher});
const soap = result => async () => ({ok: true, status: 200, text: async () => `<soap:Envelope><soap:Body><RunTimingEventResponse xmlns="http://iq.co.nz/"><RunTimingEventResult>${result}</RunTimingEventResult></RunTimingEventResponse></soap:Body></soap:Envelope>`});

test('RunTimingEvent: one SOAP 1.2 call that finishes the operation without adding press time', async () => {
  let sent;
  const f = finisher(async (url, init) => { sent = {url, init}; return soap('SUCCESS')(); });
  assert.equal(plantStamp(now.toISOString()), '2026-11-23T12:00:00');
  const r = await f.deliver({body: JSON.stringify(event)});
  assert.equal(r.state, 'accepted');
  assert.equal(sent.url, 'https://sunnyland.printiq.com/WebService/ProductionIntegration.asmx');
  assert.equal(sent.init.headers['Content-Type'], 'application/soap+xml; charset=utf-8');
  for (const part of ['<RunTimingEvent xmlns="http://iq.co.nz/">', '<AppKey>k&amp;1</AppKey>', '<JobNo>J064238</JobNo>', '<SectionKey>901</SectionKey>',
    '<OperationKey>5001</OperationKey>', '<OperatorUserName>Paul</OperatorUserName>', '<StartDate>2026-11-23T12:00:00</StartDate>',
    '<EndDate>2026-11-23T12:00:00</EndDate>', '<Duration>0</Duration>', '<TimeZoneId>AUS Eastern Standard Time</TimeZoneId>', '<Finish>true</Finish>'])
    assert.ok(sent.init.body.includes(part), part);
  assert.equal((await finisher(soap('FAIL_OPKEY')).deliver({body: JSON.stringify(event)})).state, 'rejected');
  assert.equal((await finisher(async () => { throw Object.assign(new Error('x'), {name: 'TimeoutError'}); }).deliver({body: JSON.stringify(event)})).state, 'uncertain');
  assert.equal((await finisher(async () => ({ok: false, status: 500, text: async () => 'fault'})).deliver({body: JSON.stringify(event)})).state, 'uncertain');
  assert.equal((await finisher(soap('SUCCESS')).deliver({body: JSON.stringify({...event, operationKey: 0})})).state, 'rejected');
});

test('the worker leaves finishes pending while they are switched off, and never sends one twice', async t => {
  const {s} = setup(t, 'live');
  s.queue('printiq_finish', 'J064238', event, 'indigo-printed:finish:J064238:5001');
  let calls = 0;
  const off = new PrintIQFinish({enabled: false});
  await drain(s, {iq: {deliver: async () => ({state: 'accepted', receipt: {}})}, mail: async () => ({state: 'accepted', receipt: {}}), finish: off});
  assert.equal(outbox(s, 'printiq_finish')[0].state, 'pending');
  const on = finisher(async () => { calls++; return soap('SUCCESS')(); });
  await drain(s, {mail: async () => ({state: 'accepted', receipt: {}}), finish: on});
  await drain(s, {mail: async () => ({state: 'accepted', receipt: {}}), finish: on});
  assert.equal(calls, 1);
  assert.equal(outbox(s, 'printiq_finish')[0].state, 'accepted');
  s.queue('printiq_finish', 'J064238', event, 'indigo-printed:finish:J064238:5001');
  assert.equal(outbox(s, 'printiq_finish').length, 1);
});

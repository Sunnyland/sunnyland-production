import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core.mjs';
import {createBoardLink} from '../board.mjs';
import {createServer} from '../server.mjs';
import {qrMatrix} from '../qr.mjs';
import {boardCode, instant, pressOperator, setDay, setHours, setPin, shiftAction, shiftState, shiftTick, shiftsOn, signInWithCode, signInWithPin} from '../shifts.mjs';
import {parseDays} from '../staff-shifts.mjs';
import {applyPrinted} from '../indigo-printed.mjs';

const at = (hh, mm = 0, day = '2026-11-23') => instant(day, hh * 60 + mm); // Monday 23 November, plant time
function setup(t) {
  const s = new Store(); t.after(() => s.close());
  const user = (email, role, name) => s.publicUser(s.user(email, 'a-long-test-password', role, name));
  const manager = user('paul@sunnyland.test', 'manager', 'Paul Cocks');
  const sadhir = user('sadhir@sunnyland.test', 'operator', 'Sadhir');
  const jacob = user('jacob@sunnyland.test', 'operator', 'Jacob');
  const device = (u, n) => s.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?)').run(`1111111${n}-1111-4111-8111-111111111111`, String(n).repeat(64), u.id, 'binding-' + n);
  device(manager, 1); device(sadhir, 2); device(jacob, 3);
  const week = span => Object.fromEntries(parseDays('mon-fri').map(d => [d, span]));
  setHours(s, manager, 'Sadhir', week('07:00-15:00'), {printiqUser: 'sadhir'});
  setHours(s, manager, 'jacob@sunnyland.test', week('15:00-17:00'));
  return {s, manager, sadhir, jacob};
}
const alerts = s => s.db.prepare('SELECT id,actor,title,body FROM production_alerts ORDER BY rowid').all();

test('instant() turns plant time into the right moment, daylight saving included', () => {
  assert.equal(at(15).toISOString(), '2026-11-23T04:00:00.000Z');
  assert.equal(instant('2026-07-06', 7 * 60).toISOString(), '2026-07-05T21:00:00.000Z');
});

test('the QR code is a valid size and grows with the text', () => {
  assert.equal(qrMatrix('SLP-PRESS:123456').length, 25);
  assert.equal(qrMatrix('x'.repeat(100)).length, 41);
  assert.throws(() => qrMatrix('x'.repeat(200)), /Too long/);
});

test('weekly hours, a day off and public holidays', t => {
  const {s, manager} = setup(t);
  assert.deepEqual(shiftsOn(s, '2026-11-23').map(x => [x.name, x.start, x.end]), [['Sadhir', 420, 900], ['Jacob', 900, 1020]]);
  assert.deepEqual(shiftsOn(s, '2026-11-28'), []); // Saturday
  assert.deepEqual(shiftsOn(s, '2026-12-25'), []); // Christmas Day
  setDay(s, manager, 'Jacob', {day: '2026-11-24', off: true});
  setDay(s, manager, 'Sadhir', {day: '2026-11-24', hours: '07:00-17:00'});
  assert.deepEqual(shiftsOn(s, '2026-11-24').map(x => [x.name, x.end]), [['Sadhir', 1020]]);
  setDay(s, manager, 'Jacob', {day: '2026-11-28', hours: '08:00-12:00'});
  assert.deepEqual(shiftsOn(s, '2026-11-28').map(x => x.name), ['Jacob']);
  setHours(s, manager, 'Jacob', {sat: '08:00-12:00'}, {merge: true});
  assert.deepEqual(Object.keys(s.get('staffShift', s.all('user').find(u => u.name === 'Jacob').id).week), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.throws(() => setHours(s, s.publicUser(s.all('user').find(u => u.name === 'Jacob')), 'Jacob', {mon: '07:00-15:00'}), /manager/);
  assert.throws(() => setDay(s, manager, 'Jacob', {day: '2026-11-24', hours: '15:00-07:00'}), /end after/);
});

test('a PIN signs in until the end of the shift; wrong PINs lock the screen for 15 minutes', t => {
  const {s, manager, sadhir} = setup(t);
  setPin(s, sadhir, sadhir.id, '4826');
  assert.throws(() => setPin(s, manager, 'Jacob', '4826'), /different PIN/);
  assert.throws(() => setPin(s, manager, 'Jacob', '1111'), /simple/);
  assert.throws(() => setPin(s, sadhir, 'Jacob', '5937'), /manager/);
  const signed = signInWithPin(s, 'screen-key', '4826', at(6, 45));
  assert.equal(signed.name, 'Sadhir'); assert.equal(signed.until, at(15).toISOString());
  assert.equal(pressOperator(s, at(14, 59)).printiqUser, 'sadhir');
  assert.equal(pressOperator(s, at(15)), null);
  for (let i = 0; i < 5; i++) assert.throws(() => signInWithPin(s, 'screen-key', '9999', at(8)), /didn’t match/);
  assert.throws(() => signInWithPin(s, 'screen-key', '4826', at(8, 1)), /15 minutes/);
  assert.equal(signInWithPin(s, 'other-screen', '4826', at(8, 1)).name, 'Sadhir');
  assert.equal(signInWithPin(s, 'screen-key', '4826', at(8, 20)).name, 'Sadhir');
});

test('the board code signs in from the app, changes after use and every 10 minutes', t => {
  const {s, jacob, sadhir} = setup(t);
  const code = boardCode(s, at(14, 50)).code;
  assert.equal(boardCode(s, at(14, 55)).code, code);
  assert.throws(() => signInWithCode(s, jacob, '000000' === code ? '000001' : '000000', at(14, 55)), /not on the press screen/);
  const signed = signInWithCode(s, jacob, 'SLP-PRESS:' + code, at(14, 55));
  assert.equal(signed.until, at(17).toISOString(), 'Jacob signing in 5 minutes early runs to the end of his shift');
  assert.notEqual(boardCode(s, at(14, 55)).code, code);
  assert.throws(() => signInWithCode(s, sadhir, code, at(14, 56)), /not on the press screen/);
  const later = boardCode(s, at(15, 30)).code;
  assert.ok(Date.parse(s.get('pressCode', 'HP Indigo 7900').issuedAt) === +at(15, 30) || later);
  assert.throws(() => shiftAction(s, sadhir, {action: 'signOut'}, at(15, 31)), /operator or a manager/);
  assert.deepEqual(shiftAction(s, jacob, {action: 'signOut'}, at(15, 31)), {press: 'HP Indigo 7900', signedIn: null});
});

test('notifications: shift ending, handover, shift started, nobody signed in, printing with nobody signed in', t => {
  const {s, manager, sadhir, jacob} = setup(t);
  setPin(s, manager, 'Sadhir', '4826');
  signInWithPin(s, 'k', '4826', at(6, 55));
  assert.deepEqual(shiftTick(s, {now: at(7, 0)}).alerts, []);
  shiftTick(s, {now: at(14, 45)}); shiftTick(s, {now: at(14, 50)});
  let list = alerts(s);
  assert.equal(list.length, 1); assert.equal(list[0].actor, sadhir.id);
  assert.equal(list[0].title, 'Your shift ends at 3pm'); assert.match(list[0].body, /signs you out at 3pm\. Hand over to Jacob\./);
  assert.equal(shiftState(s, at(14, 50)).warning.next.name, 'Jacob');
  const tick = shiftTick(s, {now: at(15, 0)});
  assert.deepEqual(tick.ended, [sadhir.id]);
  assert.equal(pressOperator(s, at(15, 0)), null);
  list = alerts(s);
  assert.equal(list.at(-1).actor, jacob.id); assert.equal(list.at(-1).title, 'Your shift has started');
  shiftTick(s, {now: at(15, 15)}); shiftTick(s, {now: at(15, 20)});
  const nobody = alerts(s).filter(a => a.title === 'Nobody is signed in at the Indigo');
  assert.equal(nobody.length, 1); assert.equal(nobody[0].actor, manager.id); assert.match(nobody[0].body, /Jacob was due at 3pm/);
  shiftTick(s, {now: at(17, 30), printing: true}); shiftTick(s, {now: at(17, 40), printing: true}); shiftTick(s, {now: at(18, 5), printing: true});
  assert.equal(alerts(s).filter(a => a.title.startsWith('The Indigo is printing')).length, 2);
});

test('the printIQ finish uses the operator signed in at the press', t => {
  const {s, manager} = setup(t);
  s.put('indigoPlannerConfig', {id: 'indigo', enabled: false, revision: 1, printedMode: 'live'});
  setPin(s, manager, 'Sadhir', '4826');
  const now = at(12);
  signInWithPin(s, 'k', '4826', at(7));
  const indigo = {sectionKey: 902, quotedSectionKey: 12, operationKey: 5002, pressKey: 64, press: 'HP Indigo 7900', name: 'Cover 300gsm'};
  const entry = {queueEntryId: 'b'.padEnd(32, '0'), part: 'IP0.D', submitted: '2026-11-22T22:45:41+00:00', fromCockpit: true,
    ticket: {sheets: {'113gsm': 900}, separations: {Cyan: 1800, Magenta: 1800, Yellow: 1800, Black: 1800}, requested: 1},
    imposition: {up: 2, sheetsPerSet: 1, sides: 2, imposed: true, media: '113gsm'}, impositionState: 'found'};
  applyPrinted(s, {now, snapshot: {schema: 1, generatedAt: now.toISOString(), health: {}, jobs: [{job: 'J064238',
    printiq: {printiqJobNo: 'J064238', quantity: 1700, status: 'In Production', sections: [indigo], readAt: now.toISOString()}, entries: [entry]}]}});
  const finish = s.db.prepare("SELECT body FROM outbox WHERE channel='printiq_finish'").all();
  assert.equal(finish.length, 1); assert.equal(JSON.parse(finish[0].body).operator, 'sadhir');
  const note = JSON.parse(s.db.prepare("SELECT body FROM outbox WHERE channel='printiq'").get().body);
  assert.ok(note.lines.includes('Operator at the press: Sadhir'));
});

test('board: sign-in panel with code and QR, PIN pad, sign out; app sign-in with the code', async t => {
  const {s, jacob} = setup(t);
  setPin(s, jacob, jacob.id, '5937');
  const key = createBoardLink(s, {label: 'Indigo press'});
  let now = at(15, 5);
  const dir = mkdtempSync(join(tmpdir(), 'shifts-'));
  const server = createServer(s, {mediaDir: dir, allowedPeers: null, boardWatch: () => null, clock: () => now});
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.close(); rmSync(dir, {recursive: true, force: true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let page = await (await fetch(`${base}/board/${key}`)).text();
  const code = s.get('pressCode', 'HP Indigo 7900').code;
  assert.match(page, /Nobody is signed in at the press/);
  assert.ok(page.includes(`${code.slice(0, 3)} ${code.slice(3)}`)); assert.match(page, /<svg[^>]+Sign-in QR code/);
  assert.match(page, /On shift now: Jacob \(3pm–5pm\)/); assert.match(page, /content="15"/);
  assert.ok(page.includes(`href="${key}/pin"`));
  const post = (path, body) => fetch(`${base}/board/${key}/${path}`, {method: 'POST', redirect: 'manual', body: new URLSearchParams(body),
    headers: {origin: 'https://printcrm.sunnyland.com.au'}});
  let r = await post('pin', {d: '593', k: '7'});
  assert.equal(r.status, 200); assert.match(await r.text(), /value="5937"/);
  r = await post('pin', {d: '5936', k: 'enter'});
  assert.equal(r.status, 401); assert.match(await r.text(), /didn’t match/);
  r = await post('pin', {d: '5937', k: 'enter'});
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '../' + key);
  page = await (await fetch(`${base}/board/${key}`)).text();
  assert.match(page, /Operator <b>Jacob<\/b> · signed in until 5:00pm/); assert.match(page, /content="60"/);
  now = at(16, 50);
  page = await (await fetch(`${base}/board/${key}`)).text();
  assert.match(page, /Jacob is signed out at 5pm\./); assert.match(page, /content="30"/);
  r = await post('sign-out', {});
  assert.equal(r.status, 303); assert.equal(pressOperator(s, now), null);
  // From the app: the code on the screen.
  const {token} = s.login('jacob@sunnyland.test', 'a-long-test-password');
  const fresh = boardCode(s, now).code;
  r = await fetch(`${base}/api/action?shifts=1`, {method: 'POST', headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
    body: JSON.stringify({action: 'signIn', code: 'SLP-PRESS:' + fresh})});
  assert.equal(r.status, 200); assert.equal((await r.json()).name, 'Jacob');
  const overview = await (await fetch(`${base}/api/shifts`, {headers: {authorization: 'Bearer ' + token}})).json();
  assert.equal(overview.operator.name, 'Jacob'); assert.deepEqual(overview.today.map(x => x.from), ['7am', '3pm']);
  assert.equal((await fetch(`${base}/board/${key}/sign-out`)).status, 404);
});

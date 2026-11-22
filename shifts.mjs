// Staff shifts and press sign-in.
//   staffShift      - normal weekly hours per person (Mon-Sat), plus their printIQ user name for finishes
//   staffShiftDay   - a change for one day (different hours, or off)
//   pressPin        - each operator's own PIN for the board screen (hash only)
//   pressSignIn     - who is running the press now, and until when (the end of their shift)
//   pressCode       - the 6-digit code shown on the board while nobody is signed in (changes every 10 minutes and after use)
// Sign-in: scan the board's QR code with the app, type the code in the app, or type a PIN on the board.
// Sign-out: at the end of the operator's shift (handover), when the next operator signs in, or by hand.
// Notifications (iPhone, through the production alert queue): 15 minutes before a shift ends; at shift start if
// not signed in; managers when nobody has signed in 15 minutes into a shift, or the press prints with nobody signed in.
import {createHash, randomBytes, randomInt, scryptSync, timingSafeEqual} from 'node:crypto';
import {need, str} from './core.mjs';
import {finishDay, isPlantWorkday, validDay} from './job-visibility.mjs';
import {plantMinute} from './print-planning.mjs';
import {prepareProductionAlerts} from './indigo-watch.mjs';

export const press = 'HP Indigo 7900';
export const qrPrefix = 'SLP-PRESS:';
const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const warnMinutes = 15, lateMinutes = 15, codeMinutes = 10, earlyMinutes = 30, offShiftMinutes = 120;
const hash = v => createHash('sha256').update(v).digest('hex');

const toMinute = value => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  need(m && +m[1] < 24 && +m[2] < 60, 'Use times like 07:00 or 15:30.');
  return +m[1] * 60 + +m[2];
};
export const clockLabel = minute => {
  const h = Math.floor(minute / 60), m = minute % 60, h12 = h % 12 || 12;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
};
const span = text => {
  const [a, b] = String(text).split('-');
  const start = toMinute(a), end = toMinute(b);
  need(end > start, 'A shift has to end after it starts.');
  return {start, end};
};
const weekdayOf = day => new Date(day + 'T00:00:00Z').getUTCDay();
/// Plant day and minute for an instant.
export const localNow = now => ({day: finishDay(now.toISOString()), minute: plantMinuteExact(now)});
function plantMinuteExact(now) {
  const m = plantMinute(now);
  return now.getSeconds() !== 0 ? m - 1 : m;
}
/// The instant for a plant day and minute (Melbourne, daylight saving aware).
export function instant(day, minute) {
  const guess = new Date(`${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00Z`);
  for (const offset of [11, 10]) {
    const at = new Date(+guess - offset * 3600000);
    if (localNow(at).day === day && localNow(at).minute === minute) return at;
  }
  return new Date(+guess - 10 * 3600000);
}

const userFor = (store, who) => {
  const users = store.all('user').filter(u => u.enabled);
  const text = String(who ?? '').trim().toLowerCase();
  const found = users.filter(u => u.id === who || u.email === text || u.name.toLowerCase() === text || u.name.toLowerCase().split(/\s+/)[0] === text);
  need(found.length === 1, found.length ? `More than one person matches "${who}".` : `No staff account matches "${who}".`, found.length ? 409 : 404);
  return found[0];
};

/// Hours for each person on a day: weekly hours, then that day's change. Public holidays have no shifts.
export function shiftsOn(store, day) {
  const wd = days[weekdayOf(day)];
  const result = [];
  for (const s of store.all('staffShift')) {
    const user = store.get('user', s.user);
    if (!user?.enabled) continue;
    const change = store.get('staffShiftDay', `${s.user}:${day}`);
    const hours = change ? (change.off ? null : {start: change.start, end: change.end}) : (isPlantWorkday(day) || wd === 'sat' ? s.week?.[wd] : null);
    if (hours) result.push({user: s.user, name: user.name, start: hours.start, end: hours.end, printiqUser: s.printiqUser ?? null, changed: Boolean(change)});
  }
  for (const c of store.all('staffShiftDay').filter(c => c.day === day && !c.off && !result.some(r => r.user === c.user))) {
    const user = store.get('user', c.user);
    if (user?.enabled) result.push({user: c.user, name: user.name, start: c.start, end: c.end, printiqUser: store.get('staffShift', c.user)?.printiqUser ?? null, changed: true});
  }
  return result.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}

/// Who is signed in at the press now (null once their time is up).
export function pressOperator(store, now = new Date()) {
  const s = store.get('pressSignIn', press);
  if (!s || s.endedAt || Date.parse(s.until) <= +now) return null;
  const user = store.get('user', s.user);
  if (!user?.enabled) return null;
  return {...s, printiqUser: store.get('staffShift', s.user)?.printiqUser ?? null};
}

/// Where the shift day stands: who is on, who is next, and whether the handover warning is showing.
export function shiftState(store, now = new Date()) {
  const {day, minute} = localNow(now);
  const shifts = shiftsOn(store, day), operator = pressOperator(store, now);
  const onNow = shifts.filter(s => s.start <= minute && minute < s.end);
  const next = shifts.find(s => s.start > minute && (!operator || s.user !== operator.user)) ?? null;
  const mine = operator && shifts.find(s => s.user === operator.user && s.start - earlyMinutes <= minute && minute < s.end);
  const endsAt = operator ? localNow(new Date(operator.until)).minute : null;
  const warning = operator && endsAt - minute <= warnMinutes && endsAt > minute ? {ends: endsAt, next: next && next.start <= endsAt + warnMinutes ? next : null} : null;
  return {day, minute, shifts, onNow, next, operator, warning, rostered: Boolean(mine)};
}

/// When a sign-in ends: the end of the person's shift today (they can sign in up to 30 minutes early), else 2 hours.
function signInUntil(store, user, now) {
  const {day, minute} = localNow(now);
  const shift = shiftsOn(store, day).find(s => s.user === user && s.start - earlyMinutes <= minute && minute < s.end);
  return shift ? instant(day, shift.end) : new Date(+now + offShiftMinutes * 60000);
}

function signIn(store, user, via, now) {
  const until = signInUntil(store, user.id, now);
  const prior = pressOperator(store, now);
  if (prior && prior.user !== user.id) store.audit({id: prior.user}, 'press_sign_out', press, {reason: 'handover', by: user.id});
  const record = {id: press, press, user: user.id, name: user.name, via, at: now.toISOString(), until: until.toISOString(), endedAt: null};
  store.put('pressSignIn', record);
  store.audit(user, 'press_sign_in', press, {via, until: record.until});
  newCode(store, now);
  return record;
}

export function signOut(store, actor, now = new Date(), reason = 'signed out') {
  const s = store.get('pressSignIn', press);
  if (!s || s.endedAt) return null;
  const ended = {...s, endedAt: now.toISOString(), endReason: reason};
  store.put('pressSignIn', ended);
  store.audit(actor ?? {id: s.user}, 'press_sign_out', press, {reason});
  return ended;
}

function newCode(store, now) {
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  return store.put('pressCode', {id: press, code, issuedAt: now.toISOString(), expiresAt: new Date(+now + codeMinutes * 60000).toISOString()});
}
/// The code on the board; a fresh one every 10 minutes.
export function boardCode(store, now = new Date()) {
  const c = store.get('pressCode', press);
  return c && Date.parse(c.expiresAt) > +now ? c : newCode(store, now);
}

function guard(store, identity, now, fn) {
  const failed = store.db.prepare('SELECT * FROM failures WHERE identity=?').get(identity);
  need(!failed || failed.count < 5 || failed.until < +now, 'Too many wrong tries. Try again in 15 minutes.', 429);
  const ok = fn();
  if (ok) { store.db.prepare('DELETE FROM failures WHERE identity=?').run(identity); return ok; }
  const count = failed && failed.until > +now ? failed.count + 1 : 1;
  store.db.prepare('INSERT INTO failures VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET count=excluded.count,until=excluded.until').run(identity, count, +now + 900000);
  return null;
}

/// From the app: the staff member typed or scanned the board's code.
export function signInWithCode(store, actor, value, now = new Date()) {
  const text = String(value ?? '').trim();
  const code = text.startsWith(qrPrefix) ? text.slice(qrPrefix.length) : text;
  need(/^\d{6}$/.test(code), 'Type the 6-digit code on the press screen.');
  const user = store.require('user', actor.id);
  const ok = guard(store, 'presscode:' + actor.id, now, () => {
    const c = store.get('pressCode', press);
    return c && Date.parse(c.expiresAt) > +now && timingSafeEqual(Buffer.from(c.code), Buffer.from(code));
  });
  need(ok, 'That code is not on the press screen now. Check the screen and try again.', 401);
  return publicSignIn(signIn(store, user, 'code', now));
}

const pinHash = (pin, salt) => scryptSync(pin, salt, 32).toString('hex');
const pinMatches = (record, pin) => timingSafeEqual(Buffer.from(pinHash(pin, record.salt), 'hex'), Buffer.from(record.hash, 'hex'));

/// From the board: a PIN typed on the screen. `screen` is the board link (wrong tries lock that screen for 15 minutes).
export function signInWithPin(store, screen, pin, now = new Date()) {
  need(typeof pin === 'string' && /^\d{4,6}$/.test(pin), 'Type your 4 to 6 digit PIN.');
  let user = null;
  guard(store, 'boardpin:' + hash(screen), now, () => {
    for (const p of store.all('pressPin')) {
      const u = store.get('user', p.id);
      if (u?.enabled && pinMatches(p, pin)) { user = u; return true; }
    }
    return false;
  });
  need(user, 'That PIN didn’t match.', 401);
  return publicSignIn(signIn(store, user, 'pin', now));
}

export function setPin(store, actor, who, pin) {
  const user = userFor(store, who);
  need(actor.id === user.id || actor.role === 'manager', 'A manager can set someone else’s PIN.', 403);
  need(typeof pin === 'string' && /^\d{4,6}$/.test(pin), 'Use 4 to 6 digits.');
  need(!/^(\d)\1+$/.test(pin) && !'0123456789'.includes(pin) && !'9876543210'.includes(pin), 'Choose a PIN that isn’t all one digit or a simple run.');
  need(!store.all('pressPin').some(p => p.id !== user.id && pinMatches(p, pin)), 'Choose a different PIN.', 409);
  const salt = randomBytes(16).toString('hex');
  store.put('pressPin', {id: user.id, salt, hash: pinHash(pin, salt), setAt: new Date().toISOString(), setBy: actor.id});
  store.audit(actor, 'press_pin', user.id, {});
  return {user: user.id, name: user.name, pin: true};
}

const publicSignIn = s => ({press: s.press, user: s.user, name: s.name, via: s.via, at: s.at, until: s.until});

/// Weekly hours: {mon:'07:00-15:00', ..., sat:null}. Days left out are not worked.
/// With merge, days not given keep their hours (null clears a day).
export function setHours(store, actor, who, week, {printiqUser, merge = false} = {}) {
  store.manager(actor);
  const user = userFor(store, who);
  need(week && typeof week === 'object', 'Give the hours for each day.');
  const prior = store.get('staffShift', user.id);
  const hours = merge ? {...(prior?.week ?? {})} : {};
  for (const [key, value] of Object.entries(week)) {
    need(days.includes(key) && key !== 'sun', 'Use mon, tue, wed, thu, fri or sat.');
    if (value) hours[key] = span(value); else delete hours[key];
  }
  const iq = printiqUser === undefined ? prior?.printiqUser ?? null : printiqUser === null || printiqUser === '' ? null : str(printiqUser, 'printIQ user name', 60);
  need(iq === null || /^[\w .@-]{1,60}$/.test(iq), 'Check the printIQ user name.');
  const record = {id: user.id, user: user.id, week: hours, printiqUser: iq, updatedAt: new Date().toISOString(), updatedBy: actor.id, revision: (prior?.revision ?? 0) + 1};
  store.put('staffShift', record);
  store.audit(actor, 'staff_shift', user.id, {week, printiqUser: iq});
  return {...record, name: user.name};
}

/// One day's change: {day, hours:'07:00-12:00'} or {day, off:true} or {day, remove:true}.
export function setDay(store, actor, who, {day, hours, off, remove}) {
  store.manager(actor);
  const user = userFor(store, who);
  need(validDay(day), 'Choose a day.');
  const id = `${user.id}:${day}`;
  if (remove) { store.db.prepare("DELETE FROM records WHERE kind='staffShiftDay' AND id=?").run(id); store.audit(actor, 'staff_shift_day', user.id, {day, remove: true}); return {id, removed: true}; }
  const record = off ? {id, user: user.id, day, off: true} : {id, user: user.id, day, off: false, ...span(hours)};
  store.put('staffShiftDay', {...record, updatedBy: actor.id, updatedAt: new Date().toISOString()});
  store.audit(actor, 'staff_shift_day', user.id, record);
  return record;
}

/// Manager and app requests: POST /api/action?shifts=1
export function shiftAction(store, actor, body, now = new Date()) {
  switch (body?.action) {
    case 'hours': return setHours(store, actor, body.user, body.week, {printiqUser: body.printiqUser, merge: body.merge === true});
    case 'day': return setDay(store, actor, body.user, body);
    case 'pin': return setPin(store, actor, body.user ?? actor.id, body.pin);
    case 'signIn': return signInWithCode(store, actor, body.code, now);
    case 'signOut': {
      const current = pressOperator(store, now);
      need(current, 'Nobody is signed in at the press.', 409);
      need(current.user === actor.id || actor.role === 'manager', 'Only the operator or a manager can sign out the press.', 403);
      signOut(store, actor, now, actor.id === current.user ? 'signed out' : 'signed out by a manager');
      return {press, signedIn: null};
    }
    default: need(false, 'Unknown shift change.');
  }
}

/// For the app: the week's hours, today's changes and who is at the press.
export function shiftOverview(store, now = new Date()) {
  const state = shiftState(store, now);
  const pins = new Set(store.all('pressPin').map(p => p.id));
  const staff = store.all('staffShift').map(s => ({user: s.user, name: store.get('user', s.user)?.name ?? s.user, printiqUser: s.printiqUser,
    week: Object.fromEntries(Object.entries(s.week).map(([k, v]) => [k, `${clockLabel(v.start)}–${clockLabel(v.end)}`])), pin: pins.has(s.user)}));
  return {press, day: state.day, today: state.shifts.map(s => ({...s, from: clockLabel(s.start), to: clockLabel(s.end)})),
    operator: state.operator && publicSignIn(state.operator), staff,
    changes: store.all('staffShiftDay').filter(c => c.day >= state.day).sort((a, b) => a.day.localeCompare(b.day))};
}

/// Runs every minute: signs out at the end of a shift and queues the notifications (each once).
export function shiftTick(store, {now = new Date(), printing = false} = {}) {
  prepareProductionAlerts(store);
  const ended = [];
  const s = store.get('pressSignIn', press);
  if (s && !s.endedAt && Date.parse(s.until) <= +now) { signOut(store, null, now, 'shift ended'); ended.push(s.user); }
  const {day, minute, shifts, operator} = shiftState(store, now);
  const alerts = [];
  const notify = (users, key, title, body) => {
    for (const user of users) for (const device of store.db.prepare('SELECT binding FROM push_devices WHERE actor=?').all(user)) {
      const id = `shift:${key}:${device.binding}`;
      if (store.db.prepare('INSERT OR IGNORE INTO production_alerts (id,actor,binding,title,body,due) VALUES (?,?,?,?,?,?)').run(id, user, device.binding, title, body, +now).changes)
        alerts.push({key, user});
    }
  };
  const managers = store.all('user').filter(u => u.enabled && u.role === 'manager').map(u => u.id);
  for (const shift of shifts) {
    const nextUp = shifts.find(n => n.user !== shift.user && n.start >= shift.end - warnMinutes && n.start <= shift.end + warnMinutes);
    if (operator?.user === shift.user && shift.end - warnMinutes <= minute && minute < shift.end)
      notify([shift.user], `end:${shift.user}:${day}:${shift.end}`, `Your shift ends at ${clockLabel(shift.end)}`,
        `The Indigo screen signs you out at ${clockLabel(shift.end)}.${nextUp ? ` Hand over to ${nextUp.name.split(' ')[0]}.` : ''}`);
    if (operator?.user !== shift.user && shift.start <= minute && minute < shift.start + lateMinutes && minute < shift.end)
      notify([shift.user], `start:${shift.user}:${day}:${shift.start}`, 'Your shift has started',
        'Sign in at the Indigo: scan the code on the screen with the app, or type your PIN on the screen.');
    if (!operator && shift.start + lateMinutes <= minute && minute < shift.end)
      notify(managers, `nobody:${day}:${shift.start}`, 'Nobody is signed in at the Indigo',
        `${shift.name} was due at ${clockLabel(shift.start)} and hasn't signed in at the press.`);
  }
  if (printing && !operator)
    notify(managers, `printing:${day}:${Math.floor(minute / 60)}`, 'The Indigo is printing with nobody signed in',
      'The press is printing but nobody is signed in on the press screen.');
  return {ended, alerts};
}

// Shift hours and press PINs from the server (run on PrintCRM as the service user):
//   node staff-shifts.mjs list
//   node staff-shifts.mjs hours Sadhir mon-fri 07:00-15:00 [--printiq "printIQ user name"]   (other days keep their hours)
//   node staff-shifts.mjs hours Sadhir sat none                (stops a day)
//   node staff-shifts.mjs day Jacob 2026-11-27 12:00-17:00     (one day's change)
//   node staff-shifts.mjs off Jacob 2026-11-27                  (not working that day)
//   node staff-shifts.mjs clear Jacob 2026-11-27                (back to normal hours)
//   node staff-shifts.mjs pin Sadhir                            (asks for the PIN; the operator types it)
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {Store} from './core.mjs';
import {setDay, setHours, setPin, shiftOverview} from './shifts.mjs';

const server = {id: 'server', name: 'PrintCRM server', role: 'manager'};
const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function parseDays(text) {
  const result = new Set();
  for (const part of String(text).toLowerCase().split(',')) {
    const [a, b] = part.split('-');
    const i = order.indexOf(a), j = b === undefined ? i : order.indexOf(b);
    if (i < 0 || j < i) throw new Error('Use days like mon-fri, sat or mon,wed,fri.');
    for (let k = i; k <= j; k++) result.add(order[k]);
  }
  return [...result];
}

/// Asks for the PIN twice without showing it (one prompt reader, so piped input works too).
async function askTwice(first, second) {
  const rl = createInterface({input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY)});
  let prompt = '';
  rl._writeToOutput = text => { if (text.startsWith(prompt) || !process.stdin.isTTY) process.stdout.write(text === prompt ? text : text.startsWith(prompt) ? prompt : ''); };
  const lines = rl[Symbol.asyncIterator]();
  const ask = async q => { prompt = q; process.stdout.write(q); const {value} = await lines.next(); process.stdout.write('\n'); return String(value ?? '').trim(); };
  try { return [await ask(first), await ask(second)]; } finally { rl.close(); }
}

async function main(args) {
  const store = new Store(join(process.env.SUNNYLAND_DATA || '/var/lib/sunnyland-production', 'production.sqlite'));
  try {
    const [action, who, ...rest] = args;
    if (action === 'list') {
      const o = shiftOverview(store);
      if (!o.staff.length) console.log('No shift hours set yet.');
      for (const s of o.staff) console.log(`${s.name}: ${order.filter(d => s.week[d]).map(d => `${d} ${s.week[d]}`).join(', ') || 'no hours'}`
        + ` · printIQ user ${s.printiqUser ?? '(default)'} · PIN ${s.pin ? 'set' : 'not set'}`);
      for (const c of o.changes) console.log(`  change ${c.day}: ${store.get('user', c.user)?.name ?? c.user} ${c.off ? 'off' : `${c.start / 60}h-${c.end / 60}h`}`);
      console.log(o.operator ? `At the press now: ${o.operator.name} until ${new Date(o.operator.until).toLocaleTimeString('en-AU', {timeZone: 'Australia/Melbourne'})}` : 'Nobody signed in at the press.');
      console.log('Staff accounts: ' + store.all('user').filter(u => u.enabled).map(u => `${u.name} (${u.role})`).join(', '));
    } else if (action === 'hours') {
      const [daysText, span, flag, iq] = rest;
      const week = Object.fromEntries(parseDays(daysText).map(d => [d, span === 'none' ? null : span]));
      const r = setHours(store, server, who, week, {merge: true, ...(flag === '--printiq' ? {printiqUser: iq} : {})});
      console.log(`${r.name}: ${order.filter(d => r.week[d]).join(', ')} ${span}${r.printiqUser ? ` · printIQ user ${r.printiqUser}` : ''}`);
    } else if (action === 'day' || action === 'off' || action === 'clear') {
      const [day, span] = rest;
      setDay(store, server, who, {day, hours: span, off: action === 'off', remove: action === 'clear'});
      console.log(`Saved ${action} for ${who} on ${day}.`);
    } else if (action === 'pin') {
      const [pin, again] = await askTwice(`PIN for ${who} (4-6 digits): `, 'Type it again: ');
      if (pin !== again) throw new Error('The two PINs were different. Nothing was changed.');
      const r = setPin(store, server, who, pin);
      console.log(`PIN set for ${r.name}.`);
    } else {
      console.error('Usage: node staff-shifts.mjs list | hours <name> mon-fri 07:00-15:00 [--printiq NAME] | day|off|clear <name> <YYYY-MM-DD> [hh:mm-hh:mm] | pin <name>');
      process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; } finally { store.close(); }
}
if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));

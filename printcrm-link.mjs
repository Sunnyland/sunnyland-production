// PrintCRM <-> production service. Managers use their PrintCRM account: PrintCRM checks the sign-in and role, then calls
// these endpoints from the server with a private key (a file both servers can read; never in a browser):
//   GET  /api/printcrm/plan   - today's plan, the Not planned list and the next press days
//   POST /api/printcrm/plan   - a manager's answer: place / fix / ignore / unignore (see not-planned.mjs)
// X-PrintCRM-User carries who is acting (shown in the audit log). Only from the allowed peers, like every request.
import {readFileSync} from 'node:fs';
import {createHash, timingSafeEqual} from 'node:crypto';
import {need} from './core.mjs';
import {finishDay, isPlantWorkday} from './job-visibility.mjs';
import {indigoCapacity} from './print-planning.mjs';
import {openDays, planBookings} from './press-plan.mjs';

export const keyFile = process.env.SUNNYLAND_PRINTCRM_KEY_FILE || '/etc/sunnyland-production/printcrm-link.key';
const digest = v => createHash('sha256').update(String(v)).digest();

export function readLinkKey(file = keyFile) {
  try { const key = readFileSync(file, 'utf8').trim(); return /^[A-Za-z0-9_-]{40,}$/.test(key) ? key : null; } catch { return null; }
}

/// The acting PrintCRM manager, or a refusal.
export function printcrmActor(req, key) {
  need(key, 'The PrintCRM link is not set up on this server.', 503);
  const given = req.headers['x-printcrm-key'];
  need(typeof given === 'string' && timingSafeEqual(digest(given), digest(key)), 'Not allowed.', 403);
  let who = null;
  try { who = JSON.parse(Buffer.from(String(req.headers['x-printcrm-user'] ?? ''), 'base64url').toString('utf8')); } catch { who = null; }
  need(who && typeof who.id === 'string' && /^[\w-]{1,64}$/.test(who.id) && typeof who.name === 'string' && who.name.trim() && who.name.length <= 80,
    'Say which PrintCRM manager is acting.', 400);
  return {id: 'printcrm:' + who.id, name: who.name.trim(), email: typeof who.email === 'string' ? who.email.slice(0, 120) : null, role: 'manager'};
}

/// The next six press days with hours left: weekdays (not public holidays) and Saturdays a manager opened.
export function pressDays(store, today) {
  const open = openDays(store), bookings = planBookings(store), days = [];
  for (let d = new Date(today + 'T00:00:00Z'); days.length < 6; d = new Date(+d + 86400000)) {
    const day = d.toISOString().slice(0, 10);
    if (!(isPlantWorkday(day) || (d.getUTCDay() === 6 && open.has(day)))) continue;
    const c = indigoCapacity(bookings.filter(b => !b.removed && b.press === 'HP Indigo 7900' && b.day === day), day, 'HP Indigo 7900');
    days.push({day, left: c.limitMinutes - c.bookedMinutes});
  }
  return days;
}

/// Today's board, trimmed for PrintCRM.
export function planSummary(board) {
  const row = r => ({job: r.job, customer: r.customer ?? '', name: r.name ?? '', part: r.part ?? '', start: r.start ?? null, minutes: r.minutes ?? null,
    status: r.status?.label ?? '', key: r.status?.key ?? '', late: r.status?.late ?? null, rush: Boolean(r.status?.rush), wontFit: Boolean(r.status?.wontFit)});
  return {day: board.day, hours: board.hours, printing: board.current.map(row), next: [...board.next, ...board.maintenance].map(row),
    held: board.held.map(row), done: board.done.map(row), problems: board.problems};
}
export const today = now => finishDay(now.toISOString());

// Manager page: /plan (signed in, managers only). Lists the Not planned jobs with Add to a day, Fix and Ignore.
// Plain HTML forms, no scripts. The session is an HttpOnly, SameSite=Strict cookie holding a normal staff session token.
import {indigoCapacity} from './print-planning.mjs';
import {isPlantWorkday} from './job-visibility.mjs';
import {planBookings, openDays} from './press-plan.mjs';

export const cookieName = 'slp_plan';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const hm = m => { const h = Math.floor(Math.abs(m) / 60), r = Math.abs(m) % 60; return (m < 0 ? '−' : '') + (h ? `${h}h${r ? String(r).padStart(2, '0') : ''}` : `${r}m`); };
const short = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-AU', {weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'});

export function readCookie(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === cookieName) return v.join('=');
  }
  return null;
}
export function sessionCookie(token, req, maxAge = 12 * 3600) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  // No Path: the browser scopes it to the plan page's own folder, so PrintCRM's other pages never receive it.
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
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

const style = `*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f4ee;color:#1d2a26}
header{display:flex;justify-content:space-between;align-items:center;padding:.8em 1.2em;background:#143b33;color:#fff}header h1{margin:0;font-size:1.25em}
header form{margin:0}main{padding:1em 1.2em;max-width:1200px}h2{margin:1.4em 0 .4em;font-size:1.05em}h2 small{font-weight:400;color:#5c6b66}
.msg{padding:.6em .9em;border-radius:.4em;background:#dff3e6;margin:.6em 0}.err{background:#fde2de}
.item{background:#fff;border-radius:.5em;padding:.7em .9em;margin:.5em 0;box-shadow:0 1px 2px #0001}
.item .top{display:flex;flex-wrap:wrap;gap:.3em 1em;align-items:baseline}.job{font-weight:700}.due{color:#5c6b66}.late{color:#b3261e;font-weight:700}
.why{margin:.3em 0;color:#3d4b47}.raw{color:#8a9692;font-size:.85em}
.acts{display:flex;flex-wrap:wrap;gap:.5em 1.4em;margin-top:.5em}.acts form{display:flex;flex-wrap:wrap;gap:.35em;align-items:center;margin:0;padding:.35em .5em;border-radius:.4em;background:#f0efe8}
.acts b{font-size:.85em;color:#3d4b47}input,select,button{font:inherit;padding:.25em .45em;border:1px solid #b9c2bf;border-radius:.3em;background:#fff}
input[type=number]{width:5em}button{background:#143b33;color:#fff;border-color:#143b33;cursor:pointer}button.quiet{background:#fff;color:#143b33}
table{border-collapse:collapse;width:100%;background:#fff;border-radius:.5em;overflow:hidden}td,th{padding:.4em .6em;border-bottom:1px solid #eceae2;text-align:left;font-size:.92em}
details summary{cursor:pointer;margin:1em 0 .4em;font-weight:700}.hint{color:#5c6b66}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${style}</style></head><body>${body}</body></html>`;

export function renderLogin(error = '') {
  return page('Sign in · Indigo plan', `<header><h1>Indigo plan</h1></header><main><h2>Managers sign in</h2>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}<form method="post" action="plan/login" class="item" style="max-width:24em">
<p><label>Email<br><input name="email" type="email" autocomplete="username" required style="width:100%"></label></p>
<p><label>Password<br><input name="password" type="password" autocomplete="current-password" required style="width:100%"></label></p>
<button>Sign in</button></form></main>`);
}

export function renderPlan({list, days, user, message = '', error = ''}) {
  const dayOptions = days.map(d => `<option value="${d.day}">${esc(short(d.day))} · ${esc(hm(d.left))} left</option>`).join('');
  const hidden = i => `<input type="hidden" name="job" value="${esc(i.job)}"><input type="hidden" name="id" value="${esc(i.id)}">`;
  const place = i => `<form method="post" action="plan/action"><input type="hidden" name="action" value="place">${hidden(i)}<b>Add to</b>
<select name="day">${dayOptions}</select><input type="number" name="minutes" min="1" max="600" value="${esc(i.minutes ?? 30)}" title="Minutes"> min <button>Add</button></form>`;
  const fix = i => `<form method="post" action="plan/action"><input type="hidden" name="action" value="fix">${hidden(i)}<b>Fix</b>
${i.action === 'minutes' || i.action === 'any' ? `<input type="number" name="minutes" min="1" max="600" placeholder="min" title="Run time in minutes">` : ''}
${i.action === 'any' ? `<input name="stock" placeholder="stock" value="${esc(i.stock)}" size="14"><input type="date" name="due" value="${esc(i.due ?? '')}">` : ''}
<button class="quiet">Save, agent replans</button></form>`;
  const ignore = i => `<form method="post" action="plan/action"><input type="hidden" name="action" value="ignore">${hidden(i)}<b>Ignore</b>
<select name="why"><option value="notIndigo">Not an Indigo job</option><option value="notNeeded">Not needed</option><option value="printed">Already printed</option></select>
<button class="quiet">Ignore</button></form>`;
  const head = i => `<div class="top"><span class="job">${esc(i.job)}</span><span>${esc(i.name)}</span>${i.part ? `<span class="hint">${esc(i.part)}</span>` : ''}
<span class="${i.overdue ? 'late' : 'due'}">${i.due ? 'Due ' + esc(short(i.due)) : 'No due date'}</span>${i.minutes ? `<span class="hint">${esc(hm(i.minutes))}</span>` : ''}
${i.stock ? `<span class="hint">${esc(i.stock)}</span>` : ''}${i.rep ? `<span class="hint">Rep ${esc(i.rep)}</span>` : ''}${i.fixed ? '<span class="hint">· your fix saved</span>' : ''}</div>`;
  const needs = list.needs.map(i => `<div class="item">${head(i)}<div class="why">${esc(i.plain)} <span class="raw">(${esc(i.reason)})</span></div>
<div class="acts">${place(i)}${['minutes', 'any'].includes(i.action) ? fix(i) : ''}${ignore(i)}</div></div>`).join('');
  const artwork = list.artwork.map(i => `<tr><td class="job">${esc(i.job)}</td><td>${esc(i.name)}</td><td class="${i.overdue ? 'late' : ''}">${i.due ? esc(short(i.due)) : '—'}${i.overdue ? ' · overdue' : ''}</td>
<td>${esc(i.rep ?? '')}</td><td><div class="acts" style="margin:0">${place(i)}${ignore(i)}</div></td></tr>`).join('');
  const ignored = list.ignored.map(i => `<tr><td class="job">${esc(i.job)}</td><td>${esc(i.name)}</td><td>${esc(i.why)}</td><td>${esc(i.at.slice(0, 10))}</td>
<td><form method="post" action="plan/action"><input type="hidden" name="action" value="unignore"><input type="hidden" name="job" value="${esc(i.job)}"><button class="quiet">Undo</button></form></td></tr>`).join('');
  return page('Not planned · Indigo plan', `<header><h1>Indigo · not planned</h1><form method="post" action="plan/logout"><span>${esc(user.name)}</span> <button class="quiet">Sign out</button></form></header><main>
${message ? `<div class="msg">${esc(message)}</div>` : ''}${error ? `<div class="msg err">${esc(error)}</div>` : ''}
<p class="hint">From the agent’s last check${list.asOf ? ' at ' + esc(new Date(list.asOf).toLocaleTimeString('en-AU', {hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne'})) : ''}. Fixes and ignores are picked up within a minute.</p>
<h2>Needs a manager <small>${list.needs.length}</small></h2>${needs || '<p class="hint">Nothing — every approved Indigo job is on the plan.</p>'}
<details${list.artwork.length && !list.needs.length ? ' open' : ''}><summary>Waiting on artwork approval (${list.artwork.length}) <span class="hint">— due in the next 5 working days are pencilled in; these are later or overdue</span></summary>
${artwork ? `<table><tr><th>Job</th><th>Name</th><th>Due</th><th>Rep</th><th></th></tr>${artwork}</table>` : '<p class="hint">None.</p>'}</details>
<details><summary>Ignored (${list.ignored.length})</summary>${ignored ? `<table><tr><th>Job</th><th>Name</th><th>Why</th><th>When</th><th></th></tr>${ignored}</table>` : '<p class="hint">None.</p>'}</details>
</main>`);
}

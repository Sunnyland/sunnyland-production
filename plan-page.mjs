// Production planning page: /plan (today), /plan/week, /plan/not-planned. Read only: anyone with a press PIN signs in
// with the PIN alone. Changing the plan is for managers, in PrintCRM. Plain HTML, no scripts.
// The session is an HttpOnly, SameSite=Strict cookie holding a view-only plan session (not a staff API session).

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

const style = `*{box-sizing:border-box}body{margin:0;font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f4ee;color:#1d2a26}
header{display:flex;justify-content:space-between;align-items:center;padding:.8em 1.2em;background:#143b33;color:#fff}header h1{margin:0;font-size:1.25em}
header form{margin:0}header a{color:#cfe8df}main{padding:1em 1.2em;max-width:1200px}h2{margin:1.4em 0 .4em;font-size:1.05em}h2 small{font-weight:400;color:#5c6b66}
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
  return page('Sign in · Production plan', `<header><h1>Production plan</h1></header><main><h2>Sign in with your PIN</h2>
${error ? `<div class="msg err">${esc(error)}</div>` : ''}<form method="post" action="plan/login" class="item" style="max-width:20em">
<p><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,6}" autocomplete="off" required autofocus placeholder="PIN" style="width:100%;font-size:1.6em;letter-spacing:.3em"></p>
<button>Sign in</button></form><p class="hint">This page shows the plan only. Managers change it in PrintCRM.</p></main>`);
}

/// Read-only Not planned list.
export function renderNotPlanned({list, user, nav}) {
  const head = i => `<div class="top"><span class="job">${esc(i.job)}</span><span>${esc(i.name)}</span>${i.part ? `<span class="hint">${esc(i.part)}</span>` : ''}
<span class="${i.overdue ? 'late' : 'due'}">${i.due ? 'Due ' + esc(short(i.due)) : 'No due date'}</span>${i.minutes ? `<span class="hint">${esc(hm(i.minutes))}</span>` : ''}
${i.stock ? `<span class="hint">${esc(i.stock)}</span>` : ''}${i.rep ? `<span class="hint">Rep ${esc(i.rep)}</span>` : ''}</div>`;
  const needs = list.needs.map(i => `<div class="item">${head(i)}<div class="why">${esc(i.plain)}</div></div>`).join('');
  const artwork = list.artwork.map(i => `<tr><td class="job">${esc(i.job)}</td><td>${esc(i.name)}</td><td class="${i.overdue ? 'late' : ''}">${i.due ? esc(short(i.due)) : '—'}${i.overdue ? ' · overdue' : ''}</td><td>${esc(i.rep ?? '')}</td></tr>`).join('');
  return page('Not planned · Production plan', `<header><h1>Indigo · not planned</h1><form method="post" action="logout">${nav} · <span>${esc(user.name)}</span> <button class="quiet">Sign out</button></form></header><main>
<p class="hint">From the agent’s last check${list.asOf ? ' at ' + esc(new Date(list.asOf).toLocaleTimeString('en-AU', {hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Melbourne'})) : ''}. Managers sort these out in PrintCRM.</p>
<h2>Needs a manager <small>${list.needs.length}</small></h2>${needs || '<p class="hint">Nothing — every approved Indigo job is on the plan.</p>'}
<details><summary>Waiting on artwork approval (${list.artwork.length})</summary>
${artwork ? `<table><tr><th>Job</th><th>Name</th><th>Due</th><th>Rep</th></tr>${artwork}</table>` : '<p class="hint">None.</p>'}</details></main>`);
}

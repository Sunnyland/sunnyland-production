// Sends the app's emails from the outbox (production alerts, sample emails). Email only: printIQ notes and finishes
// are not touched here. Runs every two minutes from a systemd timer (sunnyland-mail.timer).
//   SUNNYLAND_MAIL_MODE=log  (default) - nothing is sent; each email is recorded as "logged" with its address and subject
//   SUNNYLAND_MAIL_MODE=live           - sent through Mailgun (PrintCRM's account, from production@sunnyland.com.au),
//                                        or the SMTP settings in private.env when no Mailgun credential is given
// Every email is checked again just before it would go: if it no longer applies (the job printed, the approval came in,
// it is over two days old) it is cancelled with the reason instead of being sent.
import {join, resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from './core.mjs';
import {sendMail} from './worker.mjs';
import {readWatch} from './indigo-watch.mjs';
import {printIQJobKey} from './job-tickets.mjs';

const maxAgeHours = 48;
const jobKey = v => printIQJobKey(v) ?? v;

export function staleReason(store, row, event, now = new Date(), watch = null) {
  if (now - Date.parse(row.created) > maxAgeHours * 3600000) return 'Over two days old when sending started';
  if (['sample_ready', 'sample_reminder'].includes(event.kind) && store.get('sample', row.entity)?.state !== 'pending') return 'The sample was already reviewed';
  const job = jobKey(event.job ?? row.entity);
  const printed = store.all('indigoPrinted').find(r => jobKey(r.job) === job);
  const hasPrinted = Boolean(printed && (printed.done || printed.printed > 0));
  if (row.id.startsWith('indigo-agent:late-dispatch:')) {
    if (hasPrinted) return 'Already printed (or part printed)';
    const late = store.all('printPlanRun').some(r => !r.removed && jobKey(r.job) === job && r.late);
    if (!late) return 'No longer late on the plan';
  }
  if (/^indigo-agent:approval-/.test(row.id)) {
    if (hasPrinted) return 'Already printed (or part printed)';
    if (watch?.approvals?.[job]?.approved) return 'Approved since the email was queued';
  }
  return null;
}

const from = process.env.SUNNYLAND_MAIL_FROM || 'Sunnyland Production <production@sunnyland.com.au>';
const address = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;

/// PrintCRM's Mailgun account, handed to this service by systemd (never printed).
export function mailgunConfig(file = process.env.SUNNYLAND_MAILGUN_FILE || (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, 'mailgun.json') : '')) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return typeof c.apiKey === 'string' && c.apiKey && typeof c.domain === 'string' && /^[a-z0-9.-]+$/i.test(c.domain)
      ? {apiKey: c.apiKey, domain: c.domain, baseUrl: /^https:\/\/[a-z0-9.-]+$/i.test(c.baseUrl ?? '') ? c.baseUrl : 'https://api.mailgun.net'} : null;
  } catch { return null; }
}

/// The message for one outbox row (same wording as the SMTP sender).
export function message(event) {
  if (!address.test(event.to ?? '')) return null;
  if (event.kind === 'production_alert') {
    if (typeof event.subject !== 'string' || !event.subject.trim() || event.subject.length > 200 || /[\r\n]/.test(event.subject) || typeof event.text !== 'string' || event.text.length > 5000) return null;
    return {to: event.to, subject: event.subject.trim(), text: event.text + '\n\nSent by the Sunnyland Production Indigo agent.'};
  }
  if (['sample_ready', 'sample_reminder'].includes(event.kind) && event.job && event.title)
    return {to: event.to, subject: `${event.job} - ${event.kind.replace('_', ' ')} - ${event.title}`.slice(0, 200).replace(/[\r\n]/g, ' '),
      text: `Job: ${event.job}\nSample: ${event.title}\nUpdate: ${event.kind.replace('_', ' ')}\n\nOpen Sunnyland Production, select Samples and review the sample.`};
  return null;
}

export function mailgunSender(cfg, {fetchImpl = fetch} = {}) {
  return async row => {
    const m = message(JSON.parse(row.body));
    if (!m) return {state: 'blocked', receipt: {reason: 'Not an email this sender handles, or an invalid address.'}};
    let res;
    try {
      res = await fetchImpl(`${cfg.baseUrl}/v3/${encodeURIComponent(cfg.domain)}/messages`, {method: 'POST',
        headers: {Authorization: 'Basic ' + Buffer.from('api:' + cfg.apiKey).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({from, to: m.to, subject: m.subject, text: m.text, 'h:Message-Id': `<sunnyland-${row.id.replace(/[^\w.-]/g, '-').slice(0, 120)}@sunnyland.com.au>`}),
        signal: AbortSignal.timeout(20000)});
    } catch { return {state: 'uncertain', receipt: {reason: 'Mailgun did not answer; not resent automatically.'}}; }
    if (res.ok) { const j = await res.json().catch(() => ({})); return {state: 'accepted', receipt: {via: 'mailgun', id: j.id ?? null, at: new Date().toISOString()}}; }
    return {state: res.status >= 500 ? 'uncertain' : 'rejected', receipt: {via: 'mailgun', status: res.status}};
  };
}

export async function sendMailOutbox(store, {mail = null, mode = process.env.SUNNYLAND_MAIL_MODE === 'live' ? 'live' : 'log', now = new Date(), watch = readWatch} = {}) {
  const w = typeof watch === 'function' ? watch() : watch;
  if (!mail) { const cfg = mailgunConfig(); mail = cfg ? mailgunSender(cfg) : sendMail; }
  const rows = store.db.prepare("SELECT * FROM outbox WHERE channel='mail' AND state='pending' ORDER BY created LIMIT 50").all();
  const done = {sent: 0, logged: 0, cancelled: 0, failed: 0};
  const set = (id, state, receipt, from = 'pending') => store.db.prepare('UPDATE outbox SET state=?,receipt=? WHERE id=? AND state=?').run(state, JSON.stringify(receipt), id, from).changes;
  for (const row of rows) {
    let event; try { event = JSON.parse(row.body); } catch { set(row.id, 'cancelled', {reason: 'Unreadable email'}); done.cancelled++; continue; }
    const reason = staleReason(store, row, event, now, w);
    if (reason) { if (set(row.id, 'cancelled', {reason, at: now.toISOString()})) done.cancelled++; continue; }
    if (mode !== 'live') { if (set(row.id, 'logged', {mode: 'log', to: event.to ?? null, subject: event.subject ?? event.kind, at: now.toISOString()})) done.logged++; continue; }
    if (!set(row.id, 'sending', {startedAt: now.toISOString()})) continue;
    let result;
    try { result = await mail(row); } catch (e) { result = {state: 'blocked', receipt: {reason: e.message}}; }
    set(row.id, result.state, result.receipt, 'sending');
    if (result.state === 'accepted') done.sent++; else done.failed++;
  }
  return done;
}

/// One-off: cancel everything waiting from before email was set up (kept as a record, never sent).
export function clearBacklog(store, before, reason) {
  return store.db.prepare("UPDATE outbox SET state='cancelled',receipt=? WHERE channel='mail' AND state='pending' AND created < ?")
    .run(JSON.stringify({reason, at: new Date().toISOString()}), before).changes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new Store(join(process.env.SUNNYLAND_DATA || '/var/lib/sunnyland-production', 'production.sqlite'));
  try {
    if (process.argv[2] === '--clear-backlog') console.log('Cancelled', clearBacklog(store, new Date().toISOString(), 'Built up before email was set up (cleared 23 Nov 2026)'), 'waiting emails.');
    else console.log(JSON.stringify(await sendMailOutbox(store)));
  } finally { store.close(); }
}

// The Indigo agent's checks, every minute from the latest 10-minute watch and hourly printIQ scan:
//
// For each Indigo job (a printIQ job with a Printing operation on the HP Indigo 7900):
//   Not approved in Prinect Cockpit?
//     - Once only one working day of slack is left before its latest print day (due date less its
//       finishing time), email the rep (printIQ account manager) a reminder, once a day.
//     - When even approval today can't meet the due date, tell the rep and the production managers.
//   Approved?
//     - It should reach the Indigo queue within 30 minutes. If it hasn't, alert prepress and managers.
// Connections:
//     - The Indigo (HP Production Pro) or Prinect Cockpit feed stops answering, queue entries arrive
//       without a job number, or the watch itself stops: alert prepress and managers.
//
// Every alert has a stable key, so each one is sent once (reminders once per day), however often this runs.
import {openSync, closeSync, fstatSync, readFileSync, constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {finishDay} from './print-planning.mjs';
import {isPlantWorkday} from './job-visibility.mjs';
import {plannerSettings, withFinishingPlan} from './indigo-sequence.mjs';
import {printIQJobKey} from './job-tickets.mjs';

const path = '/var/lib/sunnyland-production/indigo-watch.json';
export const queueGraceMinutes = 30;
const watchStaleMinutes = 30;
const email = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const closedStates = new Set(['complete', 'cancelled', 'other press']);

export function readWatch(file = path) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || !(file === path ? st.uid === 0 : [0, process.geteuid()].includes(st.uid)) || (st.mode & 0o027) || st.size > 8 * 1024 * 1024) return null;
    const watch = JSON.parse(readFileSync(fd, 'utf8'));
    if (watch.schema !== 1 || !Number.isFinite(Date.parse(watch.generatedAt)) || typeof watch.approvals !== 'object' ||
        typeof watch.queue !== 'object' || !Array.isArray(watch.unmatched) || typeof watch.health !== 'object') return null;
    return watch;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}

export function prepareProductionAlerts(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS production_alerts(id TEXT PRIMARY KEY, actor TEXT, binding TEXT, title TEXT, body TEXT,
    due INTEGER, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, reason TEXT)`);
}

/// Working days from `today` (exclusive) up to `day` (inclusive); negative when `day` is already past.
export function workdaysUntil(today, day) {
  if (day < today) return -1;
  let count = 0;
  for (const date = new Date(today + 'T00:00:00Z'); date.toISOString().slice(0, 10) < day;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isPlantWorkday(date.toISOString().slice(0, 10))) count++;
  }
  return count;
}

const jobKey = value => printIQJobKey(value) ?? value;
const plainDate = day => new Date(day + 'T00:00:00Z').toLocaleDateString('en-AU', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
const localTime = stamp => new Date(stamp).toLocaleString('en-AU', {timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', minute: '2-digit'});

/// Works out the alerts for this moment. Pure: no writes. Used by `applyWatch` and by the tests.
export function watchAlerts({watch, feed, config = {}, now = new Date()}) {
  const settings = plannerSettings(config);
  const today = finishDay(now.toISOString());
  const alerts = [];
  const status = {approvalWaiting: [], notOnIndigo: [], onIndigo: 0, health: watch?.health ?? null, unmatched: watch?.unmatched?.length ?? 0};
  if (!watch) return {alerts, status: {...status, problem: 'Waiting for the first Indigo watch'}};
  const watchAge = (now - Date.parse(watch.generatedAt)) / 60000;
  if (watchAge > watchStaleMinutes) {
    alerts.push({key: 'watch-stale:' + today, audience: 'operations', subject: 'Indigo agent: approval and press checks have stopped',
      text: `The Indigo agent's 10-minute check of Prinect Cockpit approvals and the Indigo queue last ran ${localTime(watch.generatedAt)}.\n\n` +
        'Check the sunnyland-indigo-watch timer on PrintCRM. Until it runs again, approval reminders and missing-job alerts are paused.'});
  }
  const health = watch.health ?? {};
  if (health.indigo && !health.indigo.ok) {
    alerts.push({key: 'indigo-down:' + (health.indigo.lastSuccessfulAt ?? today), audience: 'operations', push: true,
      subject: 'Indigo connection is down', text: `${health.indigo.reason}\n\nLast good report: ${health.indigo.lastSuccessfulAt ? localTime(health.indigo.lastSuccessfulAt) : 'unknown'}.\n\n` +
        'The agent cannot see what has reached the Indigo until this is fixed. Check HP Production Pro and the JMF connection on PrintCRM.'});
  }
  if (health.cockpit && !health.cockpit.ok) {
    alerts.push({key: 'cockpit-down:' + today, audience: 'operations', push: true, subject: 'Prinect Cockpit approvals cannot be read',
      text: `${health.cockpit.reason}\n\nApproval reminders and the check that approved jobs reach the Indigo are paused until approvals can be read.`});
  }
  for (const entry of watch.unmatched ?? []) {
    alerts.push({key: 'indigo-unnumbered:' + entry.queueEntryId, audience: 'prepress', subject: 'Indigo queue entry without a job number',
      text: `A job reached the Indigo queue at ${localTime(entry.submitted)} without a printIQ job number (it shows "${entry.nativeJobId ?? 'blank'}", part ${entry.jobPartId ?? 'unknown'}, status ${entry.status ?? 'unknown'}).\n\n` +
        'The agent cannot match it to a job. Check the job number in Prinect before it prints.'});
  }
  const approvals = health.cockpit?.ok === false ? null : watch.approvals ?? {};
  for (const job of feed?.jobs ?? []) {
    if (!Array.isArray(job.runs) || !job.runs.length || closedStates.has(job.state)) continue;
    const no = jobKey(job.job), approval = approvals?.[no];
    const rep = job.rep?.email && email.test(job.rep.email) ? job.rep : null;
    if (approval?.approved) {
      const approvedAt = Date.parse(approval.approvedAt), queued = watch.queue?.[no];
      const reached = queued?.last && Date.parse(queued.last) >= approvedAt - 10 * 60000;
      if (reached) { status.onIndigo++; continue; }
      if (!health.indigo?.ok || !Number.isFinite(approvedAt) || now - approvedAt < queueGraceMinutes * 60000) continue;
      status.notOnIndigo.push({job: no, name: job.name, approvedAt: approval.approvedAt});
      alerts.push({key: `indigo-missing:${no}:${approval.approvedAt}`, audience: 'prepress', push: true, job: no,
        subject: `${no} approved but not on the Indigo`,
        text: `${no} ${job.name ?? ''} was approved in Prinect Cockpit ${localTime(approval.approvedAt)} but has not reached the Indigo queue after ${queueGraceMinutes} minutes.\n\n` +
          `Due: ${job.due ? plainDate(finishDay(job.due)) : 'not set'}.\n\nCheck where the job is in Prinect and whether the workflow to the Indigo has stopped.`});
      continue;
    }
    if (!approvals) continue;
    const plans = job.runs.map(run => withFinishingPlan({...run, due: finishDay(job.due)}, settings)).filter(r => r.latestPrintDay);
    if (!plans.length) continue;
    const latest = plans.map(r => r.latestPrintDay).sort()[0];
    const finishing = Math.max(...plans.map(r => r.finishingDays));
    const slack = workdaysUntil(today, latest);
    status.approvalWaiting.push({job: no, name: job.name, due: finishDay(job.due), latestPrintDay: latest, slack, rep: job.rep?.name ?? null});
    if (!isPlantWorkday(today) || slack > 1) continue;
    const lines = `${no} ${job.name ?? ''}\nDue: ${plainDate(finishDay(job.due))}\nFinishing after printing: ${finishing} working day${finishing === 1 ? '' : 's'}\n`;
    if (slack < 0) {
      alerts.push({key: `approval-late:${no}:${today}`, audience: 'rep+managers', rep, push: true, job: no,
        subject: `${no} cannot make its due date without approval now`,
        text: `${lines}\nThis job is still not approved in Prinect Cockpit. Even if it is approved today, printing and finishing cannot be done by the due date.\n\nPlease agree a new date with the customer or speed up approval and finishing.`});
    } else {
      alerts.push({key: `approval-reminder:${no}:${today}`, audience: rep ? 'rep' : 'managers', rep, job: no,
        subject: `${no} needs artwork approval ${slack === 0 ? 'today' : 'by tomorrow'}`,
        text: `${lines}Latest print day: ${plainDate(latest)}\n\nThis job is not yet approved in Prinect Cockpit. To meet the due date it must be approved ${slack === 0 ? 'today' : 'by the end of tomorrow'}.` +
          (rep ? '' : '\n\n(No rep email was found for this job in printIQ, so this went to the production managers.)')});
    }
  }
  return {alerts, status};
}

/// Queues alert emails (and iPhone pushes for alerts marked push) for production managers, prepress and reps.
/// Each alert key goes to each address once. Call inside a transaction.
export function queueProductionAlerts(store, alerts, config = {}) {
  const users = store.all('user').filter(u => u.enabled);
  const managers = users.filter(u => u.role === 'manager');
  const managerEmails = managers.map(u => u.email).filter(e => email.test(e));
  const prepress = (Array.isArray(config.prepressEmails) ? config.prepressEmails : []).filter(e => typeof e === 'string' && email.test(e));
  const sent = [];
  for (const alert of alerts) {
    const to = new Set(alert.audience === 'rep' ? [alert.rep.email] :
      alert.audience === 'rep+managers' ? [alert.rep?.email, ...managerEmails] :
      alert.audience === 'prepress' || alert.audience === 'operations' ? [...prepress, ...managerEmails] : managerEmails);
    for (const address of [...to].filter(Boolean)) {
      const id = 'indigo-agent:' + alert.key + ':' + address.toLowerCase();
      if (store.db.prepare('SELECT 1 FROM outbox WHERE id=?').get(id)) continue;
      store.queue('mail', alert.job ?? 'indigo-agent', {to: address, kind: 'production_alert', job: alert.job ?? 'Indigo', subject: alert.subject, text: alert.text}, id);
      sent.push({key: alert.key, to: address});
    }
    if (alert.push) {
      for (const manager of managers) {
        for (const device of store.db.prepare('SELECT binding FROM push_devices WHERE actor=?').all(manager.id)) {
          store.db.prepare('INSERT OR IGNORE INTO production_alerts (id,actor,binding,title,body,due) VALUES (?,?,?,?,?,?)')
            .run('indigo-agent:' + alert.key + ':' + device.binding, manager.id, device.binding, alert.subject.slice(0, 120),
              alert.text.split('\n').find(Boolean)?.slice(0, 200) ?? '', Date.now());
        }
      }
    }
  }
  return sent;
}

/// Queues the alerts (each key once) and records the latest status for the app.
export function applyWatch(store, {watch, feed, now = new Date()}) {
  prepareProductionAlerts(store);
  const config = store.get('indigoPlannerConfig', 'indigo') ?? {};
  const {alerts, status} = watchAlerts({watch, feed, config, now});
  store.db.exec('BEGIN IMMEDIATE');
  let sent;
  try {
    sent = queueProductionAlerts(store, alerts, config);
    store.put('indigoWatch', {id: 'latest', checkedAt: now.toISOString(), watchGeneratedAt: watch?.generatedAt ?? null, ...status,
      alerts: alerts.map(a => ({key: a.key, subject: a.subject})).slice(0, 50)});
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return {alerts, sent, status};
}

/// Sends queued production push notifications to managers' iPhones.
export async function drainProductionAlerts(store, send) {
  if (!send) return;
  prepareProductionAlerts(store);
  const due = store.db.prepare("SELECT * FROM production_alerts WHERE state='pending' AND due<=? ORDER BY due LIMIT 25").all(Date.now());
  for (const alert of due) {
    const lease = Date.now() + 60000;
    if (!store.db.prepare("UPDATE production_alerts SET due=?,attempts=attempts+1 WHERE id=? AND state='pending' AND due=?").run(lease, alert.id, alert.due).changes) continue;
    const finish = (state, reason = null, next = lease) => store.db.prepare("UPDATE production_alerts SET state=?,reason=?,due=? WHERE id=? AND state='pending' AND due=?").run(state, reason, next, alert.id, lease);
    const device = store.db.prepare('SELECT * FROM push_devices WHERE binding=? AND actor=?').get(alert.binding, alert.actor);
    if (!device || !store.get('user', alert.actor)?.enabled) { finish('cancelled'); continue; }
    let receipt;
    try { receipt = await send(device, {id: randomUUID(), collapse: alert.id.slice(0, 64), title: alert.title, body: alert.body}); }
    catch { receipt = {status: 0, reason: 'ConnectionError'}; }
    if (receipt.status === 200) { finish('accepted'); continue; }
    if (receipt.status === 410) store.db.prepare('DELETE FROM push_devices WHERE binding=?').run(alert.binding);
    const retry = receipt.status === 0 || receipt.status === 429 || receipt.status >= 500;
    finish(retry && alert.attempts < 6 ? 'pending' : 'failed', receipt.reason || String(receipt.status), Date.now() + Math.min(3600000, 30000 * 2 ** alert.attempts));
  }
}

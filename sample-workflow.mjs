import {need} from './core.mjs';
import {randomUUID} from 'node:crypto';

export function productionStaff(actor) {
  return ['operator', 'rep', 'manager'].includes(actor?.role);
}

export function reviewer(store, id) {
  const user = typeof id === 'string' && store.get('user', id);
  need(user?.enabled && ['rep', 'manager'].includes(user.role), 'Choose an active rep or manager.');
  return user.id;
}

export function queueSampleAlert(store, sample) {
  if (!sample.rep || sample.state !== 'pending') return;
  const devices = store.db.prepare('SELECT binding FROM push_devices WHERE actor=?').all(sample.rep);
  const queue = store.db.prepare('INSERT INTO sample_alerts (id,sample,rep,binding,due) VALUES (?,?,?,?,?)');
  for (const device of devices) queue.run(randomUUID(), sample.id, sample.rep, device.binding, Date.now());
}

export function makeVideoSample(store, video, rep = null) {
  const sample = store.put('sample', {
    id:video.id, family:video.id, version:1, source:'jobVideo', printiqId:video.printiqId,
    job:video.job, title:video.title, note:'', media:video.media, creator:video.creator,
    rep, state:rep ? 'pending' : 'unassigned', at:video.at, decisionAt:null,
  });
  queueSampleAlert(store, sample);
  return sample;
}

export function prepareSamples(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS push_devices (
      installation TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, binding TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sample_alerts (
      id TEXT PRIMARY KEY, sample TEXT NOT NULL, rep TEXT NOT NULL, binding TEXT NOT NULL,
      due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', reason TEXT
    );
    CREATE INDEX IF NOT EXISTS sample_alerts_due ON sample_alerts(state,due);
    BEGIN IMMEDIATE;
  `);
  try {
    const missing = store.db.prepare(`SELECT v.doc FROM records v
      WHERE v.kind='jobVideo' AND NOT EXISTS (SELECT 1 FROM records s WHERE s.kind='sample' AND s.id=v.id)`).all();
    for (const row of missing) makeVideoSample(store, JSON.parse(row.doc));
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export function assignSample(store, actor, data) {
  const sample = store.require('sample', data.id);
  need(productionStaff(actor) && (!sample.rep || [sample.rep,sample.creator].includes(actor.id) || actor.role==='manager'),
    'Only the creator, assigned rep or a manager can change this assignment.',403);
  need(['unassigned','pending'].includes(sample.state),'This version is no longer awaiting assignment.',409);
  need((sample.rep || '') === data.previousRep,'The assignment changed. Refresh the sample.',409);
  const rep = reviewer(store, data.rep);
  if (rep !== sample.rep) {
    store.db.prepare("UPDATE sample_alerts SET state='cancelled' WHERE sample=? AND state='pending'").run(sample.id);
    store.cancelMail(sample.id);
    sample.rep = rep;
    sample.state = 'pending';
    store.put('sample', sample);
    queueSampleAlert(store, sample);
  }
  return sample;
}

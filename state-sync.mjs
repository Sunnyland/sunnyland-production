// Changes-only state for the iPhone app.
//
// Every record write gets a sequence number in `record_seq`, a side table, so the `records`
// table keeps its original three columns and earlier builds of this service can still run
// against the same database. A random epoch is chosen at every service start: a cursor from
// another epoch (or another database) always gets the full state, so a restore or a rollback
// can never leave a phone with a silently incomplete copy.
import {randomUUID} from 'node:crypto';

// Record kinds the app keeps as lists, and the state field each one fills.
export const syncedKinds = {
  job: 'jobs', stock: 'stock', lot: 'lots', operation: 'operations', hold: 'holds', issue: 'issues',
  cutrule: 'cutrules', sample: 'samples', consignmentCount: 'consignmentCounts',
  consignmentTransfer: 'consignmentTransfers', consignmentOpening: 'consignmentOpenings'
};
// Lists whose rows can disappear from view (completed jobs are archived after ten working days).
// For these the delta also carries the ids still visible, so the app can drop the rest.
export const visibilityFields = ['jobs', 'samples', 'operations', 'holds', 'issues'];

export function prepareSync(store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS record_seq(kind TEXT, id TEXT, seq INTEGER NOT NULL, PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS record_seq_by_seq ON record_seq(seq);`);
  store.syncEpoch = randomUUID().slice(0, 8);
  store.syncTouch = store.db.prepare(`INSERT INTO record_seq(kind,id,seq)
    VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM record_seq))
    ON CONFLICT(kind,id) DO UPDATE SET seq=excluded.seq`);
}

export function syncCursor(store) {
  const row = store.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM record_seq').get();
  return `${store.syncEpoch}.${row.seq}`;
}

/// The sequence number to read from, or null when the cursor can't be trusted (full state needed).
export function parseCursor(store, value) {
  if (typeof value !== 'string') return null;
  const match = /^([0-9a-f]{8})\.(\d{1,15})$/.exec(value);
  if (!match || match[1] !== store.syncEpoch) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/// Records of the synced kinds changed after `since`, grouped by state field.
export function changedRecords(store, since) {
  const kinds = Object.keys(syncedKinds);
  const rows = store.db.prepare(`SELECT r.kind, r.doc FROM record_seq s JOIN records r ON r.kind=s.kind AND r.id=s.id
    WHERE s.seq > ? AND s.kind IN (${kinds.map(() => '?').join(',')}) ORDER BY r.rowid`).all(since, ...kinds);
  const changes = Object.fromEntries(Object.values(syncedKinds).map(field => [field, []]));
  for (const row of rows) changes[syncedKinds[row.kind]].push(JSON.parse(row.doc));
  return changes;
}

/// Light rows (id, job, printiqId) for the lists whose visibility can change, without parsing documents.
export function visibilityRows(store, kind) {
  const job = kind === 'job' ? 'id' : "json_extract(doc,'$.job')";
  return store.db.prepare(`SELECT id, ${job} AS job, json_extract(doc,'$.printiqId') AS printiqId,
    json_extract(doc,'$.family') AS family FROM records WHERE kind=? ORDER BY rowid`).all(kind);
}

/// Adds the newerVersionExists flag in one pass instead of comparing every sample with every other.
export function markNewerVersions(samples, allSamples = samples) {
  const latest = new Map();
  for (const s of allSamples) latest.set(s.family, Math.max(latest.get(s.family) ?? 0, s.version ?? 0));
  return samples.map(s => ({...s, newerVersionExists: (latest.get(s.family) ?? 0) > (s.version ?? 0)}));
}

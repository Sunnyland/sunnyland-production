import {openSync, fstatSync, closeSync, readSync, constants, statSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../core.mjs';
import {pressStatusHook} from './status.mjs';

// The collector hands off a completed, private file owned by the service account.
export function readPrivateReceipt(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0 || info.nlink !== 1)
      throw new Error('Expected a private receipt owned by the service account.');
    const limit = 65536;
    if (info.size > limit) throw new Error('Receipt exceeds 64 KiB.');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size);
      if (n === 0) break;
      size += n;
    }
    if (size > limit) throw new Error('Receipt exceeds 64 KiB.');
    return JSON.parse(bytes.toString('utf8', 0, size));
  } finally { closeSync(fd); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node smartstream/ingest.mjs PRIVATE_RECEIPT.json');
    const receipt = readPrivateReceipt(process.argv[2]);
    const path = join(process.env.SUNNYLAND_DATA || '/var/lib/sunnyland-production', 'production.sqlite');
    if (!statSync(path).isFile()) throw new Error('Existing service database required.');
    const store = new Store(path);
    try { console.log(JSON.stringify(pressStatusHook(store).ingest(receipt))); }
    finally { store.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

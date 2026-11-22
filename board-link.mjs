// Board links for screens (run on PrintCRM as the service user):
//   node board-link.mjs create "Indigo press"   -> prints the private board address (shown once)
//   node board-link.mjs list
//   node board-link.mjs revoke "Indigo press"
import {join} from 'node:path';
import {Store} from './core.mjs';
import {createBoardLink, revokeBoardLink} from './board.mjs';

const [action, label] = process.argv.slice(2);
const store = new Store(join(process.env.SUNNYLAND_DATA || '/var/lib/sunnyland-production', 'production.sqlite'));
try {
  if (action === 'create') {
    const key = createBoardLink(store, {label});
    console.log(`Board link for "${label}":\n  https://printcrm.sunnyland.com.au/sunnyland-production/board/${key}`);
  } else if (action === 'revoke') {
    console.log(`Revoked ${revokeBoardLink(store, label)} link(s) named "${label}".`);
  } else if (action === 'list') {
    for (const l of store.all('boardLink')) console.log(`${l.label} · created ${l.createdAt.slice(0, 10)}${l.revokedAt ? ' · revoked' : ''}`);
  } else {
    console.error('Usage: node board-link.mjs create|list|revoke "Screen name"'); process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; } finally { store.close(); }

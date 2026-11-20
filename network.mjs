import {isIP} from 'node:net';

export function normalizePeer(value) {
  if (typeof value !== 'string') return '';
  const address = value.toLowerCase();
  if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) return address.slice(7);
  return address;
}

export function parseAllowedPeers(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('SUNNYLAND_ALLOWED_PEERS must contain explicit IP addresses.');
  const entries = value.split(',').map(value => normalizePeer(value.trim()));
  if (entries.some(value => !isIP(value))) throw new Error('SUNNYLAND_ALLOWED_PEERS contains an invalid IP address.');
  return new Set(entries);
}

export function peerIsAllowed(address, peers) {
  return peers === null || peers.has(normalizePeer(address));
}

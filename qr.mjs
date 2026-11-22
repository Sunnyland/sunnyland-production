// Small QR code encoder (byte mode, error correction M, versions 1-6) for the press sign-in code on the board.
// Draws an inline SVG, so the board needs no scripts or images from elsewhere. Follows ISO/IEC 18004.
const eccPerBlock = [0, 10, 16, 26, 18, 24, 16], blocksM = [0, 1, 1, 1, 2, 2, 4];

function mul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function divisor(degree) {
  const result = new Array(degree).fill(0); result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = mul(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; }
    root = mul(root, 2);
  }
  return result;
}
function remainder(data, div) {
  const result = new Array(div.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift(); result.push(0);
    div.forEach((coef, i) => { result[i] ^= mul(coef, factor); });
  }
  return result;
}
function rawModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; result -= (25 * n - 10) * n - 55; }
  return result;
}
const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - eccPerBlock[ver] * blocksM[ver];
function alignment(ver, size) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2, result = [6];
  for (let pos = size - 7; result.length < n; pos -= step) result.splice(1, 0, pos);
  return result;
}

/// Returns the module grid (true = dark) for `text`.
export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const ver = [1, 2, 3, 4, 5, 6].find(v => 4 + 8 + bytes.length * 8 <= dataCodewords(v) * 8);
  if (!ver) throw new Error('Too long for the sign-in QR code.');
  const size = ver * 4 + 17, capacity = dataCodewords(ver) * 8;
  const bits = [], push = (value, len) => { for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(4, 4); push(bytes.length, 8); bytes.forEach(b => push(b, 8));
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // Error correction, then interleave the blocks.
  const numBlocks = blocksM[ver], eccLen = eccPerBlock[ver], raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = numBlocks - raw % numBlocks, shortLen = Math.floor(raw / numBlocks), div = divisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1)); k += dat.length;
    const ecc = remainder(dat, div); if (i < shortBlocks) dat.push(0); blocks.push(dat.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) codewords.push(b[i]); });

  const grid = Array.from({length: size}, () => new Array(size).fill(false));
  const fixed = Array.from({length: size}, () => new Array(size).fill(false));
  const set = (x, y, dark) => { grid[y][x] = dark; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  const pos = alignment(ver, size), last = pos.length - 1;
  pos.forEach((px, i) => pos.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = mask => {
    const value = (0 << 3) | mask; let rem = value; // error correction M = 00
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((value << 10) | rem) ^ 0x5412, bit = i => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fixed[y][x] && i < codewords.length * 8) { grid[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masks[m](x, y)) grid[y][x] = !grid[y][x]; };
  const penalty = () => {
    let score = 0, dark = 0;
    for (let a = 0; a < size; a++) for (const line of [grid[a], grid.map(r => r[a])]) {
      let run = 1;
      for (let b = 1; b <= size; b++) { if (b < size && line[b] === line[b - 1]) run++; else { if (run >= 5) score += run - 2; run = 1; } }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = grid[y][x]; if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += 3; }
    grid.forEach(r => r.forEach(c => { if (c) dark++; }));
    return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) { apply(m); format(m); const s = penalty(); if (s < bestScore) { best = m; bestScore = s; } apply(m); }
  apply(best); format(best);
  return grid;
}

/// Inline SVG with a 4-module quiet zone; black on white so phones read it on the dark board.
export function qrSvg(text, {size = 260} = {}) {
  const grid = qrMatrix(text), n = grid.length + 8;
  const path = grid.flatMap((r, y) => r.map((c, x) => c ? `M${x + 4} ${y + 4}h1v1h-1z` : '')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="Sign-in QR code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

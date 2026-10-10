/* vr/src/qr.js - tiny QR Code encoder (byte mode, error-correction level M, versions 1-10), written for
   Kawaii Cat Attack!! (original code, no third-party QR library, no network). Used at BUILD time only (vite.config.js ->
   src/feedback.js) to draw the "Scan to send feedback" code on the 2D start card from FEEDBACK_URL. Legal +
   TRY-IT-OUT-SCOPE.md section 8: no QR web service, no logo in the code, plain URL only.
   Follows ISO/IEC 18004 (same layout rules as every reader): finder / timing / alignment patterns, BCH format + version
   info, Reed-Solomon over GF(2^8) with 0x11D, block interleaving, the 8 masks and the 4 penalty rules.
   Gaming Engineer 2, 2026-10-09. */

export const QR_ECL = 'M';
const ECL_BITS = 0; // format-info bits for level M (L = 1, M = 0, Q = 3, H = 2)
// Per version (index = version, 0 unused): EC codewords per block and number of blocks, level M.
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
export const MIN_VERSION = 1, MAX_VERSION = 10;

/* ---------- GF(256) Reed-Solomon ---------- */
function gfMul(a, b) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((b >>> i) & 1) * a; }
  return z & 0xff;
}
export function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) r[j] = gfMul(r[j], root) ^ (j + 1 < degree ? r[j + 1] : 0);
    root = gfMul(root, 2);
  }
  return r;
}
export function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    for (let i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], f);
  }
  return r;
}

/* ---------- capacity ---------- */
export function sizeOf(version) { return version * 4 + 17; }
export function rawCodewords(version) {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) { const a = Math.floor(version / 7) + 2; n -= (25 * a - 10) * a - 55; if (version >= 7) n -= 36; }
  return Math.floor(n / 8);
}
export function dataCodewords(version) { return rawCodewords(version) - EC_PER_BLOCK[version] * NUM_BLOCKS[version]; }
export function countBits(version) { return version >= 10 ? 16 : 8; }
export function blockLayout(version) {
  const nb = NUM_BLOCKS[version], ecc = EC_PER_BLOCK[version], raw = rawCodewords(version);
  const numShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  return { numBlocks: nb, ecc, numShort, shortData: shortLen - ecc, raw };
}

/* ---------- bit stream (byte mode) ---------- */
function utf8(text) { return Array.from(new TextEncoder().encode(String(text))); }
export function pickVersion(bytes) {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) if (4 + countBits(v) + 8 * bytes.length <= 8 * dataCodewords(v)) return v;
  throw new Error(`qr: text too long for version ${MAX_VERSION}-M (${bytes.length} bytes)`);
}
export function encodeData(bytes, version) {
  const bits = [];
  const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4); push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);
  const cap = dataCodewords(version) * 8;
  push(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}
export function interleave(data, version) {
  const { numBlocks, ecc, numShort, shortData } = blockLayout(version);
  const div = rsDivisor(ecc), blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortData + (i < numShort ? 0 : 1), dat = data.slice(k, k + len); k += len;
    const ec = rsRemainder(dat, div);
    if (i < numShort) dat.push(-1); // hole: short blocks have one data codeword less
    blocks.push(dat.concat(ec));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) for (let j = 0; j < numBlocks; j++) if (!(i === shortData && j < numShort)) out.push(blocks[j][i]);
  return out;
}

/* ---------- matrix ---------- */
function grid(size, v) { return Array.from({ length: size }, () => new Array(size).fill(v)); }
/** Function-module map + the fixed patterns (finders, separators, timing, alignment, dark module, format/version areas). */
export function functionModules(version) {
  const size = sizeOf(version), fn = grid(size, false), m = grid(size, 0);
  const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = dark ? 1 : 0; fn[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[version], n = al.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  for (const copy of formatPositions(size)) for (const [x, y] of copy) set(x, y, false); // format areas (filled by the mask step)
  set(8, size - 8, true); // dark module
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) { const b = (bits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }
  return { size, fn, m };
}
export function formatBits(mask, eclBits = ECL_BITS) {
  const data = (eclBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
/** The 15 (x, y) module positions of each format-info copy, bit index 0 first (bit 14 = MSB). */
export function formatPositions(size) {
  const a = [], b = [];
  for (let i = 0; i <= 5; i++) a.push([8, i]);
  a.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
  for (let i = 0; i < 8; i++) b.push([size - 1 - i, 8]);
  for (let i = 8; i < 15; i++) b.push([8, size - 15 + i]);
  return [a, b];
}
export const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
/** Zigzag order of the data modules: [x, y] pairs, same walk as every reader. */
export function dataPositions(size, fn) {
  const out = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fn[y][x]) out.push([x, y]);
    }
  }
  return out;
}
function penalty(m) {
  const size = m.length; let score = 0, dark = 0;
  const line = (get) => {
    let s = '';
    for (let i = 0; i < size; i++) s += get(i);
    for (const run of s.match(/0+|1+/g)) if (run.length >= 5) score += run.length - 2;
    score += 40 * ((s.match(/10111010000/g) || []).length + (s.match(/00001011101/g) || []).length);
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  for (const row of m) for (const c of row) dark += c;
  const total = size * size;
  score += 10 * (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score;
}
function applyMaskAndFormat(base, fn, codewords, positions, mask) {
  const size = base.length, m = base.map((r) => r.slice()), f = MASKS[mask];
  let i = 0;
  for (const [x, y] of positions) {
    const bit = i < codewords.length * 8 ? (codewords[i >>> 3] >>> (7 - (i & 7))) & 1 : 0; i++;
    m[y][x] = bit ^ (f(x, y) ? 1 : 0);
  }
  const bits = formatBits(mask);
  for (const copy of formatPositions(size)) copy.forEach(([x, y], k) => { m[y][x] = (bits >>> k) & 1; });
  return m;
}

/** Encode text -> { version, size, mask, modules (rows of 0/1, no quiet zone) }. */
export function qrEncode(text) {
  const bytes = utf8(text), version = pickVersion(bytes);
  const codewords = interleave(encodeData(bytes, version), version);
  const { size, fn, m } = functionModules(version), positions = dataPositions(size, fn);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = applyMaskAndFormat(m, fn, codewords, positions, mask), p = penalty(cand);
    if (!best || p < best.penalty) best = { mask, penalty: p, modules: cand };
  }
  return { version, size, mask: best.mask, modules: best.modules };
}

/** Inline SVG (one path, quiet zone of 4 modules, no logo, no image, no external reference). */
export function qrSvg(text, { label = 'QR code', quiet = 4, className = 'qr' } = {}) {
  const { size, modules } = qrEncode(text), n = size + quiet * 2;
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<svg class="${esc(className)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

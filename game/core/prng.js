/* game/core/prng.js — seeded PRNG + state hashing. Gaming Engineer, 2026-10-06.
   Rules: the sim NEVER calls Math.random or Date. Every random choice comes from a Prng owned by the game state,
   so the same seed + the same input log replays bit-for-bit (rollback groundwork).
   Build rule: only `export function` / `export const` (the proto builder strips the `export ` prefix). */

/** mulberry32: small, fast, 2^32 period, good enough for gameplay randomness (not for security). */
export function createPrng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** float in [0,1) */
    next,
    /** float in [a,b) */
    range: (a, b) => a + (b - a) * next(),
    /** integer in [0,n) */
    int: (n) => Math.floor(next() * n),
    /** pick one element */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** chance in [0,1] */
    chance: (p) => next() < p,
    /** current internal state (for hashing / snapshots) */
    getState: () => s,
    setState: (v) => { s = v >>> 0; },
  };
}

/** Turn any string into a 32-bit seed (FNV-1a). */
export function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Incremental FNV-1a style hasher over numbers (quantised) and strings; used for state hashes in tests and netcode. */
export function createHasher() {
  let h = 0x811c9dc5;
  const mix = (n) => { h ^= n & 0xff; h = Math.imul(h, 0x01000193); };
  const api = {
    /** Hash a number. Floats are quantised to 1e-4 so equal sims hash equal; tiny formatting noise does not matter. */
    num(x) {
      const q = Math.round(x * 10000) | 0;
      mix(q); mix(q >>> 8); mix(q >>> 16); mix(q >>> 24);
      return api;
    },
    str(s) { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(0xff); return api; },
    digest() { return (h >>> 0).toString(16).padStart(8, '0'); },
  };
  return api;
}

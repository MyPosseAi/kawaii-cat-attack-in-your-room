/* game/core/happiness.js — P0a "Kitten Happiness" meter (ALL HANDS playable slice, GE1 2026-10-10). The visible goal of the
   3-minute slice: ONE meter that fills from playing with the kittens and celebrates when full. Pure, deterministic, no DOM,
   no Math.random / Date, unit-free (the host draws `pct`).
   Sources (meter units of HAPPY.full = 100): stroke (roomcat 'purr'), treat ('eat'), laser catch ('catch'), near miss,
   pounce (a miss still counts: the kitten PLAYED), toss landing ('land' from 'toss'), play (wand bat, big leap, hand climb),
   combo. Each source has a per-second cap (token bucket: a frantic stroke storm cannot fill it in 10 s; the mix fills it).
   Decay: after idleS with no source the meter leaks decayPerS per second (never below 0). Fill target: ~2-3 min of normal
   play (measured by the bot in game/test/p0a-slice.test.mjs test 2: see the table in docs/P0A-SLICE.md).
   Full: { type: 'happy_full', level } once, the celebration runs celebrateS (sources are paused), then { type: 'happy_next',
   level + 1 } and the meter restarts at restartPct of full for the next level (same size every level: no
   streak to lose, no timer to beat: the fairness / dark-pattern rule).
   API: createHappiness(cfg?) -> h; happinessAdd(h, source, n = 1) -> units gained; happinessStep(h, dtMs) -> events (a NEW
   array only when something happened, HAPPY_NONE otherwise); happinessFromEvents(h, simEvents) -> units gained (maps the
   roomcat events: the host calls it with session.events each step, then happinessStep; a toss pays only when its landing says
   happy = gentle); happinessState(h) -> { value, pct,
   level, celebrating, idleS, fills }; happinessHash(h, hasher).
   Build rule: only `export function` / `export const`; private names carry the `hp` prefix. */

export const HAPPY_VERSION = 1;
export const HAPPY = Object.freeze({
  full: 100,
  gain: Object.freeze({ stroke: 0.8, treat: 8.5, catch: 3.0, near_miss: 1.2, pounce: 0.6, toss: 6.5, play: 1.3, combo: 4.5 }), // GDXE 2026-10-10 (owner's Quest test): treat 7.5 -> 8.5 (Build 2 item 5: a real player is 1.3x slower than the bot). P0a Build 1 (GDXE fix 2): stroke 0.65 -> 0.8, toss 5.5 -> 6.5; + catch 3.5 / near_miss 1.6 (fix 1 turned catches into near misses)
  // per-source cap in units per second (token bucket; the bucket holds max(1.5 gains, burstS seconds of the cap))
  capPerS: Object.freeze({ stroke: 1.0, treat: 0.55, catch: 0.35, near_miss: 0.35, pounce: 0.22, toss: 0.55, play: 0.38, combo: 0.33 }),
  burstS: 4,              // a bucket holds this many seconds of its cap (2 catches in a row pay in full, then it throttles)
  idleS: 6,               // no source for this long -> decay starts
  decayPerS: 0.35,        // ... and the meter leaks this per second (a 100 meter takes ~5 min to empty: never punishing)
  celebrateS: 3,          // the celebration (confetti / purr chorus) length; sources are ignored meanwhile
  restartPct: 0.15,       // the next level starts here (the first fill was the hard one; levels never get bigger)
  levelMax: 999,
});
export const HAPPY_SOURCES = Object.freeze(Object.keys(HAPPY.gain));
export const HAPPY_NONE = Object.freeze([]);

/** create the meter. cfg overrides HAPPY (gain / capPerS as whole tables). */
export function createHappiness(cfg = null) {
  const K = cfg ? Object.freeze(Object.assign({}, HAPPY, cfg)) : HAPPY;
  const bucket = {}; for (const k of HAPPY_SOURCES) bucket[k] = hpBucketMax(K, k);
  return { K, v: 0, level: 1, idleMs: 0, celebrateMs: 0, fills: 0, total: 0, bucket, by: {} };
}
function hpBucketMax(K, k) { const a = K.gain[k] * 1.5, b = K.capPerS[k] * K.burstS; return a > b ? a : b; }
/** feed the meter from a source; returns the units actually gained (0 while celebrating, 0 past the per-source cap) */
export function happinessAdd(h, source, n = 1) {
  const K = h.K, g = K.gain[source];
  if (!g || !(n > 0) || h.celebrateMs > 0) return 0;
  const want = g * n, b = h.bucket[source], got = want <= b ? want : b;
  if (!(got > 0)) return 0;
  h.bucket[source] = b - got; h.v += got; h.total += got; h.idleMs = 0; h.by[source] = (h.by[source] || 0) + 1;
  if (h.v > K.full) h.v = K.full;
  return got;
}
/** one step of dtMs: buckets refill, idle decay, the full -> celebrate -> next-level sequence. Returns the events. */
export function happinessStep(h, dtMs) {
  const K = h.K, dt = dtMs / 1000; let out = null;
  for (const k of HAPPY_SOURCES) { const cap = hpBucketMax(K, k), b = h.bucket[k] + K.capPerS[k] * dt; h.bucket[k] = b > cap ? cap : b; }
  if (h.celebrateMs > 0) {
    h.celebrateMs -= dtMs;
    if (h.celebrateMs <= 0) { h.celebrateMs = 0; if (h.level < K.levelMax) h.level++; h.v = K.full * K.restartPct; h.idleMs = 0; (out || (out = [])).push({ type: 'happy_next', level: h.level }); }
    return out || HAPPY_NONE;
  }
  if (h.v >= K.full - 1e-9) { h.v = K.full; h.fills++; h.celebrateMs = K.celebrateS * 1000; (out || (out = [])).push({ type: 'happy_full', level: h.level, fills: h.fills }); return out; }
  h.idleMs += dtMs;
  if (h.idleMs > K.idleS * 1000 && h.v > 0) { h.v -= K.decayPerS * dt; if (h.v < 0) h.v = 0; }
  return out || HAPPY_NONE;
}
/** map roomcat.js session.events (this step) onto the sources; returns the units gained */
export function happinessFromEvents(h, evs) {
  let got = 0;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i], t = e.type;
    if (t === 'purr') got += happinessAdd(h, 'stroke');
    else if (t === 'eat') got += happinessAdd(h, 'treat');
    else if (t === 'catch') got += happinessAdd(h, 'catch');
    else if (t === 'near_miss') got += happinessAdd(h, 'near_miss');
    else if (t === 'pounce') { if (!e.catch) got += happinessAdd(h, 'pounce'); }
    else if (t === 'land') { if (e.happy) got += happinessAdd(h, 'toss'); else if (e.from === 'bat') got += happinessAdd(h, 'play'); } // (only a GENTLE toss landing pays: a hard one, or one during a wander-off, earns nothing:)
    else if (t === 'big_leap' || t === 'hand_climb') got += happinessAdd(h, 'play');
    else if (t === 'combo') got += happinessAdd(h, 'combo');
  }
  return got;
}
/** the HUD view */
export function happinessState(h) {
  return { value: Math.round(h.v * 100) / 100, pct: Math.round(h.v / h.K.full * 1000) / 1000, level: h.level, celebrating: h.celebrateMs > 0, idleS: Math.round(h.idleMs / 100) / 10, fills: h.fills };
}
/** fold the meter into a hasher (createHasher) */
export function happinessHash(h, hasher) { hasher.num(h.v).num(h.level).num(h.idleMs).num(h.celebrateMs).num(h.fills).num(h.total); for (const k of HAPPY_SOURCES) hasher.num(h.bucket[k]); return hasher; }

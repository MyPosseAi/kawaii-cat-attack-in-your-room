/* game/core/lasertag-fun.js — Laser Tag FUN LAYER (docs/GAMES-FUN-AUDIT.md section 3.2 + 5, dev/impl/SK-106.md).
   Pure, deterministic, unit-agnostic (BL on the desktop, metres in VR): the same functions serve lasertag.js (v7) and
   lasertag-room.js. It reads the sim's events for one step and the context, updates a small state record and
   returns the "moments" the HUD / the Games Master caption:
     streak    {type:'streak', n, mult}      consecutive near misses / dodges, each within streakWindowMs of the last:
                                             mult = min(1 + floor(n / 2), streakCap) (x2 at 2, x3 at 4+). The multiplier
                                             applies to the NEAR-MISS BONUS ONLY (the base curve is untouched); the sim
                                             reads it back from the annotated near_miss event (mult, shown). n = 0 when
                                             the window lapses (the HUD clears the chip). A catch ends the round, so it
                                             ends the streak too.
     near_miss (annotated in place)          + streak, mult, shown = round(bonus x mult): "Whisker-close! +N x2" at the dot
     comeback  {type:'comeback', n}          >= 3 cats within comebackR of the dot, then within comebackMs none within it
                                             and not caught (cooldown comebackCdMs)
     pb_close  {type:'pb_close'}             once per round: with best > 0, the base curve projects the best <= pbCloseS away
     new_best  {type:'new_best'}             once per round: the points crossed best
   No Math.random / Date / Math.hypot; no allocation per step beyond the returned events (0 on a quiet step); everything
   that changes the score sits in the state and goes into the sim hash via ltFunHash. Fairness (dark-pattern rule): no
   "don't lose your streak" text anywhere; the chip just shows the multiplier. */

/** knobs (the desktop values; lasertag-room.js passes metres) */
export const LT_FUN = Object.freeze({
  streakWindowMs: 6000,   // a near miss / dodge keeps the streak alive when it comes within this of the last one
  streakCap: 3,           // x3 at 4+ in a row (x2 at 2)
  comebackR: 2.0,         // comeback: >= 3 cats within this of the dot (BL; VR 0.5 m) ...
  comebackMs: 1000,       // ... then none within it inside this time (and not caught)
  comebackCdMs: 10000,    // one comeback caption per 10 s
  pbCloseS: 10,           // "best is close" when the curve projects the personal best within this many seconds
});

export function createLtFun(cfg = null) {
  const K = cfg ? Object.assign({}, LT_FUN, cfg) : LT_FUN;
  return { K, n: 0, mult: 1, lastMs: -1e9, crowdMs: -1e9, comebackMs: -1e9, comebacks: 0, pbClose: false, newBest: false };
}
/** the streak multiplier for the n-th consecutive near miss (pure) */
export function ltStreakMult(n, cap = LT_FUN.streakCap) { return Math.min(cap, 1 + Math.floor(n / 2)); }
/** distance with basic ops + sqrt only (project rule: Math.hypot is not correctly rounded on every engine) */
function ltfDist(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

/** ONE sim step. simEvents = the sim's events of this step (near_miss entries are annotated in place); ctx =
    { elapsedMs, rate, points, best, growth, dot: {x, y}, cats: [{x, y}, ...], caught }. Returns the fun events (a new
    array only when there is something to say; FUN_NONE otherwise, never mutate it). */
export const LT_FUN_NONE = Object.freeze([]);
export function ltFunStep(fs, simEvents, ctx) {
  const K = fs.K, t = ctx.elapsedMs;
  let out = null;
  // 1. streak: lapse first (so a near miss after a lapse starts at 1), then this step's near misses in order
  if (fs.n > 0 && t - fs.lastMs > K.streakWindowMs) { fs.n = 0; fs.mult = 1; (out || (out = [])).push({ type: 'streak', n: 0, mult: 1 }); }
  for (const e of simEvents) {
    if (e.type !== 'near_miss') continue;
    fs.n = t - fs.lastMs <= K.streakWindowMs ? fs.n + 1 : 1; fs.lastMs = t;
    fs.mult = ltStreakMult(fs.n, K.streakCap);
    e.streak = fs.n; e.mult = fs.mult; e.shown = Math.round(e.bonus * fs.mult);
    (out || (out = [])).push({ type: 'streak', n: fs.n, mult: fs.mult });
  }
  // 2. comeback: a crowd (>= 3 cats within comebackR), then a clean break inside comebackMs
  if (!ctx.caught) {
    const d = ctx.dot, cats = ctx.cats, R = K.comebackR; let near = 0;
    for (let i = 0; i < cats.length; i++) { const c = cats[i]; if (ltfDist(c.x - d.x, c.y - d.y) <= R) near++; }
    if (near >= 3) fs.crowdMs = t;
    else if (near === 0 && t - fs.crowdMs <= K.comebackMs && t - fs.comebackMs >= K.comebackCdMs) { fs.comebackMs = t; fs.comebacks++; fs.crowdMs = -1e9; (out || (out = [])).push({ type: 'comeback', n: fs.comebacks }); }
  }
  // 3. personal best chase (best > 0 only; the base curve projection, near misses would only make it sooner)
  if (ctx.best > 0) {
    if (!fs.newBest && ctx.points >= ctx.best) { fs.newBest = true; fs.pbClose = true; (out || (out = [])).push({ type: 'new_best' }); }
    else if (!fs.pbClose && ctx.growth > 1 && ctx.points + ctx.rate * (Math.pow(ctx.growth, K.pbCloseS) - 1) / Math.log(ctx.growth) >= ctx.best) { fs.pbClose = true; (out || (out = [])).push({ type: 'pb_close' }); }
  }
  return out || LT_FUN_NONE;
}
/** fold the fun state into the sim hasher (every field that can change the score or an event) */
export function ltFunHash(fs, h) { return h.num(fs.n).num(fs.mult).num(fs.lastMs).num(fs.crowdMs).num(fs.comebackMs).num(fs.comebacks).num(fs.pbClose ? 1 : 0).num(fs.newBest ? 1 : 0); }
/** the HUD view of the state (no allocation when nothing changed is the host's job; this is a tiny object) */
export function ltFunState(fs) { return { streak: fs.n, mult: fs.mult, comebacks: fs.comebacks, pbClose: fs.pbClose, newBest: fs.newBest }; }

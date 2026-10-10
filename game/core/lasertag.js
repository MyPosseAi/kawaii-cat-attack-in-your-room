/* game/core/lasertag.js — LASER TAG (2026-10-09 playtest: the laser race "is not very fun"). YOU are the laser dot.
   The player steers the dot with the pointer / touch (later the VR hand ray); the dot shines on the floor and the drawn
   windows: it slides along x toward the pointer at a capped speed and is ALWAYS on the surface under it (v3: a laser dot
   is a projection, it never glides through the air where no cat could reach it). Cats join slowly (1 at the start, one
   more every ~10 s, the gap shrinking gently to 6 s, up to 7 cats); they run, STALK (creep), CLIMB (v3: planned hops from
   under or beside a ledge, via another ledge when needed, like the roam AI) and POUNCE at the dot with the existing
   cat controller (cat.js stepCat) and the laser race chaser (aiActions) plus a pounce / paw-slap layer here. v4: cats
   also DROP DOWN (walk off the nearer ledge end) when the dot is below their window, so a dot parked under a cat pile is
   caught (Code Review E MUST 1). v5: the AI judges the dot's LEVEL (floor / which window) through a short hysteresis
   (levelHoldMs) so a pointer flicked across a window seam or a ledge lip every frame cannot cancel a drop plan against
   the same-level chase (Code Review I MUST 1), climb plans are dropped as soon as the judged level leaves their goal
   ledge (no cat finishes a climb to a window the dot already left: MUST 2), and the GUARD flanker never climbs. Every catch is telegraphed: a standing pounce has the 350 ms butt-wiggle (the cat stops
   first), a running pounce (cats #3+) a 150 ms crouch, a paw slap a 250 ms raised-paw crouch (event 'tell', state cats[].tell). CAUGHT = a pounce's leap lands on the dot, a jump lands on it, or a paw slap hits it ->
   the round is over. SCORE grows EXPONENTIALLY with the time survived: points/s = base * growth^t (default 10 * 1.06^t,
   shown as the multiplier x growth^t); a near miss (a pounce that lands close but not on the dot) adds 2 s worth of the
   current rate. Spec + feel numbers: docs/GAME-LASER-TAG.md. NEW MODE: createGame / the laser race are untouched.
   Deterministic + replayable for server verification: no Math.random / Date; the prng is seeded; the input is the
   pointer target quantised to 1/64 BL; ONLY 'playing' steps change the sim and only they are logged, so pauses,
   countdowns and blur never affect a replay. replayLaserTag(opts, log) + encode/decodeLaserTagLog (run-length text).
   v7 (fun pass, docs/GAMES-FUN-AUDIT.md 3.2 / 5): the FUN LAYER (lasertag-fun.js: streak multiplier on the near-miss
   bonus, comeback and personal-best moments), the per-cat COACH override (LASER_TAG.coach, cat 1 only, round 1 of an
   unranked session) and the hidden ASSIST (createLaserTag({ assist: { joinScale, coach } })): both are applied at round
   start only, both go into digest() and the replay hash, and `ranked: true` (the desktop ranked start + the server
   replay) forces them OFF (Manager decision: rubber-banding never decides a ranked prize; VR / unranked may use it). */
import { createPrng, createHasher } from './prng.js';
import { createWorld } from './physics.js';
import { createCat, stepCat, aiActions } from './cat.js';
import { createModeMachine } from './mode.js';
import { createFixedLoop, STEP_MS, STEP_S } from './loop.js';
import { TUNING } from './tuning.js';
import { clamp, sign, smooth01 } from './vec.js';
import { DEFAULT_WORLD } from './world.js'; // (not game.js: desktop-only code, not part of this build)
import { LT_FUN, createLtFun, ltFunStep, ltFunHash, ltFunState } from './lasertag-fun.js';

/** review SHOULD 4: the ONE standard ranked world ('std16x8' on the server) = the core DEFAULT_WORLD (game.js).
    The proto, the desktop ranked start and the server replay bundle all use this constant; never copy the numbers. */
export const LASER_TAG_STD_WORLD = DEFAULT_WORLD;
export const LASER_TAG_STD_WORLD_ID = 'std16x8';
/** distance with basic ops + sqrt only (sqrt is correctly rounded in IEEE 754; Math.hypot is NOT required to be, so it
    can differ between engines: review SHOULD 1, project rule in vec.js) */
function ltDist(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

/** Feel numbers (PROVISIONAL until playtested). Override any of them with createLaserTag({ ..., tag: { ... } }). */
export const LASER_TAG = Object.freeze({
  version: 7,             // v7 (fun pass): streak multiplier on the near-miss bonus (lasertag-fun.js), comeback / personal-best moments, coach cat knob + hidden assist in the hash (ranked forces both off); v6 (fun tuning, Code Review K SHOULD 1): slap dodge window, no pinned-cat catch, slower joins (15 s / 0.86 / 7 s), 1.3x slower on a floor-only world, pounce knobs; v5 was level hysteresis, stale-climb cancel, guard never climbs, closed seams; v4 was drop-down AI, slap tell 250 ms, near-miss 1.4 BL, hop re-plan cooldown; v1..v4 runs are not accepted
  levelHoldMs: 800,       // v5: time constant of the AI's judged dot level (floor / window): an exponential share of the recent time the dot spent off the judged surface...
  levelAwayShare: 0.6,    // ...and the judgement moves only when that share passes this: an honest move re-judges in ~0.75 s, a 50/50 flicker (seam, lip, window <-> floor, at any rate up to ~1 s periods) never moves it, a 95/5 blip settles on the 95 side (the judgement is STABLE under any flicker, the cats commit)
  basePts: 10,            // points per second at t = 0
  growth: 1.06,           // points/s multiplies by this every second survived (x5.7 at 30 s, x33 at 60 s, x190 at 90 s)
  stepGrowth: 1.0009716201860972, // = growth^(1/60) as a LITERAL so every engine multiplies the same bits (only used when growth is 1.06)
  nearMissS: 2,           // a near miss pays this many seconds of the current rate
  nearMissBL: 1.4,        // ...when the pounce's paws came within this distance of the dot without catching it (v4: 1.0 -> 1.4, the "close!" moments QA liked had almost vanished)
  maxCats: 7,             // the cap (<= 10 coats)
  firstJoinMs: 15000,     // cat 2 joins after 15 s (v6: 10 -> 15, the one-cat opening is the tutorial)
  joinDecay: 0.86,        // each next gap = previous * 0.86 ... (v6: 0.9 -> 0.86, the pack still fills within the minute)
  minJoinMs: 7000,        // ... but never under 7 s  => joins at 15, 27.9, 39.0, 48.5, 56.7, 63.9 s (7 cats; v5 was 10, 19, 27.1, 34.4, 41.0, 47.0)
  oneLaneJoinScale: 1.3,  // v6: on a world with NO windows (the desktop overlay with no ledges) the join gaps are 1.3x (19.5, 36.3, 50.7, 63.1, 73.7, 83.0 s): every cat shares the dot's one lane there, and 3 cats on a 16 BL lane were a wall (floor-only human p50 23 s -> 36 s). The standard ranked world always has windows, so ranked play is untouched
  joinGraceMs: 1200,      // a cat that just walked in cannot catch for this long
  flankBL: 2.5,           // a FLANKER heads for this far past the dot on the side away from the other cats
  guardBL: 4.0,           // v4: a FLANKER farther than this from the dot GUARDS the room half the pack is not in (a 7 BL/s dot outruns any pack that all runs the same way)
  guardInBL: 2.5,         // v4: ...standing this far from that wall
  cutS: 1.0,              // a CUTTER aims where the dot will be in this many seconds
  rushFrom: 2,            // cats #3 and later may pounce from a run (short crouch telegraph instead of the wiggle)
  rushTellMs: 150,        // v3: a running pounce is announced this long before the leap (event 'tell', state cats[].tell)
  climbTimeoutMs: 5000,   // v3 climb AI: a hop plan that has not landed on its ledge by then is dropped and re-planned
  climbRetryMs: 1000,     // v4: ...after this cooldown (no twitching between plans)
  campHoldBL: 3.0,        // v5 ambush: a flanker / cutter on a window keeps it while the dot is on the floor farther than this in x (section 3)
  climbCommitMs: 3000,    // v5: after a climb plan was dropped because the dot left for the floor, the next plans are COMMITTED (not droppable) for this long: a dot bobbing floor <-> window at the hold's cadence cannot walk the pack back and forth between the chase and the launch spot
  dropOutBL: 0.4,         // v4 drop-down: a cat on a window with the dot BELOW walks to the nearer ledge end + this far out and falls
  climbReachBL: 2.85,     // a ledge this far above the cat's surface is still reachable (a full charge rises 2.94 BL in the sim)
  climbLandBL: 0.8,       // a beside hop aims to land this far inside the ledge's near end
  climbRunUpBL: 0.7,      // a beside hop runs this far before the charge (the flight table is built the same way)
  multCap: 1000,          // the multiplier stops growing at x1000 (t ~ 118.5 s): points/s then stay at base * 1000
  dotSpeed: 7,            // BL/s cap of the dot (cats: run 1.25, dash 4.0) — the player can always outrun ONE cat
  dotSnapBL: 0.25,        // pointing this little below a window's top still counts as on it
  quant: 64,              // input quantisation: 1/64 BL (exact in binary floats)
  catchBL: 0.4,           // paw point to dot distance that is a catch
  slapBL: 0.3,            // paw slap reach (dot almost under the cat)
  dodgeMs: 100,           // v6: a paw slap catches only a dot that has been under that paw for this long (6 steps); a dot flashing through (7 BL/s crosses the 0.8 BL paw column in ~7 steps) dodges it and is paid a near miss (section 2.1)
  dodgeAboveBL: 2.0,      // v6: ...counting the dot as in the paw column while its JUDGED level is within this of the paw (so a flicker across a lip never resets the count)
  pounceP: 0.10,          // standing-pounce chance per step for cat #1 once the dot is in its band (v6 knob; the running pounce uses 2x)
  pouncePStep: 0.01,      // ...+ this per later cat
  cooldownMs: 1400,       // ms between two pounces of cat #1, 100 ms less per later cat...
  cooldownMinMs: 600,     // ...down to this
  slapArmMs: 250,         // a slap catches only after the paw is raised this long (the telegraph: event 'tell' + the crouch pose; v4: 150 -> 250, above human reaction time)
  maxRunMs: 600000,       // 10 min cap: the round ends 'time_cap' with the score kept (server sanity bound)
  // v7 fun layer (lasertag-fun.js; docs/GAMES-FUN-AUDIT.md section 5): the streak multiplies the NEAR-MISS BONUS only
  streakWindowMs: LT_FUN.streakWindowMs, // a near miss / dodge within this of the last one extends the streak (x2 at 2, x3 at 4+)
  streakCap: LT_FUN.streakCap,           // the streak multiplier cap (x3)
  comebackR: LT_FUN.comebackR,           // comeback: >= 3 cats within this many BL of the dot, then none within comebackMs
  comebackMs: LT_FUN.comebackMs,
  // v7 COACH CAT (audit section 2 #8, cat-1-only sim C1: slow-circle novices 8.2 -> 20.2 s, human 48.0 -> 49.6 s): the
  // per-cat override for brains with k < coach.k, applied ONLY when createLaserTag({ assist: { coach: true } }) and not
  // ranked (round 1 of an unranked VR session; the director decides). Cats 2-7 keep the numbers above.
  coach: Object.freeze({ k: 1, pounceP: 0.04, cooldownMs: 2600, slapArmMs: 600, dodgeMs: 400 }),
  assistMin: 0.8, assistMax: 1.3, // v7 hidden assist (B5): the join-gap scale the director may ask for is clamped to this
  catOrder: Object.freeze(['shadow', 'biscuit', 'pebble', 'confetti', 'cotton', 'latte', 'nectarine', 'bowtie']),
});

/** Closed form of the score curve without near misses (docs + HUD previews): base * (growth^t - 1) / ln(growth). */
export function laserTagPointsAt(tS, tag = LASER_TAG) { const L = Math.log(tag.growth); return tag.basePts * (Math.pow(tag.growth, tS) - 1) / L; }

/** Join schedule in ms: [0, 10000, 19000, ...] up to maxCats (pure, used by the sim and the tests). */
export function laserTagJoinTimes(tag = LASER_TAG, scale = 1) {
  const out = [0]; let gap = tag.firstJoinMs * scale, t = 0;
  for (let i = 1; i < tag.maxCats; i++) { t += gap; out.push(Math.round(t)); gap = Math.max(tag.minJoinMs * scale, gap * tag.joinDecay); }
  return out;
}
/** v6: the join-gap scale for a world: oneLaneJoinScale when the world has no windows (the floor is the only lane, every
    cat shares it with the dot), 1 otherwise. Pure; the sim and the tests use it. */
export function laserTagJoinScale(world, tag = LASER_TAG) { const n = world && world.platforms ? world.platforms.filter((p) => !p.floor).length : 0; return n ? 1 : tag.oneLaneJoinScale; }

/** v7 (B5): the ASSIST a round actually runs with. assist = { joinScale, coach } from the director;
    joinScale is clamped to [assistMin, assistMax], coach is a boolean; `ranked` forces both off (joinScale 1, no coach).
    The result goes into the digest and the replay hash, so a ranked claim can never carry a hidden hand. Pure. */
export function laserTagAssist(assist = null, ranked = false, tag = LASER_TAG) {
  if (ranked || !assist) return { joinScale: 1, coach: false };
  const js = Number.isFinite(+assist.joinScale) ? +assist.joinScale : 1;
  return { joinScale: Math.min(tag.assistMax, Math.max(tag.assistMin, js)), coach: !!assist.coach && !!tag.coach };
}
/** v7 (step 6) the director's rubber-band rule between rounds, pure: given the previous scale and the finished
    rounds' [{ timeS, caught }] (oldest first), returns the next joinScale: +10 % after 2 consecutive catches under 15 s
    (cap +30 %), -10 % after a round over 90 s (cap -20 %), else the previous scale. Never shown or captioned. */
export function laserTagRubberBand(prevScale = 1, rounds = [], tag = LASER_TAG) {
  const n = rounds.length; if (!n) return laserTagAssist({ joinScale: prevScale }, false, tag).joinScale;
  const last = rounds[n - 1], prev = rounds[n - 2];
  let s = prevScale;
  if (last.caught && last.timeS < 15 && prev && prev.caught && prev.timeS < 15) s = Math.min(tag.assistMax, prevScale * 1.1);
  else if (last.timeS > 90) s = Math.max(tag.assistMin, prevScale * 0.9);
  return laserTagAssist({ joinScale: s }, false, tag).joinScale;
}

/** Run-length text encoding of an input log ([[qx, qy], ...]) for upload: "qx.qy*n,qx.qy,..." */
export function encodeLaserTagLog(log) {
  const parts = [];
  for (let i = 0; i < log.length;) {
    let j = i + 1; while (j < log.length && log[j][0] === log[i][0] && log[j][1] === log[i][1]) j++;
    parts.push(log[i][0] + '.' + log[i][1] + (j - i > 1 ? '*' + (j - i) : '')); i = j;
  }
  return parts.join(',');
}
/** Decode the run-length text. maxSteps caps the TOTAL decoded steps (review MUST 1): the server passes the claimed
    `steps` (<= 36,000) and the decoder throws BEFORE expanding a run that would pass it, so a tiny body like
    "0.0*36000,0.0*36000,..." can never allocate millions of entries. Default = the 10 min cap (36,000 steps). */
export function decodeLaserTagLog(s, maxSteps = 36000) {
  const out = [];
  if (!s) return out;
  const cap = Math.min(36000, Math.max(0, Math.floor(+maxSteps) || 0));
  let total = 0;
  for (const p of String(s).split(',')) {
    const m = /^(-?\d+)\.(-?\d+)(?:\*(\d+))?$/.exec(p);
    if (!m) throw new Error('bad laser tag log entry: ' + p);
    const n = m[3] ? +m[3] : 1;
    if (n > 36000) throw new Error('laser tag log run too long');
    total += n;
    if (total > cap) throw new Error('laser tag log longer than ' + cap + ' steps');
    for (let k = 0; k < n; k++) out.push([+m[1], +m[2]]);
  }
  return out;
}

export function createLaserTag({ seed = 1, world = null, tag = null, countdownMs = 1500, assist = null, ranked = false, best = 0 } = {}) {
  const T = tag ? Object.assign({}, LASER_TAG, tag) : LASER_TAG;
  const A = laserTagAssist(assist, ranked, T); // v7: what this round runs with (hashed; ranked = { 1, false })
  const fun = createLtFun({ streakWindowMs: T.streakWindowMs, streakCap: T.streakCap, comebackR: T.comebackR, comebackMs: T.comebackMs });
  const W = createWorld(world || LASER_TAG_STD_WORLD);
  const prng = createPrng(seed);
  const stepG = T.growth === 1.06 ? T.stepGrowth : Math.pow(T.growth, 1 / 60);
  const joins = laserTagJoinTimes(T, laserTagJoinScale(W, T) * A.joinScale); // v6: 1.3x slower joins on a floor-only world (the desktop overlay with no ledges); v7: x the hidden assist (1 when ranked), at round start only
  const order = T.catOrder.slice(); // seeded shuffle of the coats (Fisher-Yates on the game prng)
  for (let i = order.length - 1; i > 0; i--) { const j = prng.int(i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
  const modeM = createModeMachine({ countdownMs });
  const loop = createFixedLoop();
  const cats = [], brain = {}, inputLog = [], events = [];
  const q = T.quant;
  const startX = Math.round(W.width / 2 * q) / q, floorY = W.height - 0.05;
  const dot = { x: startX, y: floorY, px: startX, py: floorY, tx: startX, ty: floorY, qx: Math.round(startX * q), qy: Math.round(floorY * q), moving: false, svx: 0 }; // svx: v5 smoothed x velocity (BL/s) the AI leads with
  const lt = {
    tag: T, dot, simTick: 0, elapsedMs: 0, points: 0, mult: 1, nearMisses: 0, caught: null, ended: null, joins,
    score: {}, winner: null, target: '', catches: 0, timeLimitMs: T.maxRunMs, events: [], bestStreak: 0, assist: A,
    get rate() { return T.basePts * lt.mult; },
  };
  let tick = 0, finishTick = -1;

  /** first surface (floor / window top) at or below the pointer at x; y grows down. v5 (Code Review I NIT 2): a window
      is the CLOSED interval [x0, x1], so a pointer exactly on the seam of two touching windows (std world x = 7.0) is on
      the higher one, never on the floor between them (dotLedge agrees). */
  function surfaceUnder(x, y) {
    let best = W.height;
    for (const p of W.platforms) if (x >= p.x0 && x <= p.x1 && p.y >= y - T.dotSnapBL && p.y < best) best = p.y;
    return best - 0.05;
  }
  /** ---- v3 CLIMB (SK-BUG-29): cats ROUTE to the dot's window instead of hopping at it and dropping off. Mirrors the
      free-roam hop AI (freeroam.js): a ledge is reachable UP when its top is at most jump.chargeMaxH - reachMarginBL
      above the cat's surface and the cat can launch from UNDER it (one-way platform) or from BESIDE its near end with a
      charge whose drift lands inside it. One intermediate ledge is tried when the dot's ledge is not reachable directly
      (std world: the floor never reaches the y=5 window, cats go floor -> side window -> middle -> high). */
  const INSET = 0.3, LAND_M = 0.1, R = TUNING.roam, J = TUNING.jump, FULL = Math.ceil(J.chargeMs / STEP_MS);
  const FLOOR = W.platforms[0];
  function platById(id) { for (const p of W.platforms) if (p.id === id) return p; return FLOOR; }
  function chargeH(n) { return J.hopH + (J.chargeMaxH - J.hopH) * smooth01(Math.min((n + 1) * STEP_MS, J.chargeMs) / J.chargeMs); }
  function holdFor(h) { for (let n = 1; n < FULL; n++) if (chargeH(n) >= h) return n; return FULL; }
  /** beside hop: from a settled stand at preX (facing the ledge) the cat RUNS + sprints at it (trot), charges n steps while
      running, releases on its own ledge and drifts over the gap. The drift is not modelled by a formula: the same cat
      controller is run once on a flat scratch world per (height, n) and the table is cached, so the plan is exact. */
  const flightCache = new Map(), SCRATCH = createWorld({ width: 400, height: 8, platforms: [] });
  function flightTable(dh) {
    const key = dh.toFixed(6); if (flightCache.has(key)) return flightCache.get(key);
    const rows = [];
    for (let n = 1; n <= FULL; n++) {
      const c = createCat('biscuit', 200, 8, { side: 1, ai: true, world: SCRATCH }), b = c.body, a = { moveX: 1, jump: 0, pounce: 0, swat: 0, meow: 0, emote: 0, knead: 0, nap: 0, interact: 0, sneak: 0, sprint: 1, pause: 0, clickX: NaN, clickY: NaN, clickKind: 0 };
      let phase = 0, held = 0, rel = NaN, D = NaN, apex = 0;
      for (let i = 0; i < 400; i++) {
        if (phase === 0 && b.x - 200 >= T.climbRunUpBL) phase = 1;
        a.jump = phase === 1 && held < n ? 1 : 0; if (a.jump) held++;
        if (phase === 1 && held >= n && !a.jump && rel !== rel) rel = b.x - 200;
        stepCat(c, a, SCRATCH, STEP_S, TUNING);
        if (!b.onGround) { phase = 2; apex = Math.max(apex, 8 - b.y); if (b.vy > 0 && 8 - b.y <= dh) { D = b.x - 200; break; } }
        else if (phase === 2) break; // landed on the floor before reaching the ledge height: too low
      }
      rows.push({ n, rel, D, apex });
    }
    flightCache.set(key, rows); return rows;
  }
  function besideSpec(cur, x, half, p, dh) {
    const dir = x < p.x0 ? 1 : -1, want = dir > 0 ? Math.min(p.x0 + T.climbLandBL, (p.x0 + p.x1) / 2) : Math.max(p.x1 - T.climbLandBL, (p.x0 + p.x1) / 2);
    const lo = Math.max(cur.x0 + INSET, half), hi = Math.min(cur.x1 - INSET, W.width - half);
    let best = null, bestErr = Infinity;
    for (const r of flightTable(dh)) {
      if (r.D !== r.D || r.apex < dh + LAND_M) continue;
      const preX = clamp(want - dir * r.D, lo, hi), landX = preX + dir * r.D, relX = preX + dir * r.rel;
      if (landX < p.x0 + INSET || landX > p.x1 - INSET) continue;
      if (relX < cur.x0 + 0.05 || relX > cur.x1 - 0.05) continue; // the charge must be released on my own ledge
      const err = Math.abs(landX - want); if (err < bestErr) { bestErr = err; best = { pid: p.id, launchX: preX, dir, under: false, hold: r.n }; }
    }
    return best;
  }
  /** hop spec from surface `cur` (cat feet at y = cur.y, x) up to ledge p, or null */
  function hopSpec(cur, x, half, p, aimX) {
    const dh = cur.y - p.y;
    if (dh < R.minHopBL || dh > T.climbReachBL) return null;
    const lo = Math.max(p.x0 + INSET, cur.x0 + INSET, half), hi = Math.min(p.x1 - INSET, cur.x1 - INSET, W.width - half);
    if (hi >= lo) return { pid: p.id, launchX: clamp(aimX, lo, hi), dir: 0, under: true, hold: holdFor(dh + LAND_M) };
    return besideSpec(cur, x, half, p, dh);
  }
  /** the ledge the dot is on (null = the floor / in the air) */
  function dotLedge() { let best = null; for (let i = 1; i < W.platforms.length; i++) { const p = W.platforms[i]; if (dot.x >= p.x0 && dot.x <= p.x1 && Math.abs(dot.y - (p.y - 0.05)) < 1e-6 && (!best || p.y < best.y)) best = p; } return best; }
  /** v5 JUDGED LEVEL (Code Review I MUST 1, target hysteresis): the AI never reads the dot's level straight off the
      projection. `lvl.ledge` (null = the floor) is the surface the dot has HELD for levelHoldMs; a candidate surface
      gains a step while the dot is on it and loses half a step while the dot is back on the judged one, so a per-frame
      seam / lip flicker (6.97 <-> 7.03 at the high/middle seam) leaves the judgement alone for ~1.2 s at a time instead
      of flipping the drop plan against the same-level chase every frame (the cats stood still for 10 min). The dot's x
      is always the real one: only the level is damped. lvl.y = the judged surface's dot height. */
  const lvl = { ledge: null, y: floorY, away: 0 };
  function judgeLevel() {
    const cur = dotLedge(), k = cur === lvl.ledge ? 0 : 1;
    lvl.away += (k - lvl.away) * (STEP_MS / T.levelHoldMs); // share of recent time the dot spent OFF the judged surface (any other surface counts, so a per-frame flip between two other windows still moves a stale judgement)
    if (k && lvl.away >= T.levelAwayShare) { lvl.ledge = cur; lvl.y = (cur ? cur.y : W.height) - 0.05; lvl.away = 0; }
  }
  /** plan a route from the cat's ground surface to ledge p: direct, else via one ledge from which p is reachable */
  function routeTo(c, B, p, aimX = dot.x) {
    const b = c.body, cur = platById(b.groundId), half = b.w / 2;
    let spec = hopSpec(cur, b.x, half, p, aimX);
    if (!spec) { let bestD = Infinity; for (let i = 1; i < W.platforms.length; i++) { const q = W.platforms[i]; if (q === p || q === cur) continue; const s1 = hopSpec(cur, b.x, half, q, aimX); if (!s1 || !hopSpec(q, s1.launchX, half, p, aimX)) continue; const d = Math.abs(s1.launchX - b.x); if (d < bestD) { bestD = d; spec = s1; } } }
    if (!spec) return false;
    B.hop = { ...spec, goal: p.id, held: 0, phase: 0, ms: 0, runUp: false, x0: 0 }; return true; // goal = the dot's ledge (pid may be the via ledge)
  }
  /** v4 drop-down: the surface a falling cat lands on at x below surface y (the floor when no ledge is under it) */
  function landingAt(x, y) { let best = FLOOR; for (const p of W.platforms) if (x > p.x0 && x < p.x1 && p.y > y + 1e-6 && p.y < best.y) best = p; return best; }
  /** v4 drop-down plan from ledge cur: walk dropOutBL past the end whose landing is the dot's surface (0), else a surface
      the dot's ledge is reachable from (1), else any (2); ties go to the end on the dot's side (walking toward the dot is
      never wasted, and a dot bobbing between the floor and a far window never makes the cat dither), then the nearer end.
      An end at a wall is skipped. */
  function dropPlan(cur, b, target) {
    const half = b.w / 2;
    let best = null, bestKey = Infinity;
    for (const dir of [-1, 1]) {
      const x = dir < 0 ? cur.x0 - T.dropOutBL : cur.x1 + T.dropOutBL;
      if (x < half || x > W.width - half) continue;
      const land = landingAt(x, cur.y);
      const rank = land === target ? 0 : (land.y > target.y && hopSpec(land, x, half, target, dot.x)) ? 1 : 2;
      const key = rank * 100 + (dot.x < cur.x0 ? (dir < 0 ? 0 : 50) : dot.x > cur.x1 ? (dir > 0 ? 0 : 50) : 0) + Math.abs(x - b.x);
      if (key < bestKey) { bestKey = key; best = { pid: cur.id, x, dir }; }
    }
    return best || { pid: cur.id, x: b.x - cur.x0 <= cur.x1 - b.x ? cur.x0 - T.dropOutBL : cur.x1 + T.dropOutBL, dir: b.x - cur.x0 <= cur.x1 - b.x ? -1 : 1 };
  }
  function hopActions(c, B, a) {
    const hop = B.hop, b = c.body; hop.ms += STEP_MS;
    if (b.onGround && b.groundId === hop.pid) { B.hop = null; return; }
    if (hop.ms > T.climbTimeoutMs) { B.hop = null; B.noHopUntil = lt.elapsedMs + T.climbRetryMs; return; } // v4 (NIT 1): back off before the next plan
    a.jump = 0;
    if (hop.phase === 0) {
      if (hop.under) {
        const d = hop.launchX - b.x;
        if (Math.abs(d) > 0.15) { a.moveX = sign(d) * 0.6; a.sprint = Math.abs(d) > 2.5 ? 1 : 0; return; }
        a.moveX = 0; a.sprint = 0;
        if (!b.onGround || c.turnMs >= 0 || (c.mode !== 'rest' && c.mode !== 'move') || Math.abs(b.vx) > 0.1) return; // settle: a straight jump lands straight
      } else { // beside: settle at the run-up spot facing the ledge, then run (sprint = trot) and charge while running
        const d = hop.launchX - b.x;
        if (!hop.runUp) {
          if (Math.abs(d) > 0.15) { a.moveX = sign(d) * 0.6; a.sprint = Math.abs(d) > 2.5 ? 1 : 0; return; }
          a.moveX = 0; a.sprint = 0;
          if (!b.onGround || c.turnMs >= 0 || (c.mode !== 'rest' && c.mode !== 'move') || Math.abs(b.vx) > 0.1) return;
          if (c.side !== hop.dir) { a.moveX = hop.dir * 0.3; return; } // face the ledge (a small step turns the cat)
          hop.runUp = true; hop.x0 = b.x;
        }
        a.moveX = hop.dir * 1; a.sprint = 1;
        if (hop.dir * (b.x - hop.x0) < T.climbRunUpBL) return;
      }
      hop.phase = 1; hop.held = 0;
    }
    if (hop.phase === 1) {
      if (hop.held < hop.hold) { a.jump = 1; hop.held++; } else hop.phase = 2;
      a.moveX = hop.under ? 0 : hop.dir * 1; a.sprint = hop.under ? 0 : 1; return;
    }
    if (b.onGround) { B.hop = null; return; } // landed somewhere else: re-plan
    a.moveX = hop.under ? 0 : hop.dir * 1; a.sprint = hop.under ? 0 : 1;
  }
  function addCat() {
    const k = cats.length, id = order[k % order.length];
    // walk in from the edge farther from the dot (fair: never spawn on top of the player)
    const left = dot.x > W.width / 2, x = left ? 0.6 : W.width - 0.6;
    const c = createCat(id, x, W.height, { side: left ? 1 : -1, ai: true, world: W });
    cats.push(c);
    const co = A.coach && k < T.coach.k ? T.coach : null; // v7 coach cat: cat 1 of round 1 of an unranked session is gentler (per-cat override; cats 2-7 untouched)
    brain[id] = { k, role: k % 3, joinedMs: lt.elapsedMs, reaction: Math.min(0.95, 0.82 + 0.02 * k), leadS: Math.min(0.5, 0.15 + 0.05 * k), pounceP: co ? co.pounceP : T.pounceP + T.pouncePStep * k, cooldownMs: co ? co.cooldownMs : Math.max(T.cooldownMinMs, T.cooldownMs - 100 * k), slapArmMs: co ? co.slapArmMs : T.slapArmMs, dodgeMs: co ? co.dodgeMs : T.dodgeMs, coach: !!co, lastPounceMs: -1e9, minD: 1e9, inPounce: false, tellMs: -1, slapMs: -1, hop: null, noHopUntil: 0, commitUntil: 0, drop: null, backing: false, inMs: 0, trapD: -1 };
    lt.events.push({ type: 'join', cat: id, n: cats.length, x });
  }
  /** v5 AMBUSH (Code Review I, hug_ledge_lips / hug_top / hop_far family): with the dot on a window, the FLANKERS and
      CUTTERS do not join the blob climbing after it (a dot that hops to the farthest ledge lip the moment a cat nears
      outran five cats taking the same 2-hop route for 10 min while both guards idled on the far floor). Only the HUNTERS
      (k = 0, 3, 6) chase a dot on a window; the j-th other cat (k = 1, 2, 4, 5, ... -> j = 0, 1, 2, 3, ...) has a FIXED
      window of its own (the j-th in platform order, wrapping: std world, 7 cats = one cat per window), sits at its
      middle (both lips are a pounce band away) and only leaves it to chase a dot that is on its own window (it is then
      the best-placed cat) or on the floor within campHoldBL in x (a dot parked under a cat pile is still caught). The
      assignment never depends on where the dot is, so a dot hopping between the far ends of the room cannot drag the
      campers back and forth. The hunters and the floor guard take the floor. */
  function campLedge(B, b) {
    if (B.role === 0 || cats.length < 3 || W.platforms.length < 2) return null;
    const j = B.k - 1 - Math.floor((B.k - 1) / 3); // my index among the non-hunters (k = 1, 2, 4, 5, 7, 8 -> 0..5)
    const camp = W.platforms[1 + j % (W.platforms.length - 1)], own = lvl.ledge;
    if (own) return own === camp ? null : camp;
    return Math.abs(dot.x - b.x) > T.campHoldBL ? camp : null;
  }
  /** AI per cat. Roles by join order (k % 3): 0 HUNTER chases the dot (with a little lead), 1 FLANKER circles to the
      dot's far side from the other cats then hunts (a pincer), 2 CUTTER aims where the dot will be in cutS seconds.
      Same-level close range: creep (stalk), standing pounce (350 ms wiggle telegraph), or a RUNNING pounce (no wiggle,
      shorter leap) for cats from #rushFrom on; dot under the paws = a paw slap (150 ms arm). */
  function think(c) {
    const B = brain[c.id], b = c.body, dvx = dot.svx; // v5: the smoothed dot velocity (a per-frame 0.06 BL flicker read as +-3.6 BL/s put every lead 1.8 BL off and no cat ever found the pounce band)
    let tx = clamp(dot.x + dvx * B.leadS, 0.3, W.width - 0.3), guarding = false;
    const camp = campLedge(B, b), goal = camp || lvl.ledge, goalY = (goal ? goal.y : W.height) - 0.05; // v5: the ledge this cat wants (null = the floor)
    if (camp) { if (b.onGround && b.groundId === camp.id) tx = (camp.x0 + camp.x1) / 2; } // camping: sit at the middle of my window (both of its lips are within a pounce band from there: a dot hopping to the "far" lip lands next to a cat)
    else if (B.role === 2) tx = clamp(dot.x + dvx * T.cutS, 0.3, W.width - 0.3);
    else if (B.role === 1 && cats.length > 1) {
      let sx = 0, n = 0; for (const o of cats) if (o !== c) { sx += o.body.x; n++; }
      const side = sign(dot.x - sx / n) || 1, spot = clamp(dot.x + side * T.flankBL, 0.5, W.width - 0.5);
      if (Math.abs(b.x - dot.x) > T.guardBL) { guarding = true; tx = sx / n < W.width / 2 ? W.width - T.guardInBL : T.guardInBL; } // v4 GUARD: far from the dot, hold the half of the room the pack is NOT in (the pincer the dot cannot outrun)
      else if (Math.abs(b.x - dot.x) > 1.6 && sign(b.x - dot.x) !== side) tx = spot; // not yet on the far side: go round
    }
    const ty = goalY; // v5: the judged level, not the raw projection
    const a = aiActions(c, tx, ty, prng, { reaction: B.reaction });
    a.pounce = 0; a.swat = 0; a.jump = 0; // v3: jumps come from the climb planner only (no more hopping at a window the cat cannot reach)
    // v5 (Code Review I MUST 2): a climb plan that has not launched yet is DROPPED the moment the judged level leaves its
    // goal ledge (the dot went to a floor corner or another window): a stale climb used to run to completion (up to 5 s
    // + the settle) while the dot was long gone, and a far-hopping pointer kept the whole pack climbing. A plan in the
    // charge / in the air finishes (the cat cannot un-jump). The GUARD flanker never climbs: it holds the floor.
    if (B.hop && B.hop.phase === 0 && !goal && lt.elapsedMs >= B.commitUntil) { B.hop = null; B.commitUntil = lt.elapsedMs + T.climbCommitMs; } // (another window: the climb is kept, a re-plan from up there is shorter than restarting on the floor, and two windows flipped at the hold's cadence cannot make it dither)
    if (b.onGround && !B.hop && !guarding && c.mode !== 'pounce' && c.mode !== 'swat' && lt.elapsedMs >= B.noHopUntil) {
      if (goal && b.y > goal.y + R.minHopBL) routeTo(c, B, goal, camp ? (camp.x0 + camp.x1) / 2 : dot.x);
    }
    if (B.hop) { hopActions(c, B, a); return a; }
    // v4 DROP DOWN (Code Review E MUST 1): a cat on a window with the dot BELOW it (the floor, or a lower ledge) can never
    // pounce or slap it, and the climb planner only routes UP, so it used to stand over the dot for ever. Now it walks to
    // a ledge end, dropOutBL past it, and falls off (dropPlan picks the end that lands on the dot's surface, else one from
    // which the dot's ledge is reachable, else the nearer one); the plan is kept until the cat leaves that ledge so it
    // never dithers at the middle. On the new surface the chase / climb AI takes over again. Jumps stay suppressed.
    if (b.onGround && b.groundId !== FLOOR.id && c.mode !== 'pounce' && c.mode !== 'swat' && (goalY > b.y + 0.4 || (B.drop && B.drop.pid === b.groundId))) { // v5: judged level (or the camp ledge); a drop in progress is COMMITTED until the cat is off the ledge
      const cur = platById(b.groundId); // (v5: a started drop is never cancelled by the dot coming back onto the ledge: the seam / lip flicker and the 0.5 s window swap used to cancel it against the same-level chase every judgement, and the cats stood still)
      if (!B.drop || B.drop.pid !== cur.id) B.drop = dropPlan(cur, b, goal || FLOOR);
      const d = B.drop.x - b.x; a.moveX = Math.abs(d) > 0.05 ? sign(d) * 0.7 : B.drop.dir * 0.7; a.sprint = Math.abs(d) > 2.5 ? 1 : 0;
      B.tellMs = -1; return a;
    }
    if (B.drop && b.groundId !== B.drop.pid) B.drop = null;
    const dx = dot.x - b.x, adx = Math.abs(dx), sameLevel = Math.abs(lvl.y - b.y) < 0.4, facing = sign(dx) === c.side || adx < 0.05;
    if (sameLevel && b.onGround && c.mode !== 'pounce' && c.mode !== 'swat') { // (v4: no pounce tell while a slap is armed: the slap's own tell stands)
      const pdx = Math.abs(clamp(dot.x + dvx * 0.5, 0, W.width) - b.x), ready = lt.elapsedMs - B.lastPounceMs > B.cooldownMs;
      const running = Math.abs(b.vx) > TUNING.speeds.walk;
      const telling = B.tellMs >= 0;
      if (telling) { // v3: a RUNNING pounce is telegraphed too: the cat keeps running for rushTellMs (crouched ears, event 'tell'), then leaps
        if (lt.elapsedMs - B.tellMs >= T.rushTellMs) { B.tellMs = -1; if (running && facing && pdx >= 0.7 && pdx <= 2.1) { a.pounce = 1; B.lastPounceMs = lt.elapsedMs; } }
      }
      else if (B.k >= T.rushFrom && running && facing && pdx >= 0.9 + T.rushTellMs / 1000 * Math.abs(b.vx) && pdx <= 1.9 && ready && prng.chance(B.pounceP * 2)) { B.tellMs = lt.elapsedMs; lt.events.push({ type: 'tell', cat: c.id, running: true }); }
      else if (adx > 2.4 && adx < 3.6 && !running) { a.moveX = sign(dx) * 0.6; a.sprint = 0; }  // stalk: creep in
      else if (pdx >= 1.2 && pdx <= 2.3 && facing && ready && !running && prng.chance(B.pounceP)) { a.pounce = 1; a.moveX = 0; B.lastPounceMs = lt.elapsedMs; lt.events.push({ type: 'tell', cat: c.id, running: false }); } // standing pounce: the cat has STOPPED, so cat.js gives it the 350 ms wiggle (v3: SK-BUG-28)
      else if (pdx >= 1.2 && pdx <= 2.3 && facing && ready && running && adx > 1.2) { a.moveX = 0; a.sprint = 0; } // in the band but still moving: brake first (then the wiggle)
      else if (adx < 0.8 && c.mode !== 'swat' && prng.chance(0.12)) { a.swat = 1; a.moveX = 0; } // the dot is under the paws: slap (v4: never re-pressed during a slap, so the arm is never restarted; announced below)
      else if (adx < 1.2 || (B.backing && adx < 1.6)) { a.moveX = -sign(dx) * 0.5; B.backing = true; } // too close to leap: back up into the pounce band (v3: SK-BUG-27, was 1.1 = a dead zone at 1.1..1.2). v5: back up to 1.6, not 1.2: a 420 ms turn ends each step, so a cat at the 1.2 boundary turned away and back for ever (Code Review I probes: the seam flicker's hunters)
      else B.backing = false;
    } else { if (B.tellMs >= 0) B.tellMs = -1; B.backing = false; }
    return a;
  }
  function pawPoint(c) { return { x: c.body.x + c.side * 0.4, y: c.body.y - 0.05 }; }
  /** v6 DODGE (fun tuning, Code Review K SHOULD 1): the near-miss pay-out for a dot that slipped a trap */
  function dodged(c, B, d) { const bonus = T.nearMissS * lt.rate; lt.points += bonus; lt.nearMisses++; lt.events.push({ type: 'near_miss', cat: c.id, bonus, d, dodge: true }); }
  function catchCheck(c) {
    const B = brain[c.id], b = c.body, P = TUNING.pounce, pp = pawPoint(c);
    // v6: how long the dot has been IN THIS CAT'S PAW COLUMN: within catchBL in x (the dot's x is always real: it glides,
    // it never teleports) and, by the JUDGED level (lvl.y, stable under any flicker: a per-frame window <-> floor flick
    // at a lip must not reset the count, edge_flip_frame_wide seed 66 capped on the raw dot.y), within dodgeAboveBL in y.
    // A paw slap is a TRAP (the paw comes down on a spot): it catches a dot that has sat in that spot for dodgeMs, never
    // one that is just flashing through at 7 BL/s (Code Review K's human bot died 1-3 frames after arriving under a paw
    // in most of its rounds: a crouched cat was a wall across the floor lane). The slap's own 2D reach (slapBL) is still
    // the catch condition; the count only gates it. The flying pounce and the landing are unchanged: they are the attacks
    // with a visible wind-up, they catch movers.
    // The count LEAKS instead of resetting (a frame out costs a quarter step, and it is capped at 2 x dodgeMs): the
    // 0.12 BL per-frame x zig-zag of a lip flicker (edge_flip_frame_wide seed 66) crosses the column edge every other
    // frame, and a reset let three swatting cats miss it for 10 min; a dot flashing through is in the column for at
    // most ~7 frames and inside the slap reach for fewer, so it still dodges.
    B.inMs = Math.abs(pp.x - dot.x) <= T.catchBL && Math.abs(lvl.y - pp.y) < T.dodgeAboveBL ? Math.min(2 * B.dodgeMs, B.inMs + STEP_MS) : Math.max(0, B.inMs - STEP_MS * 0.25); // (v7: per-cat dodgeMs, the coach cat's is longer)
    if (lt.elapsedMs - B.joinedMs < T.joinGraceMs) return null; // (the count runs through the grace: it is a measurement, not a catch)
    if (c.mode === 'pounce' && c.pounce) {
      const wig = c.pounce.flying ? 0 : P.wiggleMs;
      if (!B.inPounce) { B.inPounce = true; B.minD = 1e9; }
      if (c.modeMs >= wig + P.leapMs * 0.5 && c.modeMs <= wig + P.leapMs + STEP_MS) { // v6: the LEAP catches (second half of the flight + the landing step); a cat lying pinned after a miss is not a wall the dot dies on
        const d = ltDist(pp.x - dot.x, pp.y - dot.y);
        if (d < B.minD) B.minD = d;
        if (d <= T.catchBL) return 'pounce';
      }
    } else if (B.inPounce) { // the pounce just ended without a catch: near miss?
      B.inPounce = false;
      if (B.minD <= T.nearMissBL) { const bonus = T.nearMissS * lt.rate; lt.points += bonus; lt.nearMisses++; lt.events.push({ type: 'near_miss', cat: c.id, bonus, d: B.minD }); }
    }
    if (c.mode === 'swat' && c.modeMs >= B.slapArmMs && b.onGround) { const d = ltDist(pp.x - dot.x, pp.y - dot.y); if (d <= T.slapBL) { if (B.inMs >= B.dodgeMs) return 'slap'; if (B.trapD < 0 || d < B.trapD) B.trapD = d; } }
    else if (B.trapD >= 0) { dodged(c, B, B.trapD); B.trapD = -1; } // the slap came down and the dot was under it but not long enough: a dodge pays like a near miss
    if (c.events.indexOf('land') >= 0 && ltDist(b.x - dot.x, b.y - 0.05 - dot.y) <= T.catchBL) return 'land'; // (a landing is NOT dodgeable: the flight is the tell, and the window-hop family (wf_far, leave_on_threat) reached the cap when it was: a dot that moves under a flying cat is caught)
    return null;
  }
  /** the deterministic sim core: ONE playing step with a quantised target [qx, qy] */
  function simStep(qxy) {
    lt.events.length = 0;
    if (lt.ended) return;
    inputLog.push([qxy[0], qxy[1]]);
    lt.simTick++; lt.elapsedMs = lt.simTick * STEP_MS;
    for (const c of cats) { c.body.px = c.body.x; c.body.py = c.body.y; }
    dot.px = dot.x; dot.py = dot.y;
    // the dot: target = first surface under the pointer, glide there at <= dotSpeed
    const px = clamp(qxy[0] / q, 0.2, W.width - 0.2), py = clamp(qxy[1] / q, 0, W.height);
    dot.tx = px; dot.ty = surfaceUnder(px, py);
    // v3 (SK-BUG-29): the dot is a PROJECTION. It slides along x at <= dotSpeed and is ALWAYS on the surface under it
    // (the floor, or a window top the pointer is over): it never glides through the air, where no cat could reach it.
    const ddx = dot.tx - dot.x, adx = Math.abs(ddx), maxD = T.dotSpeed * STEP_S;
    if (adx <= maxD) dot.x = dot.tx; else dot.x += sign(ddx) * maxD;
    dot.y = surfaceUnder(dot.x, py);
    dot.moving = adx > 1e-6 || Math.abs(dot.y - dot.py) > 1e-6;
    dot.svx += ((dot.x - dot.px) * 60 - dot.svx) * 0.15; // ~7-step EMA (100 ms lag; the dot's own motion is unsmoothed)
    judgeLevel(); // v5: the AI's damped view of the dot's level
    // joins
    while (cats.length < joins.length && lt.elapsedMs >= joins[cats.length]) addCat();
    // cats
    for (const c of cats) stepCat(c, think(c), W, STEP_S, TUNING);
    for (const c of cats) for (const e of c.events) if (e === 'pounce') lt.events.push({ type: 'pounce', cat: c.id });
    // v4 (Code Review E SHOULD 1): a paw slap is announced the step it starts (event 'tell' {slap}, state cats[].tell counts up to slapArmMs; the proto draws the crouch)
    for (const c of cats) if (c.mode === 'swat' && c.swatHits === 1 && c.events.indexOf('swat') >= 0) { brain[c.id].slapMs = lt.elapsedMs; lt.events.push({ type: 'tell', cat: c.id, running: false, slap: true }); }
    for (const c of cats) {
      const how = catchCheck(c);
      if (how) { lt.caught = { cat: c.id, how, tick: lt.simTick }; lt.catches = 1; lt.winner = c.id; lt.ended = 'caught'; lt.events.push({ type: 'caught', cat: c.id, how, x: dot.x, y: dot.y }); break; }
    }
    if (!lt.ended) { // survived this step: the score grows
      if (lt.mult < T.multCap) lt.mult = Math.min(T.multCap, lt.mult * stepG);
      lt.points += T.basePts * lt.mult * STEP_S;
      if (lt.elapsedMs >= T.maxRunMs) { lt.ended = 'time_cap'; lt.winner = 'draw'; lt.events.push({ type: 'time_cap' }); }
    }
    // v7 FUN LAYER (lasertag-fun.js): the streak annotates this step's near misses (mult, shown) and the sim pays the
    // extra (mult - 1) x bonus; comeback / personal-best moments are events only. All of its state is in simHash.
    funCtx.elapsedMs = lt.elapsedMs; funCtx.rate = lt.rate; funCtx.points = lt.points; funCtx.caught = !!lt.ended; funCtx.cats.length = 0;
    for (const c of cats) funCtx.cats.push(c.body);
    const fev = ltFunStep(fun, lt.events, funCtx);
    for (const e of lt.events) if (e.type === 'near_miss' && e.mult > 1) { const extra = e.bonus * (e.mult - 1); lt.points += extra; e.bonus += extra; }
    for (let i = 0; i < fev.length; i++) { lt.events.push(fev[i]); if (fev[i].type === 'streak' && fev[i].n > lt.bestStreak) lt.bestStreak = fev[i].n; }
    lt.score = { you: Math.floor(lt.points) };
  }
  const funCtx = { elapsedMs: 0, rate: 0, points: 0, best: Number.isFinite(+best) ? Math.max(0, +best) : 0, growth: T.growth, dot, cats: [], caught: false }; // best = the player's personal best for the pb_close / new_best moments (events only, never points: it is not hashed)
  function simHash() {
    const h = createHasher();
    h.num(A.joinScale).num(A.coach ? 1 : 0); ltFunHash(fun, h); // v7: the assist this round ran with + the fun layer's score-bearing state
    h.num(lt.simTick).num(prng.getState()).num(dot.x).num(dot.y).num(dot.svx).num(lvl.y).num(lvl.away).num(cats.length).str(lt.ended || '-').str(String(Math.floor(lt.points))).num(lt.points - Math.floor(lt.points)).num(lt.mult).num(lt.nearMisses);
    for (const c of cats) h.str(c.id).num(c.body.x).num(c.body.y).num(c.body.vx).num(c.body.vy).num(c.body.onGround ? 1 : 0).num(c.side).str(c.mode).num(c.modeMs).num(c.stamina);
    return h.digest();
  }
  function quantise(inp) {
    if (inp && Number.isFinite(inp.x) && Number.isFinite(inp.y)) { dot.qx = Math.round(clamp(inp.x, 0, W.width) * q); dot.qy = Math.round(clamp(inp.y, 0, W.height) * q); }
    return [dot.qx, dot.qy]; // no pointer this step = keep the last target
  }

  addCat(); // cat #1 is there from the start (the start-card preview shows it); later cats walk in on the schedule
  lt.events.length = 0;

  const g = {
    seed, mode: 'laser_tag', world: W, cats, player: null, ai: null, modeMachine: modeM, race: lt, inputLog, events,
    view: 'front', plane: 'side', viewRequested: 'front', floor: null, tuning: TUNING,
    fxOpts: { blood: false }, setBloodFx(on) { g.fxOpts.blood = !!on; return g.fxOpts.blood; },
    get tick() { return tick; }, get finishTick() { return finishTick; }, get timeS() { return lt.elapsedMs / 1000; },
    start() { modeM.start(); modeM.heartbeat(); return g; },
    escape() { modeM.escape(); return modeM.state; },
    resume() { return modeM.resume(); },
    forceExit(reason) { return modeM.forceExit(reason); },
    heartbeat() { modeM.heartbeat(); },
    systemEvent(k) { return modeM.systemEvent(k); },
    softReleased() { return modeM.softReleased(); },
    /** one fixed host step; input = { x, y } pointer in world BL (null = keep the last target). Only 'playing' changes the sim. */
    step(input = null) {
      modeM.heartbeat(); modeM.tick(STEP_MS);
      const qxy = quantise(input);
      if (modeM.state === 'playing' && !lt.ended) {
        simStep(qxy);
        for (const e of lt.events) events.push({ ...e, tick });
        if (lt.ended) {
          finishTick = tick; modeM.finish();
          events.push({ type: 'laser_tag_result', reason: lt.ended, caughtBy: lt.caught ? lt.caught.cat : null, score: Math.floor(lt.points), timeS: lt.elapsedMs / 1000, steps: lt.simTick, seed, hash: simHash(), version: T.version, ranked: !!ranked, assist: { ...A }, bestStreak: lt.bestStreak, nearMisses: lt.nearMisses, tick });
        }
      } else { dot.px = dot.x; dot.py = dot.y; for (const c of cats) { c.body.px = c.body.x; c.body.py = c.body.y; } }
      tick++;
      return g;
    },
    advance(frameMs, inputFn) { const n = loop.advance(frameMs); for (let i = 0; i < n; i++) g.step(inputFn ? inputFn() : null); return n; },
    get alpha() { return loop.alpha; },
    /** the run as the server needs it (POST body of the high-score claim, docs/GAME-LASER-TAG.md section 6) */
    digest() { return { mode: 'laser_tag', version: T.version, seed, ranked: !!ranked, assist: { ...A }, world: { width: W.width, height: W.height, platforms: W.platforms.filter((p) => !p.floor).map((p) => ({ x0: p.x0, x1: p.x1, y: p.y })) }, steps: lt.simTick, score: Math.floor(lt.points), timeS: lt.elapsedMs / 1000, ended: lt.ended, hash: simHash(), log: encodeLaserTagLog(inputLog) }; },
    state() {
      const al = loop.alpha, lerp = (a, b) => (a == null ? b : a + (b - a) * al);
      return {
        tick, timeS: lt.elapsedMs / 1000, mode: modeM.state, indicator: modeM.indicator(), exitReason: modeM.exitReason, pauseReason: modeM.pauseReason, softReleased: modeM.softReleased(),
        view: 'front', plane: 'side', viewLocked: modeM.captureAllowed(),
        cats: cats.map((c) => ({ id: c.id, ai: true, tell: brain[c.id].tellMs >= 0 ? lt.elapsedMs - brain[c.id].tellMs : brain[c.id].slapMs >= 0 && c.mode === 'swat' && lt.elapsedMs - brain[c.id].slapMs < brain[c.id].slapArmMs ? lt.elapsedMs - brain[c.id].slapMs : -1, coach: brain[c.id].coach, climbing: !!brain[c.id].hop, x: c.body.x, y: c.body.y, rx: lerp(c.body.px, c.body.x), ry: lerp(c.body.py, c.body.y), vx: c.body.vx, vy: c.body.vy, onGround: c.body.onGround, side: c.side, mode: c.mode, modeMs: c.modeMs, speedBL: c.speedBL, ph: c.ph, stamina: c.stamina, charging: c.charging, chargeMs: c.chargeMs, pounce: c.pounce })),
        race: {
          dot: { x: dot.x, y: dot.y, rx: lerp(dot.px, dot.x), ry: lerp(dot.py, dot.y), moving: dot.moving, frozen: !!lt.ended },
          score: { ...lt.score }, winner: lt.winner, target: '', elapsedMs: lt.elapsedMs, timeLimitMs: T.maxRunMs,
          laserTag: { points: Math.floor(lt.points), mult: lt.mult, rate: lt.rate, cats: cats.length, maxCats: T.maxCats, nextJoinS: cats.length < joins.length ? (joins[cats.length] - lt.elapsedMs) / 1000 : null, nearMisses: lt.nearMisses, ended: lt.ended, caught: lt.caught, fun: ltFunState(fun), bestStreak: lt.bestStreak, assist: { ...A }, ranked: !!ranked },
        },
      };
    },
    hash() { return simHash(); },
    drainEvents() { const out = events.slice(); events.length = 0; return out; },
    /** replay entry (tests / server): run one logged playing step directly, skipping the mode machine */
    _simStep: simStep,
    /** test / diag hook (v5): the AI's judged dot level and the per-cat brains. v6 (Code Review K NIT 1): a fresh
        SNAPSHOT per read (lvl.ledge is the world's platform object, so identity comparisons across steps still work;
        everything else is copied), so no page script can poke the live AI state. */
    get _ai() { const out = {}; for (const id in brain) { const B = brain[id]; out[id] = { ...B, hop: B.hop ? { ...B.hop } : null, drop: B.drop ? { ...B.drop } : null }; } return { lvl: { ledge: lvl.ledge, y: lvl.y, away: lvl.away }, brain: out }; },
  };
  return g;
}

/** Server-side / test replay: rebuild from the same options and run the logged playing steps (stops when the round ends). */
export function replayLaserTag(opts, log) {
  const g = createLaserTag(opts);
  const L = typeof log === 'string' ? decodeLaserTagLog(log) : log; // the server decodes first with maxSteps = claimed steps
  for (let i = 0; i < L.length && !g.race.ended; i++) g._simStep(L[i]);
  return g;
}

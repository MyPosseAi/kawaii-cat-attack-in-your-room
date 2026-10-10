/* vr/src/director.js - P0a slice (docs/P0A-SLICE.md, GE2 section): the 3-minute GAME around the room sim, as plain data.
   Gaming Engineer 2, 2026-10-10. PURE and engine-neutral (no three / WebXR / DOM); node-tested in vr/test/director.test.mjs.
   Beats (d.mode):
     play       the kittens are out; every deed fills the KITTEN HAPPINESS meter = GE1's game/core/happiness.js (fed with
                roomcat's events each frame: strokes, treats, catches, near misses, pounces, safe toss landings, play, combos;
                per-source token buckets, idle decay, levels that restart at 15 %). Caps per source force variety.
     celebrate  the meter is full ('happy_full'): hearts fountain + bouncing kittens + the chord (fx.js draws it) until
                'happy_next' (HAPPY.celebrateS, 3 s).
     offer      "Laser Tag! Point at the ring to start" on the hint line + a floor ring 1.5 m ahead. The second beat NEVER
                auto-starts (anti-nudge, review BB MUST 1): only a FRESH point (a frame with no point ray first, after
                the offer appeared) held on the ring for ltStartHoldS starts it; the Play laser stays live everywhere else;
                palm up = "not now" (back to play, re-offered after reofferS); no offer in wind / nap / end.
     countdown / playing   game/core/lasertag-room.js runs at 60 Hz on the same fixed loop; the Play sim is FROZEN (not
                stepped) and its kittens are the crowd. The point ray (either hand; the right one wins) is the input.
     scorecard  the round ended: score / time / best this session / caught by; "Again? Point at the floor" (point-hold =
                a new round with the next seed) beside "Rest: palm up" (back to the kittens where they were). No auto-start,
                no countdown into the next round (dark-pattern rule).
   Local best = memory only (Legal 10.1 line pending, step 9). Captions here are original text, no brands.
   Build rule: only `export function` / `export const`; private names carry the `dr` prefix. */
import * as LTR from '../../game/core/lasertag-room.js';
import { LASER_TAG, laserTagRubberBand } from '../../game/core/lasertag.js';
const { createLaserTagBeat, LT_ROOM_STARTERS, VR_TAG } = LTR;
import { createHappiness, happinessFromEvents, happinessStep, happinessState } from '../../game/core/happiness.js';
import { roomRaycast, roomSurface, roomNearestLegal } from '../../game/core/room.js';

export const DIRECTOR_VERSION = 1;
export const HAPPY_TUNING = Object.freeze({
  // the meter's own numbers live in game/core/happiness.js HAPPY (GE1 / GDXE); these are the beat flow's
  ltStartHoldS: 0.6,                 // point at the floor this long to start / replay Laser Tag
  reofferS: 20,                      // after a Rest, the offer comes back after this much Play
  scorecardMinS: 1.0,                // the score card must be up this long before "Again?" counts (reads first)
  ltCats: 4,                         // Laser Tag roster size, round 1 (GDXE Build 1 item 4; VR_TAG.maxCats caps it too)
  celebrateS: 4,                     // the celebration length (GDXE: 3-6 s band, target 4); passed to GE1's happiness.js
  celebrateBeat2S: 2,                // the second beat of the celebration (chord + hearts burst)
  ringAheadM: 1.5,                   // the floor ring (the Laser Tag start target) sits this far ahead of the viewer
  ringBehindDeg: 60, ringBehindS: 3, // the ring this far off the gaze for this long -> "Turn around" on the hint line
  ringNearM: 0.5,                    // ... unless the ring is within this of the player's feet (review BL S1)
  openerMoveM: 0.3, openerCheckS: 2.5, // Laser Tag opener: a dot that moved less than this by then -> "Move the dot!" once
  closeCdS: 6,                       // "So close!" at most once per this per kitten (GDXE Build 2 item 4)
  ringHitM: 0.35,                    // a point counts as "on the ring" within this of its centre (the Play laser stays live elsewhere)
  armNoRayS: 0.15,                   // a release = this long with no point ray; point_end is NOT a release by itself (Quest dropouts emit it at once: review BI S1)
  crowdMax: 3,                       // Play kittens shown as the crowd during Laser Tag (<= 8 billboards in view)
});
export const DIRECTOR_TEXT = Object.freeze({
  goal: 'Make the kittens happy!',
  full: 'The kittens love you!',
  offer: 'Laser Tag! Point at the ring to start',
  level: 'Level {n}!',
  ltGoal: 'Keep the dot alive!',
  go: 'Go!',
  again: 'Again? Point at the ring',
  rest: 'Rest: palm up for the kittens',
  gotcha: 'Gotcha!', close: 'So close!', combo: 'Pounce combo!', comeback: 'Comeback!', newBest: 'New best!',
  turn: 'Turn around: the ring is behind you', enough: "She's had enough for now", moveDot: 'Move the dot!',
});

const drCap = (v, cap) => (v > cap ? cap : v);
const drName = (id) => String(id || '').split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/** Fresh director. opts = { room, seed, roster (ignored for Laser Tag: starters only), happy (HAPPY overrides for tests) }. */
export function createDirector(opts = {}) {
  const seed = Number.isFinite(opts.seed) ? opts.seed : 1, room = opts.room || null;
  const roster = LT_ROOM_STARTERS.slice(0, Math.min(HAPPY_TUNING.ltCats, VR_TAG.maxCats));
  // GE1's beat options (LT_BEAT: cats / coach cat 1 / rubber band from round 2) when they exist; older cores take only room / roster / seed
  const beatOpts = { room, roster, seed: seed * 100 };
  // B5: the coach cat is ROUND 1 ONLY (GE1 measured an evasive human at 74 s with coach on vs 39.6 s off; GDXE bar 35-50 s):
  // the beat's `coach` flag covers every round, so the director owns a mutable `assist` (the beat reads it at each start()):
  // round 1 { joinScale 1, coach true }, from round 2 coach false + the rubber band from the beat's round history
  const assist = { joinScale: 1, coach: true };
  if (LTR.LT_BEAT) Object.assign(beatOpts, { cats: HAPPY_TUNING.ltCats, rubberBand: true, assist });
  // the floor ring = the Laser Tag start target: placed ringAheadM ahead of the viewer at build time, and RE-PLACED from the
  // current head + forward every time the offer / score card appears (GDXE Build 2 MUST 2: the player has turned / walked by then)
  const ring = placeRing(room, opts.viewer, opts.forward);
  return {
    mode: 'play', modeT: 0, t: 0, room, seed, ring, beat2: false, armed: false, noRayS: 0, behindS: 0, hintLine: null, enoughUntil: -Infinity, moveDotSaid: false, dotStart: null, closeAt: {},
    hp: createHappiness(Object.assign({ celebrateS: HAPPY_TUNING.celebrateS }, opts.happy || null)), meter: { value: 0, level: 1, full: false, fills: 0 },
    assist, beat: room ? createLaserTagBeat(beatOpts) : null,
    lt: null, ltRound: 0, best: 0, lastScore: null, hud: null, hudKey: null, scorecard: null, caption: null,
    hold: 0, restAt: -Infinity, extra: [], ltEvents: [], ltViews: {},
  };
}

/** Which gesture / sim path the bridge runs THIS frame: 'play' (roomcat steps, laser allowed), 'offer' (roomcat steps,
 *  laser muted) or 'lt' (Laser Tag steps, roomcat frozen). */
export function directorRoute(d) {
  if (d.mode === 'countdown' || d.mode === 'playing' || d.mode === 'scorecard') return 'lt';
  return d.mode === 'offer' ? 'offer' : 'play';
}

/** One frame of the meter (PLAY beats): roomcat's events -> GE1's happiness.js, then its step. Mutates d.meter (value 0..1,
 *  level, full = filled at least once, fills). Returns the happiness events ('happy_full' / 'happy_next') of this frame. */
export function meterStep(d, dt, simEvents) {
  if (simEvents && simEvents.length) happinessFromEvents(d.hp, simEvents);
  const ev = happinessStep(d.hp, dt * 1000), st = happinessState(d.hp), M = d.meter;
  M.value = st.pct; M.level = st.level; M.fills = st.fills; M.full = st.fills > 0;
  return ev;
}

/** Moment captions from roomcat v2 events (one per frame, the biggest wins). "So close!" at most once per closeCdS per kitten
 *  (closeAt = { [cat]: lastT }, mutated; t in seconds). "Gotcha!" every time, "Pounce combo!" as the sim sends it. */
export function momentCaption(simEvents, closeAt, t) {
  let cap = null;
  for (const ev of simEvents || []) {
    if (ev.type === 'combo') return DIRECTOR_TEXT.combo;
    if (ev.type === 'pounce' && ev.catch) cap = DIRECTOR_TEXT.gotcha;
    else if (ev.type === 'near_miss' && !cap) {
      if (!closeAt) cap = DIRECTOR_TEXT.close;
      else if (!(t - (closeAt[ev.cat] == null ? -Infinity : closeAt[ev.cat]) < HAPPY_TUNING.closeCdS)) { closeAt[ev.cat] = t; cap = DIRECTOR_TEXT.close; }
    }
  }
  return cap;
}

/** The point ray of this frame, if any: the right hand wins. gestureEvents = raw gestures.js events of both hands. */
export function pointRay(gestureEvents) {
  let ray = null;
  for (const ev of gestureEvents || []) {
    if ((ev.type === 'point_start' || ev.type === 'point_hold') && ev.origin && ev.dir) { if (!ray || ev.hand === 'right') ray = { o: ev.origin, d: ev.dir, hand: ev.hand }; }
  }
  return ray;
}
/** Does a ray hit a legal (non-ceiling) surface of the room? */
export function rayOnFloor(room, ray) {
  if (!room || !ray) return false;
  const hit = roomRaycast(room, ray.o, ray.d); if (!hit) return false;
  const s = roomSurface(room, hit.surf); return !!s && s.kind !== 'ceiling' && hit.t <= 6;
}
/** The ring spot: the legal spot nearest to ringAheadM ahead of the viewer { x, z } along the flat forward { x, z }. Pure. */
export function placeRing(room, viewer, forward) {
  if (!room || !room.floor) return null;
  const v = viewer || { x: 0, z: 0 }, f = forward || { x: 0, z: -1 }, fl = Math.sqrt(f.x * f.x + f.z * f.z) || 1;
  const L = roomNearestLegal(room, { x: v.x + f.x / fl * HAPPY_TUNING.ringAheadM, y: roomSurface(room, room.floor).y, z: v.z + f.z / fl * HAPPY_TUNING.ringAheadM });
  return L ? { x: L.x, y: L.y, z: L.z, surf: L.surf } : null;
}
/** Is the ring more than ringBehindDeg off the flat gaze? (the "turn around" hint, GDXE Build 2 MUST 2) */
export function ringBehind(ring, head, fwd) {
  if (!ring || !head || !fwd) return false;
  const dx = ring.x - head.x, dz = ring.z - head.z, dist = Math.sqrt(dx * dx + dz * dz);
  if (dist <= HAPPY_TUNING.ringNearM) return false; // standing on / next to the ring (even exactly over its centre): not "behind" (review BL S1 / BM NIT)
  const dl = dist, fl = Math.sqrt(fwd.x * fwd.x + fwd.z * fwd.z) || 1;
  return (dx * fwd.x + dz * fwd.z) / (dl * fl) < Math.cos(HAPPY_TUNING.ringBehindDeg * Math.PI / 180);
}
/** Does the ray hit the floor ring (within ringHitM of its centre, on its surface)? The start / Again target (review BB MUST 1 / S1). */
export function rayOnRing(room, ray, ring) {
  if (!room || !ray || !ring) return false;
  const hit = roomRaycast(room, ray.o, ray.d); if (!hit || hit.t > 6) return false;
  const dx = hit.x - ring.x, dz = hit.z - ring.z;
  return Math.abs(hit.y - ring.y) < 0.3 && dx * dx + dz * dz <= HAPPY_TUNING.ringHitM * HAPPY_TUNING.ringHitM;
}
function drPalmUp(gestureEvents) { for (const ev of gestureEvents || []) if (ev.type === 'palm_start' || ev.type === 'palm_hold') return true; return false; }

/** Start a Laser Tag round (countdown first) on GE1's createLaserTagBeat (next seed each round; the best rides inside it). */
export function startLaserTag(d) {
  d.ltRound++;
  if (d.ltRound >= 2) { d.assist.coach = false; const rounds = d.beat.rounds || []; if (rounds.length) d.assist.joinScale = laserTagRubberBand(d.assist.joinScale, rounds, LASER_TAG); }
  d.beat.start();
  d.lt = d.beat.game;
  d.mode = 'countdown'; d.modeT = 0; d.hold = 0; d.armed = false; d.scorecard = null; d.hud = null; d.hudKey = null; d.ltViews = {}; d.dotStart = null; d.moveDotSaid = false;
  d.extra.push({ sound: 'tick', haptic: 0.2 });
  return d;
}

/** Laser Tag cats as billboard-shaped records (the bridge runs them through catsToBillboards). Reused array `out`. Their
 *  billboard ids are 'lt:<coat>' so a Play kitten with the same coat (the roster is the same 8 starters) keeps its own billboard. */
export function ltCatRecords(d, out) {
  const o = out || []; o.length = 0;
  if (!d.lt) return o;
  const st = d.lt.state(), dot = st.dot;
  for (const c of st.catList) {
    let pose = c.pose;
    if (pose === 'walk') { const dx = dot.x - c.x, dz = dot.z - c.z; pose = dx * dx + dz * dz > VR_TAG.stalkFarM * VR_TAG.stalkFarM ? 'run' : 'walk'; }
    else if (pose === 'hop' && c.mode === 'pounce') pose = 'pounce';
    o.push({ id: 'lt:' + c.id, size: 'kitten', x: c.x, y: c.y, z: c.z, fx: c.fx, fz: c.fz, surf: c.surf, mode: c.mode, pose, poof: false, purr: false, bond: 0, airborne: c.mode === 'hop' || c.mode === 'pounce', support: c.surf });
  }
  return o;
}

function drHud(d) {
  const st = d.lt.state(), s = Math.floor(st.timeS), mult = st.mult >= 10 ? Math.round(st.mult) : st.mult.toFixed(1);
  if (d.hud && d.t - (d.hudT || 0) < 0.25) return; // review BB S4: the card redraws at most 4 Hz (and only on a change)
  d.hudT = d.t;
  const streak = st.fun && st.fun.mult > 1 ? `  close calls x${st.fun.mult}` : ''; // the multiplier chip, never a "streak to lose" line (fairness rule)
  const next = st.nextJoinS != null ? `  next kitten ${Math.max(0, Math.ceil(st.nextJoinS))} s` : '';
  const pts = Math.floor(st.points / 10) * 10; // score to the nearest 10 (S4)
  const key = `${pts}|${mult}|${s}|${streak}|${next}`;
  if (key !== d.hudKey) { d.hudKey = key; d.hud = `Score ${pts}  x${mult}  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${streak}${next}`; }
}
function drScorecard(d, res, prevBest) {
  const who = res.caughtBy ? `Caught by ${drName(res.caughtBy)}!` : 'Time! The kittens gave up';
  const lines = [who, `Score ${res.score}  ·  ${res.timeS.toFixed(1)} s`];
  if (prevBest > 0 && res.score >= prevBest) lines.push(DIRECTOR_TEXT.newBest); else if (prevBest > 0) lines.push(`Best this visit ${prevBest}`);
  lines.push(DIRECTOR_TEXT.again, DIRECTOR_TEXT.rest);
  return lines;
}

/**
 * One frame AFTER the bridge ran the sims. inp = { dt, t, state (roomcat, frozen in LT), prevState, simEvents (roomcat
 * events this frame), gestureEvents (raw gestures.js events, both hands), nSteps (fixed steps this frame), ray (point ray
 * this frame, from pointRay) }. In the 'lt' route the bridge calls ltStep first. Returns d (mutated) with:
 * d.caption (moment caption or null), d.hud (one line or null), d.scorecard (lines or null), d.extra (fx requests, drained
 * by the bridge), d.celebrate (bool), d.meterChanged.
 */
export function directorStep(d, inp) {
  const T = HAPPY_TUNING, dt = inp.dt || 0, ge = inp.gestureEvents;
  d.t += dt; d.modeT += dt; d.caption = null; d.celebrate = false;
  const ray = inp.ray === undefined ? pointRay(ge) : inp.ray;
  const onRing = !!ray && rayOnRing(d.room, ray, d.ring);
  // MUST 1 (review BB): the start / Again hold only counts for a FRESH point: a frame with no point ray after the offer / card
  // appeared arms it, so a point the player was already holding (the Play laser, the Laser Tag input itself) never starts a round
  // (review BF S1 / BI S1) a release is >= armNoRayS with no point ray. gestures.js emits point_end on the FIRST frame of a
  // tracking loss, so point_end alone is not trusted: a point that comes back within armNoRayS was never released
  d.noRayS = ray ? 0 : d.noRayS + dt;
  if (d.noRayS >= T.armNoRayS) d.armed = true;
  const holdStep = () => { d.hold = d.armed && onRing ? d.hold + dt : 0; };
  const v0 = d.meter.value;
  if (d.mode === 'play' || d.mode === 'offer' || d.mode === 'celebrate') {
    const hev = meterStep(d, dt, inp.simEvents);
    d.caption = d.mode === 'celebrate' ? null : momentCaption(inp.simEvents, d.closeAt, d.t);
    for (const ev of inp.simEvents || []) if (ev.type === 'wander_off') d.enoughUntil = d.t + (Number.isFinite(ev.s) ? ev.s : 8); // "had enough" line (GE1 hard-toss rule)
    let full = false, next = false;
    for (const e of hev) { if (e.type === 'happy_full') full = true; else if (e.type === 'happy_next') next = true; }
    if (full) { d.mode = 'celebrate'; d.modeT = 0; d.celebrate = true; d.beat2 = false; d.caption = DIRECTOR_TEXT.full; d.extra.push({ sound: 'fanfare', haptic: 0.7 }); }
    else if (d.mode === 'celebrate') {
      d.celebrate = true;
      if (!d.beat2 && d.modeT >= T.celebrateBeat2S) { d.beat2 = true; d.extra.push({ sound: 'combo', haptic: 0.5 }); if (inp.state) for (const c of inp.state.cats) if (c.mode !== 'inbox') d.extra.push({ heart: { x: c.x, y: c.y + 0.2, z: c.z, n: 3 } }); } // the second beat (fx limits bursts to 3 / s)
      if (next) { d.celebrate = false; d.mode = drCarried(inp.state) || !drOfferable(inp.state) ? 'play' : 'offer'; d.modeT = 0; d.hold = 0; d.armed = false; if (d.mode === 'offer') drRing(d, inp); if (d.mode === 'play') { d.restAt = d.t - T.reofferS; d.caption = DIRECTOR_TEXT.level.replace('{n}', String(d.meter.level)); } }
    }
    else if (d.mode === 'play' && d.meter.full && d.t - d.restAt >= T.reofferS && !drCarried(inp.state) && drOfferable(inp.state)) { d.mode = 'offer'; d.modeT = 0; d.hold = 0; d.armed = false; drRing(d, inp); }
    else if (d.mode === 'offer') {
      // the offer lives on the hint line (room-bridge) with the floor ring as its target; the Play laser stays live everywhere else
      holdStep();
      if (d.hold >= T.ltStartHoldS && !drCarried(inp.state)) startLaserTag(d);
      else if (drPalmUp(ge) && d.modeT > 0.5) { d.mode = 'play'; d.modeT = 0; d.restAt = d.t; d.hold = 0; d.extra.push({ sound: 'purr', haptic: 0.1 }); } // "not now": palm up declines; re-offered after reofferS
      else if (!drOfferable(inp.state)) { d.mode = 'play'; d.modeT = 0; d.restAt = Infinity; }
    } else if (d.mode === 'play' && d.modeT < 0.1 && d.t < 1) d.caption = DIRECTOR_TEXT.goal;
  } else if (d.mode === 'countdown' || d.mode === 'playing') {
    // ltStep already ran; read its events
    for (const ev of d.ltEvents) {
      if (ev.type === 'countdown') { d.caption = ev.caption; d.extra.push({ sound: 'tick', haptic: 0.15 }); }
      else if (ev.type === 'go') { d.mode = 'playing'; d.modeT = 0; d.caption = DIRECTOR_TEXT.ltGoal; d.extra.push({ sound: 'go', haptic: 0.4 }); }
      else if (ev.type === 'join') d.extra.push({ sound: 'mew', haptic: 0.1 });
      else if (ev.type === 'tell') d.extra.push({ sound: 'tick', haptic: 0.1 });
      else if (ev.type === 'pounce') d.extra.push({ sound: 'whoosh', haptic: 0.2 });
      else if (ev.type === 'near_miss') { const dot = d.lt.state().dot; d.caption = `Whisker-close! +${ev.shown != null ? ev.shown : Math.round(ev.bonus)}${ev.mult > 1 ? ` x${ev.mult}` : ''}`; d.extra.push({ sound: 'swish', haptic: 0.3, spark: { x: dot.x, y: dot.y + 0.02, z: dot.z, n: 5 } }); }
      else if (ev.type === 'comeback') d.caption = DIRECTOR_TEXT.comeback;
      else if (ev.type === 'new_best') { d.caption = DIRECTOR_TEXT.newBest; d.extra.push({ sound: 'combo', haptic: 0.4 }); }
      else if (ev.type === 'caught') { d.extra.push({ sound: 'caught', haptic: 0.8, dust: { x: ev.x, y: ev.y, z: ev.z, n: 8 } }); }
      else if (ev.type === 'laser_tag_result') { d.lastScore = ev; const wasBest = d.best; d.best = d.beat.best; d.scorecard = drScorecard(d, ev, wasBest); d.mode = 'scorecard'; d.modeT = 0; d.hold = 0; d.armed = false; d.hud = null; d.hudKey = null; drRing(d, inp); }
    }
    d.ltEvents.length = 0;
    if (d.mode === 'playing') {
      drHud(d);
      // the opener (GE1 openerMs, 7 s in round 1): a dot that has not moved openerMoveM by openerCheckS gets ONE "Move the dot!"
      const st = d.lt.state();
      if (!d.dotStart) d.dotStart = { x: st.dot.x, z: st.dot.z };
      if (!d.moveDotSaid && d.modeT >= T.openerCheckS) { const dx = st.dot.x - d.dotStart.x, dz = st.dot.z - d.dotStart.z; d.moveDotSaid = true; if (dx * dx + dz * dz < T.openerMoveM * T.openerMoveM) d.caption = DIRECTOR_TEXT.moveDot; }
    }
  } else if (d.mode === 'scorecard') {
    if (d.modeT >= T.scorecardMinS) {
      holdStep();
      if (d.hold >= T.ltStartHoldS) startLaserTag(d);
      else if (drPalmUp(ge)) { d.beat.end(); d.mode = 'play'; d.modeT = 0; d.lt = null; d.scorecard = null; d.restAt = d.t; d.hold = 0; d.extra.push({ sound: 'purr', haptic: 0.2 }); }
    }
  }
  // the extra hint line the bridge shows (over the onboarding hint, under the Laser Tag HUD): "turn around" while the ring is
  // behind the gaze for ringBehindS in offer / scorecard; "had enough" during a sulk (GDXE Build 2 MUST 1 / 2)
  if ((d.mode === 'offer' || d.mode === 'scorecard') && ringBehind(d.ring, inp.head, inp.fwd)) d.behindS += dt; else d.behindS = 0;
  // during a sulk in the offer both lines show (review BL S2): the offer stays, the sulk line rides beside it
  const enough = d.t < d.enoughUntil && (d.mode === 'play' || d.mode === 'offer');
  // two card lines ('\n': room-hook splits it; each at full size, review BM) rather than one long shrunken line
  d.hintLine = d.behindS >= T.ringBehindS ? DIRECTOR_TEXT.turn : enough ? (d.mode === 'offer' ? DIRECTOR_TEXT.enough + '\n' + DIRECTOR_TEXT.offer : DIRECTOR_TEXT.enough) : null;
  d.meterChanged = d.meter.value !== v0;
  return d;
}
/** re-place the ring from the current head + flat forward (inp.head / inp.fwd from the bridge; the build-time spot otherwise) */
function drRing(d, inp) { if (inp && inp.head && inp.fwd) { const r = placeRing(d.room, { x: inp.head.x, z: inp.head.z }, inp.fwd); if (r) d.ring = r; } d.behindS = 0; }
/** the offer only stands while the kittens are in their play phase (never in wind-down / nap / end: review BB S1) */
function drOfferable(state) { return !state || !state.phase || state.phase === 'play' || state.phase === 'climb'; }
function drCarried(state) { if (!state) return false; for (const c of state.cats) if (c.mode === 'carried' || c.mode === 'onhand') return true; return false; }

/** The Laser Tag steps of this frame (route 'lt' only): n fixed steps with the frame's ray; events collected in d.ltEvents. */
export function ltStep(d, n, ray) {
  if (!d.lt) return d;
  const input = ray ? { ray: { o: ray.o, d: ray.d } } : null;
  for (let i = 0; i < n; i++) for (const ev of d.beat.tick(input)) d.ltEvents.push(ev);
  return d;
}
/** The floor ring the host draws while Laser Tag is offered / on the score card (the point-hold target): { x, y, z } or null. */
export function offerRing(d) { return (d.mode === 'offer' || d.mode === 'scorecard') && d.ring ? d.ring : null; }
/** The dot the host draws during Laser Tag: { x, y, z, on } or null. */
export function ltDot(d) { if (!d.lt) return null; const s = d.lt.state(), a = Number.isFinite(s.dot.alpha) ? s.dot.alpha : (s.dot.on ? 1 : 0); return a > 0 ? { x: s.dot.x, y: s.dot.y, z: s.dot.z, on: true, alpha: a, scoring: s.dot.scoring !== false } : null; }

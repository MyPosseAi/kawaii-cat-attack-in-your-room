/* game/core/lasertag-room.js — VR LASER TAG CORE (dev/impl/SK-95.md). The 2D desktop game (lasertag.js, BL units,
   platforms world, ranked server replay) re-done in METRES on a scanned room (room.js surfaces, routes, ray casts) for the
   Quest entry: pure, deterministic, no DOM, no network. The player's hand ray is the input; the dot is a PROJECTION on a
   legal surface (floor / rug / couch seat / low table top: roomRaycast, a forbidden top snaps to the nearest legal spot via
   roomNearestLegal); air / ceiling = the dot stays on its last legal point and goes dark after fadeMs (never sooner than
   minLitMs after it lit: no blink), and the score accrues ONLY while the ray hits a legal surface (no "hide the dot"
   exploit). The dot slides along its surface at <= dotSpeedMps; a jump to another surface is a lit jump (no blink).
   Cats come ONLY from `roster` (starter ids; never defaulted to LASER_TAG.catOrder),
   join on the desktop schedule (laserTagJoinTimes x the hidden assist), and run a per-cat FSM in metres:
   enter -> approach (roomRoute hops between surfaces) -> stalk -> tell -> pounce | slap -> pin / cooldown. Every catch is
   preceded by its tell (wiggle 350 ms, slap arm 250 ms); joinGraceMs, dodgeMs, the near-miss pay-out (nearMissS x rate) and
   the score curve (10 x 1.06^t, the stepGrowth literal) are the desktop's. Fun layer = lasertag-fun.js with metre knobs.
   Round: countdown (1.5 s, captions 3 / 2 / 1) -> playing -> caught | time_cap -> scorecard (the host shows it at once:
   <= 3 s) -> "Again?" = a new createLaserTagRoom (rules: never auto-starts). Events mirror lasertag.js:
   join, tell, pounce, near_miss, caught, time_cap, laser_tag_result { score, timeS, caughtBy, hash }, + streak / comeback /
   pb_close / new_best. Unranked, offline: no server replay, no prize, no world id. The local best (`ltBest`, a
   number) is kept IN MEMORY by the host until Legal's section 10.1 line (Oct 23) lets it into the kca.vr.visit record;
   LT_ROOM_BEST_NOTICE_KEY is the caption key for that line (text = Legal's, not here). replayLaserTagRoom(opts, log). */
import { createPrng, createHasher } from './prng.js';
import { STEP_MS, STEP_S } from './loop.js';
import { roomSurface, roomLegalAt, roomLineLegal, roomRoute, roomNearestLegal, roomRaycast } from './room.js';
import { LASER_TAG, laserTagJoinTimes, laserTagAssist, laserTagRubberBand } from './lasertag.js';
import { createLtFun, ltFunStep, ltFunHash, ltFunState } from './lasertag-fun.js';

/** the coats a VR Laser Tag roster may use: LASER_TAG.catOrder (entry = starter cats only) */
export const LT_ROOM_PREMIUM = Object.freeze([]);
export const LT_ROOM_STARTERS = Object.freeze(LASER_TAG.catOrder.filter((id) => LT_ROOM_PREMIUM.indexOf(id) < 0));
/** the visit-record field for the local best (whitelisted in vr/src/visit-store.js ONLY after Legal 10.1, Oct 23) and the
    caption key whose wording Legal supplies (a PLACEHOLDER key: no text lives here) */
export const LT_ROOM_BEST_FIELD = 'ltBest';
export const LT_ROOM_BEST_NOTICE_KEY = 'lt_best_notice_legal_10_1';

/** metre knobs (PROVISIONAL, GDXE tunes; blM = a kitten body length, the desktop BL numbers x blM where they carry over) */
export const VR_TAG = Object.freeze({
  version: 2,             // the VR core's version (overrides LASER_TAG.version in the merged table); 2 = P0a opener + ambush pounce (GE1 2026-10-10)
  blM: 0.18,              // kitten body length in metres (ROOMCAT_SIZES.kitten.h)
  dotSpeedMps: 2.0,       // the dot slides along its surface at most this fast (a kitten runs 0.9, walks 0.35)
  catchM: 0.072,          // landing / paw point to dot = a catch (0.4 BL)
  slapM: 0.054,           // paw slap reach (0.3 BL)
  nearMissM: 0.25,        // a pounce landing within this (but not a catch) pays nearMissS x rate (1.4 BL)
  comebackM: 0.5,         // fun layer: comeback radius
  maxCats: 5,             // with the Play crowd <= 8 billboards in view
  fadeMs: 300,            // no legal hit: the dot goes dark after this on its last legal point (score paused at once)
  minLitMs: 1000,         // ... and never sooner than this after it last came on: <= 1 off-period per second (no blink, <= 3 changes / s)
  alphaUpMs: 150, alphaDownMs: 200, // dot.alpha ramps (the host draws alpha; fade >= 150 ms)
  blinkMs: 0,             // (Review BA MUST 1: there is NO surface-change blink any more; the dot jumps, lit)
  quant: 256,             // ray quantisation 1/256 m
  walkMps: 0.35, runMps: 0.9, up: 0.55, gap: 0.6, drop: 1.4, // kitten limits (ROOMCAT_SIZES.kitten)
  stalkFarM: 0.55, stalkNearM: 0.43, // 3.1 / 2.4 BL: creep in this band, run outside it (P0a Build 1 fix 4: 0.65 -> 0.55, the slow human lands sooner)
  bandLoM: 0.22, bandHiM: 0.41,      // pounce band 1.2 / 2.3 BL
  slapFromM: 0.144,                  // dot under the paws (< 0.8 BL)
  wiggleMs: 350, rushTellMs: 150, slapArmMs: 250, flightMs: 310, pinMs: 400, slapCdMs: 500,
  pounceReachM: 0.5,                 // a pounce never flies further than this
  rushFrom: 2,                       // cats #3+ may pounce from a run (short crouch tell)
  hopClearM: 0.1, g: 9.81,
  countdownMs: 1500,
  // P0a (GE1, GDXE flags): openerMs = no tell / pounce / slap before this much of the round (the cats walk in and STALK the
  // dot first: a still dot used to die at 2.1 s); fastDotMps = a dot moving faster than a kitten runs is AMBUSHED: the tell
  // fires when the dot's curved lead (velocity + acceleration over the tell + flight) lands within pounceReachM of the cat,
  // and the pounce aims at the curved lead over the flight (a 1.26 m/s circle was never caught: a straight lead misses a curve)
  openerMs: 4000, fastDotMps: 1.0, ambushP: 2, ambushSlackM: 0.3, ambushLookS: 2.4, ambushHoldM: 0.3, ambushMaxMs: 4000, fizzleCdMs: 700,
  maxRunMs: 180000,                  // 3 min cap (unranked, local: a seated player's round, not the desktop's 10 min server bound); the score is kept
});

function ltrDist(dx, dz) { return Math.sqrt(dx * dx + dz * dz); }
/** ballistic hop arc from y0 to y1 clearing `clear` above the higher end (PROVISIONAL local copy of roomcat.js startHop's
    maths: GE3 owns roomcat.js right now; when roomHopArc() is exported there this helper goes, see team/FROM-MANAGER.md) */
function ltrArc(y0, y1, clear, g) { const apex = Math.max(y0, y1) + clear, vy = Math.sqrt(2 * g * (apex - y0)); return { vy, dur: vy / g + Math.sqrt(2 * (apex - y1) / g) }; }

export function createLaserTagRoom({ room, seed = 1, roster = null, tag = null, assist = null, best = 0, countdownMs = null } = {}) {
  if (!room || !room.floor) throw new Error('lasertag-room: room with a floor (or rug) required');
  const T = Object.assign({}, LASER_TAG, VR_TAG, tag || null), A = laserTagAssist(assist, false, T); // ONE knob table: the desktop numbers (score curve, grace, dodge, pounce odds, coach, assist clamp), the metre overrides (VR_TAG wins on shared names: version, maxCats, countdownMs, maxRunMs), then the round's `tag`. VR is never ranked
  const ids = (Array.isArray(roster) ? roster : []).map(String).filter((id, i, a) => LT_ROOM_STARTERS.indexOf(id) >= 0 && a.indexOf(id) === i);
  if (!ids.length) throw new Error('lasertag-room: roster of starter cat ids required (never LASER_TAG.catOrder)');
  const prng = createPrng(seed), stepG = T.growth === 1.06 ? T.stepGrowth : Math.pow(T.growth, 1 / 60);
  const joins = laserTagJoinTimes(Object.assign({}, T, { maxCats: Math.min(T.maxCats, ids.length) }), A.joinScale);
  const order = ids.slice(); for (let i = order.length - 1; i > 0; i--) { const j = prng.int(i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
  const lim = { up: T.up, gap: T.gap, drop: T.drop }, floor = roomSurface(room, room.floor), CD = countdownMs == null ? T.countdownMs : countdownMs;
  const fun = createLtFun({ comebackR: T.comebackM, streakWindowMs: T.streakWindowMs, streakCap: T.streakCap, comebackMs: T.comebackMs });
  const spawn = room.box ? { surf: room.box.surf, x: room.box.x, y: room.box.y, z: room.box.z } : { surf: floor.id, x: floor.samples[0].x, y: floor.y, z: floor.samples[0].z };
  const dot = { surf: spawn.surf, x: spawn.x, y: spawn.y, z: spawn.z, on: true, scoring: true, alpha: 1, litMs: -1e9, offMs: 0, blink: 0, tx: spawn.x, tz: spawn.z, tsurf: spawn.surf, vx: 0, vz: 0, ax: 0, az: 0, px: spawn.x, pz: spawn.z };
  const cats = [], log = [], out = [], evs = [];
  const lt = { phase: CD > 0 ? 'countdown' : 'playing', phaseMs: 0, simTick: 0, elapsedMs: 0, points: 0, mult: 1, nearMisses: 0, caught: null, ended: null, bestStreak: 0, cdShown: -1 };
  const rate = () => T.basePts * lt.mult;
  const funCtx = { elapsedMs: 0, rate: 0, points: 0, best: Number.isFinite(+best) ? Math.max(0, +best) : 0, growth: T.growth, dot: { x: 0, y: 0 }, cats: [], caught: false };
  const q = T.quant, qz = (v) => Math.round(v * q), last = [0, 0, 0, 0, 0, 0]; let haveRay = false;

  function addCat() {
    const k = cats.length, id = order[k];
    // walk in from the floor sample farthest from the dot (fair: never on top of the player's dot; the box spot is where
    // the DOT starts, so cat 1 enters from the far side of the rug and the grace runs while it crosses)
    let sx = spawn.x, sz = spawn.z, bd = -1; const ssurf = floor.id, sy = floor.y;
    for (const p of floor.samples) { const d = ltrDist(p.x - dot.x, p.z - dot.z); if (d > bd) { bd = d; sx = p.x; sz = p.z; } }
    const c = { id, k, surf: ssurf, x: sx, y: sy, z: sz, fx: 0, fz: 1, mode: 'approach', modeMs: 0, joinedMs: lt.elapsedMs, pounceP: T.pounceP + T.pouncePStep * k, cooldownMs: Math.max(T.cooldownMinMs, T.cooldownMs - 100 * k), lastPounceMs: -1e9, tellMs: -1, tellRunning: false, slapMs: -1, inMs: 0, trapD: -1, hop: null, land: null, aim: null, back: false, ambush: false, ambushMs: 0 };
    if (A.coach && k < T.coach.k) { c.pounceP = T.coach.pounceP; c.cooldownMs = T.coach.cooldownMs; c.coach = true; } else c.coach = false;
    c.slapArmMs = c.coach ? T.coach.slapArmMs : T.slapArmMs; c.dodgeMs = c.coach ? T.coach.dodgeMs : T.dodgeMs; // (slapArmMs 250 / dodgeMs 100 are the desktop's, in ms)
    cats.push(c); evs.push({ type: 'join', cat: id, n: cats.length, x: c.x, y: c.y, z: c.z });
  }
  const face = (c, dx, dz) => { const d = ltrDist(dx, dz); if (d > 1e-9) { c.fx = dx / d; c.fz = dz / d; } };
  /** walk c toward (x, z) on its surface at speed v (m/s); stops on the spot; stays legal: a blocked straight step
      (an obstacle footprint, the couch on the floor) deflects 45 / 90 / 135 degrees, and when every deflection is blocked
      the cat heads for the surface sample nearest the goal that it can reach in a straight legal line (no cat stands
      against a couch for ever: the "no stuck cat" rule). Returns true when it has arrived. */
  const DEFL = [0.7071, -0.7071, 1, -1, 0.7071, -0.7071];
  function walkTo(c, x, z, v) {
    const dx = x - c.x, dz = z - c.z, d = ltrDist(dx, dz), s = v * STEP_S; face(c, dx, dz);
    if (d <= s) { if (roomLegalAt(room, c.surf, x, z)) { c.x = x; c.z = z; return true; } return false; }
    const ux = dx / d, uz = dz / d;
    if (roomLegalAt(room, c.surf, c.x + ux * s, c.z + uz * s)) { c.x += ux * s; c.z += uz * s; return false; }
    for (let i = 0; i < 6; i++) { // deflect: 45 deg either side, 90 either side, 135 either side (cos, sin of the turn)
      const ang = i < 2 ? 0.7854 : i < 4 ? 1.5708 : 2.3562, sg = i % 2 ? -1 : 1, ca = Math.cos(ang), sa = Math.sin(ang) * sg;
      const vx = ux * ca - uz * sa, vz = ux * sa + uz * ca;
      if (roomLegalAt(room, c.surf, c.x + vx * s, c.z + vz * s)) { c.x += vx * s; c.z += vz * s; return false; }
    }
    const S = roomSurface(room, c.surf); let bx = c.x, bz = c.z, bd = Infinity; // boxed in: the reachable sample nearest the goal
    for (const p of S.samples) { const dd = ltrDist(p.x - x, p.z - z); if (dd < bd && ltrDist(p.x - c.x, p.z - c.z) > s && roomLineLegal(room, c.surf, c, p)) { bd = dd; bx = p.x; bz = p.z; } }
    if (bd < Infinity) { const ex = bx - c.x, ez = bz - c.z, e = ltrDist(ex, ez); c.x += ex / e * s; c.z += ez / e * s; }
    return false;
  }
  function startHop(c, to, x, y, z) { const a = ltrArc(c.y, y, T.hopClearM, T.g), n = Math.max(6, Math.ceil(a.dur / STEP_S)); face(c, x - c.x, z - c.z); c.hop = { x0: c.x, y0: c.y, z0: c.z, x1: x, y1: y, z1: z, vy: a.vy, dur: a.dur, n, k: 0, to }; c.mode = 'hop'; c.modeMs = 0; c.surf = null; }
  function stepHop(c) {
    const h = c.hop; h.k++; const t = Math.min(1, h.k / h.n), tt = t * h.dur;
    c.x = h.x0 + (h.x1 - h.x0) * t; c.z = h.z0 + (h.z1 - h.z0) * t; c.y = Math.max(Math.min(h.y0, h.y1) - 0.5, h.y0 + h.vy * tt - 0.5 * T.g * tt * tt);
    if (h.k >= h.n) { c.x = h.x1; c.y = h.y1; c.z = h.z1; c.surf = h.to; c.hop = null; c.mode = 'approach'; c.modeMs = 0; }
  }
  /** nearest legal sample of c's own surface to the dot (the chase target when the dot is on a surface c cannot reach) */
  function nearestOwn(c) { const s = roomSurface(room, c.surf); let bx = c.x, bz = c.z, bd = Infinity; for (const p of s.samples) { const d = ltrDist(p.x - dot.x, p.z - dot.z); if (d < bd) { bd = d; bx = p.x; bz = p.z; } } return { x: bx, z: bz }; }
  /** where the dot will be in ts seconds on a constant-turn path (speed + turn rate from its smoothed velocity and
      acceleration: exact for a circle, the straight lead when it barely turns). Writes into `pt`. */
  const pt = { x: 0, z: 0 };
  function predictDot(ts) {
    const vx = dot.vx, vz = dot.vz, v2 = vx * vx + vz * vz, w = v2 > 1e-6 ? (vx * dot.az - vz * dot.ax) / v2 : 0;
    if (Math.abs(w) < 0.05) { pt.x = dot.x + vx * ts; pt.z = dot.z + vz * ts; return pt; }
    const sn = Math.sin(w * ts) / w, cs = (1 - Math.cos(w * ts)) / w;
    pt.x = dot.x + vx * sn - vz * cs; pt.z = dot.z + vz * sn + vx * cs; return pt;
  }
  function think(c) {
    c.modeMs += STEP_MS;
    if (c.mode === 'hop') { stepHop(c); return; }
    if (c.mode === 'pin') { if (c.modeMs >= T.pinMs) { c.mode = 'approach'; c.modeMs = 0; } return; }
    if (c.mode === 'pounce') { // the flight: ballistic to the aim point, the catch check runs in catchCheck on the landing step
      const a = c.aim, t = Math.min(1, c.modeMs / T.flightMs); c.x = a.x0 + (a.x - a.x0) * t; c.z = a.z0 + (a.z - a.z0) * t; c.y = a.y + 4 * T.hopClearM * t * (1 - t);
      if (t >= 1) { c.y = a.y; c.land = { x: c.x, z: c.z }; c.mode = 'pin'; c.modeMs = 0; }
      return;
    }
    if (c.mode === 'tell') { // standing wiggle (350 ms) or running crouch (150 ms): aimed at the dot's position at tell END
      if (c.modeMs >= (c.tellRunning ? T.rushTellMs : T.wiggleMs)) {
        const P = predictDot(T.flightMs / 1000), dx = P.x - c.x, dz = P.z - c.z, d = ltrDist(dx, dz), r = Math.min(d, T.pounceReachM) / Math.max(d, 1e-9); // the leap LEADS a moving dot by its smoothed velocity (+ acceleration: a circling dot curves) over the flight (pounceLeadS): a steady dot is caught, one that turns during the tell / flight escapes (the skill)
        if (dot.surf === c.surf && dot.on && (ltrDist(dot.x - c.x, dot.z - c.z) <= T.bandHiM + 0.1 || d <= T.pounceReachM + 0.1) && roomLegalAt(room, c.surf, c.x + dx * r, c.z + dz * r)) { c.aim = { x0: c.x, z0: c.z, x: c.x + dx * r, z: c.z + dz * r, y: c.y }; face(c, dx, dz); c.mode = 'pounce'; c.modeMs = 0; c.lastPounceMs = lt.elapsedMs; evs.push({ type: 'pounce', cat: c.id }); }
        else { c.mode = 'approach'; c.modeMs = 0; c.lastPounceMs = Math.max(c.lastPounceMs, lt.elapsedMs - c.cooldownMs + T.fizzleCdMs); } // the dot left the band during the wiggle: no leap (the tell was the warning); a short rest before the next tell (no tell spam)
      }
      return;
    }
    if (c.mode === 'slap') { if (c.modeMs > c.slapArmMs + STEP_MS) { c.mode = 'cooldown'; c.modeMs = 0; } return; } // the paw comes down at slapArmMs (catchCheck), then rests
    if (c.mode === 'cooldown') { if (c.modeMs >= T.slapCdMs) { c.mode = 'approach'; c.modeMs = 0; } return; }
    // approach / stalk
    if (c.surf !== dot.surf) {
      const route = roomRoute(room, c.surf, dot.surf, lim);
      if (route && route.length) { const pair = route[0].pairs[0]; if (walkTo(c, pair.a.x, pair.a.z, T.runMps)) { const to = roomSurface(room, route[0].to); startHop(c, route[0].to, pair.b.x, to.y, pair.b.z); } return; }
      const p = nearestOwn(c); walkTo(c, p.x, p.z, T.runMps); return; // unreachable: shadow the dot from my surface (no catch possible)
    }
    const dx = dot.x - c.x, dz = dot.z - c.z, d = ltrDist(dx, dz), ready = lt.elapsedMs - c.lastPounceMs > c.cooldownMs && lt.elapsedMs >= T.openerMs;
    const dotV = ltrDist(dot.vx, dot.vz), creep = dotV > T.walkMps * 0.8 ? T.runMps : T.walkMps; // a dot on the move is CHASED (a creep never closes on a 0.5 m/s dot); a slow dot is stalked
    // the chase LEADS the dot (desktop roles: hunter 0.15 s + 0.05 s per later cat, cutter 1.0 s): a dot circling faster
    // than a kitten runs (2.0 vs 0.9 m/s) is cut off, not followed; the lead point is clamped to the surface's legal top
    const leadS = c.k % 3 === 2 ? 1.0 : Math.min(0.5, 0.15 + 0.05 * c.k), LP = predictDot(leadS); let lx = LP.x, lz = LP.z; // curved lead (constant-turn path)
    if (!roomLegalAt(room, c.surf, lx, lz)) { lx = dot.x; lz = dot.z; }
    if (dotV > T.fastDotMps && dot.on && d <= T.stalkFarM * 2) { // AMBUSH: the dot outruns me (a kitten runs 0.9 m/s): a real cat stops and waits on the path
      const P = predictDot((T.wiggleMs + T.flightMs) / 1000), ex = P.x - c.x, ez = P.z - c.z, ed = ltrDist(ex, ez);
      if (ready && ed >= T.bandLoM && ed <= T.pounceReachM + T.ambushSlackM && prng.chance(Math.min(1, c.pounceP * T.ambushP))) { c.mode = 'tell'; c.modeMs = 0; c.tellRunning = false; face(c, ex, ez); evs.push({ type: 'tell', cat: c.id, running: false, ambush: true }); return; } // its curved path crosses my reach at the end of a tell + flight: tell now
      let bx = dot.x, bz = dot.z, bd = d; // the dot's path over the next ambushLookS (constant-turn model: a circle stays a circle): its point nearest me
      for (let k = 1; k <= 12; k++) { const Q = predictDot(k * T.ambushLookS / 12), qd = ltrDist(Q.x - c.x, Q.z - c.z); if (qd < bd) { bd = qd; bx = Q.x; bz = Q.z; } }
      if (bd <= T.ambushHoldM && c.ambushMs < T.ambushMaxMs) { c.back = false; face(c, dx, dz); c.ambush = true; c.ambushMs += STEP_MS; return; } // the path passes by me: hold still, eyes on the dot (it comes round again); never longer than ambushMaxMs in one go
      c.ambush = false; if (c.ambushMs >= T.ambushMaxMs) c.ambushMs = Math.max(0, c.ambushMs - 4 * STEP_MS); if (roomLegalAt(room, c.surf, bx, bz)) walkTo(c, bx, bz, creep); else walkTo(c, dot.x, dot.z, creep); return; // too far from its path (or held long enough): creep onto it
    }
    c.ambush = false; c.ambushMs = 0;
    if (d > T.stalkFarM) { c.back = false; walkTo(c, lx, lz, T.runMps); return; }
    if (d > T.stalkNearM) { c.back = false; walkTo(c, lx, lz, creep); return; } // stalk: creep in
    if (d >= T.bandLoM && d <= T.bandHiM && ready && dot.on && !c.back && dotV <= T.fastDotMps) { // a dot that outruns me gets the ambush tell above, never the band tell (it would fizzle)
      if (prng.chance(c.pounceP)) { c.mode = 'tell'; c.modeMs = 0; c.tellRunning = false; face(c, dx, dz); evs.push({ type: 'tell', cat: c.id, running: false }); return; }
      walkTo(c, dot.x, dot.z, dotV > T.walkMps * 0.8 ? creep : T.walkMps * 0.5); return; // edge in
    }
    if (d < T.slapFromM && ready && dot.on && prng.chance(0.12)) { c.mode = 'slap'; c.modeMs = 0; c.slapMs = lt.elapsedMs; face(c, dx, dz); evs.push({ type: 'tell', cat: c.id, running: false, slap: true }); return; }
    if (d < T.bandLoM || (c.back && d < T.bandLoM + 0.07)) { c.back = true; walkTo(c, c.x - dx / Math.max(d, 1e-9) * 0.3, c.z - dz / Math.max(d, 1e-9) * 0.3, T.walkMps); face(c, dx, dz); return; } // too close to leap: back into the band
    c.back = false; walkTo(c, dot.x, dot.z, dotV > T.walkMps * 0.8 ? creep : T.walkMps * 0.5);
  }
  function catchCheck(c) {
    const px = c.x + c.fx * T.catchM, pz = c.z + c.fz * T.catchM, same = c.surf === dot.surf && dot.on; // paw point
    c.inMs = same && ltrDist(px - dot.x, pz - dot.z) <= T.catchM ? Math.min(2 * c.dodgeMs, c.inMs + STEP_MS) : Math.max(0, c.inMs - STEP_MS * 0.25);
    if (lt.elapsedMs - c.joinedMs < T.joinGraceMs) { c.land = null; return null; }
    if (c.land) { // the pounce landed this step: one catch rule, distance from the landing point to the dot AT LANDING
      const d = same ? ltrDist(c.land.x - dot.x, c.land.z - dot.z) : Infinity; c.land = null;
      if (d <= T.catchM) return 'pounce';
      if (d <= T.nearMissM) { const bonus = T.nearMissS * rate(); lt.points += bonus; lt.nearMisses++; evs.push({ type: 'near_miss', cat: c.id, bonus, d }); }
    }
    if (c.mode === 'slap' && c.modeMs >= c.slapArmMs && c.modeMs < c.slapArmMs + STEP_MS) { const d = same ? ltrDist(px - dot.x, pz - dot.z) : Infinity; if (d <= T.slapM) { if (c.inMs >= c.dodgeMs) return 'slap'; const bonus = T.nearMissS * rate(); lt.points += bonus; lt.nearMisses++; evs.push({ type: 'near_miss', cat: c.id, bonus, d, dodge: true }); } }
    return null;
  }
  /** Review BA MUST 1 / photosensitivity: the dot NEVER blinks. A surface change (or a hole in the slide) JUMPS the
      dot to the target, lit. Only a ray into the air / ceiling / above the hand darkens it, and only after fadeMs on its last
      legal point, never sooner than minLitMs after it last came on (so a sweep that grazes the air cannot strobe); dot.alpha
      ramps over alphaUpMs / alphaDownMs for the host (draw alpha, never toggle `visible`). `scoring` = this step pays (a legal
      ray hit); `on` = visible. */
  function moveDot() {
    dot.px = dot.x; dot.pz = dot.z;
    if (!haveRay) { dot.offMs += STEP_MS; dot.scoring = false; if (dot.on && dot.offMs >= T.fadeMs && lt.elapsedMs - dot.litMs >= T.minLitMs) dot.on = false; }
    else {
      dot.scoring = true; dot.offMs = 0; if (!dot.on) { dot.on = true; dot.litMs = lt.elapsedMs; }
      if (dot.tsurf !== dot.surf) { dot.surf = dot.tsurf; dot.x = dot.tx; dot.z = dot.tz; dot.y = roomSurface(room, dot.surf).y; } // a new surface: jump, lit
      else {
        const dx = dot.tx - dot.x, dz = dot.tz - dot.z, d = ltrDist(dx, dz), s = T.dotSpeedMps * STEP_S;
        let nx = dot.tx, nz = dot.tz; if (d > s) { nx = dot.x + dx / d * s; nz = dot.z + dz / d * s; }
        if (roomLegalAt(room, dot.surf, nx, nz, 0)) { dot.x = nx; dot.z = nz; } else { dot.x = dot.tx; dot.z = dot.tz; } // the straight slide left the legal top (a hole): jump to the target, lit
      }
    }
    const target = dot.on ? 1 : 0, rate = STEP_MS / (dot.on ? T.alphaUpMs : T.alphaDownMs);
    if (target > dot.alpha) dot.alpha = Math.min(1, dot.alpha + rate); else if (target < dot.alpha) dot.alpha = Math.max(0, dot.alpha - rate); // (at the target it HOLDS: Review BE MUST 1, a lit dot used to flicker 1 <-> 0.889)
    const pvx = dot.vx, pvz = dot.vz;
    dot.vx += ((dot.x - dot.px) * 60 - dot.vx) * 0.15; dot.vz += ((dot.z - dot.pz) * 60 - dot.vz) * 0.15;
    dot.ax += ((dot.vx - pvx) * 60 - dot.ax) * 0.15; dot.az += ((dot.vz - pvz) * 60 - dot.az) * 0.15; // smoothed acceleration (the curve of a circling dot)
  }
  /** the deterministic sim core: one playing step with the quantised ray [ox, oy, oz, dx, dy, dz] (6 ints) or [] = no ray */
  function simStep(qr) {
    evs.length = 0; if (lt.ended) return;
    log.push(qr); lt.simTick++; lt.elapsedMs = lt.simTick * STEP_MS;
    haveRay = qr.length === 6;
    if (haveRay) {
      const hit = roomRaycast(room, { x: qr[0] / q, y: qr[1] / q, z: qr[2] / q }, { x: qr[3] / q, y: qr[4] / q, z: qr[5] / q });
      const S = hit && roomSurface(room, hit.surf);
      if (hit && S && S.kind !== 'ceiling' && hit.y <= qr[1] / q) { const L = hit.legal && roomLegalAt(room, hit.surf, hit.x, hit.z, 0) ? hit : roomNearestLegal(room, hit); if (L) { dot.tsurf = L.surf; dot.tx = L.x; dot.tz = L.z; } else haveRay = false; } // a forbidden TOP (couch back, plant, high shelf) snaps to the nearest legal spot under it; the ceiling / anything above the hand is "air"
      else haveRay = false;
    }
    moveDot();
    while (cats.length < joins.length && lt.elapsedMs >= joins[cats.length]) addCat();
    for (const c of cats) think(c);
    for (const c of cats) { const how = catchCheck(c); if (how) { lt.caught = { cat: c.id, how, tick: lt.simTick }; lt.ended = 'caught'; evs.push({ type: 'caught', cat: c.id, how, x: dot.x, y: dot.y, z: dot.z }); break; } }
    if (!lt.ended) {
      if (dot.scoring) { if (lt.mult < T.multCap) lt.mult = Math.min(T.multCap, lt.mult * stepG); lt.points += T.basePts * lt.mult * STEP_S; } // score ONLY while the ray lights a legal surface (a visible-but-fading dot in the air pays nothing)
      if (lt.elapsedMs >= T.maxRunMs) { lt.ended = 'time_cap'; evs.push({ type: 'time_cap' }); }
    }
    funCtx.elapsedMs = lt.elapsedMs; funCtx.rate = rate(); funCtx.points = lt.points; funCtx.caught = !!lt.ended; funCtx.dot.x = dot.x; funCtx.dot.y = dot.z; funCtx.cats.length = 0;
    for (const c of cats) funCtx.cats.push({ x: c.x, y: c.z }); // (x, z) plane; a cat on another surface is still "near" if its footprint is: the crowd is what the player sees
    const fev = ltFunStep(fun, evs, funCtx);
    for (const e of evs) if (e.type === 'near_miss' && e.mult > 1) { const extra = e.bonus * (e.mult - 1); lt.points += extra; e.bonus += extra; }
    for (let i = 0; i < fev.length; i++) { evs.push(fev[i]); if (fev[i].type === 'streak' && fev[i].n > lt.bestStreak) lt.bestStreak = fev[i].n; }
    if (lt.ended) finish();
  }
  function finish() { lt.phase = 'scorecard'; lt.phaseMs = 0; evs.push({ type: 'laser_tag_result', reason: lt.ended, caughtBy: lt.caught ? lt.caught.cat : null, score: Math.floor(lt.points), timeS: lt.elapsedMs / 1000, steps: lt.simTick, seed, hash: simHash(), version: T.version, assist: { ...A }, bestStreak: lt.bestStreak, nearMisses: lt.nearMisses }); }
  function simHash() {
    const h = createHasher(); h.num(T.version).num(A.joinScale).num(A.coach ? 1 : 0); ltFunHash(fun, h);
    h.num(lt.simTick).num(prng.getState()).str(dot.surf || '-').num(dot.x).num(dot.z).num(dot.on ? 1 : 0).num(dot.scoring ? 1 : 0).num(dot.offMs).num(dot.litMs).num(cats.length).str(lt.ended || '-').str(String(Math.floor(lt.points))).num(lt.points - Math.floor(lt.points)).num(lt.mult).num(lt.nearMisses);
    for (const c of cats) h.str(c.id).str(c.surf || '-').num(c.x).num(c.y).num(c.z).num(c.fx).num(c.fz).str(c.mode).num(c.modeMs).num(c.inMs).num(c.lastPounceMs);
    return h.digest();
  }
  function quantise(input) {
    const r = input && input.ray; if (!r || !r.o || !r.d || !Number.isFinite(r.d.y)) return [];
    last[0] = qz(r.o.x); last[1] = qz(r.o.y); last[2] = qz(r.o.z); last[3] = qz(r.d.x); last[4] = qz(r.d.y); last[5] = qz(r.d.z);
    return last.slice();
  }
  addCat(); evs.length = 0; // cat #1 is there from the start
  const g = {
    seed, mode: 'laser_tag_room', room, cats, race: lt, dot, log, joins, assist: A, version: T.version, tag: T,
    /** one 60 Hz step; input = { ray: { o, d } } | null. Only 'playing' steps change the sim and are logged. */
    step(input = null) {
      lt.phaseMs += STEP_MS;
      if (lt.phase === 'countdown') { const n = Math.ceil((CD - lt.phaseMs) / 500); if (n !== lt.cdShown && n > 0) { lt.cdShown = n; out.push({ type: 'countdown', n, caption: String(n) }); } if (lt.phaseMs >= CD) { lt.phase = 'playing'; lt.phaseMs = 0; out.push({ type: 'go' }); } return g; }
      if (lt.phase !== 'playing') return g;
      simStep(quantise(input)); for (const e of evs) out.push(e);
      return g;
    },
    state() {
      return { phase: lt.phase, timeS: lt.elapsedMs / 1000, points: Math.floor(lt.points), mult: lt.mult, rate: rate(), nearMisses: lt.nearMisses, ended: lt.ended, caught: lt.caught, cats: cats.length, maxCats: joins.length, nextJoinS: cats.length < joins.length ? (joins[cats.length] - lt.elapsedMs) / 1000 : null, fun: ltFunState(fun), bestStreak: lt.bestStreak, assist: { ...A },
        dot: { surf: dot.surf, x: dot.x, y: dot.y, z: dot.z, on: dot.on, alpha: Math.round(dot.alpha * 1000) / 1000, scoring: dot.scoring, moving: Math.abs(dot.x - dot.px) + Math.abs(dot.z - dot.pz) > 1e-6 },
        catList: cats.map((c) => ({ id: c.id, x: c.x, y: c.y, z: c.z, fx: c.fx, fz: c.fz, surf: c.surf, mode: c.mode, modeMs: c.modeMs, tell: c.mode === 'tell' ? c.modeMs : c.mode === 'slap' && c.modeMs < c.slapArmMs ? c.modeMs : -1, pose: c.mode === 'tell' || c.mode === 'slap' || (c.mode === 'approach' && c.ambush) ? 'crouch' : c.mode === 'pounce' || c.mode === 'hop' ? 'hop' : c.mode === 'pin' ? 'pin' : 'walk' })) };
    },
    drainEvents() { const o = out.slice(); out.length = 0; return o; },
    /** P0a: the host ends the round now (menu / box closed / Again): reason 'ended', the score is kept, the result event is queued once */
    end() { if (lt.ended) return g; if (lt.phase === 'countdown') { lt.phase = 'playing'; } evs.length = 0; lt.ended = 'ended'; evs.push({ type: 'ended' }); finish(); for (const e of evs) out.push(e); evs.length = 0; return g; },
    hash() { return simHash(); },
    _simStep: simStep,
  };
  return g;
}
/** test / host replay: same options, run the logged playing steps (stops when the round ends) */
export function replayLaserTagRoom(opts, log) { const g = createLaserTagRoom(opts); for (let i = 0; i < log.length && !g.race.ended; i++) g._simStep(log[i]); return g; }

/** P0a second beat (GE1 2026-10-10): ONE clean API for the VR host (GE2) around createLaserTagRoom.
    const beat = createLaserTagBeat({ room, roster, seed, best, cats = LT_BEAT.cats, coach = LT_BEAT.coach, rubberBand = LT_BEAT.rubberBand, openerRound1Ms = LT_BEAT.openerRound1Ms, assist, tag, countdownMs });
      (openerRound1Ms: round 1's no-pounce opener, 7 s; later rounds use VR_TAG.openerMs 4 s)
      beat.start()          -> a fresh round (seed + round - 1), countdown 3 / 2 / 1 / go (never auto-starts: the host calls it).
                               Difficulty (P0a Build 1 fix 4, the director's knobs, all exposed): round 1 plays with the ASSIST
                               { joinScale: 1, coach } (coach ON by default in VR:'s Manager decision); from round 2 the
                               joinScale follows laserTagRubberBand(prev, rounds) (+10 % after two quick catches, -10 % after a
                               90 s+ round) while `coach` stays as set; `cats` caps the roster (default 4; the roster order is kept);
                               an explicit `assist` object overrides both for every round (so a director that passes its own
                               assist and runs its own band gets NO coach / band from the beat: say so in the director, BA NIT 3).
                               beat.assist = the round's effective assist,
                               beat.rounds = [{ timeS, caught }] so far (the rubber band's input).
      beat.tick(input)      -> one 60 Hz step; input = { ray: { o, d } } | null; returns this step's events (join / tell / pounce /
                               near_miss / streak / comeback / caught / ended / time_cap / laser_tag_result / countdown / go)
      beat.score()          -> { points, rate, mult, timeS } (points = floor)
      beat.streak()         -> { n, mult, best, nearMisses, comebacks }
      beat.end()            -> ends the round now (reason 'ended', the score is kept) and returns the result record (or null)
      beat.state()          -> the room sim's state() (dot, catList with poses, phase, fun) or { phase: 'idle' } before start
      beat.result / beat.best / beat.round / beat.game
    The local best (`best`) is carried IN MEMORY across rounds (Legal 10.1 decides the store, LT_ROOM_BEST_FIELD). */
/** the beat's director defaults (VR entry): 4 cats, coach ON in round 1, the rubber band from round 2 */
export const LT_BEAT = Object.freeze({ cats: 4, coach: true, rubberBand: true, openerRound1Ms: 7000 }); // openerRound1Ms: GDXE Build 2 MUST 3, round 1 only (a frozen first-timer's still dot lived ~1 s after Go)
export function createLaserTagBeat(opts = {}) {
  let g = null, result = null, round = 0, best = Number.isFinite(+opts.best) ? Math.max(0, +opts.best) : 0, scale = 1, assistNow = null;
  const seed0 = Number.isFinite(+opts.seed) ? +opts.seed : 1, rounds = [];
  const cats = Number.isFinite(+opts.cats) ? Math.max(1, Math.floor(+opts.cats)) : LT_BEAT.cats, coach = opts.coach == null ? LT_BEAT.coach : !!opts.coach, band = opts.rubberBand == null ? LT_BEAT.rubberBand : !!opts.rubberBand;
  const roster = (Array.isArray(opts.roster) ? opts.roster : []).slice(0, cats);
  const record = (res) => { result = res; if (res.score > best) best = res.score; rounds.push({ timeS: res.timeS, caught: res.reason === 'caught' }); };
  const beat = {
    get game() { return g; }, get result() { return result; }, get best() { return best; }, get round() { return round; },
    get phase() { return g ? g.race.phase : 'idle'; }, get assist() { return assistNow; }, get rounds() { return rounds.slice(); },
    start(seed = null) {
      round++; result = null;
      if (band && rounds.length) scale = laserTagRubberBand(scale, rounds, LASER_TAG);
      const assist = opts.assist ? opts.assist : { joinScale: scale, coach };
      const op1 = opts.openerRound1Ms == null ? LT_BEAT.openerRound1Ms : +opts.openerRound1Ms, tag = round === 1 && op1 > (opts.tag && opts.tag.openerMs != null ? opts.tag.openerMs : VR_TAG.openerMs) ? Object.assign({}, opts.tag || null, { openerMs: op1 }) : (opts.tag || null);
      g = createLaserTagRoom({ room: opts.room, seed: seed == null ? seed0 + round - 1 : seed, roster, tag, assist, best, countdownMs: opts.countdownMs == null ? null : opts.countdownMs });
      assistNow = g.assist;
      return beat;
    },
    tick(input = null) {
      if (!g) return [];
      g.step(input); const evs = g.drainEvents();
      for (let i = 0; i < evs.length; i++) if (evs[i].type === 'laser_tag_result') record(evs[i]);
      return evs;
    },
    score() { return g ? { points: Math.floor(g.race.points), rate: g.tag.basePts * g.race.mult, mult: g.race.mult, timeS: g.race.elapsedMs / 1000 } : { points: 0, rate: 0, mult: 1, timeS: 0 }; },
    streak() { const f = g ? g.state().fun : null; return f ? { n: f.streak, mult: f.mult, best: g.race.bestStreak, nearMisses: g.race.nearMisses, comebacks: f.comebacks } : { n: 0, mult: 1, best: 0, nearMisses: 0, comebacks: 0 }; },
    end() { if (!g) return null; if (!g.race.ended) { g.end(); for (const e of g.drainEvents()) if (e.type === 'laser_tag_result') record(e); } return result; },
    state() { return g ? g.state() : { phase: 'idle' }; },
  };
  return beat;
}

/* game/core/roomcat.js — week 1: the floor-plane cat sim lifted into the player's REAL room (room.js), in metres.
   Gaming Engineer, 2026-10-09. Engine-agnostic + deterministic: no IWSDK / WebXR / DOM, no Math.random / Date, no trig.
   Fixed 60 Hz step (loop.js STEP_S); every random choice comes from the session's prng, so seed + room + event log
   replays bit-for-bit (replayRoomSession). The VR host draws each cat as a billboard at (x, y, z) facing (fx, fz) with
   `pose`, and turns hands into events (it owns gesture detection: gestures.js, week 2).
   What a cat does: wander its surface, hop up / down between surfaces on arcs within its size's limits (kitten: up 0.55 m,
   gap 0.6 m; adult: up 1.0 m, gap 1.2 m), perch, nap; reacts to hand events:
     { type: 'pet', p }                 open hand stroking near a cat's back: purr, bond +1 (once per 0.5 s per cat)
     { type: 'pinch', hand, p }         thumb-index pinch near a cat's scruff: carried (limp) / near the box top: opens it
     { type: 'move', hand, p }          hand position: the host sends it EVERY tracked frame for every tracked hand
                                        (carried cats follow it, on-palm cats glide after it); handLostS (3 s) without
                                        any event from a hand = tracking lost: its cat lets go
     { type: 'release', hand, v }       pinch released with hand velocity v: gentle toss, speed capped at tossCap; over the
                                        cap the cat POOFS (kawaii float, low gravity). Always lands on a legal surface:
                                        the flight is dry-run at release; an illegal landing becomes a twisting arc to
                                        room.js roomNearestLegal (no hovering, never on a couch back / plant / outside).
     { type: 'laser', on, p }           finger laser dot (host ray-casts; roomRaycast helps): interested cats chase + pounce
     { type: 'wand', on, p }            feather wand tip: nearby cats bat at it
     { type: 'treat', on, hand, p }     open palm treat: the nearest awake cat comes; palm low enough = hops ONTO the hand
   The 10-minute arc (plan 1.3; arc: true): box drops on the floor in front of the viewer, opens on a pinch (or after
   15 s), kittens climb out 5 at a time (waves every 2.5 s), play until 7:30, zoomies, then each cat walks to a nap spot
   (couch seat, then bed, then floor / rug) and naps; phase 'end' at 10:00.
   Grounded cats ALWAYS stand on a legal room surface (feet y = surface y exactly, footprint legal with ROOM_LIMITS.catR);
   airborne = 'hop' | 'fly'; 'carried' / 'onhand' = the hand is the support; 'inbox' = the box floor.
   Build rule: only `export function` / `export const`; private names carry the `rc` prefix. */
import { createPrng, createHasher } from './prng.js';
import { STEP_S } from './loop.js';
import { roomInside, roomSurface, roomLegalAt, roomLineLegal, roomHops, roomRoute, roomNearestLegal, roomNapSpots } from './room.js';

export const ROOMCAT_VERSION = 1;
export const ROOMCAT_SIZES = Object.freeze({
  kitten: Object.freeze({ h: 0.18, walk: 0.35, run: 0.9, up: 0.55, gap: 0.6, drop: 1.4, scruff: 0.15 }),
  adult: Object.freeze({ h: 0.3, walk: 0.5, run: 1.4, up: 1.0, gap: 1.2, drop: 1.4, scruff: 0.26 }),
});
export const ROOMCAT_TUNING = Object.freeze({
  g: 9.81, floatG: 1.6, tossCap: 1.6, hopClear: 0.1, maxFlyS: 4,
  pinchR: 0.1, petR: 0.2, petCdS: 0.5, pounceR: 0.14, batR: 0.28, treatR: 0.13, handHop: 0.5, eatS: 2,
  boxDropS: 0.35, boxDropH: 0.6, boxAutoOpenS: 15, waveSize: 5, waveS: 2.5, waveStaggerS: 0.2, boxH: 0.3, boxR: 0.14,
  playEndS: 450, zoomiesS: 20, endS: 600, interest: 0.75, maxCats: 24,
  // review fixes: fallback hops (twist / off the hand) are not snaps: at most floatV (poof float) or hopV m/s across,
  // never longer than maxSafeS; a hand that sends nothing for handLostS lets go of its cat; a cat leaves a palm after onhandMaxS
  floatV: 1.2, hopV: 3, maxSafeS: 3.5, handLostS: 3, onhandMaxS: 12,
  // re-review SHOULD 2: a cat on a palm glides after the moving palm (this fraction of the gap per 60 Hz step)
  palmFollow: 0.25,
});
const RC_T = (s) => Math.round(s / STEP_S);

function rcLen(x, z) { return Math.sqrt(x * x + z * z); }
/** do segments p-q and a-b (x, z) cross? */
function rcCross(px, pz, qx, qz, a, b) {
  const o = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = o(a.x, a.z, b.x, b.z, px, pz), d2 = o(a.x, a.z, b.x, b.z, qx, qz), d3 = o(px, pz, qx, qz, a.x, a.z), d4 = o(px, pz, qx, qz, b.x, b.z);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function rcFace(c, dx, dz) { const l = rcLen(dx, dz); if (l > 1e-6) { c.fx = dx / l; c.fz = dz / l; } }

/** Create a session. opts: { room (createRoom), seed, cats: number | [{ id, size, napSurf? }], size = 'kitten', arc = true }.
 *  napSurf (W4 kitten memory): the id of the surface this cat heads to first at nap time when it is free (its
 *  remembered favourite spot, matched by label in vr/src/return-visit.js spotsForRoom); other cats are unchanged. */
export function createRoomSession(opts = {}) {
  const room = opts.room, T = ROOMCAT_TUNING, prng = createPrng(opts.seed == null ? 1 : opts.seed);
  if (!room || !room.floor) throw new Error('roomcat: room with a floor (or rug) required');
  const arc = opts.arc !== false;
  let list = Array.isArray(opts.cats) ? opts.cats : Array.from({ length: opts.cats == null ? 3 : opts.cats }, (_, i) => ({ id: 'k' + (i + 1) }));
  list = list.slice(0, T.maxCats);
  const floor = roomSurface(room, room.floor);
  const boxSpot = room.box || { surf: floor.id, x: floor.samples[0].x, y: floor.y, z: floor.samples[0].z };
  const s = {
    tick: 0, phase: arc ? 'drop' : 'play', phaseT: 0, openTick: -1,
    box: { x: boxSpot.x, y: boxSpot.y + (arc ? T.boxDropH : 0), z: boxSpot.z, surf: boxSpot.surf, landed: !arc, open: !arc, gone: !arc },
    laser: null, wand: null, treat: null, hands: {}, log: [], queue: [], napTaken: [], napSpots: null,
    cats: [],
  };
  list.forEach((d, i) => {
    const size = ROOMCAT_SIZES[d.size || opts.size || 'kitten'] ? (d.size || opts.size || 'kitten') : 'kitten';
    const c = { id: String(d.id != null ? d.id : 'k' + (i + 1)), size, lim: ROOMCAT_SIZES[size], x: 0, y: 0, z: 0, surf: null, mode: 'inbox', pose: 'inbox',
      fx: 0, fz: 1, t: 0, plan: [], hop: null, fly: null, poof: false, bond: 0, purr: 0, petCd: 0, interest: prng.chance(T.interest),
      goal: 'wander', nap: null, eat: 0, hand: null, onT: 0, wave: Math.floor(i / T.waveSize), slot: i % T.waveSize, cool: 0, lastHop: 0,
      napSurf: typeof d.napSurf === 'string' && d.napSurf ? d.napSurf : null };
    if (arc) { c.x = s.box.x + (prng.next() - 0.5) * 0.12; c.z = s.box.z + (prng.next() - 0.5) * 0.12; c.y = s.box.y; c.surf = 'box'; }
    else { const p = prng.pick(floor.spots); c.x = p.x; c.z = p.z; c.y = floor.y; c.surf = floor.id; c.mode = 'idle'; c.pose = 'sit'; c.t = RC_T(prng.range(0.2, 1.5)); }
    s.cats.push(c);
  });

  const legalAt = (c, x, z) => roomLegalAt(room, c.surf, x, z);
  // fixed per room: horizontal surfaces (landing / bonk) and vertical ones (walls) for the toss sweep
  const flat = room.surfaces.filter((q) => q.kind !== 'vertical'), vert = room.surfaces.filter((q) => q.kind === 'vertical');
  // ballistic arc to (x, y, z); g / minDur optional (fallback hops: float gravity, a minimum duration from the distance)
  const startHop = (c, to, x, y, z, clear = T.hopClear, pose = 'hop', g = T.g, minDur = 0) => {
    const y0 = c.y, apex = Math.max(y0, y) + clear;
    let vy = Math.sqrt(2 * g * (apex - y0)), dur = vy / g + Math.sqrt(2 * (apex - y) / g);
    if (minDur > dur) { dur = minDur; vy = (y - y0 + 0.5 * g * dur * dur) / dur; }
    rcFace(c, x - c.x, z - c.z);
    c.hop = { x0: c.x, y0, z0: c.z, x1: x, y1: y, z1: z, vy, g, dur, n: Math.max(6, Math.ceil(dur / STEP_S)), k: 0, to };
    c.mode = 'hop'; c.pose = pose; c.surf = null; c.lastHop = s.tick;
  };
  // fallback hop to a safe landing L: within the cat's size limits it is a normal hop at <= hopV m/s; a longer drop than
  // lim.drop or a wider gap than lim.gap becomes a slow poof float (low gravity, <= floatV m/s across): never a snap
  const safeHop = (c, L, pose) => {
    const hd = rcLen(L.x - c.x, L.z - c.z), float = pose === 'poof' || c.y - L.y > c.lim.drop || hd > c.lim.gap;
    const dur = Math.min(T.maxSafeS, hd / (float ? T.floatV : T.hopV));
    c.poof = float;
    startHop(c, L.surf, L.x, L.y, L.z, 0.05, float ? 'poof' : pose, float ? T.floatG : T.g, dur);
  };
  // the hand lets go (treat closed / eaten + bored / tracking lost / landing on a hand with no treat): nearest legal spot
  const dropFromHand = (c) => {
    c.hand = null; c.eat = 0; c.plan = [];
    safeHop(c, roomNearestLegal(room, { x: c.x, y: c.y, z: c.z }), 'hop');
  };
  const land = (c, surf, x, y, z) => { c.x = x; c.y = y; c.z = z; c.surf = surf; c.hop = null; c.fly = null; c.poof = false; c.mode = 'idle'; };
  // plan a route; validated first with no allocation (failed plans, e.g. a chase that cannot reach the dot, are the
  // common case during laser play), the plan legs are only built once the whole route is legal
  const picks = [], goalXZ = { x: 0, z: 0 };
  const planTo = (c, surf, x, z) => {
    const route = roomRoute(room, c.surf, surf, c.lim); if (!route) return false;
    let cur = c, cs = c.surf; picks.length = 0;
    for (const e of route) {
      let pair = null;
      for (const p of e.pairs) if (roomLineLegal(room, cs, cur, p.a)) { pair = p; break; }
      if (!pair) return false;
      picks.push(pair); cur = pair.b; cs = e.to;
    }
    goalXZ.x = x; goalXZ.z = z;
    if (!roomLineLegal(room, cs, cur, goalXZ)) return false;
    const plan = [];
    for (let i = 0; i < route.length; i++) { const pair = picks[i]; plan.push({ k: 'walk', x: pair.a.x, z: pair.a.z }, { k: 'hop', to: route[i].to, x: pair.b.x, z: pair.b.z }); }
    plan.push({ k: 'walk', x, z }); c.plan = plan; return true;
  };
  // walk toward (x, z) on the current surface; true = arrived, false = moving, null = blocked
  const walk = (c, x, z, speed) => {
    const dx = x - c.x, dz = z - c.z, d = rcLen(dx, dz), st = speed * STEP_S;
    rcFace(c, dx, dz);
    if (d <= st) { if (!legalAt(c, x, z)) return null; c.x = x; c.z = z; return true; }
    const nx = c.x + dx / d * st, nz = c.z + dz / d * st;
    if (!legalAt(c, nx, nz)) return null;
    c.x = nx; c.z = nz; return false;
  };
  const scruff = (c) => ({ x: c.x, y: c.y + c.lim.scruff, z: c.z });
  const d3 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); };
  const busy = (c) => c.mode === 'carried' || c.mode === 'onhand' || c.mode === 'inbox' || c.mode === 'hop' || c.mode === 'fly' || c.mode === 'climb';
  // one fixed step of a toss flight F = { x, y, z, vx, vy, vz, g, h } (shared by the dry-run and the real flight, so both
  // are identical). Swept: crossing a wall stops the horizontal motion (the cat slides down it); the cat's HEAD (feet + h,
  // re-review SHOULD 4) rising into a horizontal surface from below (table top, ceiling) bonks: vertical speed 0, head
  // just under it (never pushed down). Returns the landing surface or null.
  const flyStep = (F) => {
    const px = F.x, py = F.y, pz = F.z;
    F.vy -= F.g * STEP_S; F.x += F.vx * STEP_S; F.y += F.vy * STEP_S; F.z += F.vz * STEP_S;
    for (const w of vert) {
      if (F.y < w.lo - 0.02 || F.y > w.y) continue;
      if ((w.seg && rcCross(px, pz, F.x, F.z, w.seg.a, w.seg.b)) || roomInside(room, w.id, F.x, F.z)) { F.x = px; F.z = pz; F.vx = 0; F.vz = 0; break; }
    }
    if (F.vy > 0) {
      const h = F.h || 0;
      for (const q of flat) if (py < q.y - 1e-6 && F.y + h >= q.y && roomInside(room, q.id, F.x, F.z)) { F.y = Math.max(py, Math.min(F.y, q.y - h - 0.01)); F.vy = 0; return null; }
      return null;
    }
    let hit = null;
    for (const q of flat) if (q.kind !== 'ceiling' && py >= q.y && F.y <= q.y && (!hit || q.y > hit.y) && roomInside(room, q.id, F.x, F.z)) hit = q;
    return hit;
  };
  // toss: dry-run the swept flight; illegal landing -> fallback hop (twist / poof float) to the nearest legal spot
  const toss = (c, v) => {
    let vx = v ? +v.x || 0 : 0, vy = v ? +v.y || 0 : 0, vz = v ? +v.z || 0 : 0;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    c.poof = sp > T.tossCap;
    if (c.poof) { const k = T.tossCap / sp; vx *= k; vy *= k; vz *= k; }
    const g = c.poof ? T.floatG : T.g, D = { x: c.x, y: c.y, z: c.z, vx, vy, vz, g, h: c.lim.h };
    let hit = null, n = 0;
    for (; n < RC_T(T.maxFlyS) && !hit; n++) hit = flyStep(D);
    if (hit && roomLegalAt(room, hit.id, D.x, D.z)) {
      c.fly = { x: c.x, y: c.y, z: c.z, vx, vy, vz, g, h: c.lim.h, n, k: 0, surf: hit.id, x1: D.x, y1: hit.y, z1: D.z };
      c.mode = 'fly'; c.pose = c.poof ? 'poof' : 'fall'; c.surf = null; rcFace(c, vx, vz);
    } else {
      const L = roomNearestLegal(room, { x: D.x, y: Math.max(c.y, D.y), z: D.z });
      // the fallback starts at the release point (feet); it never passes through a wall: the target is inside the room
      safeHop(c, L, c.poof ? 'poof' : 'twist');
    }
  };
  const dotFor = (p) => {
    if (!p) return null;
    return roomNearestLegal(room, { x: p.x, y: p.y + 0.02, z: p.z });
  };
  const apply = (ev) => {
    const h = ev.hand || 'r';
    if (ev.type === 'move' || ev.type === 'pinch' || ev.type === 'treat') if (ev.p) s.hands[h] = { x: ev.p.x, y: ev.p.y, z: ev.p.z, tick: s.tick };
    if (ev.type === 'pinch' && ev.p) {
      if (s.box.landed && !s.box.open && d3(ev.p, { x: s.box.x, y: s.box.y + T.boxH, z: s.box.z }) <= 0.3) { rcOpen(); return; }
      let best = null, bd = T.pinchR;
      for (const c of s.cats) { if (c.mode === 'carried' || c.mode === 'inbox' || c.mode === 'onhand') continue; const d = d3(ev.p, scruff(c)); if (d <= bd) { bd = d; best = c; } }
      if (best) { const c = best; c.mode = 'carried'; c.pose = 'carried'; c.surf = null; c.hop = null; c.fly = null; c.plan = []; c.hand = h; c.onT = s.tick; c.x = ev.p.x; c.y = ev.p.y - c.lim.scruff; c.z = ev.p.z; }
    } else if (ev.type === 'move' && ev.p) {
      // carried cats hang from the pinch (exact); on-palm cats glide after the palm in stepCat (no teleport)
      for (const c of s.cats) if (c.mode === 'carried' && c.hand === h) { c.x = ev.p.x; c.z = ev.p.z; c.y = ev.p.y - c.lim.scruff; }
      if (s.treat && s.treat.hand === h) { s.treat.p = { x: ev.p.x, y: ev.p.y, z: ev.p.z }; s.treat.at = dotFor(ev.p); }
    } else if (ev.type === 'release') {
      for (const c of s.cats) if (c.mode === 'carried' && c.hand === h) { c.hand = null; toss(c, ev.v); }
    } else if (ev.type === 'pet' && ev.p) {
      for (const c of s.cats) {
        if (c.mode === 'carried' || c.mode === 'inbox' || c.mode === 'hop' || c.mode === 'fly') continue;
        const b = { x: c.x, y: c.y + c.lim.h * 0.8, z: c.z };
        if (d3(ev.p, b) <= T.petR) {
          c.purr = RC_T(1.2);
          if (c.petCd <= 0) { c.bond++; c.petCd = RC_T(T.petCdS); }
          if (c.mode !== 'nap' && c.mode !== 'onhand') { c.mode = 'idle'; c.pose = 'petted'; c.plan = []; c.t = RC_T(1.2); }
        }
      }
    } else if (ev.type === 'laser') {
      s.laser = ev.on === false || !ev.p ? null : dotFor(ev.p);
    } else if (ev.type === 'wand') {
      s.wand = ev.on === false || !ev.p ? null : { p: { x: ev.p.x, y: ev.p.y, z: ev.p.z }, at: dotFor(ev.p) };
    } else if (ev.type === 'treat') {
      if (ev.on === false) {
        // the palm closes: a cat on it OR still hopping onto it (review MUST 2) drops to the nearest legal spot
        for (const c of s.cats) if (c.hand === h && (c.mode === 'onhand' || (c.mode === 'hop' && c.hop.to === 'hand'))) dropFromHand(c);
        if (s.treat && s.treat.hand === h) s.treat = null;
      } else if (ev.p) {
        let best = null, bd = Infinity; const at = dotFor(ev.p);
        for (const c of s.cats) { if (busy(c) || c.mode === 'nap') continue; const d = d3(c, at); if (d < bd) { bd = d; best = c; } }
        s.treat = { hand: h, p: { x: ev.p.x, y: ev.p.y, z: ev.p.z }, at, cat: best ? best.id : null };
        if (best) best.plan = [];
      }
    }
  };
  function rcOpen() { s.box.open = true; s.openTick = s.tick; s.phase = 'climb'; }

  const think = (c) => {
    // nap time
    if (s.phase === 'nap' || s.phase === 'end') {
      if (!c.nap) {
        const all = s.napSpots || (s.napSpots = roomNapSpots(room));
        const spots = c.napSurf && all.some((sp) => sp.surf === c.napSurf) ? all.filter((sp) => sp.surf === c.napSurf).concat(all.filter((sp) => sp.surf !== c.napSurf)) : all; // the remembered favourite first
        for (const sp of spots) {
          if (s.napTaken.some((q) => q.surf === sp.surf && rcLen(q.x - sp.x, q.z - sp.z) < 0.25)) continue;
          if (sp.surf !== c.surf && !roomRoute(room, c.surf, sp.surf, c.lim)) continue;
          c.nap = sp; s.napTaken.push(sp); break;
        }
        if (!c.nap) { c.nap = { surf: c.surf, x: c.x, y: c.y, z: c.z }; s.napTaken.push(c.nap); }
        c.plan = [];
      }
      if (c.surf === c.nap.surf && rcLen(c.x - c.nap.x, c.z - c.nap.z) < 1e-6) { c.mode = 'nap'; c.pose = 'nap'; return; }
      if (!planTo(c, c.nap.surf, c.nap.x, c.nap.z)) { s.napTaken = s.napTaken.filter((q) => q !== c.nap); c.nap = { surf: c.surf, x: c.x, y: c.y, z: c.z }; s.napTaken.push(c.nap); }
      return;
    }
    const zoom = s.phase === 'wind';
    // treat
    if (s.treat && s.treat.cat === c.id && s.treat.at) {
      const at = s.treat.at;
      if (c.surf === at.surf && rcLen(c.x - at.x, c.z - at.z) <= T.treatR) {
        if (s.treat.p.y - c.y <= T.handHop && s.treat.p.y >= c.y) { c.hand = s.treat.hand; const p = s.treat.p; startHop(c, 'hand', p.x, p.y, p.z, 0.06); c.eat = RC_T(T.eatS); return; }
        c.mode = 'idle'; c.pose = 'beg'; c.t = RC_T(0.3); rcFace(c, s.treat.p.x - c.x, s.treat.p.z - c.z); return;
      }
      if (c.surf === at.surf) { c.plan = [{ k: 'walk', x: at.x, z: at.z }]; return; }
      if (planTo(c, at.surf, at.x, at.z)) return;
    }
    // laser chase
    if (s.laser && c.interest && s.phase === 'play') {
      const L = s.laser;
      if (c.surf === L.surf) {
        const d = rcLen(L.x - c.x, L.z - c.z);
        if (d <= T.pounceR && c.cool <= 0) { startHop(c, L.surf, L.x, L.y, L.z, 0.12, 'pounce'); c.cool = RC_T(0.5); return; }
        c.goal = 'chase'; c.mode = 'run'; c.pose = 'run';
        if (walk(c, L.x, L.z, c.lim.run) === null) { c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.25); }
        return;
      }
      if (planTo(c, L.surf, L.x, L.z)) { c.goal = 'chase'; c.t = RC_T(0.6); return; }
      c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.4); rcFace(c, L.x - c.x, L.z - c.z); return;
    }
    // wand
    if (s.wand && s.wand.at && c.interest && s.phase === 'play') {
      const W = s.wand.at;
      if (c.surf === W.surf && rcLen(W.x - c.x, W.z - c.z) <= T.batR) {
        if (c.cool <= 0) { const clear = Math.max(0.05, Math.min(0.3, s.wand.p.y - c.y - c.lim.h)); startHop(c, c.surf, c.x, c.y, c.z, clear, 'bat'); c.cool = RC_T(0.7); return; }
        c.mode = 'idle'; c.pose = 'crouch'; c.t = RC_T(0.1); rcFace(c, W.x - c.x, W.z - c.z); return;
      }
      if (c.surf === W.surf) { if (walk(c, W.x, W.z, c.lim.walk) === null) { c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.3); } else { c.mode = 'walk'; c.pose = 'walk'; } return; }
      if (planTo(c, W.surf, W.x, W.z)) return;
    }
    // wander
    const surf = roomSurface(room, c.surf), r = prng.next();
    if (r < (zoom ? 0.75 : 0.45)) {
      for (let i = 0; i < 4; i++) { const p = prng.pick(surf.samples); if (roomLineLegal(room, c.surf, c, p)) { c.plan = [{ k: 'walk', x: p.x, z: p.z }]; c.goal = zoom ? 'zoom' : 'wander'; return; } }
    } else if (r < (zoom ? 0.95 : 0.8)) {
      const hops = roomHops(room, c.surf, c.lim);
      if (hops.length) {
        const e = prng.pick(hops), pair = e.pairs.find((p) => roomLineLegal(room, c.surf, c, p.a));
        if (pair) { c.plan = [{ k: 'walk', x: pair.a.x, z: pair.a.z }, { k: 'hop', to: e.to, x: pair.b.x, z: pair.b.z }]; c.goal = 'wander'; return; }
      }
    }
    c.mode = 'idle'; c.pose = prng.chance(0.5) ? 'sit' : 'loaf'; c.t = RC_T(prng.range(1.2, 4));
  };

  // nothing stays on a hand without an active pinch / treat: tracking silent for handLostS -> let go
  const handLost = (c) => { const hs = s.hands[c.hand]; return s.tick - Math.max(hs ? hs.tick : -1e9, c.onT) > RC_T(T.handLostS); };
  const stepCat = (c) => {
    if (c.cool > 0) c.cool--; if (c.petCd > 0) c.petCd--; if (c.purr > 0) c.purr--;
    if (c.mode === 'inbox') {
      c.y = s.box.y;
      if (s.phase !== 'drop' && s.box.open && s.openTick >= 0) {
        const go = s.openTick + RC_T(0.5 + c.wave * T.waveS + c.slot * T.waveStaggerS);
        if (s.tick >= go) {
          let L = null;
          for (let i = 0; i < 12 && !L; i++) {
            let ux = prng.next() * 2 - 1, uz = prng.next() * 2 - 1; const l = rcLen(ux, uz); if (l < 0.2 || l > 1) continue; ux /= l; uz /= l;
            const dd = prng.range(0.3, 0.55), x = s.box.x + ux * dd, z = s.box.z + uz * dd;
            if (roomLegalAt(room, s.box.surf, x, z)) L = { x, z };
          }
          if (!L) { const p = roomNearestLegal(room, { x: s.box.x + 0.4, y: s.box.y, z: s.box.z }); L = { x: p.x, z: p.z }; }
          startHop(c, s.box.surf, L.x, s.box.y, L.z, T.boxH, 'climb');
        }
      }
      return;
    }
    if (c.mode === 'carried') { if (handLost(c)) { c.hand = null; toss(c, null); } return; }
    if (c.mode === 'onhand') {
      const mine = s.treat && s.treat.hand === c.hand;
      if (!mine || handLost(c) || s.tick - c.onT > RC_T(T.onhandMaxS)) {
        if (mine && (s.treat.eaten || handLost(c))) s.treat = null;
        dropFromHand(c); return;
      }
      const p = s.treat.p, k = T.palmFollow; // glide after the palm (it moved since the hop launched, or moves now)
      c.x += (p.x - c.x) * k; c.y += (p.y - c.y) * k; c.z += (p.z - c.z) * k;
      if (Math.abs(p.x - c.x) + Math.abs(p.y - c.y) + Math.abs(p.z - c.z) < 1e-4) { c.x = p.x; c.y = p.y; c.z = p.z; }
      c.pose = c.eat > 0 ? 'eat' : 'sit';
      if (c.eat > 0 && --c.eat === 0) { c.bond++; s.treat.eaten = true; }
      return;
    }
    if (c.mode === 'hop') {
      const H = c.hop; H.k++;
      if (H.k >= H.n) {
        if (H.to === 'hand') {
          // the treat may be gone (closed during the hop, or replaced by the other hand): never land on an empty hand
          if (!s.treat || s.treat.hand !== c.hand) { c.x = H.x1; c.y = H.y1; c.z = H.z1; dropFromHand(c); return; }
          // re-review SHOULD 2: land where the palm was at launch (the hop's own target, no last-frame snap to the
          // current palm); from there the cat glides after the palm (onhand step)
          c.x = H.x1; c.y = H.y1; c.z = H.z1; c.hop = null; c.surf = null; c.mode = 'onhand'; c.pose = 'eat'; c.onT = s.tick; return;
        }
        land(c, H.to, H.x1, H.y1, H.z1); c.pose = 'land'; c.t = RC_T(0.15); return;
      }
      const t = H.dur * H.k / H.n, f = H.k / H.n;
      c.x = H.x0 + (H.x1 - H.x0) * f; c.z = H.z0 + (H.z1 - H.z0) * f; c.y = H.y0 + H.vy * t - 0.5 * H.g * t * t;
      return;
    }
    if (c.mode === 'fly') {
      const F = c.fly; F.k++;
      if (F.k >= F.n) { land(c, F.surf, F.x1, F.y1, F.z1); c.pose = 'land'; c.t = RC_T(0.4); return; }
      flyStep(F); c.x = F.x; c.y = F.y; c.z = F.z;
      return;
    }
    if (c.mode === 'nap') { c.pose = 'nap'; return; }
    // grounded: plan first
    if (c.plan.length) {
      const leg = c.plan[0];
      if (leg.k === 'walk') {
        const fast = c.goal === 'chase' || c.goal === 'zoom';
        const r = walk(c, leg.x, leg.z, fast ? c.lim.run : c.lim.walk);
        c.mode = fast ? 'run' : 'walk'; c.pose = c.mode;
        if (r === true) c.plan.shift(); else if (r === null) { c.plan = []; c.mode = 'idle'; c.pose = 'sit'; c.t = RC_T(0.3); }
        // laser moved: re-think a chase every 0.5 s
        if (c.goal === 'chase' && (s.tick - c.lastHop) % 30 === 0 && s.laser && c.surf === s.laser.surf) c.plan = [];
      } else { c.plan.shift(); const to = roomSurface(room, leg.to); startHop(c, leg.to, leg.x, to.y, leg.z); }
      return;
    }
    if (c.t > 0) { c.t--; c.mode = 'idle'; return; }
    think(c);
  };

  const phaseStep = () => {
    const t = s.tick;
    if (s.phase === 'drop') {
      const k = Math.min(1, t / RC_T(T.boxDropS)); s.box.y = boxSpot.y + T.boxDropH * (1 - k * k);
      if (k >= 1) { s.box.y = boxSpot.y; s.box.landed = true; s.phase = 'closed'; }
    } else if (s.phase === 'closed') {
      if (t >= RC_T(T.boxAutoOpenS)) rcOpen();
    } else if (s.phase === 'climb') {
      if (s.cats.every((c) => c.mode !== 'inbox')) { s.phase = 'play'; s.box.gone = false; }
    }
    if ((s.phase === 'play' || s.phase === 'climb') && t >= RC_T(T.playEndS)) s.phase = 'wind';
    if (s.phase === 'wind' && t >= RC_T(T.playEndS + T.zoomiesS)) { s.phase = 'nap'; s.laser = null; s.wand = null; for (const c of s.cats) if (c.mode !== 'carried' && c.mode !== 'onhand') { c.plan = []; c.t = 0; } }
    if (s.phase === 'nap' && t >= RC_T(T.endS)) s.phase = 'end';
  };

  const api = {
    room,
    get tick() { return s.tick; },
    get phase() { return s.phase; },
    get log() { return s.log; },
    /** queue an event for the next step (recorded in the log with that step's tick) */
    push(ev) { if (ev && typeof ev.type === 'string') s.queue.push(ev); },
    /** one fixed 60 Hz step; `events` (optional array) are applied first, like push() */
    step(events) {
      if (Array.isArray(events)) for (const e of events) api.push(e);
      if (s.queue.length) { for (const e of s.queue) { s.log.push({ tick: s.tick, ev: e }); apply(e); } s.queue = []; }
      phaseStep();
      for (const c of s.cats) stepCat(c);
      s.tick++;
    },
    /** open the box now (host button / tests) */
    openBox() { if (s.box.landed && !s.box.open) rcOpen(); },
    cat(id) { return s.cats.find((c) => c.id === id) || null; },
    /** render / test view: plain data */
    state() {
      return {
        tick: s.tick, phase: s.phase, box: { ...s.box }, laser: s.laser && { ...s.laser }, wand: s.wand && { ...s.wand.at, tip: s.wand.p }, treat: s.treat && { ...s.treat.p, cat: s.treat.cat },
        cats: s.cats.map((c) => ({ id: c.id, size: c.size, x: c.x, y: c.y, z: c.z, fx: c.fx, fz: c.fz, surf: c.surf, mode: c.mode, pose: c.pose, poof: c.poof, purr: c.purr > 0, bond: c.bond, airborne: c.mode === 'hop' || c.mode === 'fly', support: c.mode === 'carried' || c.mode === 'onhand' ? 'hand' : c.surf })),
      };
    },
    hash() {
      const h = createHasher(); h.num(s.tick).str(s.phase).num(prng.getState() / 65536);
      h.num(s.box.y).num(s.box.open ? 1 : 0);
      for (const c of s.cats) h.str(c.id).str(c.mode).str(c.pose).str(c.surf || '-').num(c.x).num(c.y).num(c.z).num(c.fx).num(c.fz).num(c.bond).num(c.poof ? 1 : 0);
      return h.digest();
    },
  };
  return api;
}

/** Replay: same opts + the recorded log (from session.log) for `ticks` steps -> the final hash. */
export function replayRoomSession(opts, log, ticks) {
  const g = createRoomSession(opts); let i = 0;
  for (let t = 0; t < ticks; t++) { while (i < log.length && log[i].tick === t) g.push(log[i++].ev); g.step(); }
  return g.hash();
}

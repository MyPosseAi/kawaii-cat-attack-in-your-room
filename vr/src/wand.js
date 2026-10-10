/* vr/src/wand.js - W3: the feather wand and its toy basket (plan 1.2 "Feather wand": pinch the wand from a toy
   basket next to you, then wiggle it; cats bat and jump at it; wiggle speed sets excitement).
   Gaming Engineer 2, 2026-10-09. PURE and engine-neutral (no three / WebXR / DOM): plain state in, state + roomcat events
   out, node-tested in vr/test/wand.test.mjs. The host (room-bridge.js) feeds it the gestures.js events of every hand and
   forwards the returned `{ type: 'wand', on, p }` events to roomcat (game/core/roomcat.js already reacts to them).
   Rules:
   - placeBasket(room, viewer, forward, floorY): the basket sits on the legal spot (floor, table or couch seat) closest to
     a point about 0.5 m to the viewer's RIGHT, a little ahead and at reach height (seated, plan 1.2), never on the box
     spot. Left-handed players: pass mirror = true. No legal spot within reachHardM of a seated shoulder (no scan, or
     only a small floor patch away from the player) -> the basket sits on a virtual stand at the wanted spot
     (`virtual: true`, floor height) so the wand is always within reach. The stand never sits behind / inside a wall
     or inside a mesh footprint (Code Review L B2b MUST 1 / SHOULDs 1-2), never clips the seat the player sits in and
     never stands at / against the body (Code Review N SHOULDs 1-2): it is the clear point nearest the wanted spot on a
     polar grid around the player (bodyClearM..standMaxM out, hip to straight ahead, at least standMinSideM off the body
     midline, basketR + standMarginM clear of every wall / obstacle / own-seat edge, within reachHardM). Nothing clear on
     the wand side -> the best real spot within reach wins (even across the midline), else the stand goes to the OTHER
     side (`mirrored: true`), else (a tight nook) a relaxed stand (`tight: true`: margin = basketR, then the midline
     straight ahead), still never behind a wall. The REAL path skips a legal spot the player could only reach THROUGH a
     wall, a wall mesh or a block taller than the seated shoulder (Code Review N SHOULD 3).
   - the wand rests in the basket STANDING UP (a tall wand, Code Review B 07:2x MUST 1): the handle sits at the basket rim
     or at least restHandleM above the floor, whichever is higher, so in a no-scan / floor-only room (basket on the rug)
     a SEATED player still reaches it without bending to the floor; the stick is drawn from the basket bottom (view.base) up
     to the tip, so nothing floats. A pinch_start within pickR of the handle PICKS IT UP (the pinch is consumed:
     it is not a scruff pinch / box pinch for roomcat). While held: handle = the pinch point every move; the FEATHER TIP
     hangs tipLen ahead of the handle along the viewer's flat forward and tipDrop below it, lagging the handle with a
     spring (tipFollow per frame) so a wiggle makes the feather swing. The excitement (0..1) is the mean tip speed over
     exciteWindowS divided by exciteV.
   - pinch_release / lost DROPS it: the wand lands on the nearest legal spot under the handle (never floats, never ends up
     outside the room; a room with NO legal spot keeps the handle where it was); after returnS on the floor away from the
     basket it hops back into the basket so it is never lost.
   - every held frame emits { type: 'wand', on: true, p: tip }; the drop emits { type: 'wand', on: false }.
   Build rule: only `export function` / `export const`; private names carry the `wd` prefix. */
import { roomNearestLegal, roomSurface } from '../../game/core/room.js';

export const WAND_VERSION = 7; // 7: `speed` (m/s) on every held wand event (big leap)
export const WAND_TUNING = Object.freeze({
  basketRightM: 0.5, basketAheadM: 0.25, basketReachY: 0.45, // where the basket wants to be (then snapped to a legal surface)
  basketR: 0.12, basketH: 0.12,                              // basket size (host draws it; the wand handle rests at its rim)
  restHandleM: 0.55,                                         // resting handle at least this high over the floor (seated reach)
  seatedShoulderM: 0.9, shoulderSideM: 0.18, reachSoftM: 0.6, // seated shoulder (over the floor / to the basket side); handle further than reachSoftM from it is penalised
  reachHardM: 0.7,                                           // handle further than this from the shoulder on EVERY legal spot -> virtual stand at the wanted spot
  standMarginM: 0.03, standMinSideM: 0.1,                    // virtual stand: clear of walls / meshes by basketR + margin; min offset from the body midline before the side counts as blocked
  bodyClearM: 0.3, standMaxM: 0.8, standStepM: 0.05,         // virtual stand: never closer than bodyClearM (horizontal) to the player's body; searched up to standMaxM from the body in standStepM steps
  pickR: 0.12,                                               // a pinch this close to the handle picks the wand up
  tipLen: 0.35, tipDrop: 0.12, tipFollow: 0.35,              // feather tip: ahead along the flat forward, below, spring lag
  exciteV: 1.2, exciteWindowS: 0.5, maxDt: 0.1,              // tip speed that counts as full excitement; averaging window
  returnS: 20, returnFarM: 0.6,                              // dropped this far from the basket -> back in it after returnS
});

function wdLen(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
function wdD(a, b) { return wdLen(a.x - b.x, a.y - b.y, a.z - b.z); }
function wdOk(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }

/**
 * Basket spot: { x, y, z, surf } on a legal room surface next to the viewer. viewer = { x, z } (head), forward = { x, z }
 * (flat), floorY. mirror = true puts it on the LEFT (left-handed). The spot is pushed off the box spot if they collide.
 */
export function placeBasket(room, viewer, forward, floorY, mirror, tuning) {
  const T = tuning || WAND_TUNING;
  let fx = forward && Number.isFinite(forward.x) ? forward.x : 0, fz = forward && Number.isFinite(forward.z) ? forward.z : -1;
  const l = Math.sqrt(fx * fx + fz * fz); if (l < 1e-9) { fx = 0; fz = -1; } else { fx /= l; fz /= l; }
  const side = mirror ? -1 : 1;
  const rx = -fz * side, rz = fx * side; // viewer's right (y up, right = forward x up)
  const vx = viewer && Number.isFinite(viewer.x) ? viewer.x : 0, vz = viewer && Number.isFinite(viewer.z) ? viewer.z : 0;
  const fy = Number.isFinite(floorY) ? floorY : (room && Number.isFinite(room.floorY) ? room.floorY : 0);
  const want = { x: vx + rx * T.basketRightM + fx * T.basketAheadM, y: fy + T.basketReachY, z: vz + rz * T.basketRightM + fz * T.basketAheadM };
  // the legal spot (any legal surface: floor, table, couch seat) closest to the wanted point: horizontal distance plus half
  // the height difference from a comfortable reach height, so a side table beside the chair beats the floor under it;
  // PLUS a steep penalty once the RESTING HANDLE on that spot is more than reachSoftM from a seated shoulder (Code Review
  // B2 SHOULD 2: a high counter where the basket wanted to go used to push it 0.68 m out beside the counter, 0.77 m from
  // the shoulder; now the nearest reachable floor sample wins instead)
  const box = room && room.box;
  const sh = { x: vx + rx * T.shoulderSideM, y: fy + T.seatedShoulderM, z: vz + rz * T.shoulderSideM };
  const score = (s, q) => {
    const dx = q.x - want.x, dz = q.z - want.z, dy = s.y - want.y;
    const hy = Math.max(s.y + T.basketH, fy + T.restHandleM); // = restHandleY of a basket on this surface
    const reach = Math.sqrt((q.x - sh.x) * (q.x - sh.x) + (hy - sh.y) * (hy - sh.y) + (q.z - sh.z) * (q.z - sh.z));
    let sc = Math.sqrt(dx * dx + dz * dz) + 0.5 * Math.abs(dy) + (reach > T.reachSoftM ? 4 * (reach - T.reachSoftM) : 0);
    if (box && Math.sqrt((q.x - box.x) * (q.x - box.x) + (q.z - box.z) * (q.z - box.z)) < T.basketR + 0.2) sc += 10; // never on the box spot
    return sc;
  };
  // walls and obstacles, computed once (Code Review N B2b SHOULD 3): a real spot the player cannot reach without going
  // THROUGH a wall (a stub wall, a nook corner, a wall mesh, a cabinet taller than the seated shoulder) is skipped
  const blocks = wdBlocks(room, vx, vz, fy, T);
  let spot = null, best = Infinity;
  for (const s of (room && room.surfaces) || []) {
    if (!s.legal) continue;
    for (const q of s.samples) {
      const sc = score(s, q);
      if (sc >= best || wdThroughWall(blocks, vx, vz, q.x, q.z, s.id)) continue;
      best = sc; spot = { x: q.x, y: s.y, z: q.z, surf: s.id };
    }
  }
  if (!spot) { const q = roomNearestLegal(room, want, T.basketR); if (q && !wdThroughWall(blocks, vx, vz, q.x, q.z, q.surf)) spot = { x: q.x, y: q.y, z: q.z, surf: q.surf }; }
  // HARD reach rule (Code Review J B2 SHOULD 2): when the only legal surface is a small floor patch away from the player
  // (a partial scan: 0.8 x 0.8 m of floor up to 1.5 m off), the soft penalty still picked it. If the resting handle on the
  // best spot is further than reachHardM from the seated shoulder, the basket instead sits on a VIRTUAL STAND at the
  // wanted spot (floor height, `virtual: true`; the host draws a small stand / rug under it), the same thing a no-scan
  // room gets: the wand is always within reach.
  const reachOf = (q, sy) => { const hy = Math.max(sy + T.basketH, fy + T.restHandleM); return Math.sqrt((q.x - sh.x) * (q.x - sh.x) + (hy - sh.y) * (hy - sh.y) + (q.z - sh.z) * (q.z - sh.z)); };
  // (also when the best spot is across the body midline on the WRONG side: a left-handed player's basket stays on the left)
  const sideOf = (q) => (q.x - vx) * rx + (q.z - vz) * rz;
  const realOk = !!spot && reachOf(spot, spot.y) <= T.reachHardM;
  if (realOk && sideOf(spot) >= 0) return { x: spot.x, y: spot.y, z: spot.z, surf: spot.surf, floorY: fy, virtual: false, mirrored: false };
  // Virtual stand, kept inside the room (Code Review L B2b MUST 1: a player seated < 0.3 m from a side wall got the stand
  // BEHIND the wall; SHOULD 1-2: never clipping a wall / inside a mesh; Code Review N SHOULDs 1-2: never clipping the seat
  // the player sits in, never at / against the body). wdStand picks the CLEAR point nearest the wanted spot out of a
  // polar grid around the player on the wand side (bodyClearM..standMaxM out, from a little behind the hip to straight
  // ahead). Blocked wand side (no clear point standMinSideM off the midline) -> the best real spot within reach (even
  // across the midline, the pre-v4 behaviour), else the mirrored side, else the wanted spot as it is (never the feet).
  const ax = { x: rx, z: rz }, fw = { x: fx, z: fz }, shM = { x: vx - rx * T.shoulderSideM, y: sh.y, z: vz - rz * T.shoulderSideM };
  const mw = { x: vx - rx * T.basketRightM + fx * T.basketAheadM, z: vz - rz * T.basketRightM + fz * T.basketAheadM };
  const stand = (q, mirrored, tight) => ({ x: q.x, y: fy, z: q.z, surf: room && room.floor, floorY: fy, virtual: true, mirrored, tight: !!tight }); // tight: a relaxed stand (basket touching a wall / on the midline straight ahead)
  const m0 = T.basketR + T.standMarginM;
  const ws = wdStand(blocks, vx, vz, want.x, want.z, ax, fw, sh, fy, T, m0, T.standMinSideM);
  if (ws) return stand(ws, false);
  if (realOk) return { x: spot.x, y: spot.y, z: spot.z, surf: spot.surf, floorY: fy, virtual: false, mirrored: false };
  const ms = wdStand(blocks, vx, vz, mw.x, mw.z, { x: -rx, z: -rz }, fw, shM, fy, T, m0, T.standMinSideM);
  if (ms) return stand(ms, true);
  // Tight spots (a 0.5 m nook between two stub walls): relax the wall / obstacle margin to the basket radius (the basket
  // touches the wall but is never inside / behind it), then also allow the stand on the midline straight ahead. The
  // wanted spot as it is only when even that fails (nothing but a wall within reach).
  for (const [margin, minSide] of [[T.basketR, T.standMinSideM], [T.basketR, 0]]) {
    const r1 = wdStand(blocks, vx, vz, want.x, want.z, ax, fw, sh, fy, T, margin, minSide);
    if (r1) return stand(r1, false, true);
    const r2 = wdStand(blocks, vx, vz, mw.x, mw.z, { x: -rx, z: -rz }, fw, shM, fy, T, margin, minSide);
    if (r2) return stand(r2, true, true);
  }
  const free = wdStand({ segs: [], polys: [], held: [], walls: [] }, vx, vz, want.x, want.z, ax, fw, sh, fy, T, m0, T.standMinSideM); // body clearance + reach only
  return stand(free || { x: want.x, z: want.z }, false, true);
}

/** The room's wall segments and obstacle footprints a virtual stand must keep clear of: `segs` = every vertical plane;
 *  `polys` = every vertical mesh and every raised surface (table, couch, counter, 'other' volume) whose footprint does NOT
 *  hold the viewer and whose volume meets the basket / handle height band; `held` = the footprints the viewer sits in (ON a
 *  couch mesh / IN an armchair volume): the stand keeps clear of their EDGES but the viewer -> stand line may cross them
 *  (Code Review N SHOULD 1); `walls` = the polys the REAL basket path may not reach through (wall meshes and anything
 *  taller than the seated shoulder), with the surface id so a spot on that very surface is not blocked by its own edge. */
function wdBlocks(room, vx, vz, fy, T) {
  const segs = [], polys = [], held = [], walls = [];
  for (const s of (room && room.surfaces) || []) {
    if (s.kind === 'floor' || s.kind === 'rug' || s.kind === 'ceiling' || s.virtual) continue;
    if (s.kind === 'vertical' && s.seg) { segs.push(s.seg); continue; }
    if (!Array.isArray(s.poly) || s.poly.length < 3) continue;
    const lo = Number.isFinite(s.lo) ? s.lo : fy;
    if (!(s.y > fy + 0.02) || lo > fy + T.restHandleM) continue; // flat on the floor / high above the handle: not in the way
    const holds = wdPip(s.poly, vx, vz);
    if (!holds && (s.kind === 'vertical' || s.y > fy + T.seatedShoulderM)) walls.push({ id: String(s.id).split(':')[0], poly: s.poly });
    (holds ? held : polys).push(s.poly);
  }
  return { segs, polys, held, walls };
}
function wdPip(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
function wdSegD2(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
  let t = L > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + dx * t - x, ez = a.z + dz * t - z; return ex * ex + ez * ez;
}
function wdCross(px, pz, qx, qz, a, b) { // open segment p-q crosses closed segment a-b
  const d = (qx - px) * (b.z - a.z) - (qz - pz) * (b.x - a.x); if (Math.abs(d) < 1e-12) return false;
  const t = ((a.x - px) * (b.z - a.z) - (a.z - pz) * (b.x - a.x)) / d, u = ((a.x - px) * (qz - pz) - (a.z - pz) * (qx - px)) / d;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}
function wdCrossPoly(px, pz, qx, qz, poly) {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (wdCross(px, pz, qx, qz, poly[j], poly[i])) return true;
  return false;
}
/** Does the viewer -> (x, z) line go through a wall (a vertical plane, a wall mesh, a block taller than the seated
 *  shoulder)? surf = the id of the surface the spot sits on: its own footprint edge never blocks it. */
function wdThroughWall(blocks, vx, vz, x, z, surf) {
  for (const w of blocks.segs) if (wdCross(vx, vz, x, z, w.a, w.b)) return true;
  const own = surf != null ? String(surf).split(':')[0] : null;
  for (const w of blocks.walls) if (w.id !== own && wdCrossPoly(vx, vz, x, z, w.poly)) return true;
  return false;
}
/** Is a stand at (x, z) clear: the viewer -> stand line crosses no wall, the stand is >= m (basketR + standMarginM, or
 *  basketR in a tight spot) from every wall segment and obstacle edge (the edges of the seat the player sits in included), not inside an obstacle footprint,
 *  >= bodyClearM from the player's body, and the resting handle is within reachHardM. */
function wdClear(blocks, vx, vz, x, z, sh, fy, T, m) {
  const m2 = m * m;
  if ((x - vx) * (x - vx) + (z - vz) * (z - vz) < T.bodyClearM * T.bodyClearM) return false;
  for (const w of blocks.segs) if (wdCross(vx, vz, x, z, w.a, w.b) || wdSegD2(x, z, w.a, w.b) < m2) return false;
  for (const poly of blocks.polys) {
    if (wdPip(poly, x, z) || wdCrossPoly(vx, vz, x, z, poly)) return false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (wdSegD2(x, z, poly[j], poly[i]) < m2) return false;
  }
  for (const poly of blocks.held) { // the player's own seat: the line out of it crosses its edge by nature; keep clear of the edge
    if (wdPip(poly, x, z)) return false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (wdSegD2(x, z, poly[j], poly[i]) < m2) return false;
  }
  const hy = fy + T.restHandleM; // a stand at floor height: handle at restHandleM (basketH is lower)
  return Math.sqrt((x - sh.x) * (x - sh.x) + (hy - sh.y) * (hy - sh.y) + (z - sh.z) * (z - sh.z)) <= T.reachHardM;
}
/** The stand: the wanted point if clear, else the clear point nearest the wanted point on a polar grid around the player:
 *  bearings from 30 degrees behind the hip on the wand side (`ax`) round to straight ahead (`fw`), every 7.5 degrees, at
 *  bodyClearM..standMaxM in standStepM steps; every point at least minSide off the body midline on the wand side, m clear
 *  of every wall / obstacle edge. null when nothing on that side is clear. */
function wdStand(blocks, vx, vz, wx, wz, ax, fw, sh, fy, T, m, minSide) {
  const sideOk = (x, z) => (x - vx) * ax.x + (z - vz) * ax.z >= minSide;
  if (sideOk(wx, wz) && wdClear(blocks, vx, vz, wx, wz, sh, fy, T, m)) return { x: wx, z: wz };
  let best = null, bd = Infinity;
  for (let deg = -30; deg <= 90; deg += 7.5) {
    const a = deg * Math.PI / 180, dx = ax.x * Math.cos(a) + fw.x * Math.sin(a), dz = ax.z * Math.cos(a) + fw.z * Math.sin(a);
    for (let r = T.bodyClearM; r <= T.standMaxM + 1e-9; r += T.standStepM) {
      const x = vx + dx * r, z = vz + dz * r, d = (x - wx) * (x - wx) + (z - wz) * (z - wz);
      if (d >= bd || !sideOk(x, z) || !wdClear(blocks, vx, vz, x, z, sh, fy, T, m)) continue;
      best = { x, z }; bd = d;
    }
  }
  return best;
}

/** Where the resting handle sits: the basket rim, or restHandleM over the floor if that is higher (tall wand). */
export function restHandleY(basket, T) {
  const Tn = T || WAND_TUNING;
  const fy = Number.isFinite(basket.floorY) ? basket.floorY : basket.y;
  return Math.max(basket.y + Tn.basketH, fy + Tn.restHandleM);
}

/** Fresh wand state. basket = placeBasket(...). The wand starts resting in the basket, handle at the rim. */
export function createWandState(basket, tuning) {
  const T = tuning || WAND_TUNING;
  const handle = { x: basket.x, y: restHandleY(basket, T), z: basket.z };
  return {
    basket: { x: basket.x, y: basket.y, z: basket.z, surf: basket.surf, floorY: Number.isFinite(basket.floorY) ? basket.floorY : basket.y, virtual: !!basket.virtual, mirrored: !!basket.mirrored },
    handle, tip: { x: handle.x, y: handle.y + T.tipLen * 0.6, z: handle.z }, // resting: feather sticks up out of the basket
    held: null, place: 'basket', droppedT: null, t: null,
    hist: [], excitement: 0, tipV: { x: 0, y: 0, z: 0 },
  };
}

function wdResting(st, T) {
  st.handle = { x: st.basket.x, y: restHandleY(st.basket, T), z: st.basket.z };
  st.tip = { x: st.handle.x, y: st.handle.y + T.tipLen * 0.6, z: st.handle.z };
  st.place = 'basket'; st.droppedT = null; st.hist = []; st.excitement = 0; st.tipV = { x: 0, y: 0, z: 0 };
}

/**
 * One gesture event for the wand. ev = a gestures.js event ({ type, hand, p, ... }); ctx = { room, forward: { x, z } (the
 * viewer's flat forward), t (session seconds) }. Returns { state (new object), events (roomcat events), consumed }:
 * consumed = true when the pinch / release was the wand's (the host must not forward it as a scruff / box pinch).
 * Pure: the input state is never mutated.
 */
export function wandStep(prev, ev, ctx, tuning) {
  const T = tuning || WAND_TUNING;
  const st = Object.assign({}, prev, { handle: { ...prev.handle }, tip: { ...prev.tip }, hist: prev.hist.slice(), tipV: { ...prev.tipV } });
  const events = [];
  let consumed = false;
  const t = ctx && Number.isFinite(ctx.t) ? ctx.t : st.t;
  if (!ev) return { state: wdTime(st, ctx, T), events, consumed };
  const hand = ev.hand || 'right';
  if (ev.type === 'pinch_start' && !st.held && wdOk(ev.p) && wdD(ev.p, st.handle) <= T.pickR) {
    st.held = hand; st.place = 'hand'; st.droppedT = null; st.hist = []; st.excitement = 0;
    st.handle = { x: ev.p.x, y: ev.p.y, z: ev.p.z };
    consumed = true;
    wdFollow(st, ctx, T, t, true);
    events.push({ type: 'wand', on: true, hand, p: { ...st.tip }, speed: 0 });
  } else if ((ev.type === 'move' || ev.type === 'pinch_hold') && st.held === hand && wdOk(ev.p)) {
    if (ev.type === 'move') {
      st.handle = { x: ev.p.x, y: ev.p.y, z: ev.p.z };
      wdFollow(st, ctx, T, t, false);
      // (GE3's ask): the tip speed in m/s rides on every held event; roomcat's big leap needs speed > bigLeapV
      events.push({ type: 'wand', on: true, hand, p: { ...st.tip }, speed: wdLen(st.tipV.x, st.tipV.y, st.tipV.z) });
    }
  } else if ((ev.type === 'pinch_release' || ev.type === 'lost') && st.held === hand) {
    consumed = ev.type === 'pinch_release';
    wdDrop(st, ctx, T, t);
    events.push({ type: 'wand', on: false, hand });
  }
  st.t = t;
  return { state: wdTime(st, ctx, T), events, consumed };
}

/** The feather tip chases its target (ahead of the handle along the flat forward, below it) with a spring lag. */
function wdFollow(st, ctx, T, t, snap) {
  const f = ctx && ctx.forward, fl = f ? Math.sqrt(f.x * f.x + f.z * f.z) : 0;
  const fx = fl > 1e-9 ? f.x / fl : 0, fz = fl > 1e-9 ? f.z / fl : -1;
  const target = { x: st.handle.x + fx * T.tipLen, y: st.handle.y - T.tipDrop, z: st.handle.z + fz * T.tipLen };
  const prevTip = st.tip;
  if (snap) st.tip = target;
  else st.tip = { x: prevTip.x + (target.x - prevTip.x) * T.tipFollow, y: prevTip.y + (target.y - prevTip.y) * T.tipFollow, z: prevTip.z + (target.z - prevTip.z) * T.tipFollow };
  // excitement = mean tip speed over the window
  if (Number.isFinite(t)) {
    const last = st.hist.length ? st.hist[st.hist.length - 1] : null;
    const dt = last ? t - last.t : 0;
    if (last && dt > 0 && dt <= T.maxDt) st.hist.push({ t, d: wdD(st.tip, last.p), p: { ...st.tip } });
    else st.hist = [{ t, d: 0, p: { ...st.tip } }];
    while (st.hist.length > 1 && t - st.hist[0].t > T.exciteWindowS) st.hist.shift();
    const span = st.hist.length > 1 ? t - st.hist[0].t : 0;
    let dist = 0; for (let i = 1; i < st.hist.length; i++) dist += st.hist[i].d;
    const v = span > 1e-4 ? dist / span : 0;
    st.excitement = Math.max(0, Math.min(1, v / T.exciteV));
    if (last && dt > 0) st.tipV = { x: (st.tip.x - last.p.x) / dt, y: (st.tip.y - last.p.y) / dt, z: (st.tip.z - last.p.z) / dt };
  }
}

function wdDrop(st, ctx, T, t) {
  st.held = null; st.hist = []; st.excitement = 0; st.tipV = { x: 0, y: 0, z: 0 };
  const room = ctx && ctx.room;
  if (room) {
    const L = roomNearestLegal(room, { x: st.handle.x, y: st.handle.y, z: st.handle.z }, 0.05);
    if (L && Number.isFinite(L.x) && Number.isFinite(L.y) && Number.isFinite(L.z)) st.handle = { x: L.x, y: L.y + 0.02, z: L.z }; // no legal spot at all: keep it where it is (never throw in the frame loop)
  }
  if (wdLen(st.handle.x - st.basket.x, 0, st.handle.z - st.basket.z) <= T.returnFarM) { wdResting(st, T); return; }
  st.place = 'floor'; st.droppedT = Number.isFinite(t) ? t : 0;
  st.tip = { x: st.handle.x + T.tipLen * 0.8, y: st.handle.y, z: st.handle.z }; // lying flat, feather to +x
}

/** time-only rules: a wand lying away from the basket for returnS hops back into it */
function wdTime(st, ctx, T) {
  const t = ctx && Number.isFinite(ctx.t) ? ctx.t : null;
  if (t != null && st.place === 'floor' && st.droppedT != null && t - st.droppedT >= T.returnS) wdResting(st, T);
  if (t != null) st.t = t;
  return st;
}

/** Host read-out: what to draw. { basket, handle, tip, base, held, place, excitement, inBasket }. base = where the stick
 *  starts: the basket rim while resting (a tall wand standing in the basket), else the handle. */
export function wandView(st) {
  const inBasket = st.place === 'basket';
  const base = inBasket ? { x: st.basket.x, y: st.basket.y, z: st.basket.z } : st.handle; // standing in the basket: from its bottom
  return { basket: st.basket, handle: st.handle, tip: st.tip, base, held: st.held, place: st.place, excitement: st.excitement, inBasket };
}

/** The basket's surface height for a given room (host convenience / tests). */
export function basketSurfaceY(room, basket) { const s = roomSurface(room, basket.surf); return s ? s.y : basket.y; }

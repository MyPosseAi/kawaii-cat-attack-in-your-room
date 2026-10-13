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

/* ---- Q-GE2 2026-10-12 (the owner's Quest list #7 "Still can't move furniture"): VIRTUAL FURNITURE the player places, grabs,
   moves, rotates and removes. PURE like the wand above (no three / WebXR / DOM), same file so the public allowlist does not
   change. The art is the existing original F1 / B5 furniture (design/batches/B5-furniture-views prims, Design 1): each kind
   is a few boxes / cylinders in the F1 palette, in metres (0.006 m per art unit), y up from the floor, centred on its
   footprint; the host draws `parts` with plain three meshes (no new art files).
   Rules:
   - furnitureAdd(st, kind, ctx): a new piece stands on the floor about spawnAheadM ahead of the viewer (else the first free
     spot beside / behind that), facing them, its footprint kept inside the floor's bounds; at most maxPieces.
   - furnitureStep(st, ev, ctx): grab_start (controller grip or hand pinch; pinch_start is the same) within grabM of a
     piece's box, or a controller ray (ev.ray) that hits the box within rayMaxM, GRABS it (consumed = true: not a scruff /
     wand / box pinch). While held (grab_move / move / pinch_hold of that hand) the piece slides on the floor under the
     hand (near grab: the grab offset is kept) or under the ray's floor hit (ray grab); in a near grab a finite ev.yaw
     (hand / controller heading) twists it by the yaw change since the grab. grab_end / pinch_release drops it: over the BIN (within binR of st.bin on the floor
     plane) it is REMOVED, else it stays where it is (clamped into the floor bounds). lost = dropped where it is.
     rotate { hand, x (stick -1..1), dt } turns the held piece, else the last touched one (stickRate rad/s past stickDead).
   - furnitureRemove(st, id?) removes a piece (default: the held / last touched one) = the picker's "Remove" action.
   - furnitureMeshes(st, floorY) -> room.js meshes ({ id, label, min, max, footprint }) so the NEXT room build (session
     start) makes the pieces surfaces / obstacles for the cats. A live roomcat session keeps its room (game/core roomcat
     binds it at creation), so mid-session the pieces are props the player arranges.
   - SAVED between visits ONLY as Legal / FOR-DEV allows (visit-store.js FURNITURE_PERSIST + sanitizeFurniture):
     furnitureRugFrame(room) = the PLAY RUG (room.js virtual rug: room.rug, surface 'rug'; null in a scanned room = nothing is
     saved or restored there); furnitureSave(st, frame) -> { v: 1, items: [[k, x, z, r]] }: k = FURN_VR_KINDS index, x / z =
     10 cm cells from the rug centre on the rug's own axes (a piece whose centre is off the rug is NOT saved), r = yaw in
     45 deg steps, max 12; nothing else (no y / size / time / rug pose). furnitureRestore(st, saved, frame) puts saved
     pieces on their rug cells (clamped to the rug only, never snapped to real-room planes / meshes); an unmoved restored
     piece keeps its saved cell (p.saved) so a load-time nudge is never written back; a drag or twist clears it.
   - Hot path (a held piece every frame) writes into the state's own objects: zero allocation per frame. */
export const FURN_VR_VERSION = 1;
export const FURN_VR_TUNING = Object.freeze({
  maxPieces: 8, spawnAheadM: 0.9, grabM: 0.08, rayMaxM: 3.0, binR: 0.3,
  stickDead: 0.3, stickRate: 2.5, edgeM: 0.02,
});
function wdFk(kind, label, name, w, h, d, parts) { return Object.freeze({ kind, label, name, w, h, d, parts: Object.freeze(parts.map((p) => Object.freeze(p))) }); }
/** The picker: one tile per kind (name = tile text). Original art: F1 / B5 prims (Design 1), colours = F1 COLORS. */
export const FURN_VR_KINDS = Object.freeze([
  wdFk("cat_tree", "cat tree", "Cat tree", 0.606, 0.768, 0.36, [
    {t: 'box', x0: -0.279, x1: 0.273, y0: 0, y1: 0.072, z0: -0.18, z1: 0.18, c: '#d9a878'},
    {t: 'cyl', cx: -0.003, cz: 0, r: 0.048, y0: 0.06, y1: 0.696, c: '#e6cf9c'},
    {t: 'box', x0: 0.009, x1: 0.273, y0: 0.228, y1: 0.432, z0: -0.12, z1: 0.12, c: '#cdbdf0'},
    {t: 'cyl', cx: 0.141, cz: 0, r: 0.162, y0: 0.402, y1: 0.486, c: '#f6bfd3'},
    {t: 'box', x0: -0.231, x1: -0.015, y0: 0.642, y1: 0.696, z0: -0.078, z1: 0.078, c: '#d9a878'},
    {t: 'cyl', cx: -0.123, cz: 0, r: 0.18, y0: 0.672, y1: 0.768, c: '#f6bfd3'},
    {t: 'box', x0: -0.255, x1: -0.183, y0: 0.474, y1: 0.66, z0: -0.138, z1: -0.066, c: '#cdbdf0'}]),
  wdFk("scratch_post", "cat tree", "Scratch post", 0.36, 0.762, 0.36, [
    {t: 'box', x0: -0.18, x1: 0.18, y0: 0, y1: 0.072, z0: -0.18, z1: 0.18, c: '#d9a878'},
    {t: 'cyl', cx: 0, cz: 0, r: 0.066, y0: 0.06, y1: 0.708, c: '#e6cf9c'},
    {t: 'cyl', cx: 0, cz: 0, r: 0.144, y0: 0.678, y1: 0.762, c: '#bfe6cf'},
    {t: 'box', x0: 0.09, x1: 0.15, y0: 0.51, y1: 0.708, z0: -0.03, z1: 0.03, c: '#bfe6cf'}]),
  wdFk("cushion", "bed", "Cushion", 0.6, 0.258, 0.576, [
    {t: 'box', x0: -0.3, x1: 0.3, y0: 0, y1: 0.258, z0: -0.288, z1: 0.288, c: '#f6bfd3'}]),
  wdFk("box", "storage", "Box", 0.648, 0.432, 0.42, [
    {t: 'box', x0: -0.264, x1: 0.264, y0: 0, y1: 0.324, z0: -0.21, z1: 0.198, c: '#e2b27a'},
    {t: 'box', x0: -0.324, x1: -0.264, y0: 0.3, y1: 0.42, z0: -0.198, z1: 0.186, c: '#e2b27a'},
    {t: 'box', x0: 0.264, x1: 0.324, y0: 0.3, y1: 0.432, z0: -0.198, z1: 0.186, c: '#e2b27a'},
    {t: 'box', x0: -0.216, x1: 0.216, y0: 0.324, y1: 0.396, z0: 0.186, z1: 0.21, c: '#e2b27a'}]),
  wdFk("couch", "couch", "Mini couch", 1.032, 0.456, 0.42, [
    {t: 'box', x0: -0.408, x1: -0.36, y0: 0, y1: 0.048, z0: -0.21, z1: -0.162, c: '#b9845a'},
    {t: 'box', x0: -0.408, x1: -0.36, y0: 0, y1: 0.048, z0: 0.15, z1: 0.198, c: '#b9845a'},
    {t: 'box', x0: 0.36, x1: 0.408, y0: 0, y1: 0.048, z0: -0.21, z1: -0.162, c: '#b9845a'},
    {t: 'box', x0: 0.36, x1: 0.408, y0: 0, y1: 0.048, z0: 0.15, z1: 0.198, c: '#b9845a'},
    {t: 'box', x0: -0.432, x1: 0.432, y0: 0.036, y1: 0.252, z0: -0.198, z1: 0.186, c: '#bfe6cf'},
    {t: 'box', x0: -0.396, x1: 0.396, y0: 0.192, y1: 0.456, z0: 0.078, z1: 0.21, c: '#8fcaa8'},
    {t: 'box', x0: -0.516, x1: -0.36, y0: 0.036, y1: 0.348, z0: -0.21, z1: 0.198, c: '#bfe6cf'},
    {t: 'box', x0: 0.36, x1: 0.516, y0: 0.036, y1: 0.348, z0: -0.21, z1: 0.198, c: '#bfe6cf'},
    {t: 'box', x0: 0.132, x1: 0.312, y0: 0.252, y1: 0.396, z0: 0.03, z1: 0.09, c: '#f6bfd3'}]),
  wdFk("plant", "plant", "Plant", 0.324, 0.624, 0.324, [
    {t: 'cyl', cx: 0, cz: 0, r: 0.12, y0: 0, y1: 0.228, c: '#e98f72'},
    {t: 'box', x0: -0.162, x1: 0.162, y0: 0.228, y1: 0.624, z0: -0.162, z1: 0.162, c: '#8fd19a'}])
]);
export const FURN_VR_PICKER = Object.freeze(FURN_VR_KINDS.map((k) => Object.freeze({ id: k.kind, label: k.name })).concat([Object.freeze({ id: 'remove', label: 'Remove' })]));
export function furnitureKind(kind) { for (let i = 0; i < FURN_VR_KINDS.length; i++) if (FURN_VR_KINDS[i].kind === kind) return FURN_VR_KINDS[i]; return null; }

/** Fresh state. opts = { bin: { x, y, z } | null (the bin tile on the floor), floor: { x0, z0, x1, z1 } | null (bounds) } */
export function createFurnitureState(opts) {
  const o = opts || {};
  return {
    pieces: [], seq: 0, sel: null, bin: o.bin ? { x: o.bin.x, y: o.bin.y, z: o.bin.z } : null, floor: o.floor || null, version: 0,
    held: { left: null, right: null }, // per hand: { piece, mode: 'near' | 'ray', ox, oz, yaw0, hy0 }
    out: { consumed: false, event: null, id: null }, T: FURN_VR_TUNING,
  };
}

/** floor bounds from a room.js room (its floor surface's bb) */
export function furnitureFloor(room) {
  const f = room && room.floor != null ? roomSurface(room, room.floor) : null;
  return f && f.bb ? { x0: f.bb.x0, z0: f.bb.z0, x1: f.bb.x1, z1: f.bb.z1, y: f.y } : null;
}

function wdClampPiece(st, p) {
  const F = st.floor; if (!F) return;
  const k = furnitureKind(p.kind), c = Math.abs(Math.cos(p.yaw)), s = Math.abs(Math.sin(p.yaw));
  const hx = (k.w * c + k.d * s) / 2 + st.T.edgeM, hz = (k.w * s + k.d * c) / 2 + st.T.edgeM;
  p.x = F.x1 - F.x0 <= 2 * hx ? (F.x0 + F.x1) / 2 : Math.max(F.x0 + hx, Math.min(F.x1 - hx, p.x));
  p.z = F.z1 - F.z0 <= 2 * hz ? (F.z0 + F.z1) / 2 : Math.max(F.z0 + hz, Math.min(F.z1 - hz, p.z));
}

/** Add a piece of `kind` ahead of the viewer. ctx = { viewer: { x, z }, forward: { x, z }, floorY }. Returns it, or null. */
export function furnitureAdd(st, kind, ctx) {
  const k = furnitureKind(kind); if (!k || st.pieces.length >= st.T.maxPieces) return null;
  const c = ctx || {}, v = c.viewer || { x: 0, z: 0 }, f = c.forward || { x: 0, z: -1 };
  const fl = Math.sqrt(f.x * f.x + f.z * f.z), fx = fl > 1e-9 ? f.x / fl : 0, fz = fl > 1e-9 ? f.z / fl : -1;
  const y = Number.isFinite(c.floorY) ? c.floorY : (st.floor && Number.isFinite(st.floor.y) ? st.floor.y : 0);
  const p = { id: 'vf' + (++st.seq), kind, x: 0, y, z: 0, yaw: Math.atan2(fx, fz), held: null }; // the art's front (local -z, F1 z = 0) faces the viewer
  // the first free spot ahead: straight ahead, then to the sides, then further out (a new piece never lands inside another)
  const r = Math.max(k.w, k.d) / 2;
  for (let i = 0; i < WD_SPAWN.length; i++) {
    const a = st.T.spawnAheadM + WD_SPAWN[i][1], sd = WD_SPAWN[i][0]; // side offset along the viewer's right (-fz, fx)
    p.x = v.x + fx * a - fz * sd; p.z = v.z + fz * a + fx * sd; wdClampPiece(st, p);
    let free = true;
    for (const q of st.pieces) { const kq = furnitureKind(q.kind), rr = r + Math.max(kq.w, kq.d) / 2; if ((q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z) < rr * rr) { free = false; break; } }
    if (free) break;
    if (i === WD_SPAWN.length - 1) { p.x = v.x + fx * st.T.spawnAheadM; p.z = v.z + fz * st.T.spawnAheadM; wdClampPiece(st, p); } // crowded: straight ahead
  }
  st.pieces.push(p); st.sel = p.id; st.version++;
  return p;
}

/** Remove a piece (default: the one held, else the last touched). Returns true when one went. */
export function furnitureRemove(st, id) {
  let pid = id;
  if (pid == null) pid = st.held.right ? st.held.right.piece.id : st.held.left ? st.held.left.piece.id : st.sel;
  const i = st.pieces.findIndex((p) => p.id === pid); if (i < 0) return false;
  const p = st.pieces[i]; st.pieces.splice(i, 1);
  for (const h of ['left', 'right']) if (st.held[h] && st.held[h].piece === p) st.held[h] = null;
  if (st.sel === p.id) st.sel = st.pieces.length ? st.pieces[st.pieces.length - 1].id : null;
  st.version++;
  return true;
}

/** point (world) -> the piece's local frame (x along its width, z along its depth), written into `o` */
function wdLocal(p, x, z, o) { const c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = x - p.x, dz = z - p.z; o.x = dx * c - dz * s; o.z = dx * s + dz * c; return o; }
const WD_L = { x: 0, z: 0 }, WD_D = { x: 0, z: 0 };
const WD_SPAWN = [[0, 0], [0.75, 0], [-0.75, 0], [0, 0.8], [0.75, 0.8], [-0.75, 0.8], [1.4, 0], [-1.4, 0]]; // [side, extra ahead] m
/** squared distance from p3 to the piece's box (0 inside) */
function wdBoxD2(pc, q) {
  const k = furnitureKind(pc.kind); wdLocal(pc, q.x, q.z, WD_L);
  const ax = Math.max(0, Math.abs(WD_L.x) - k.w / 2), az = Math.max(0, Math.abs(WD_L.z) - k.d / 2), ly = q.y - pc.y, ay = ly < 0 ? -ly : Math.max(0, ly - k.h);
  return ax * ax + ay * ay + az * az;
}
/** ray (o, d) vs the piece's oriented box: distance along the ray, or -1 */
function wdRayHit(pc, o, d) {
  const k = furnitureKind(pc.kind); wdLocal(pc, o.x, o.z, WD_L);
  const c = Math.cos(pc.yaw), s = Math.sin(pc.yaw), dx = d.x * c - d.z * s, dz = d.x * s + d.z * c;
  let t0 = 0, t1 = Infinity;
  const slab = (o0, dd, lo, hi) => { if (Math.abs(dd) < 1e-9) return o0 >= lo && o0 <= hi; let a = (lo - o0) / dd, b2 = (hi - o0) / dd; if (a > b2) { const tt = a; a = b2; b2 = tt; } if (a > t0) t0 = a; if (b2 < t1) t1 = b2; return t0 <= t1; };
  if (!slab(WD_L.x, dx, -k.w / 2, k.w / 2) || !slab(o.y - pc.y, d.y, 0, k.h) || !slab(WD_L.z, dz, -k.d / 2, k.d / 2)) return -1;
  return t0;
}
/** The piece a grab at point q (or along ray) would take: { piece, mode } or null. Hosts use it to arbitrate (wand > kitten > furniture). */
export function furnitureHit(st, q, ray) {
  let best = null, bd = st.T.grabM * st.T.grabM, mode = 'near';
  if (q && Number.isFinite(q.x)) for (const p of st.pieces) { const d2 = wdBoxD2(p, q); if (d2 <= bd) { bd = d2; best = p; } }
  if (!best && ray && ray.o && ray.d) { let bt = st.T.rayMaxM; for (const p of st.pieces) { const t = wdRayHit(p, ray.o, ray.d); if (t >= 0 && t <= bt) { bt = t; best = p; } } mode = 'ray'; }
  return best ? { piece: best, mode } : null;
}
/** the ray's hit on the floor plane y, written into WD_D; false when it never reaches it */
function wdRayFloor(ray, y) { const o = ray.o, d = ray.d; if (!(d.y < -1e-4)) return false; const t = (y - o.y) / d.y; if (t < 0 || t > 20) return false; WD_D.x = o.x + d.x * t; WD_D.z = o.z + d.z * t; return true; }

/**
 * One input event. ev = { type, hand, p?, ray?, yaw?, x?, dt? } (types above; gestures.js pinch events work as is).
 * ctx = { room? } (unused today; reserved). Returns st.out (REUSED): { consumed, event: 'grab' | 'move' | 'drop' | 'removed' | 'rotate' | null, id }.
 */
export function furnitureStep(st, ev, ctx) {
  const out = st.out; out.consumed = false; out.event = null; out.id = null;
  if (!ev) return out;
  const hand = ev.hand === 'left' ? 'left' : 'right', H = st.held[hand], T = st.T;
  const ty = ev.type;
  if ((ty === 'grab_start' || ty === 'pinch_start') && !H) {
    const hit = furnitureHit(st, ev.p, ev.ray); if (!hit) return out;
    const p = hit.piece;
    for (const h of ['left', 'right']) if (st.held[h] && st.held[h].piece === p) return out; // the other hand has it
    let ox = 0, oz = 0;
    if (hit.mode === 'near') { ox = p.x - ev.p.x; oz = p.z - ev.p.z; }
    else if (wdRayFloor(ev.ray, p.y)) { ox = p.x - WD_D.x; oz = p.z - WD_D.z; }
    st.held[hand] = { piece: p, mode: hit.mode, ox, oz, yaw0: p.yaw, hy0: hit.mode === 'near' && Number.isFinite(ev.yaw) ? ev.yaw : null }; // a ray drag never twists (turning the controller aims the ray)
    p.held = hand; st.sel = p.id; st.version++;
    out.consumed = true; out.event = 'grab'; out.id = p.id; return out;
  }
  if (!H) { if (ty === 'rotate') return wdRotate(st, st.pieces.find((q) => q.id === st.sel), ev, out); return out; }
  const p = H.piece;
  if (ty === 'grab_move' || ty === 'move' || ty === 'pinch_hold') {
    if (H.mode === 'ray' && ev.ray && ev.ray.o && ev.ray.d) { if (wdRayFloor(ev.ray, p.y)) { p.x = WD_D.x + H.ox; p.z = WD_D.z + H.oz; } }
    else if (ev.p && Number.isFinite(ev.p.x)) { p.x = ev.p.x + H.ox; p.z = ev.p.z + H.oz; }
    if (H.hy0 != null && Number.isFinite(ev.yaw)) p.yaw = H.yaw0 + (ev.yaw - H.hy0);
    p.saved = null; p.noSave = false; // the player moved it: its new rug cell is saved from now on (rule 4; GO9b SHOULD 1: also a piece carried in from a scanned room)
    wdClampPiece(st, p); out.consumed = true; out.event = 'move'; out.id = p.id; return out;
  }
  if (ty === 'rotate') return wdRotate(st, p, ev, out);
  if (ty === 'grab_end' || ty === 'pinch_release' || ty === 'lost') {
    st.held[hand] = null; p.held = null; out.consumed = ty !== 'lost'; out.id = p.id;
    const B = st.bin;
    if (B && ty !== 'lost') { const dx = p.x - B.x, dz = p.z - B.z; if (dx * dx + dz * dz <= T.binR * T.binR) { furnitureRemove(st, p.id); out.event = 'removed'; return out; } }
    wdClampPiece(st, p); st.version++; out.event = 'drop'; return out;
  }
  return out;
}
function wdRotate(st, p, ev, out) {
  if (!p) return out; const x = Number(ev.x), dt = Number(ev.dt);
  if (!Number.isFinite(x) || !Number.isFinite(dt) || Math.abs(x) < st.T.stickDead) return out;
  const dy = x * st.T.stickRate * Math.min(dt, 0.1); p.yaw += dy; p.saved = null;
  if (p.yaw > Math.PI) p.yaw -= 2 * Math.PI; else if (p.yaw < -Math.PI) p.yaw += 2 * Math.PI;
  const H = p.held ? st.held[p.held] : null; if (H) H.yaw0 += dy; // stick and twist add up
  wdClampPiece(st, p); if (!p.held) st.version++;
  out.consumed = true; out.event = 'rotate'; out.id = p.id; return out;
}

/** The play rug's frame { cx, cz, hx, hz } (rug-local axes = the rug's: room.js lays it axis-aligned), or null when the room
 *  has no play rug (a scanned floor). Read from the rug surface only: never planes / meshes / anchors (rule 3). */
export function furnitureRugFrame(room) {
  if (!room || room.rug !== true) return null;
  const s = roomSurface(room, 'rug');
  if (!s || !s.bb || !s.virtual) return null;
  const b = s.bb;
  return { cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, hx: (b.x1 - b.x0) / 2, hz: (b.z1 - b.z0) / 2 };
}
const WD_CELL = 0.1, WD_ROT = Math.PI / 4, WD_MAXSAVE = 12;
function wdKindIndex(kind) { for (let i = 0; i < FURN_VR_KINDS.length; i++) if (FURN_VR_KINDS[i].kind === kind) return i; return -1; }
/** One piece -> [k, x, z, r] on the rug grid, or null (unknown kind / centre off the rug). */
export function furnitureCell(p, frame) {
  const k = wdKindIndex(p && p.kind); if (k < 0 || !frame || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  const dx = p.x - frame.cx, dz = p.z - frame.cz;
  if (Math.abs(dx) > frame.hx + 1e-9 || Math.abs(dz) > frame.hz + 1e-9) return null; // off the rug: not saved (rule 3)
  const mx = Math.floor(frame.hx / WD_CELL + 1e-9), mz = Math.floor(frame.hz / WD_CELL + 1e-9);
  const cx = Math.max(-mx, Math.min(mx, Math.round(dx / WD_CELL))), cz = Math.max(-mz, Math.min(mz, Math.round(dz / WD_CELL)));
  const r = (((Math.round((Number.isFinite(p.yaw) ? p.yaw : 0) / WD_ROT)) % 8) + 8) % 8;
  return [k, cx === 0 ? 0 : cx, cz === 0 ? 0 : cz, r];
}
/** What to save (rule 2): { v: 1, items } from the pieces ON the rug, max 12; an unmoved restored piece gives its saved
 *  cell back (rule 4). null when there is no play rug (nothing saved, the stored list is left as it is). */
export function furnitureSave(st, frame) {
  if (!frame) return null;
  const items = [];
  for (const p of st.pieces) {
    if (items.length >= WD_MAXSAVE) break;
    const c = p.saved ? p.saved.slice() : p.noSave ? null : furnitureCell(p, frame); // noSave: carried in from a scanned room, x / z last clamped to a REAL floor (GO9b SHOULD 1): not saved until moved on the rug
    if (c) items.push(c);
  }
  return { v: 1, items };
}
/** GO9b SHOULD 1: a piece carried into a new session (room-bridge start) is clamped into THIS session's furniture floor (the rug) */
export function furnitureReclamp(st, p) { wdClampPiece(st, p); }
/** Put saved pieces (visit-store.js readFurniture, already whitelisted) on their rug cells; returns how many. Clamped into the
 *  furniture floor (the rug) only; never snapped to a real-room surface (rule 3). Each keeps p.saved until the player moves it. */
export function furnitureRestore(st, saved, frame, floorY) {
  if (!frame || !saved || !Array.isArray(saved.items)) return 0;
  const y = Number.isFinite(floorY) ? floorY : (st.floor && Number.isFinite(st.floor.y) ? st.floor.y : 0);
  let n = 0;
  for (const it of saved.items) {
    if (n >= WD_MAXSAVE || !Array.isArray(it) || it.length !== 4) continue;
    const kd = FURN_VR_KINDS[it[0]]; if (!kd || !Number.isInteger(it[1]) || !Number.isInteger(it[2]) || !Number.isInteger(it[3])) continue;
    let yaw = (it[3] & 7) * WD_ROT; if (yaw > Math.PI) yaw -= 2 * Math.PI;
    const p = { id: 'vf' + (++st.seq), kind: kd.kind, x: frame.cx + it[1] * WD_CELL, y, z: frame.cz + it[2] * WD_CELL, yaw, held: null, saved: [it[0], it[1], it[2], it[3] & 7] };
    wdClampPiece(st, p); // may nudge it on screen; p.saved keeps the stored cell (rule 4)
    st.pieces.push(p); n++;
  }
  if (n) { st.sel = st.pieces[st.pieces.length - 1].id; st.version++; }
  return n;
}

/** room.js meshes for the next room build: { id, label, min, max, footprint (oriented corners) } per piece */
export function furnitureMeshes(st, floorY) {
  const res = [];
  for (const p of st.pieces) {
    const k = furnitureKind(p.kind), c = Math.cos(p.yaw), s = Math.sin(p.yaw), y = Number.isFinite(floorY) ? floorY : p.y, fp = [];
    for (const [lx, lz] of [[-k.w / 2, -k.d / 2], [k.w / 2, -k.d / 2], [k.w / 2, k.d / 2], [-k.w / 2, k.d / 2]]) fp.push({ x: p.x + lx * c + lz * s, z: p.z - lx * s + lz * c });
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const q of fp) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    res.push({ id: p.id, label: k.label, min: { x: x0, y, z: z0 }, max: { x: x1, y: y + k.h, z: z1 }, footprint: fp });
  }
  return res;
}
/** what to draw: the pieces (their own objects: { id, kind, x, y, z, yaw, held }), the bin, the selected id */
export function furnitureView(st) { return st; }
/** local part -> world: a box part's centre for drawing (x / z rotated by yaw), written into `o` */
export function furniturePartCentre(p, part, o) {
  const lx = part.t === 'box' ? (part.x0 + part.x1) / 2 : part.cx, lz = part.t === 'box' ? (part.z0 + part.z1) / 2 : part.cz;
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  o.x = p.x + lx * c + lz * s; o.y = p.y + (part.y0 + part.y1) / 2; o.z = p.z - lx * s + lz * c; return o;
}

/* game/core/room.js — week 1 (docs/VR-COMPETITION-PLAN.md section 2.3): the player's REAL room as a cat level.
   Gaming Engineer, 2026-10-09. Engine-agnostic and deterministic: no IWSDK / WebXR / DOM dependency, no Math.random,
   no Date, no trig (sqrt + polynomials only). The VR host (IWSDK SceneUnderstandingSystem) resolves every XRPlane /
   XRMesh pose into WORLD coordinates and hands us plain data; the same data recorded from a headset (or @iwer/sem
   synthetic rooms) replays the same room in node tests.
   Units: metres, y UP, the WebXR 'local-floor' frame (floorY = 0 by default). Horizontal = the (x, z) plane.
   Input:
     planes: [{ id, label, orientation: 'horizontal' | 'vertical', polygon: [{x, y?, z}...] (world), y? (height of a
              horizontal plane; default = mean polygon y), part?: 'back' }]
     meshes: [{ id, label, min: {x, y, z}, max: {x, y, z}, footprint?: [{x, z}...] }]   (world AABB of an XRMesh; the
              host computes it. footprint = the mesh's ORIENTED floor outline in world (x, z), e.g. the 4 corners of its
              oriented box from the mesh pose: send it, a couch / bed yawed in the local-floor frame is not axis-aligned.
              Without it the world AABB footprint is used, which is larger than the furniture but never too small.)
     labels = WebXR semanticLabel as Meta sends it ('floor', 'table', 'couch', 'bed', 'storage', 'wall', 'plant',
     'lamp', 'screen', 'door frame', 'window frame', 'wall art', 'ceiling', 'other', 'global mesh', ...); case, '_' and
     '-' do not matter.
   Output (createRoom): plain JSON-able data. Surfaces with legal = true are places a cat may stand (feet ON them,
   y = surface y exactly). Everything else is in the same list with legal = false and a `reason` (rules lifted to
   3D: never on a vertical plane, a couch BACK, a plant / lamp / screen, the ceiling, a surface too small for a cat or
   higher than ROOM_LIMITS.maxPerchH). Each legal surface keeps a legality footprint (polygon minus obstacle footprints,
   inset by catR), sample points on a 0.15 m grid, spread-out spots (floor / perch / nap) and hop links (`edges`) to
   other surfaces with their height change and gap, so roomcat.js can check jump limits per cat size.
   No scan / no floor plane: a 2 x 2 m virtual RUG on floorY in front of the viewer becomes the floor (rug: true), so
   the experience never dead-ends in a room we never tested.
   Build rule: only `export function` / `export const`; private names carry the `rm` prefix (build-proto inlines every
   core module into one classic script). */

export const ROOM_VERSION = 1;
export const ROOM_LIMITS = Object.freeze({
  catR: 0.12,          // feet keep this far from every edge / obstacle (m)
  minSide: 0.25,       // a surface narrower than this is too small for a cat
  maxPerchH: 1.3,      // higher than this above the floor = too high (out of reach for a seated player, unsafe drop)
  lowH: 0.05,          // a horizontal non-floor plane lower than this is floor-like (rug, mat): not an obstacle
  bodyH: 0.3,          // band above a surface a cat's body occupies: obstacles inside it block that surface
  maxUp: 1.0,          // largest upward hop of any cat (adult); kittens are checked again in roomcat.js
  maxDrop: 1.4,        // largest downward hop
  maxGap: 1.2,         // largest horizontal hop distance (adult)
  grid: 0.15, gridBig: 0.2, bigArea: 6, spotGap: 0.3, edgePairs: 6, edgePairGap: 0.3,
  rugSize: 2, rugAhead: 1.0, boxAhead: 0.6,
});
/** nap preference (lower = better): couch seat, then bed, then floor / rug (plan 1.3) */
export const ROOM_NAP_RANK = Object.freeze({ seat: 0, bed: 1, floor: 2, rug: 2 });

const RM_VERTICAL = ['wall', 'wall face', 'invisible wall face', 'door frame', 'window frame', 'wall art', 'window', 'door'];
const RM_NOT_SEAT = ['plant', 'lamp', 'screen', 'monitor', 'tv'];
const RM_HOPS = new WeakMap(); // room -> Map(key -> hop list / route): read-only results, cached (no per-step allocation)

/** WebXR / Meta semantic label -> our lower-case vocabulary ('wall_face' -> 'wall', 'desk' -> 'table', 'sofa' -> 'couch'). */
export function roomLabel(label) {
  let s = String(label == null ? 'other' : label).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '' || s === 'unknown') s = 'other';
  if (s === 'wall face' || s === 'invisible wall face') s = 'wall';
  if (s === 'desk') s = 'table';
  if (s === 'sofa') s = 'couch';
  if (s === 'shelf' || s === 'shelves' || s === 'bookshelf') s = 'storage';
  return s;
}

function rmPt(p) { return Array.isArray(p) ? { x: +p[0], y: p.length > 2 ? +p[1] : 0, z: +(p.length > 2 ? p[2] : p[1]) } : { x: +p.x, y: +(p.y || 0), z: +p.z }; }
function rmBox(poly) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z; }
  return { x0, z0, x1, z1 };
}
function rmRect(x0, z0, x1, z1) { return [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }]; }
function rmArea(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x * poly[i].z - poly[i].x * poly[j].z); return Math.abs(a) / 2; }
/** point in polygon (x, z), even-odd rule */
function rmPip(poly, x, z) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
function rmSegD2(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz;
  let t = L > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = a.x + dx * t - x, ez = a.z + dz * t - z; return ex * ex + ez * ez;
}
function rmEdgeD2(poly, x, z) { let m = Infinity; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const d = rmSegD2(x, z, poly[j], poly[i]); if (d < m) m = d; } return m; }
/** point inside a surface's TOP: in its polygon and not in one of its holes (the mate planes of a couch / bed mesh) */
function rmTop(s, x, z) {
  if (!rmPip(s.poly, x, z)) return false;
  if (s.holes) for (const h of s.holes) if (rmPip(h, x, z)) return false;
  return true;
}
function rmCen(poly) { let x = 0, z = 0; for (const p of poly) { x += p.x; z += p.z; } return { x: x / poly.length, z: z / poly.length }; }
function rmHd(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz); }

/** true when a cat's feet at (x, z) are legal on surface `s`: inside its polygon at least `margin` from the rim and clear of
 *  every obstacle footprint by `margin`. */
function rmLegal(s, x, z, margin) {
  if (!s || !s.legal || !rmPip(s.poly, x, z) || rmEdgeD2(s.poly, x, z) < margin * margin) return false;
  for (const o of s.obs) if (x >= o.bb.x0 - margin && x <= o.bb.x1 + margin && z >= o.bb.z0 - margin && z <= o.bb.z1 + margin
    && (rmPip(o.poly, x, z) || rmEdgeD2(o.poly, x, z) < margin * margin)) return false;
  return true;
}

function rmSurface(id, label, kind, y, poly, extra) {
  return Object.assign({ id: String(id), label, kind, y, poly, bb: rmBox(poly), lo: null, legal: true, reason: null, obs: [], samples: [], spots: [], nap: -1 }, extra || {});
}

/** Build the room. opts: { planes, meshes, floorY = 0, viewer = {x: 0, z: 0}, forward = {x: 0, z: -1} } */
export function createRoom(opts = {}) {
  const LIM = ROOM_LIMITS, floorY = Number.isFinite(opts.floorY) ? opts.floorY : 0;
  const viewer = { x: (opts.viewer && opts.viewer.x) || 0, z: (opts.viewer && opts.viewer.z) || 0 };
  let fw = opts.forward || { x: 0, z: -1 }; { const l = Math.sqrt(fw.x * fw.x + fw.z * fw.z) || 1; fw = { x: fw.x / l, z: fw.z / l }; }
  const surfaces = [], walls = [];
  let n = 0;
  const legalAbove = (s) => {
    const h = s.y - floorY;
    if (h > LIM.maxPerchH) { s.legal = false; s.reason = 'too_high'; }
    return s;
  };
  // ---- planes
  for (const pl of Array.isArray(opts.planes) ? opts.planes : []) {
    if (!pl || !Array.isArray(pl.polygon) || pl.polygon.length < 3) continue;
    const id = pl.id != null ? String(pl.id) : 'p' + (n++);
    const label = roomLabel(pl.label), pts = pl.polygon.map(rmPt);
    if (label === 'global mesh') continue;
    if (pl.orientation === 'vertical' || RM_VERTICAL.indexOf(label) >= 0 && pl.orientation !== 'horizontal') {
      let lo = Infinity, hi = -Infinity; for (const p of pts) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
      const bb = rmBox(pts), byX = bb.x1 - bb.x0 >= bb.z1 - bb.z0;
      let a = pts[0], b = pts[0];
      for (const p of pts) { if (byX ? p.x < a.x : p.z < a.z) a = p; if (byX ? p.x > b.x : p.z > b.z) b = p; }
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.sqrt(dx * dx + dz * dz) || 1, nx = -dz / L * 0.02, nz = dx / L * 0.02;
      const poly = [{ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }];
      const s = rmSurface(id, label, 'vertical', hi, poly, { lo, legal: false, reason: 'vertical', seg: { a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } } });
      surfaces.push(s); walls.push(s); continue;
    }
    let y = Number.isFinite(pl.y) ? pl.y : pts.reduce((t, p) => t + p.y, 0) / pts.length;
    const poly = pts.map((p) => ({ x: p.x, z: p.z }));
    let s;
    if (label === 'floor') s = rmSurface(id, label, 'floor', y, poly, { lo: y });
    else if (label === 'ceiling') s = rmSurface(id, label, 'ceiling', y, poly, { lo: y, legal: false, reason: 'ceiling' });
    else if (pl.part === 'back' || label === 'couch back') s = rmSurface(id, label, 'back', y, poly, { legal: false, reason: 'back' });
    else if (RM_NOT_SEAT.indexOf(label) >= 0) s = rmSurface(id, label, 'object', y, poly, { legal: false, reason: 'not_a_seat' });
    else if (RM_VERTICAL.indexOf(label) >= 0) s = rmSurface(id, label, 'vertical', y, poly, { legal: false, reason: 'vertical' });
    else {
      const kind = label === 'couch' ? 'seat' : label === 'bed' ? 'bed' : label === 'table' ? 'table' : label === 'storage' ? 'shelf' : 'perch';
      s = legalAbove(rmSurface(id, label, kind, y, poly));
      if (y - floorY < LIM.lowH) { s.kind = 'rug'; s.lo = y; }
    }
    s.src = 'plane';
    surfaces.push(s);
  }
  // ---- meshes (AABB). Review fixes (W1 MUST 1, SHOULD 1 + 4):
  //  * a mesh that has a horizontal PLANE of the same label over its footprint (Quest sends a couch / bed as both): the
  //    plane is the real seat / mattress and always wins; the mesh never becomes a surface and never covers the plane:
  //    only the part of its footprint OUTSIDE the plane(s) (couch back / arms, headboard) becomes forbidden volume.
  //  * couch mesh without a plane: back = the long side nearest a wall (planes or wall meshes, within 0.6 m), else the
  //    side away from the viewer.
  //  * 'other' meshes (Meta's unclassified volumes: a bag, a box, a person) are obstacles only, never a perch.
  const wallSegs = [];
  for (const w of walls) wallSegs.push(w.seg);
  // mesh floor outline: the host's oriented footprint when sent (rotated couch / bed), else the world AABB
  const meshFp = (m, mn, mx) => (Array.isArray(m.footprint) && m.footprint.length >= 3
    ? m.footprint.map((p) => { const q = rmPt(p); return { x: q.x, z: q.z }; }) : rmRect(mn.x, mn.z, mx.x, mx.z));
  for (const m of Array.isArray(opts.meshes) ? opts.meshes : []) {
    if (!m || !m.min || !m.max || RM_VERTICAL.indexOf(roomLabel(m.label)) < 0) continue;
    const r = meshFp(m, rmPt(m.min), rmPt(m.max));
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) wallSegs.push({ a: r[j], b: r[i] });
  }
  const wallD = (p, q) => { // smallest distance from side p-q (3 points) to any wall segment
    let d = Infinity;
    for (const w of wallSegs) for (let k = 0; k <= 2; k++) {
      const x = p.x + (q.x - p.x) * k / 2, z = p.z + (q.z - p.z) * k / 2, e = rmSegD2(x, z, w.a, w.b); if (e < d) d = e;
    }
    return Math.sqrt(d);
  };
  for (const m of Array.isArray(opts.meshes) ? opts.meshes : []) {
    if (!m || !m.min || !m.max) continue;
    const id = m.id != null ? String(m.id) : 'm' + (n++), label = roomLabel(m.label);
    if (label === 'global mesh' || label === 'floor' || label === 'ceiling') continue;
    const mn = rmPt(m.min), mx = rmPt(m.max), top = mx.y, fp = meshFp(m, mn, mx);
    if (RM_VERTICAL.indexOf(label) >= 0) {
      surfaces.push(rmSurface(id, label, 'vertical', top, fp, { lo: mn.y, legal: false, reason: 'vertical' })); continue;
    }
    if (RM_NOT_SEAT.indexOf(label) >= 0) { surfaces.push(rmSurface(id, label, 'object', top, fp, { lo: mn.y, legal: false, reason: 'not_a_seat' })); continue; }
    // mate = a same-label horizontal plane within the mesh's height whose CENTRE lies inside the mesh footprint (re-review
    // SHOULD 1: a neighbouring couch / an L sectional made of two meshes cannot steal another mesh's seat plane)
    const mates = surfaces.filter((s) => {
      if (s.src !== 'plane' || s.label !== label || s.kind === 'vertical' || s.kind === 'floor' || s.kind === 'ceiling') return false;
      if (s.y < mn.y - 0.05 || s.y > top + 0.05) return false;
      const c = rmCen(s.poly); return rmPip(fp, c.x, c.z);
    });
    if (mates.length) {
      // Re-review MUST 1 (rotated couch / bed): the WHOLE mesh volume (footprint polygon, mesh min y .. top) stays a
      // forbidden obstacle for every surface (floor, tables, ...) EXCEPT its mate plane(s), which skip it. Its top is the
      // footprint minus the mates' real polygons (`holes`, not their bounding boxes): ray casts, toss landings and bonks
      // see the seat / mattress through it; the backrest / headboard / rim part is forbidden at any yaw.
      const reason = label === 'couch' ? 'back' : label === 'bed' ? 'headboard' : 'rim';
      surfaces.push(rmSurface(id + ':' + reason, label, label === 'couch' ? 'back' : 'object', top, fp,
        { lo: mn.y, legal: false, reason, holes: mates.map((s) => s.poly), skip: mates.map((s) => s.id) }));
      continue;
    }
    if (label === 'other') { surfaces.push(rmSurface(id, label, 'object', top, fp, { lo: mn.y, legal: false, reason: 'unknown' })); continue; }
    if (label === 'couch' && top - mn.y > 0.6) {
      // seat = the 65 % of the depth on the front side at a typical seat height; the rear 35 % strip = the BACK (forbidden).
      // Back = the long side nearest a wall when one is within 0.6 m (and clearly nearer), else the side away from the viewer.
      // Worked in the footprint's own frame (oriented 4-corner footprint or the AABB): Q0-Q1 = a long side, Q0-Q3 = depth.
      const P = fp.length === 4 ? fp : (() => { const b = rmBox(fp); return rmRect(b.x0, b.z0, b.x1, b.z1); })();
      const Q = rmHd(P[0], P[1]) >= rmHd(P[0], P[3]) ? P : [P[0], P[3], P[2], P[1]];
      const at = (u, t) => {
        const ax = Q[0].x * (1 - u) + Q[1].x * u, az = Q[0].z * (1 - u) + Q[1].z * u, bx = Q[3].x * (1 - u) + Q[2].x * u, bz = Q[3].z * (1 - u) + Q[2].z * u;
        return { x: ax * (1 - t) + bx * t, z: az * (1 - t) + bz * t };
      };
      const quad = (t0, t1) => [at(0, t0), at(1, t0), at(1, t1), at(0, t1)];
      const seatY = mn.y + 0.45, c = rmCen(Q), dvx = Q[3].x - Q[0].x, dvz = Q[3].z - Q[0].z;
      const dLo = wallD(Q[0], Q[1]), dHi = wallD(Q[3], Q[2]);
      const byWall = Math.min(dLo, dHi) <= 0.6 && Math.abs(dLo - dHi) > 0.1;
      const front = byWall ? dLo < dHi : (viewer.x - c.x) * dvx + (viewer.z - c.z) * dvz >= 0; // front = the Q3 side
      const seat = front ? quad(0.35, 1) : quad(0, 0.65), back = front ? quad(0, 0.35) : quad(0.65, 1);
      surfaces.push(legalAbove(rmSurface(id + ':seat', label, 'seat', seatY, seat, { lo: mn.y })));
      surfaces.push(rmSurface(id + ':back', label, 'back', top, back, { lo: mn.y, legal: false, reason: 'back' }));
      continue;
    }
    const kind = label === 'couch' ? 'seat' : label === 'bed' ? 'bed' : label === 'table' ? 'table' : label === 'storage' ? 'shelf' : 'perch';
    surfaces.push(legalAbove(rmSurface(id, label, kind, top, fp, { lo: mn.y })));
  }
  // ---- floor / rug
  let rug = false;
  if (!surfaces.some((s) => s.kind === 'floor')) {
    const c = { x: viewer.x + fw.x * LIM.rugAhead, z: viewer.z + fw.z * LIM.rugAhead }, h = LIM.rugSize / 2;
    surfaces.push(rmSurface('rug', 'rug', 'floor', floorY, rmRect(c.x - h, c.z - h, c.x + h, c.z + h), { lo: floorY, virtual: true }));
    rug = true;
  }
  for (const s of surfaces) if (s.lo == null) s.lo = floorY;
  surfaces.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // ---- obstacles, size checks, samples, spots
  for (const s of surfaces) {
    if (!s.legal) continue;
    const w = s.bb.x1 - s.bb.x0, d = s.bb.z1 - s.bb.z0;
    if (s.kind !== 'floor' && (w < LIM.minSide || d < LIM.minSide)) { s.legal = false; s.reason = 'too_small'; continue; }
    for (const o of surfaces) {
      if (o === s || o.kind === 'ceiling' || o.kind === 'floor' || o.kind === 'rug') continue;
      if (o.skip && o.skip.indexOf(s.id) >= 0) continue; // a couch / bed mesh never blocks its own seat / mattress plane
      const lo = o.lo, hi = o.kind === 'vertical' ? o.y : o.y;
      if (hi > s.y + 0.02 && lo < s.y + LIM.bodyH) s.obs.push({ id: o.id, poly: o.poly, bb: o.bb });
    }
    const step = rmArea(s.poly) > LIM.bigArea ? LIM.gridBig : LIM.grid;
    for (let x = s.bb.x0 + step / 2; x <= s.bb.x1; x += step) for (let z = s.bb.z0 + step / 2; z <= s.bb.z1; z += step) {
      const px = Math.round(x * 1e4) / 1e4, pz = Math.round(z * 1e4) / 1e4;
      if (rmLegal(s, px, pz, LIM.catR)) s.samples.push({ x: px, z: pz });
    }
    if (!s.samples.length) { s.legal = false; s.reason = 'too_small'; continue; }
    const kind = s.kind === 'floor' || s.kind === 'rug' ? 'floor' : s.kind === 'seat' || s.kind === 'bed' ? 'nap' : 'perch';
    for (const p of s.samples) if (s.spots.every((q) => rmHd(p, q) >= LIM.spotGap)) s.spots.push({ x: p.x, z: p.z, kind });
    s.nap = Object.prototype.hasOwnProperty.call(ROOM_NAP_RANK, s.kind) ? ROOM_NAP_RANK[s.kind] : -1;
  }
  // ---- hop links between legal surfaces
  const legal = surfaces.filter((s) => s.legal), edges = [];
  for (const A of legal) for (const B of legal) {
    if (A === B) continue;
    const up = B.y - A.y;
    if (up > LIM.maxUp || -up > LIM.maxDrop) continue;
    const cand = [];
    for (const a of A.samples) {
      let best = null, bd = Infinity;
      for (const b of B.samples) { const dd = rmHd(a, b); if (dd < bd) { bd = dd; best = b; } }
      if (bd <= LIM.maxGap && (Math.abs(up) > 0.05 || bd > 0.05)) cand.push({ a, b: best, d: Math.round(bd * 1e4) / 1e4 });
    }
    cand.sort((p, q) => p.d - q.d || p.a.x - q.a.x || p.a.z - q.a.z);
    const pairs = [];
    for (const c of cand) { if (pairs.length >= LIM.edgePairs) break; if (pairs.every((p) => rmHd(p.a, c.a) >= LIM.edgePairGap)) pairs.push(c); }
    if (pairs.length) edges.push({ from: A.id, to: B.id, up: Math.round(up * 1e4) / 1e4, gap: pairs[0].d, pairs });
  }
  // ---- box spot: the legal floor point closest to 0.6 m in front of the viewer
  const floor = legal.find((s) => s.kind === 'floor') || null;
  let box = null;
  if (floor) {
    const want = { x: viewer.x + fw.x * LIM.boxAhead, z: viewer.z + fw.z * LIM.boxAhead };
    let bd = Infinity; for (const p of floor.samples) { const dd = rmHd(p, want); if (dd < bd) { bd = dd; box = { surf: floor.id, x: p.x, y: floor.y, z: p.z }; } }
  }
  const room = { version: ROOM_VERSION, floorY, viewer, forward: fw, rug, floor: floor ? floor.id : null, surfaces, edges, box, byId: {} };
  for (const s of surfaces) room.byId[s.id] = s;
  return room;
}

/** surface by id (or null) */
export function roomSurface(room, id) { return (room && room.byId[id]) || null; }
/** is (x, z) inside surface `id`'s top (polygon minus holes; no margin, legal or not)? */
export function roomInside(room, id, x, z) { const s = roomSurface(room, id); return !!s && rmTop(s, x, z); }
/** legal surfaces only */
export function roomLegalSurfaces(room) { return room.surfaces.filter((s) => s.legal); }
/** may a cat's feet be at (x, z) on surface `id`? margin defaults to ROOM_LIMITS.catR */
export function roomLegalAt(room, id, x, z, margin = ROOM_LIMITS.catR) { return rmLegal(roomSurface(room, id), x, z, margin); }
/** straight walk from p to q on surface `id` stays legal (checked every 5 cm) */
export function roomLineLegal(room, id, p, q, margin = ROOM_LIMITS.catR) {
  const s = roomSurface(room, id); if (!s || !s.legal) return false;
  const d = rmHd(p, q), k = Math.max(1, Math.ceil(d / 0.05));
  for (let i = 0; i <= k; i++) { const t = i / k; if (!rmLegal(s, p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t, margin)) return false; }
  return true;
}
/** hop links out of surface `id` that a cat with limits { up, gap, drop? } can do; each keeps only the pairs within `gap` */
function rmCache(room) { let m = RM_HOPS.get(room); if (!m) { m = new Map(); RM_HOPS.set(room, m); } return m; }
export function roomHops(room, id, lim = {}) {
  const up = lim.up != null ? lim.up : ROOM_LIMITS.maxUp, gap = lim.gap != null ? lim.gap : ROOM_LIMITS.maxGap, drop = lim.drop != null ? lim.drop : ROOM_LIMITS.maxDrop;
  const cache = rmCache(room), key = 'h|' + id + '|' + up + '|' + gap + '|' + drop, hit = cache.get(key);
  if (hit) return hit;
  const out = [];
  for (const e of room.edges) {
    if (e.from !== id || e.up > up || -e.up > drop) continue;
    const pairs = e.pairs.filter((p) => p.d <= gap);
    if (pairs.length) out.push({ from: e.from, to: e.to, up: e.up, gap: pairs[0].d, pairs });
  }
  cache.set(key, out);
  return out;
}
/** shortest surface route (fewest hops, BFS, deterministic order) from surface `from` to `to` for a cat with limits; [] when
 *  already there, null when unreachable. Result = the list of hop links to take. */
export function roomRoute(room, from, to, lim = {}) {
  if (from === to) return [];
  const cache = rmCache(room), key = 'r|' + from + '|' + to + '|' + lim.up + '|' + lim.gap + '|' + lim.drop;
  if (cache.has(key)) return cache.get(key);
  const r = rmRoute(room, from, to, lim); cache.set(key, r); return r;
}
function rmRoute(room, from, to, lim) {
  const prev = {}; prev[from] = null; const q = [from];
  while (q.length) {
    const cur = q.shift();
    for (const e of roomHops(room, cur, lim)) {
      if (Object.prototype.hasOwnProperty.call(prev, e.to)) continue;
      prev[e.to] = e; if (e.to === to) { const path = []; let k = to; while (prev[k]) { path.unshift(prev[k]); k = prev[k].from; } return path; }
      q.push(e.to);
    }
  }
  return null;
}
/** every spot of a kind ('floor' | 'perch' | 'nap'; omitted = all) as { surf, x, y, z, kind, nap } */
export function roomSpots(room, kind) {
  const out = [];
  for (const s of room.surfaces) if (s.legal) for (const p of s.spots) if (!kind || p.kind === kind) out.push({ surf: s.id, x: p.x, y: s.y, z: p.z, kind: p.kind, nap: s.nap });
  return out;
}
/** nap spots in preference order: couch seat, bed, then floor / rug; ties by distance to the viewer */
export function roomNapSpots(room) {
  const v = room.viewer, out = roomSpots(room).filter((p) => p.nap >= 0);
  out.sort((a, b) => a.nap - b.nap || rmHd(a, v) - rmHd(b, v) || a.x - b.x || a.z - b.z);
  return out;
}
/** Safe landing for a cat dropped / tossed at p = {x, y, z}: the HIGHEST legal surface at or below p.y whose legal
 *  footprint contains (x, z); else the nearest sample of a legal surface at or below p.y (horizontal distance first);
 *  else the nearest floor sample. Returns { surf, x, y, z }. */
export function roomNearestLegal(room, p, margin = ROOM_LIMITS.catR) {
  let best = null, any = false; // no filtered copies: called per laser / wand / treat frame
  for (const s of room.surfaces) if (s.legal && s.y <= p.y + 1e-6) { any = true; if ((!best || s.y > best.y) && rmLegal(s, p.x, p.z, margin)) best = s; }
  if (best) return { surf: best.id, x: p.x, y: best.y, z: p.z };
  let bd = Infinity, bq = null;
  for (const s of room.surfaces) {
    if (!s.legal || (any ? s.y > p.y + 1e-6 : (s.kind !== 'floor' && s.kind !== 'rug'))) continue;
    for (const q of s.samples) {
      const dx = q.x - p.x, dz = q.z - p.z, dy = p.y - s.y, dd = dx * dx + dz * dz + 0.1 * dy * dy;
      if (dd < bd) { bd = dd; best = s; bq = q; }
    }
  }
  return best ? { surf: best.id, x: bq.x, y: best.y, z: bq.z } : null;
}
/** Ray (origin o, direction d) against the HORIZONTAL surfaces (legal or not): the first hit { surf, legal, x, y, z, t } or
 *  null. For the finger laser dot (the host may also ray-cast the real mesh and pass that point instead). */
export function roomRaycast(room, o, d) {
  let best = null;
  if (!(Math.abs(d.y) > 1e-9)) return null;
  for (const s of room.surfaces) {
    if (s.kind === 'vertical') continue;
    const t = (s.y - o.y) / d.y; if (!(t > 0) || (best && t >= best.t)) continue;
    const x = o.x + d.x * t, z = o.z + d.z * t;
    if (rmTop(s, x, z)) best = { surf: s.id, legal: s.legal, x, y: s.y, z, t };
  }
  return best;
}
/** Stable hash of the derived room (surfaces, legality, samples, edges) for replay / regression tests. */
export function roomHash(room) {
  let h = 0x811c9dc5;
  const mix = (v) => { h ^= v & 0xff; h = Math.imul(h, 0x01000193); h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193); };
  const num = (x) => mix(Math.round(x * 1e4) | 0), str = (s) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(0xff); };
  for (const s of room.surfaces) { str(s.id); str(s.kind); str(s.reason || ''); num(s.y); mix(s.legal ? 1 : 0); mix(s.samples.length); for (const p of s.spots) { num(p.x); num(p.z); } }
  for (const e of room.edges) { str(e.from); str(e.to); num(e.up); num(e.gap); mix(e.pairs.length); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

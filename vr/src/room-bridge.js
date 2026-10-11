/* vr/src/room-bridge.js - W2: the WebXR / IWSDK host side of the room sim (plan 2.3, 2.9 host contract).
   Gaming Engineer 2, 2026-10-09.
   Three layers, top two PURE (node-tested in vr/test/room-bridge.test.mjs):
     1. Scene -> room input: planeToRoom / meshToRoom / buildRoomInput turn WebXR planes (polygon in plane space + pose
        matrix) and meshes (vertices in mesh space + pose matrix) into createRoom() input in WORLD metres: oriented mesh
        footprints (the convex hull of the mesh's local box corners after the pose: a yawed couch stays couch-sized),
        world AABBs, labels as Meta sends them. 'global mesh' is skipped before touching its vertices.
     2. Gestures -> roomcat events (gestureToRoomEvents) and roomcat state -> billboards (catsToBillboards: position,
        yaw, view with hysteresis, tilt, pose, contact-shadow y on the surface below).
     3. createRoomBridge(): the runtime. observe() collects the scene until it settles (or the no-scan fallback timer
        runs out -> virtual rug), start() creates the deterministic session, frame(dt, handSamples, camera) runs the
        fixed 60 Hz steps (loop.js) and sends a `move` for EVERY tracked hand on EVERY tracked frame (plan 2.9), then
        returns the billboards. The room is FROZEN once the session starts (a re-scan mid-session is counted, DEV-logged
        and applied on the next session), so seed + log replays bit-for-bit.
   readWebXRScene / readHands read the STANDARD WebXR objects (XRFrame.detectedPlanes / detectedMeshes / getPose,
   XRHand + fillPoses / getJointPose), not IWSDK's ECS components, so this file has no @iwsdk/core import and the exact
   XRPlane / XRMesh component field names (unverified: the docs were unreachable from the team shells) do not matter.
   Logs: none here; the host passes `onLog` and gates it behind import.meta.env.DEV (Legal section 10). */
import { createRoom, roomRaycast, roomSurface } from '../../game/core/room.js';
import { createRoomSession, ROOMCAT_SIZES, ROOMCAT_TUNING } from '../../game/core/roomcat.js';
import { createFixedLoop, STEP_MS } from '../../game/core/loop.js';
import { createGestureState, gestureStep, JOINTS } from './gestures.js';
import { pickCatView, billboardYaw } from './cat-views.js';
import { placeBasket, createWandState, wandStep, wandView } from './wand.js';
import { createProgress, progressStep, createHintState, hintStep, soundCues, createCaptionState, captionStep } from './hints.js';
import { buildEndCard, endCardDue } from './end-card.js';
import { rememberSession, spotsForRoom } from './return-visit.js';
import { createDirector, directorRoute, directorStep, ltStep, ltCatRecords, ltDot, offerRing, pointRay, startLaserTag, HAPPY_TUNING, DIRECTOR_TEXT } from './director.js';
import { createHudMenu, hudMenuStep, hudToolEvents, hudFilterEvents, createLaserGate, laserGateFilter, hudStats, HUD_ACTIONS, HUD_CAPTIONS } from './hud-menu.js';
const HUD_ACTION_LABEL = Object.fromEntries(HUD_ACTIONS.map((a) => [a.id, a.label]));
const HUD_ACTION_TIP = Object.fromEntries(HUD_ACTIONS.map((a) => [a.id, a.tip]));
import { createFx, fxStep } from './fx.js';
import { HINTS_SLICE, HINT_TUNING_SLICE } from './hints.js';

export const BRIDGE_VERSION = 6; // 6: SK-HUD quick-stat strip + action menu (hud-menu.js): controller ray + trigger / hand ray + pinch / poke pick the tool; hand-aware laser off
                                 // // 5: head events to roomcat (CH M1). 2: laser clipped by walls / furniture sides, box pinch 0.15 m, treat view gate, input hint
                                 // 3 (W3): posture-aware treat (floorY), feather wand + basket, onboarding hints + captions, end card
                                 // 4 (P0a slice): roomcat v2 events collected per step (simEvents), the director (Happiness meter,
                                 //    celebration, Laser Tag beat on game/core/lasertag-room.js with the Play sim frozen) and fx
                                 //    (squash / stretch, particles, sound + haptic cues) run every frame; slice hint pacing
export const BRIDGE_TUNING = Object.freeze({
  settleS: 1.0,       // the scene must be unchanged this long before the room is built (planes refine for a while)
  noScanS: 3.0,       // nothing detected after this -> virtual rug (plan 1.1, never dead-end)
  maxWaitS: 8.0,      // a scene that keeps changing is used anyway after this
  prebuildMoveM: 0.15, // start() reuses the half-settle prebuild only if the head moved less than this since it was built ...
  prebuildTurnDeg: 12, // ... and turned less than this (createRoom places the box / rug / couch front from the viewer: Code Review CB M1)
  hands: ['left', 'right'],
  laserMaxM: 6,       // the finger laser ray reaches this far
  boxPinchM: 0.15,    // a NEW pinch opens the box only this close to its lid (roomcat's own rule is 0.3 m: pinches in the
                      // 0.15..0.3 m ring are swallowed here so a stray pinch near the box cannot pop it open)
  hintAfterS: 2.0,    // controllers tracked and no hands for this long -> "Put your controllers down" hint
  headMoveM: 0.1, headTurnDeg: 15, // a { type: 'head' } event goes to roomcat (logged) when the head moved / turned this much (Review CH M1)
  headFlatMin: 0.35,  // the gaze's flat (xz) length must be at least this (pitch shallower than ~70 deg) to count as a forward for the head
                      // event; looking steeply down the xz part is noise, so the LAST GOOD forward is kept and only the move rule can fire (CK M1)
  shadowMaxDrop: 2.5, // contact shadow fades out over this drop (airborne / carried cats)
});

// ---------------------------------------------------------------- 1. scene -> room input (pure)

/** p' = M * p for a column-major 4x4 (WebXR / three.js layout), w = 1. */
export function transformPoint(m, p) {
  if (!m) return { x: p.x, y: p.y, z: p.z };
  return {
    x: m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
    y: m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
    z: m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
  };
}

/** Convex hull (x, z) of points, counter-clockwise (monotone chain); 3+ points in, degenerate input returns what it can. */
export function hullXZ(points) {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z)).map((p) => ({ x: p.x, z: p.z }));
  pts.sort((a, b) => a.x - b.x || a.z - b.z);
  const uniq = [];
  for (const p of pts) if (!uniq.length || Math.abs(p.x - uniq[uniq.length - 1].x) > 1e-9 || Math.abs(p.z - uniq[uniq.length - 1].z) > 1e-9) uniq.push(p);
  if (uniq.length < 3) return uniq;
  const cross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lower = [];
  for (const p of uniq) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) { const p = uniq[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * One WebXR plane -> room.js plane. plane = { id, label (semanticLabel), orientation, polygon: [{x,y,z}] in PLANE space
 * (y = 0, the plane's normal is +y), matrix: 16 numbers (plane pose in local-floor) }. Returns null for junk.
 */
export function planeToRoom(plane) {
  if (!plane || !Array.isArray(plane.polygon) || plane.polygon.length < 3) return null;
  const polygon = plane.polygon.map((p) => transformPoint(plane.matrix, p));
  let orientation = plane.orientation;
  if (orientation !== 'horizontal' && orientation !== 'vertical') {
    // derive from the transformed normal when the API did not say
    const n = plane.matrix ? { x: plane.matrix[4], y: plane.matrix[5], z: plane.matrix[6] } : { x: 0, y: 1, z: 0 };
    orientation = Math.abs(n.y) > 0.7 ? 'horizontal' : 'vertical';
  }
  const out = { id: String(plane.id), label: plane.label || plane.semanticLabel || '', orientation, polygon };
  if (plane.part) out.part = plane.part;
  return out;
}

/**
 * One WebXR mesh -> room.js mesh with a WORLD AABB and an ORIENTED footprint. mesh = { id, label, vertices (Float32Array
 * or number[], xyz triples in MESH space), matrix (mesh pose) }. The local AABB of the vertices is the mesh's oriented box;
 * its 8 corners after the pose give the world AABB (min / max) and, projected on (x, z), the hull = footprint.
 * Returns null for 'global mesh' (room.js ignores it; its vertex list is huge) or an empty mesh.
 */
export function meshToRoom(mesh) {
  if (!mesh) return null;
  const label = String(mesh.label || mesh.semanticLabel || '');
  if (label.toLowerCase().replace(/[_\-\s]/g, '') === 'globalmesh') return null;
  const v = mesh.vertices;
  if (!v || v.length < 3) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!(x1 >= x0)) return null;
  const corners = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) corners.push(transformPoint(mesh.matrix, { x, y, z }));
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const c of corners) { for (const k of ['x', 'y', 'z']) { if (c[k] < min[k]) min[k] = c[k]; if (c[k] > max[k]) max[k] = c[k]; } }
  const footprint = hullXZ(corners);
  const out = { id: String(mesh.id), label, min, max };
  if (footprint.length >= 3) out.footprint = footprint;
  return out;
}

/**
 * createRoom() input from a scene snapshot { planes, meshes } (raw WebXR-shaped, see above) plus the viewer's head
 * position / forward (world) and floorY.
 */
export function buildRoomInput(scene, viewer, forward, floorY) {
  const planes = [], meshes = [];
  for (const p of (scene && scene.planes) || []) { const r = planeToRoom(p); if (r) planes.push(r); }
  for (const m of (scene && scene.meshes) || []) { const r = meshToRoom(m); if (r) meshes.push(r); }
  const fw = forward && Number.isFinite(forward.x) && Number.isFinite(forward.z) && (forward.x || forward.z) ? { x: forward.x, z: forward.z } : { x: 0, z: -1 };
  return {
    planes, meshes,
    floorY: Number.isFinite(floorY) ? floorY : 0,
    viewer: { x: viewer && Number.isFinite(viewer.x) ? viewer.x : 0, z: viewer && Number.isFinite(viewer.z) ? viewer.z : 0 },
    forward: fw,
  };
}

/** Scene settle = "nothing in the room has MOVED, GROWN or APPEARED since the last accepted snapshot", judged with a tolerance,
 *  never by bins and never by the runtime's bookkeeping (lastChangedTime / ids): IWER re-stamps its planes every frame (CI #10:
 *  the old id + lastChangedTime key changed every frame = 8 s 'timeout' every run) and a Quest pose can carry sub-mm noise (a
 *  rounded / binned key flips at every bin edge: Review BZ M1). sceneSignature(scene) -> per object { tag, label, orientation,
 *  n, pos, basis, bounds, centroid } (plane: polygon count + plane-space bounds + centroid; mesh: vertex count + mesh-space
 *  bounds + centroid; pose from the matrix). sceneDiffers(accepted, next, tol) is true when the counts differ, or any object of
 *  `next` has no still-unmatched partner in `accepted` with the same tag / label / orientation / count whose pos, bounds and
 *  centroid all stay within tol.posM (2 cm) and whose basis stays within tol.rotSin (0.05 = ~3 degrees per axis vector).
 *  The bridge re-anchors (accepts the new snapshot + restarts the settle clock) ONLY on a difference, so jitter around any value
 *  never counts, while a slow creep DOES count once its cumulative drift from the ACCEPTED snapshot exceeds the tolerance
 *  (documented choice: 1 mm/frame creep re-anchors at the ~20th frame, then again 20 frames later, so a plane that keeps
 *  sliding never settles; a plane that stops does, 1 s after its last re-anchor). Real refinements (growth / move >= 2 cm, a
 *  new or dropped plane, a new label) restart the settle as before; the 8 s / 3 s fallbacks are unchanged. */
export const SCENE_TOL = Object.freeze({ posM: 0.02, rotSin: 0.05 });
export function sceneSignature(scene) {
  const bounds3 = (each) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity, sx = 0, sy = 0, sz = 0, k = 0;
    each((x, y, z) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; sx += x; sy += y; sz += z; k++; });
    return k ? { bounds: [x0, y0, z0, x1, y1, z1], centroid: [sx / k, sy / k, sz / k], k } : { bounds: null, centroid: null, k: 0 };
  };
  const sig = (o, tag) => {
    const m = o.matrix && o.matrix.length >= 16 ? o.matrix : null;
    const g = o.polygon ? bounds3((f) => { for (const v of o.polygon) f(v.x, v.y, v.z); })
      : o.vertices ? bounds3((f) => { const a = o.vertices; for (let i = 0; i + 2 < a.length; i += 3) f(a[i], a[i + 1], a[i + 2]); }) : bounds3(() => {});
    return { tag, label: String(o.label || ''), orientation: String(o.orientation || ''), n: o.polygon ? o.polygon.length : o.vertices ? o.vertices.length : 0,
      pos: m ? [m[12], m[13], m[14]] : null, basis: m ? [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]] : null, bounds: g.bounds, centroid: g.centroid };
  };
  const planes = ((scene && scene.planes) || []).map((o) => sig(o, 'p')), meshes = ((scene && scene.meshes) || []).map((o) => sig(o, 'm'));
  return planes.concat(meshes);
}
/** True when `next` is not the same room as `accepted` within tol (see above). Either may be null (= differs unless both are). */
export function sceneDiffers(accepted, next, tol = SCENE_TOL) {
  if (!accepted || !next) return accepted !== next;
  if (accepted.length !== next.length) return true;
  const within = (a, b, e) => { if (a === b) return true; if (!a || !b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= e)) return false; return true; };
  const same = (a, b) => a.tag === b.tag && a.label === b.label && a.orientation === b.orientation && a.n === b.n &&
    within(a.pos, b.pos, tol.posM) && within(a.basis, b.basis, tol.rotSin) && within(a.bounds, b.bounds, tol.posM) && within(a.centroid, b.centroid, tol.posM);
  const used = new Array(accepted.length).fill(false);
  for (const o of next) {
    let hit = -1;
    for (let i = 0; i < accepted.length; i++) if (!used[i] && same(accepted[i], o)) { hit = i; break; }
    if (hit < 0) return true;
    used[hit] = true;
  }
  return false;
}
// ---------------------------------------------------------------- 2. gestures -> events, state -> billboards (pure)

/** Ray (o, d) vs the vertical quad above segment a-b between heights lo and hi: the ray parameter t at the crossing, or null. */
function rayVsWall(o, d, a, b, lo, hi) {
  const ex = b.x - a.x, ez = b.z - a.z;
  const den = d.x * ez - d.z * ex;
  if (Math.abs(den) < 1e-12) return null; // parallel to the wall
  const wx = a.x - o.x, wz = a.z - o.z;
  const t = (wx * ez - wz * ex) / den;
  const u = (wx * d.z - wz * d.x) / den;
  if (!(t > 1e-9) || u < 0 || u > 1) return null;
  const y = o.y + d.y * t;
  return y >= lo - 1e-9 && y <= hi + 1e-9 ? t : null;
}

/**
 * Nearest ray parameter t at which (o, d) runs into a VERTICAL surface of the room: a wall plane (its segment, lo..hi) or
 * the side of any mesh-derived surface (a volume: lo < y, each footprint edge from lo to its top; plane surfaces are thin
 * and never block). Horizontal tops are
 * roomRaycast's job. Returns Infinity when nothing is in the way. Pure (W2 review SHOULD 4).
 */
export function roomRayBlock(room, o, d) {
  let best = Infinity;
  if (!room || !o || !d) return best;
  for (const s of room.surfaces) {
    if (s.kind === 'vertical' && s.seg) {
      const t = rayVsWall(o, d, s.seg.a, s.seg.b, Number.isFinite(s.lo) ? s.lo : -Infinity, s.y);
      if (t != null && t < best) best = t;
      continue;
    }
    // volumes = mesh-derived surfaces (lo = the mesh's bottom). Plane surfaces get lo = floorY from room.js but are thin.
    if (s.src === 'plane' || s.virtual || !Number.isFinite(s.lo) || !(s.y - s.lo > 0.02) || !Array.isArray(s.poly) || s.poly.length < 3) continue;
    // a couch / bed mesh with a mate plane (room.js `skip`): its sides only block up to the seat / mattress height, so a
    // ray aimed at the seat from across the room passes over the couch front (roomRaycast then sees the seat through the hole)
    let hi = s.y;
    if (Array.isArray(s.skip) && s.skip.length) { let m = Infinity; for (const id of s.skip) { const q = roomSurface(room, id); if (q && q.y < m) m = q.y; } if (Number.isFinite(m) && m > s.lo) hi = Math.min(hi, m); }
    for (let i = 0; i < s.poly.length; i++) {
      const t = rayVsWall(o, d, s.poly[i], s.poly[(i + 1) % s.poly.length], s.lo, hi);
      if (t != null && t < best) best = t;
    }
  }
  return best;
}

/**
 * Map one gestures.js event to roomcat events. ctx = { room, laserMaxM, box } (room for the laser ray cast; box = the
 * current roomcat box state for the pinch gate). The laser dot is the first horizontal-surface hit of the finger ray
 * (roomRaycast) within laserMaxM that is not behind a wall or a furniture side (roomRayBlock); no hit, blocked, or the
 * ceiling = laser off (a forbidden top, e.g. the couch back, still gets a dot: roomcat chases the nearest legal point).
 * A pinch that starts within roomcat's 0.3 m box-open sphere but farther than boxPinchM from the lid is NOT forwarded
 * (its moves still are), so only a pinch right at the lid opens the box. Returns an array (0..n events).
 */
export function gestureToRoomEvents(ev, ctx) {
  const hand = ev.hand;
  switch (ev.type) {
    case 'move': return [{ type: 'move', hand, p: ev.p }];
    case 'pinch_start': {
      const box = ctx && ctx.box;
      if (box && box.landed && !box.open && ev.p) {
        const lid = { x: box.x, y: box.y + ROOMCAT_TUNING.boxH, z: box.z }; // the lid roomcat's own 0.3 m rule measures from
        const dx = ev.p.x - lid.x, dy = ev.p.y - lid.y, dz = ev.p.z - lid.z, dd = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const tight = (ctx && ctx.boxPinchM) || BRIDGE_TUNING.boxPinchM;
        if (dd <= 0.3 && dd > tight) return [];
      }
      return [{ type: 'pinch', hand, p: ev.p }];
    }
    case 'pinch_release': return [{ type: 'release', hand, v: ev.v || { x: 0, y: 0, z: 0 } }];
    case 'point_start': case 'point_hold': {
      const room = ctx && ctx.room;
      const hit = room && ev.origin && ev.dir ? roomRaycast(room, ev.origin, ev.dir) : null;
      const max = (ctx && ctx.laserMaxM) || BRIDGE_TUNING.laserMaxM;
      const surf = hit && roomSurface(room, hit.surf);
      if (hit && hit.t <= max && surf && surf.kind !== 'ceiling' && hit.t <= roomRayBlock(room, ev.origin, ev.dir)) return [{ type: 'laser', on: true, hand, p: { x: hit.x, y: hit.y, z: hit.z } }];
      return [{ type: 'laser', on: false, hand }];
    }
    case 'point_end': return [{ type: 'laser', on: false, hand }];
    case 'palm_start': return [{ type: 'treat', on: true, hand, p: ev.p }];
    case 'palm_end': return [{ type: 'treat', on: false, hand }];
    case 'pet_start': case 'pet_hold': return [{ type: 'pet', hand, p: ev.p }];
    default: return [];
  }
}

/** The point a palm strokes on a cat (its back) for gesture targets. */
export function catBackPoint(c) {
  const h = (ROOMCAT_SIZES[c.size] || ROOMCAT_SIZES.kitten).h;
  return { x: c.x, y: c.y + h * 0.8, z: c.z, id: c.id };
}

/**
 * roomcat state -> billboard records. camera = head { x, y, z }; prevViews = { [catId]: view } from the last frame
 * (hysteresis). Returns { cats: [...], views: { [id]: view } }. Each cat: { id, x, y, z, yaw, view, sprite, flipX,
 * rotDeg, tiltDeg, pose, mode, poof, purr, airborne, size, shadow: { y, alpha } | null }.
 * The contact shadow sits on the surface straight below the cat (ray down over the room's horizontal surfaces), so a
 * hopping / carried cat still casts on the floor or table under it (no-hover). Over nothing = no shadow.
 */
export function catsToBillboards(state, room, camera, prevViews) {
  const views = {}, cats = [];
  if (!state) return { cats, views };
  const down = { x: 0, y: -1, z: 0 };
  for (const c of state.cats) {
    if (c.mode === 'inbox') continue; // still in the box: nothing to draw yet
    const pv = pickCatView(c, camera, prevViews ? prevViews[c.id] || null : null);
    views[c.id] = pv.view;
    let shadow = null;
    if (c.support && c.support !== 'hand' && !c.airborne) {
      const s = roomSurface(room, c.support);
      shadow = { y: s ? s.y : c.y, alpha: 1 };
    } else {
      const hit = roomRaycast(room, { x: c.x, y: c.y + 0.001, z: c.z }, down);
      if (hit) shadow = { y: hit.y, alpha: Math.max(0, 1 - (c.y - hit.y) / BRIDGE_TUNING.shadowMaxDrop) };
    }
    cats.push({
      id: c.id, size: c.size, x: c.x, y: c.y, z: c.z, yaw: billboardYaw(c, camera),
      view: pv.view, sprite: pv.sprite, flipX: pv.flipX, rotDeg: pv.rotDeg, tiltDeg: pv.tiltDeg,
      pose: c.pose, mode: c.mode, poof: !!c.poof, purr: !!c.purr, airborne: !!c.airborne, bond: c.bond, shadow,
    });
  }
  return { cats, views };
}

// ---------------------------------------------------------------- 3. WebXR readers (browser only; thin, no logic)

/**
 * Snapshot the standard WebXR scene from a frame: planes { id, label, orientation, polygon (plane space), matrix,
 * lastChangedTime } and meshes { id, label, vertices (mesh space), matrix, lastChangedTime }. Objects without a pose this
 * frame are skipped. ids come from `ids` (a WeakMap the caller keeps so an XRPlane keeps its id across frames).
 */
export function readWebXRScene(frame, refSpace, ids) {
  const planes = [], meshes = [];
  if (!frame || !refSpace) return { planes, meshes };
  const idOf = (obj, tag) => { let id = ids.get(obj); if (!id) { id = tag + (ids.n = (ids.n || 0) + 1); ids.set(obj, id); } return id; };
  const detPlanes = frame.detectedPlanes, detMeshes = frame.detectedMeshes;
  if (detPlanes && typeof detPlanes.forEach === 'function') detPlanes.forEach((pl) => {
    const pose = pl.planeSpace && frame.getPose(pl.planeSpace, refSpace);
    if (!pose || !pl.polygon) return;
    planes.push({ id: idOf(pl, 'p'), label: pl.semanticLabel || '', orientation: pl.orientation, polygon: Array.from(pl.polygon, (q) => ({ x: q.x, y: q.y, z: q.z })), matrix: pose.transform.matrix, lastChangedTime: pl.lastChangedTime });
  });
  if (detMeshes && typeof detMeshes.forEach === 'function') detMeshes.forEach((m) => {
    const label = m.semanticLabel || '';
    if (label.toLowerCase().replace(/[_\-\s]/g, '') === 'globalmesh') return; // never copy the room mesh
    const pose = m.meshSpace && frame.getPose(m.meshSpace, refSpace);
    if (!pose || !m.vertices) return;
    meshes.push({ id: idOf(m, 'm'), label, vertices: m.vertices, matrix: pose.transform.matrix, lastChangedTime: m.lastChangedTime });
  });
  return { planes, meshes };
}

/** What the session is tracking right now: { hands, controllers } counts over session.inputSources (pure over a fake). */
export function inputKinds(session) {
  const k = { hands: 0, controllers: 0 };
  if (!session || !session.inputSources) return k;
  for (const src of session.inputSources) { if (src.hand) k.hands++; else if (src.targetRayMode === 'tracked-pointer' || src.gamepad) k.controllers++; }
  return k;
}

/** "Put your controllers down - use your hands" hint state: update(kinds, t) -> true while the hint should show (controllers
 *  tracked and no hand for hintAfterS). Pure data; the host shows / hides the text on the transitions. */
export function createInputHint(afterS) {
  const h = { show: false, since: null, afterS: Number.isFinite(afterS) ? afterS : BRIDGE_TUNING.hintAfterS };
  h.update = (kinds, t) => {
    const bad = !!kinds && kinds.hands === 0 && kinds.controllers > 0;
    if (!bad) { h.since = null; h.show = false; return false; }
    if (h.since == null) h.since = t;
    h.show = t - h.since >= h.afterS;
    return h.show;
  };
  h.reset = () => { h.since = null; h.show = false; };
  return h;
}
export const CONTROLLER_HINT = 'Put your controllers down - use your hands';

const JOINT_COUNT = JOINTS.length;
/**
 * Hand samples for gestures.js from a frame: [{ hand: 'left' | 'right', t, joints }] for every TRACKED hand (an untracked
 * hand is absent). Uses XRFrame.fillPoses (one call per hand) when available, else getJointPose per joint. `scratch` is a
 * reusable { poses: Float32Array(25 * 16) } the caller keeps.
 */
export function readHands(frame, refSpace, t, scratch) {
  const out = [];
  if (!frame || !refSpace || !frame.session) return out;
  for (const src of frame.session.inputSources) {
    if (!src.hand) continue;
    const hand = src.handedness === 'left' ? 'left' : 'right';
    const joints = {};
    let ok = true;
    if (typeof frame.fillPoses === 'function') {
      if (!scratch.poses) scratch.poses = new Float32Array(JOINT_COUNT * 16);
      if (!scratch.spaces) scratch.spaces = {};
      let spaces = scratch.spaces[hand];
      if (!spaces || spaces.src !== src) { spaces = { src, list: JOINTS.map((n) => src.hand.get(n)) }; scratch.spaces[hand] = spaces; }
      if (spaces.list.some((s) => !s)) ok = false;
      else {
        try { ok = frame.fillPoses(spaces.list, refSpace, scratch.poses) !== false; } catch (e) { ok = false; }
        if (ok) for (let i = 0; i < JOINT_COUNT; i++) {
          const o = i * 16, x = scratch.poses[o + 12], y = scratch.poses[o + 13], z = scratch.poses[o + 14];
          if (!Number.isFinite(x) || (x === 0 && y === 0 && z === 0)) { ok = false; break; } // fillPoses writes NaN / 0 for untracked
          joints[JOINTS[i]] = { x, y, z };
        }
      }
    } else if (typeof frame.getJointPose === 'function') {
      for (const n of JOINTS) {
        const space = src.hand.get(n), pose = space && frame.getJointPose(space, refSpace);
        if (!pose) { ok = false; break; }
        const p = pose.transform.position; joints[n] = { x: p.x, y: p.y, z: p.z };
      }
    } else ok = false;
    if (ok) out.push({ hand, t, joints });
  }
  return out;
}

// ---------------------------------------------------------------- 4. runtime

/**
 * createRoomBridge({ seed, cats, size, arc, onLog, tuning, roster, visit, names, persisted, leftHanded, memory }) -> bridge.
 *   memory = the kitten memory loaded by the host (return-visit.js readMemory): remembered kittens head to their favourite
 *   spot at nap time; with the end card the result carries `memory` = the memory to save (rememberSession).
 *   bridge.observe(scene, viewer, forward, floorY, t)   every frame BEFORE start(): collects the scene; sets bridge.ready
 *   bridge.start()                                       builds the room + session (room frozen from here); returns room
 *   bridge.frame(dt, handSamples, camera, gaze, floorY)  after start(): gestures -> wand -> events (+ a move per tracked hand),
 *                                                        fixed steps, billboards, progress -> hint / caption, end card.
 *                                                        Returns { cats, views, state, events, wand, hint, hintChanged, caption,
 *                                                        captionChanged, endCard, memory (with the end card, else null) }. gaze (unit head direction, optional) +
 *                                                        floorY gate the treat: palm in view + above the posture-aware lap line.
 *   bridge.dispose()                                     drops the session / room / gesture state (the host builds a NEW bridge for
 *                                                        the next XR session: new local-floor origin = fresh scan)
 *   bridge.room / bridge.session / bridge.state / bridge.ready / bridge.rescans / bridge.gestures (per hand)
 */
export function createRoomBridge(opts = {}) {
  const T = Object.assign({}, BRIDGE_TUNING, opts.tuning || {});
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
  const b = {
    ready: false, reason: null, room: null, session: null, state: null, rescans: 0, roomInput: null,
    sceneChanges: 0, // observe(): how often the accepted snapshot was re-anchored before start() (smoke diagnostic: why 'timeout' / late 'settled')
    gestures: {}, views: {}, loop: createFixedLoop({ stepMs: STEP_MS, maxStepsPerFrame: 5, maxFrameMs: 250 }),
    // W3: wand / hints / captions / end card (all plain data from the pure modules)
    wand: null, progress: createProgress(), hints: createHintState(), captions: createCaptionState(), hint: null, caption: null, endCard: null, memory: null, time: 0,
    // P0a slice: the director (game beats + meter + Laser Tag) and fx (juice, particles, cues); slice = the 3-minute pacing
    director: null, fx: null, slice: opts.slice !== false, simEvents: [], ltCats: [], ltViews: {},
    _firstT: null, _accepted: null, _keyT: null, _lastScene: null, _lastViewer: null, _lastForward: null, _lastFloorY: 0, _liveAccepted: null,
    hud: null, _hudHead: { p: null, fwd: null }, _hudMerge: [], _laserGate: createLaserGate(), _hudTctx: { head: null, floorY: 0, targets: null, grabs: null, dt: 0, forceLaser: false }, _hudEnabled: { laser_tag: false },
    _scratch: {}, _prevState: null, _fxPrev: null, _gest: [], _empty: [], _ltState: { cats: [] }, _prebuilt: null, prebuilt: false, _headSent: null, _headFwd: { x: 0, z: -1 },
  };
  for (const h of T.hands) b.gestures[h] = createGestureState(h);

  b.observe = (scene, viewer, forward, floorY, t) => {
    const sig = sceneSignature(scene);
    const n = sig.length;
    // after start(): only a host that keeps calling observe() (session-life.js does not today) feeds `rescans`; log only, the room stays frozen
    if (b.session) { if (sceneDiffers(b._liveAccepted, sig)) { b._liveAccepted = sig; b.rescans++; if (onLog) onLog(`room changed mid-session (${n} objects), applied on the next session`); } return; }
    if (b._firstT == null) b._firstT = t;
    if (sceneDiffers(b._accepted, sig)) { b._accepted = sig; b._keyT = t; b.sceneChanges++; } // re-anchor only on a real change (tolerance, no bins)
    b._lastScene = scene; b._lastViewer = viewer; b._lastForward = forward; b._lastFloorY = floorY;
    const since = t - b._firstT, stable = t - b._keyT;
    if (n > 0 && stable >= T.settleS) { b.ready = true; b.reason = 'settled'; }
    else if (n === 0 && since >= T.noScanS) { b.ready = true; b.reason = 'no_scan'; }
    else if (since >= T.maxWaitS) { b.ready = true; b.reason = 'timeout'; }
    // perf (CI #11 frame 8: 254 ms at settle): build the room + session (createRoom + the detour grids = ~35 ms cold on x86, more on
    // the Quest) SPECULATIVELY halfway through the settle second, on a scan frame where nothing else happens, keyed on the accepted
    // snapshot; start() reuses it when the snapshot is still the same, so the first gameplay frame pays nothing for the room. A
    // re-anchor drops the speculation (one build per accepted snapshot, never more often than every settleS / 2).
    if (!b.ready && n > 0 && stable >= T.settleS * 0.5 && !(b._prebuilt && b._prebuilt.sig === b._accepted)) b._prebuilt = buildRoomAndSession(b._accepted);
  };
  /** CB M1: the prebuild is only the room of the pose it was built from; reuse it if the head has not moved / turned since */
  function prebuildFresh(pre) {
    if (!pre || pre.sig == null || pre.sig !== b._accepted) return false;
    const v0 = pre.input.viewer, v1 = b._lastViewer || { x: 0, z: 0 };
    if (Math.hypot((v1.x || 0) - v0.x, (v1.z || 0) - v0.z) >= T.prebuildMoveM) return false;
    const f0 = pre.input.forward, f1 = b._lastForward && (b._lastForward.x || b._lastForward.z) ? b._lastForward : { x: 0, z: -1 };
    const l0 = Math.hypot(f0.x, f0.z) || 1, l1 = Math.hypot(f1.x, f1.z) || 1;
    const cos = (f0.x * f1.x + f0.z * f1.z) / (l0 * l1);
    return cos >= Math.cos(T.prebuildTurnDeg * Math.PI / 180);
  }

  /** the room + the deterministic session for the LAST observed scene (pure of bridge state: observe() prebuilds, start() applies) */
  function buildRoomAndSession(sig) {
    const input = buildRoomInput(b._lastScene || { planes: [], meshes: [] }, b._lastViewer, b._lastForward, b._lastFloorY);
    const room = createRoom(input);
    // W4 kitten memory (return-visit.js): a remembered kitten heads to its favourite spot in THIS room (matched by label)
    let cats = opts.cats == null ? 3 : opts.cats;
    if (opts.memory && Array.isArray(cats)) {
      const fav = spotsForRoom(opts.memory, room, cats.map((c) => (c && c.id != null ? String(c.id) : '')));
      cats = cats.map((c) => (c && fav[c.id] ? Object.assign({}, c, { napSurf: fav[c.id] }) : c));
    }
    const session = createRoomSession({ room, seed: opts.seed == null ? 1 : opts.seed, cats, size: opts.size || 'kitten', arc: opts.arc !== false });
    return { sig, input, room, session };
  }

  b.start = () => {
    const pre = prebuildFresh(b._prebuilt) ? b._prebuilt : buildRoomAndSession(b._accepted); // same scene AND same head pose (< 0.15 m, < 12 deg), else a fresh build (the old cost, never a stale box)
    b.prebuilt = pre === b._prebuilt; // diagnostic: the speculative build was used
    b._prebuilt = null;
    const input = pre.input;
    b.roomInput = input;
    b.room = pre.room;
    b._liveAccepted = b._accepted;
    b.session = pre.session;
    b.loop.reset();
    b.state = b.session.state();
    b.time = 0; b.progress = createProgress(); b.hints = createHintState(); b.captions = createCaptionState(); b.hint = null; b.caption = null; b.endCard = null; b.memory = null; b._prevState = null;
    b.wand = createWandState(placeBasket(b.room, input.viewer, input.forward, input.floorY, !!opts.leftHanded));
    b.director = createDirector({ room: b.room, seed: opts.seed == null ? 1 : opts.seed, viewer: input.viewer, forward: input.forward });
    b.fx = createFx(opts.seed == null ? 1 : opts.seed);
    b.hud = createHudMenu(); b._laserGate = createLaserGate(); // SK-HUD: a fresh menu per session (tool = Laser)
    b.simEvents = []; b.ltCats = []; b.ltViews = {}; b._fxPrev = null; b._headSent = null; b._headFwd.x = input.forward.x; b._headFwd.z = input.forward.z;
    if (onLog) {
      const legal = b.room.surfaces.filter((s) => s.legal).map((s) => `${s.kind}:${s.label}`).join(', ');
      onLog(`room built (${b.reason}): ${input.planes.length} planes, ${input.meshes.length} meshes${b.room.rug ? ', virtual rug' : ''}; legal: ${legal || 'none'}`);
    }
    return b.room;
  };

  /** dt seconds; handSamples from readHands (or tests); camera head { x, y, z }; gaze unit direction (optional); floorY
   *  (optional: the treat's lap line is posture-aware with it, seated without it) */
  const EMPTY = Object.freeze({ cats: [], views: {}, state: null, events: [], simEvents: [], wand: null, hint: null, hintChanged: false, caption: null, captionChanged: false, endCard: null, memory: null, fx: null, director: null });
  b.frame = (dt, handSamples, camera, gaze, floorY, hudIn) => {
    if (!b.session) return EMPTY;
    b.time += dt;
    const D = b.director, route = directorRoute(D);
    const targets = b.state ? b.state.cats.filter((c) => c.mode !== 'inbox' && c.support !== 'hand').map(catBackPoint) : [];
    const ctx = { room: b.room, laserMaxM: T.laserMaxM, boxPinchM: T.boxPinchM, box: b.state && b.state.box };
    const view = camera && Number.isFinite(camera.y) ? { head: camera, gaze: gaze || null, floorY: Number.isFinite(floorY) ? floorY : undefined } : null;
    // the viewer's flat forward (for the wand's feather direction): from the gaze, else the room's build forward
    let fwd = b.roomInput ? b.roomInput.forward : { x: 0, z: -1 };
    if (gaze && (Math.abs(gaze.x) > 1e-6 || Math.abs(gaze.z) > 1e-6)) fwd = { x: gaze.x, z: gaze.z };
    const wctx = { room: b.room, forward: fwd, t: b.time };
    const events = [], gest = b._gest; gest.length = 0;
    // CH M1: the player's body for roomcat (keep-out column, "in front of you" curiosity stop): a logged head event on the first frame
    // and whenever the head moved headMoveM or turned headTurnDeg since the last one (not every frame: the log stays small)
    if (route !== 'lt' && camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
      const hs = b._headSent;
      // the forward: the flat gaze when it is long enough to mean a direction (CK M1), else the last good one (the build forward at first)
      const flatOk = !gaze || Math.hypot(gaze.x, gaze.z) >= T.headFlatMin;
      let fx, fz;
      if (flatOk) { const fl = Math.hypot(fwd.x, fwd.z) || 1; fx = fwd.x / fl; fz = fwd.z / fl; b._headFwd.x = fx; b._headFwd.z = fz; }
      else { fx = b._headFwd.x; fz = b._headFwd.z; }
      if (!hs || Math.hypot(camera.x - hs.x, camera.z - hs.z) >= T.headMoveM || fx * hs.fx + fz * hs.fz < Math.cos(T.headTurnDeg * Math.PI / 180)) {
        if (!hs) b._headSent = { x: camera.x, z: camera.z, fx, fz }; else { hs.x = camera.x; hs.z = camera.z; hs.fx = fx; hs.fz = fz; } // (no per-frame allocation: the event itself is the only object, and only on a change)
        events.push({ type: 'head', p: { x: camera.x, y: Number.isFinite(camera.y) ? camera.y : 0, z: camera.z }, f: { x: fx, z: fz } });
      }
    }
    const byHand = {};
    for (const s of handSamples || []) if (s && b.gestures[s.hand]) byHand[s.hand] = s;
    // SK-HUD: the quick-stat strip + action menu. hudIn = { sources: { left, right } (hud-menu.js source shape), hide, wristToggle }
    // from the host (main.js reads the WebXR input sources); null = no HUD this frame (tests / old hosts: the bridge runs as before)
    let hm = null;
    const srcs = hudIn && hudIn.sources ? hudIn.sources : null;
    if (b.hud && srcs && camera) {
      for (const h of T.hands) { const sc = srcs[h]; if (sc && sc.kind === 'hand' && !sc.tip && byHand[h] && byHand[h].joints) sc.tip = byHand[h].joints['index-finger-tip'] || null; }
      b._hudHead.p = camera; b._hudHead.fwd = fwd;
      b._hudEnabled.laser_tag = D.mode === 'offer' || D.mode === 'scorecard';
      hm = hudMenuStep(b.hud, { t: b.time, dt, head: b._hudHead, sources: srcs, hide: !!b.endCard || !!hudIn.hide, wristToggle: !!hudIn.wristToggle, enabled: b._hudEnabled });
      for (const e of hm.events) if (e.type === 'command' && e.action === 'laser_tag' && (D.mode === 'offer' || D.mode === 'scorecard')) startLaserTag(D);
      const tc = b._hudTctx; tc.forceLaser = route === 'lt'; tc.head = b._hudHead; // GO1 SHOULD 1: in Laser Tag the controller trigger aims the dot whatever the tool
       tc.floorY = b.roomInput ? b.roomInput.floorY : 0; tc.targets = targets; tc.dt = dt;
      tc.grabs = b.state && b.hud.active === 'toss' ? b.state.cats.filter((c) => c.mode !== 'inbox' && c.mode !== 'carried').map((c) => ({ x: c.x, y: c.y + (ROOMCAT_SIZES[c.size] || ROOMCAT_SIZES.kitten).scruff, z: c.z })) : null;
    }
    for (const h of T.hands) {
      const r = gestureStep(b.gestures[h], byHand[h] || null, targets, null, view);
      b.gestures[h] = r.state;
      let hev = r.events;
      if (hm) { // the active tool's events join the hand's own, then the menu's suppression (the menu click never reaches a cat)
        const m = b._hudMerge; let k = 0;
        for (const e of r.events) m[k++] = e;
        for (const e of hudToolEvents(b.hud, h, srcs[h] || null, b._hudTctx)) m[k++] = e;
        m.length = k;
        hev = hudFilterEvents(b.hud, m);
      }
      for (const ev of hev) {
        gest.push(ev);
        if (route === 'lt') continue; // Laser Tag: the Play sim is frozen; the point ray goes to lasertag-room below
        // the wand sees every gesture first: a pinch at its handle picks it up (that pinch is not a scruff / box pinch)
        const w = wandStep(b.wand, ev, wctx);
        b.wand = w.state;
        for (const we of w.events) events.push(we);
        if (w.consumed) continue;
        for (const re of gestureToRoomEvents(ev, ctx)) events.push(re); // the Play laser stays live while Laser Tag is offered (review BB S1): the floor ring is the start target
      }
    }
    const simEvents = b.simEvents; simEvents.length = 0;
    const n = b.loop.advance(dt * 1000);
    let bb;
    if (route === 'lt') {
      // Laser Tag steps on the same fixed loop; Play is frozen (not stepped, not fed); its kittens are the crowd
      ltStep(D, n, pointRay(gest));
      const crowd = b._ltState.cats; crowd.length = 0;
      let shown = 0;
      for (const c of b.state.cats) { if (c.mode === 'inbox') continue; if (shown++ >= HAPPY_TUNING.crowdMax) break; crowd.push(c.mode === 'carried' || c.mode === 'onhand' || c.airborne ? c : Object.assign({}, c, { mode: 'idle', pose: 'sit' })); }
      for (const c of ltCatRecords(D, b.ltCats)) crowd.push(c);
      bb = catsToBillboards(b._ltState, b.room, camera || { x: 0, y: 1.2, z: 0 }, b.views);
    } else {
      b.wand = wandStep(b.wand, null, wctx).state; // time-only rules (a dropped wand returns to the basket)
      laserGateFilter(b._laserGate, events); // roomcat has ONE dot: an off from the hand that does not own it is dropped (Review row 451)
      if (n > 0) {
        b.session.step(events); // all of this frame's events apply on its first step (logged with that tick)
        for (const ev of b.session.events) simEvents.push(ev);
        for (let i = 1; i < n; i++) { b.session.step(); for (const ev of b.session.events) simEvents.push(ev); }
        b.state = b.session.state();
      } else if (events.length) {
        for (const e of events) b.session.push(e); // no step this frame: queue for the next one (no event is dropped)
      }
      bb = catsToBillboards(b.state, b.room, camera || { x: 0, y: 1.2, z: 0 }, b.views);
    }
    b.views = bb.views;
    // P0a: the director (meter, celebration, offer, Laser Tag round flow) then fx (juice, particles, sound + haptic cues)
    directorStep(D, { dt, t: b.time, state: b.state, prevState: b._fxPrev, simEvents: route === 'lt' ? b._empty : simEvents, gestureEvents: gest, nSteps: n, head: camera || null, fwd });
    const dotNow = route === 'lt' ? ltDot(D) : b.state.laser; // the dot's lit / dim edges count in the fx limiter (review BF MUST 1)
    fxStep(b.fx, { dt, t: b.time, state: b.state, prevState: b._fxPrev, simEvents: route === 'lt' ? b._empty : simEvents, cats: bb.cats, celebrate: D.celebrate, extra: D.extra, dot: dotNow, dotReserve: route === 'lt' ? 2 : 1 });
    D.extra.length = 0;
    b._fxPrev = b.state;
    // W3: what the player has done -> the onboarding hint; sound cues -> caption; the end card once due
    b.progress = progressStep(b.progress, events, b.state, simEvents);
    const hr = hintStep(b.hints, Object.assign({ t: b.time, phase: b.state.phase, box: b.state.box }, b.progress), b.slice ? HINT_TUNING_SLICE : undefined, b.slice ? HINTS_SLICE : undefined);
    b.hints = hr.state;
    // the hint line: Laser Tag HUD > the offer / again line > the onboarding hint
    const before = b.hint;
    const dmode = D.mode;
    if (dmode === 'playing' && D.hud) b.hint = { id: 'lt_hud', text: D.hud, anchor: 'head' };
    else if (dmode === 'countdown') b.hint = { id: 'lt_goal', text: 'Keep the dot alive!', anchor: 'head' };
    else if (D.hintLine) b.hint = { id: 'director', text: D.hintLine, anchor: 'head' }; // "turn around" / "had enough" (GDXE Build 2)
    else if (dmode === 'offer') b.hint = { id: 'lt_offer', text: DIRECTOR_TEXT.offer, anchor: 'head' };
    else if (dmode === 'scorecard' || dmode === 'celebrate') b.hint = null;
    else b.hint = hr.hint;
    const hintChanged = (before && before.text) !== (b.hint && b.hint.text);
    const cues = n > 0 ? soundCues(b.state, b._prevState) : [];
    if (hm) for (const e of hm.events) { // SK-HUD captions: the picked tool / a greyed tile (captions only, no sound)
      const line = e.type === 'tool' ? HUD_ACTION_LABEL[e.action] + ': ' + HUD_ACTION_TIP[e.action] : e.type === 'blocked' ? HUD_CAPTIONS.blocked : null;
      if (line) { b.captions = Object.assign({}, b.captions, { text: null, since: null }); cues.unshift(line); }
    }
    if (D.caption) { b.captions = Object.assign({}, b.captions, { text: null, since: null }); cues.unshift(D.caption); } // a moment ("Gotcha!", "Whisker-close! +N") beats a sound caption at once
    const cr = captionStep(b.captions, cues, b.time, b.slice ? HINT_TUNING_SLICE : undefined);
    b.captions = cr.state; b.caption = cr.caption;
    if (n > 0) b._prevState = b.state;
    if (!b.endCard && route !== 'lt' && endCardDue(b.state, b.time)) { // never inside a Laser Tag round (review BB S2)
      b.endCard = buildEndCard({ state: b.state, room: b.room, roster: opts.roster || b.state.cats.map((c) => c.id), visit: opts.visit || 1, names: opts.names, persisted: opts.persisted === true, playedS: b.time });
      // W4: the memory to SAVE (new object: yesterday's memory + this session's bond gains, first-met visit, nap spot as
      // kind + label words only); the host writes it with return-visit.js writeMemory (main.js, at the end card)
      b.memory = rememberSession(opts.memory || null, b.state, b.room, opts.visit || 1, opts.roster || b.state.cats.map((c) => c.id));
      if (onLog) onLog('end card');
    }
    const dir = { mode: dmode, route, meter: D.meter.value, meterFull: D.meter.full, celebrate: D.celebrate, scorecard: D.scorecard, hud: D.hud, dot: route === 'lt' ? dotNow : null, ring: offerRing(D), best: D.best, round: D.ltRound };
    const hud = hm ? { visual: hm.visual, events: hm.events, haptics: hm.haptics, stats: hudStats(dir, b.state, b.hud.active) } : null;
    return { cats: bb.cats, views: bb.views, state: b.state, events, simEvents, wand: route === 'lt' ? null : wandView(b.wand), hint: b.hint, hintChanged, caption: b.caption, captionChanged: cr.changed, endCard: b.endCard, memory: b.memory, fx: b.fx, director: dir, hud };
  };

  b.openBox = () => { if (b.session) b.session.openBox(); };
  b.dispose = () => {
    b.session = null; b.room = null; b.state = null; b.roomInput = null; b.ready = false; b.reason = null; b.disposed = true;
    b._firstT = null; b._accepted = null; b._keyT = null; b._lastScene = null; b._liveAccepted = null; b.views = {}; b._prebuilt = null;
    b.wand = null; b.hint = null; b.caption = null; b.endCard = null; b.memory = null; b._prevState = null; b._fxPrev = null; b.time = 0;
    b.director = null; b.fx = null; b.hud = null; b.simEvents.length = 0; b.ltCats.length = 0;
    for (const h of T.hands) b.gestures[h] = createGestureState(h);
  };
  return b;
}

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
import { createFeatherPop } from './ports/feather-pop.js';   // SK-PORT (Q-GE2 wiring, owner yes 2026-10-11 05:06 UTC): QUEST-PORT-WIRING B
import { createYarnTug } from './ports/yarn-tug.js';         // QUEST-PORT-WIRING C
import { createKittenNeeds } from './ports/kitten-needs.js'; // QUEST-PORT-WIRING D
import { createRoomSession, ROOMCAT_SIZES, ROOMCAT_TUNING } from '../../game/core/roomcat.js';
import { createFixedLoop, STEP_MS } from '../../game/core/loop.js';
import { createGestureState, gestureStep, JOINTS } from './gestures.js';
import { pickCatView, billboardYaw } from './cat-views.js';
import { placeBasket, createWandState, wandStep, wandView, createFurnitureState, furnitureAdd, furnitureRemove, furnitureStep, furnitureMeshes, furnitureFloor, furnitureRugFrame, furnitureSave, furnitureRestore, furnitureReclamp } from './wand.js';
import { createProgress, progressStep, createHintState, hintStep, soundCues, createCaptionState, captionStep } from './hints.js';
import { buildEndCard, endCardDue } from './end-card.js';
import { rememberSession, spotsForRoom } from './return-visit.js';
import { createDirector, directorRoute, directorStep, ltStep, ltCatRecords, ltDot, offerRing, pointRay, startLaserTag, HAPPY_TUNING, DIRECTOR_TEXT } from './director.js';
import { createHudMenu, hudMenuStep, hudToolEvents, hudFilterEvents, createLaserGate, laserGateFilter, hudStats, hudPickCat, hudSetHint, HUD_ACTIONS, HUD_CAPTIONS, HUD_BLOCKED } from './hud-menu.js';
import { createTipCard, tipCardStep } from './hints.js';
import { createGamesMaster, gmEventsFromRoom, gmEventsFromLaserTag, GM_DIRECTOR } from '../../game/core/gm-director.js'; // Q-GE2: the Games Master hosts the Quest build
import { createPlaySuggester } from '../../game/core/gmplay.js'; //: his room suggestions (B4)
import { createPrng } from '../../game/core/prng.js';
const HUD_ACTION_LABEL = Object.fromEntries(HUD_ACTIONS.map((a) => [a.id, a.label]));
const HUD_ACTION_TIP = Object.fromEntries(HUD_ACTIONS.map((a) => [a.id, a.tip]));
import { createFx, fxStep } from './fx.js';
import { HINTS_SLICE, HINT_TUNING_SLICE } from './hints.js';

export const BRIDGE_VERSION = 9; // 9 (Q-GE2/113): the Games Master hosts (gamesmaster.js + gmplay.js + the sneeze notice + the Oni stalk), result.gm
                                 // 8 (Q-GE2 SK-PORT wiring): Feather Pop + Yarn Tug HUD commands (grey-out rules, per-action blocked captions, the
                                 //    feather owns the roomcat laser dot while it runs), Kitten Needs bars + a rate-limited hint on the strip
                                 // 7 7 (GE2-B, the owner's Quest test 2026-10-11): every accepted pet lands (the event carries the kitten's back
                                 //    point), distance petting (hand pinch / controller grip + ray), a kitten SEATED on the other open palm or on
                                 //    a controller (pet it there, set down gently), purr haptics on the petting controller, the tip card (tip-card.js)
                                 // 6: SK-HUD quick-stat strip + action menu (hud-menu.js): controller ray + trigger / hand ray + pinch / poke pick the tool; hand-aware laser off
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
  // GE2-B: hold a kitten in your hand (Owner #3) + distance petting + purr haptics
  seatR: 0.16,        // a pinched kitten let go with her feet this close (sideways) over the other OPEN palm (facing up) sits on it ...
  seatAbove: 0.3, seatBelow: 0.08, // ... and her feet between seatBelow under and seatAbove over the palm
  seatUpOn: 0.35, seatUpOff: 0.1, seatLostS: 0.35, seatMaxS: 40, // palm-up hysteresis; the palm turned over / gone this long = set her down
  seatLift: 0.01, ctlSeatLift: 0.04, // her feet sit this far over the palm / the controller grip
  downV: 0.8,         // set down: she is lowered at this speed (m/s) to the surface under her, then let go 2 cm over it (no drop, no toss)
  seatPetR: 0.2,      // a free hand / controller this close to a seated kitten's body pets her
  sqGrabM: 0.25,      // controller grip (squeeze) this close to a kitten's scruff picks her up (she sits on the controller)
  rayPetR: 0.3,       // hand pinch / controller grip that grabs nothing: the kitten within this of the ray is petted while it holds
  grabNearM: 0.12,    // a hand pinch this close to a scruff is a grab (never a distance pet)
  petHapEveryS: 0.14, petHap: 0.35, petHapMs: 45, // the purr rumble on a petting controller (and the one holding her)
  // SK-PORT (Q-GE2): Yarn Tug picks the nearest awake, free kitten IN FRONT within this; the Kitten Needs hint changes at most once per needsHintS
  tugPickM: 3.0, needsHintS: 8, tugEndS: 2,
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
    // GE2-B root cause: roomcat purrs only within petR (0.25 m) of the kitten's back, measured from THIS point. The palm the
    // gesture accepted could be farther (petFar 0.35 while holding, a hand over her), so pet_hold reached roomcat and nothing
    // happened. The gesture's target point (q = the back it is stroking) is what roomcat gets, so an accepted pet always lands.
    case 'pet_start': case 'pet_hold': { const q = ev.q && Number.isFinite(ev.q.x) ? ev.q : null; return [{ type: 'pet', hand, p: q ? { x: q.x, y: q.y, z: q.z } : ev.p }]; }
    default: return [];
  }
}

/** Q-GE2 grown cats (owner Quest list 2026-10-11 #4 "no grown cats"): 1-2 ADULTS from the starter roster join the day's kittens
 *  (legal: starter / house cats only; the roster passed in is Design's starter set). Pure + deterministic: seed + visit
 *  pick how many and which; taken from the END of the roster (the next days' new kittens come from its front), never a cat already
 *  in today's list; a full roster day makes the last cat grown instead. roomcat runs them on ROOMCAT_SIZES.adult (brief speeds) and
 *  makes them calmer (adultJoinS / adultCdX, no zoomies). No adult atlas art yet: the hook draws the kitten art at scale (adult
 *  height / kitten height) with a calmer cycle: fpsX on the speed clock (bigger stride), idleFpsX on the other anims. */
export const GROWN_TUNING = Object.freeze({ scale: 1.7, fpsX: 1 / 1.7, idleFpsX: 0.75, min: 1, max: 2, pool: 3 });
/** Q-GE2 adult art (Design 2026-10-12): how to draw a cat of `size`. A grown cat whose kitten has M.cats[id].adultId in the
 *  atlas draws that adult art at root scale 1.0 (the adult sheets are already drawn ~1.7x the kitten) with the adult animOverride
 *  fps (applied inside the atlas, so fpsX / idleFpsX = 1); without adultId it falls back to the kitten art x GROWN_TUNING.scale with
 *  the slower cycle. Pure; atlas = createAtlas(...) or null. Returns { artId, scale, fpsX, idleFpsX, adultArt }. */
export function grownArtFor(atlas, id, size) {
  const grown = size === 'adult', ad = grown && atlas && typeof atlas.adultIdOf === 'function' ? atlas.adultIdOf(id) : null;
  if (ad) return { artId: ad, scale: 1, fpsX: 1, idleFpsX: 1, adultArt: true };
  if (grown) return { artId: id, scale: GROWN_TUNING.scale, fpsX: GROWN_TUNING.fpsX, idleFpsX: GROWN_TUNING.idleFpsX, adultArt: false };
  return { artId: id, scale: 1, fpsX: 1, idleFpsX: 1, adultArt: false };
}
export function grownMix(cats, roster, seed, visit) {
  const T = GROWN_TUNING;
  const list = (cats || []).map((c) => (c && typeof c === 'object' ? Object.assign({}, c) : { id: String(c), size: 'kitten' }));
  const ids = (roster || []).map((r) => String(r && r.id != null ? r.id : r));
  let h = (Math.imul((Number(seed) || 0) >>> 0, 2654435761) ^ Math.imul((Number(visit) || 1) >>> 0, 40503)) >>> 0;
  const rnd = () => { h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return h / 4294967296; };
  const n = T.min + Math.floor(rnd() * (T.max - T.min + 1));
  const have = new Set(list.map((c) => String(c.id)));
  const free = ids.filter((id) => !have.has(id)).slice(-T.pool);
  let added = 0;
  while (added < n && free.length) { list.push({ id: free.splice(Math.floor(rnd() * free.length), 1)[0], size: 'adult' }); added++; }
  if (!added && list.length > 1) list[list.length - 1].size = 'adult';
  return list;
}

/** The point a palm strokes on a cat (its back) for gesture targets. */
export function catBackPoint(c) {
  const h = (ROOMCAT_SIZES[c.size] || ROOMCAT_SIZES.kitten).h;
  return { x: c.x, y: c.y + h * 0.8, z: c.z, id: c.id };
}

/**
 * roomcat state -> billboard records. camera = head { x, y, z }; prevViews = { [catId]: view } from the last frame
 * (hysteresis). Returns { cats: [...], views: { [id]: view } }. Each cat: { id, x, y, z, yaw, view, sprite, flipX,
 * rotDeg, tiltDeg, pose, mode, poof, purr, airborne, size, shadow: { y, alpha } | null, speed (m/s, eased; NaN if the state
 * has none), tell ({ phase, n, s } | null, the state's own object), stalk ('freeze' | 'burst' | null) } (Q-GE2 gait render).
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
      speed: Number.isFinite(c.speed) ? c.speed : NaN, tell: c.tell || null, stalk: c.stalk || null,
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
 * createRoomBridge({ seed, cats, size, arc, onLog, tuning, roster, visit, names, persisted, leftHanded, memory, furniture, saveFurniture }) -> bridge.
 *   furniture = the saved furniture (visit-store.js readFurniture, whitelisted): put on the PLAY RUG's cells at the
 *   first start() whose room has the play rug; saveFurniture(f) (optional) is called with wand.js furnitureSave whenever the
 *   rug list changes and no piece is held (scanned room = no rug = never called).
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
// ---------------------------------------------------------------- Q-GE2/113: the Games Master hosts the Quest build
/* He pads in GM_HOST_TUNING.arriveS after the kittens are out (roomcat phase 'play') and hosts through game/core/gamesmaster.js
   (the pack's cues: intro, the arc laser rules, Laser Tag rules / countdown / commentary / celebrate / rest offer, the pre-sneeze
   notice, B4 room suggestions from game/core/gmplay.js), and announces Feather Pop / Yarn Tug (GM_HOST_TEXT line 1 over the
   port's own start line). Captions take the caption slot only when nothing else speaks this frame (> hints > beats > him).
   Sneeze (plan 17.3): the director's sneezer; Calm sneezes ON by default; the notice card comes FIRST and no sneeze plays
   until it is answered ("Keep calm sneezes" = default focus). The choice is SESSION-ONLY: kept on this bridge for the page, never
   written to storage (Legal 10.4 would need the #privacy line change first).
   Oni mask emote (owner 2026-10-10 ~01:0x + ~00:0x item 7): only while he is OUT OF the player's view, he puts the mask on and
   walks SLOWLY toward the player, stopping at the distance ring (drawn on the floor); the moment the player turns to him (or he
   reaches the ring) the mask comes off at once and he walks off the other way. At most ONCE per session; never in safety /
   rest / countdown / Laser Tag / a port game / the notice / a sneeze / the end card. No jump-scare, no flash: the mask is a
   small static sprite, shown or hidden; nothing full-field changes.
   He is "the Games Master" only (pack text); nothing here builds a name. Art: a PLACEHOLDER original silhouette drawn in
   room-hook.js (no VR sprite sheet for him exists yet). Per frame: reused objects only; randomness = seeded prngs from
   the session seed, so the same seed + inputs give the same host (GM hash + Oni state). */
export const GM_HOST_TUNING = Object.freeze({
  arriveS: 4,             // he pads in this long after the kittens are out
  spotM: 1.7, spotDeg: 40, // his host spot: this far from the player, this far LEFT of the build forward, on the floor
  enterM: 1.4,            // he walks in from this far further left
  walkMps: 0.5,           // his normal walk
  oniMinS: 120,           // Oni: never before this much hosting time ...
  oniCheckS: 15, oniP: 0.35, // ... then one seeded roll every oniCheckS (only while he is out of view) with this chance
  oniHiddenDeg: 110,      // "out of view": at least this far off the player's flat gaze
  oniWalkMps: 0.22,       // the stalk: a slow walk
  oniRingM: 0.9,          // the distance ring around the player: he never comes inside it
  oniSeenDeg: 50,         // the player turned: he is within this of the flat gaze
  oniMaxS: 20,            // a stalk ends after this anyway
  oniOffMps: 0.6, oniOffS: 2.5, // mask off, then walk away the other way this long; then back to his spot
  noticeAheadM: 0.7, noticeBelowM: 0.12, noticeW: 0.5, noticeH: 0.3, btnDX: 0.11, btnDY: -0.09, btnR: 0.08, // the notice card + its two buttons
  megaS: 2.5,             // the megaphone pose after a port announce
});
export const GM_HOST_TEXT = Object.freeze({
  feather: 'Next game, pals: FEATHER POP!',
  tug: 'Next game, pals: YARN TUG!',
  // word for word (plan 17.3); buttons: keep = default focus
  notice: 'Heads-up: when the Games Master sneezes, his fur shimmers and changes. Calm sneezes is on: one gentle fur change. Want the full sneeze? Settings > Accessibility > Calm sneezes.',
  keep: 'Keep calm sneezes', full: 'Full sneezes',
});
const GM_LT_START = Object.freeze({ type: 'mode_start', mode: 'lasertag_vr' });
const GM_ARC_START = Object.freeze({ type: 'mode_start', mode: 'arc_laser' });
const GM_NO_EV = Object.freeze([]);

/** A fresh Oni stalk state (one per session). phase 'off' -> 'stalk' -> 'leave' -> 'done' (done = never again this session). */
export function createOni() { return { phase: 'off', x: 0, z: 0, t: 0, mask: false, checkS: 0, rolls: 0, why: null, dirX: 0, dirZ: 0, starts: 0 }; }
/** angle test: is (px, pz) within `deg` of the flat forward (fx, fz) seen from (hx, hz)? */
function gmWithin(hx, hz, fx, fz, px, pz, deg) {
  const dx = px - hx, dz = pz - hz, d = Math.hypot(dx, dz), fl = Math.hypot(fx, fz);
  if (d < 1e-6 || fl < 1e-6) return true;
  return (dx * fx + dz * fz) / (d * fl) >= Math.cos(deg * Math.PI / 180);
}
/** One frame of the Oni stalk (pure but for the prng). inp = { dt, allowed, hostS, head { x, z }, fwd { x, z } (flat),
 *  gx, gz (where he stands now), prng }. Mutates + returns o; o.x / o.z = where he is while stalking / leaving. */
export function oniStep(o, inp, T = GM_HOST_TUNING) {
  const dt = inp.dt > 0 ? inp.dt : 0, h = inp.head, f = inp.fwd;
  if (o.phase === 'done' || !h || !f) return o;
  if (o.phase === 'off') {
    if (!inp.allowed || inp.hostS < T.oniMinS) return o;
    if (gmWithin(h.x, h.z, f.x, f.z, inp.gx, inp.gz, T.oniHiddenDeg)) return o; // he only starts (and only rolls) while out of view
    if (Math.hypot(inp.gx - h.x, inp.gz - h.z) < T.oniRingM + 0.5) return o;
    o.checkS += dt;
    if (o.checkS < T.oniCheckS) return o;
    o.checkS -= T.oniCheckS; o.rolls++;
    if (!inp.prng.chance(T.oniP)) return o;
    o.phase = 'stalk'; o.mask = true; o.t = 0; o.x = inp.gx; o.z = inp.gz; o.why = null; o.starts++;
    return o;
  }
  o.t += dt;
  const dx = o.x - h.x, dz = o.z - h.z, d = Math.hypot(dx, dz);
  if (o.phase === 'stalk') {
    let why = null;
    if (!inp.allowed) why = 'blocked';
    else if (gmWithin(h.x, h.z, f.x, f.z, o.x, o.z, T.oniSeenDeg)) why = 'turned';
    else if (d <= T.oniRingM + 1e-6) why = 'reached';
    else if (o.t >= T.oniMaxS) why = 'timeout';
    if (why) { o.phase = 'leave'; o.mask = false; o.why = why; o.t = 0; o.dirX = d > 1e-6 ? dx / d : 1; o.dirZ = d > 1e-6 ? dz / d : 0; return o; }
    const s = Math.min(T.oniWalkMps * dt, d - T.oniRingM);
    o.x -= dx / d * s; o.z -= dz / d * s;
    return o;
  }
  // leave: mask already off, walking away from the player the other way
  o.x += o.dirX * T.oniOffMps * dt; o.z += o.dirZ * T.oniOffMps * dt;
  if (o.t >= T.oniOffS) o.phase = 'done';
  return o;
}
/** The notice card's button under a ray: 'calm' | 'full' | null. card = { x, y, z, rx, rz } (centre + flat right unit). */
export function gmNoticePick(card, ray, T = GM_HOST_TUNING) {
  if (!card || !ray || !ray.o || !ray.d) return null;
  const o = ray.o, d = ray.d, dl = Math.hypot(d.x, d.y, d.z) || 1;
  let best = null, bd = T.btnR;
  for (let k = 0; k < 2; k++) {
    const sx = k === 0 ? -1 : 1, cx = card.x + card.rx * T.btnDX * sx, cy = card.y + T.btnDY, cz = card.z + card.rz * T.btnDX * sx;
    const vx = cx - o.x, vy = cy - o.y, vz = cz - o.z, along = (vx * d.x + vy * d.y + vz * d.z) / dl;
    if (along <= 0) continue;
    const px = vx - d.x / dl * along, py = vy - d.y / dl * along, pz = vz - d.z / dl * along, off = Math.hypot(px, py, pz);
    if (off <= bd) { bd = off; best = k === 0 ? 'calm' : 'full'; }
  }
  return best;
}

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
    // GE2-B: seated kitten { cat, carrier, support, kind: 'palm' | 'ctl', lost, since, down: { x, y, z, yEnd } | null, purrUntil, nextPurr }
    seated: null, _gr: { left: null, right: null }, _pinchP: { left: { x: 0, y: 0, z: 0, ok: false }, right: { x: 0, y: 0, z: 0, ok: false } },
    _rayPet: { left: null, right: null }, _sq: { left: null, right: null }, _sel: { left: false, right: false }, _sqWas: { left: false, right: false },
    _hapT: { left: -Infinity, right: -Infinity }, _hapPool: [{ hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }], petHaptics: [], _tapped: false,
    tip: createTipCard(), _tipLines: [], _tipIn: { t: 0, dt: 0, text: '', head: null, gaze: null, tap: false, menuOpen: false, leftHanded: false }, _tipA: null, _tipB: null, _tipText: '',
    // Q-GE2 (owner #7): virtual furniture (wand.js); the pieces live for the page (carried into the next session's room build) and,
    //, their PLAY RUG cells are saved through opts.saveFurniture (visit-store.js writeFurniture, gate FURNITURE_PERSIST)
    furn: null, _furnPieces: [], _rugFrame: null, _furnRestored: false, _furnSavedV: -1, _furnSavedJ: null, _fev: { type: '', hand: '', p: null, ray: null, yaw: NaN, x: 0, dt: 0 }, _seatAt: { x: 0, y: 0, z: 0 }, _down: { o: { x: 0, y: 0, z: 0 }, d: { x: 0, y: -1, z: 0 } },
  };
  // SK-PORT (Q-GE2): Feather Pop / Yarn Tug / Kitten Needs state (all reused objects: the per-frame path allocates nothing new)
  Object.assign(b, { feather: null, tug: null, tugHand: 'right', tugCat: null, _tugEndAt: -1, needs: null, _fStartOff: false, _fHand: 'right',
    _fSel: { left: false, right: false }, _snatch: { p: { x: 0, y: 0, z: 0 } }, _fHead: { x: 0, z: 0, fx: 0, fz: -1 }, _portCap: null,
    _hudWhy: { laser_tag: 'laser_tag', feather: 'feather', tug: 'tug' }, _portHapPool: [{ hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }], _portHapN: 0,
    _port: { line2: null, needs: { id: '', name: '', hunger: 0, play: 0, cuddle: 0, sleepy: 0 }, needsKey: '', hintText: null, hintAt: -1e9, hintAction: '',
      fLine: null, fy: -1, fk: -1, fs: -1, tLine: null, tr: -1, ty: -1, tk: -1, tp: -1 },
    _tugView: { on: false, hand: { x: 0, y: 0, z: 0 }, cat: { x: 0, y: 0, z: 0 }, t: 0.5, m: 0 } });
  b._hudEnabled.feather = false; b._hudEnabled.tug = false;
  // Q-GE2/113: the Games Master host (GM_HOST_TUNING). The Calm sneezes answer lives on this bridge for the page only
  // (session-only: never written to storage); rulesSeen is per visit (= this page)
  Object.assign(b, { gm: null, gmPlay: null, oni: createOni(), _oniPrng: null, _gmOn: false, _gmOutT: -1, _gmTick: 0, _gmHostS: 0, _gmPrevMode: 'play',
    _gmCalm: true, _gmOfferDone: false, _gmNotice: false, _gmVisit: { rulesSeen: {} }, _gmEv: [], _gmCap: null, _gmMegaUntil: -1,
    _gmSelWas: { left: false, right: false }, _gmSpot: { x: 0, z: 0 }, _gmCtx: { box: null }, _gmLastHead: { x: 0, y: 1.2, z: 0 }, _gmLastFwd: { x: 0, z: -1 },
    _gmIn: { tick: 0, events: GM_NO_EV, arcTick: null, slot: { sk99: false, controllersHint: false, beatHint: false },
      moment: { countdown: false, last10s: false, rulesCaption: false, scoreCardMs: -1, restOffer: false, safety: false, suggestionTile: false, peekaboo: false,
        exit: false, betweenRounds: false, idle: false, hosting: true, sk99: false, driving: false } },
    _gmBlocked: { safety: false, sk99: false, countdown: false, last10s: false, rulesCaption: false },
    _gmOni: { dt: 0, allowed: false, hostS: 0, head: null, fwd: null, gx: 0, gz: 0, prng: null },
    _gmFadeQ: [{ fur: '', ms: 0, at: 0 }, { fur: '', ms: 0, at: 0 }, { fur: '', ms: 0, at: 0 }, { fur: '', ms: 0, at: 0 }], _gmFadeN: 0, _gmLastFade: -1e9,
    _gmView: { on: false, x: 0, y: 0, z: 0, pose: 'sit', mask: false, sneezing: false, fur: 'calico', furFrom: 'calico', fade: 1, fadeMs: 0, fadeAt: 0, calm: true,
      ring: { on: false, x: 0, z: 0, r: GM_HOST_TUNING.oniRingM },
      notice: { on: false, x: 0, y: 0, z: 0, rx: 1, rz: 0, text: GM_HOST_TEXT.notice, keep: GM_HOST_TEXT.keep, full: GM_HOST_TEXT.full, focus: 'keep' } } });
  /** the notice card's answer ('full' = Full sneezes; anything else = Keep calm sneezes). null when no notice is up */
  b.gmAnswer = (choice) => {
    if (!b.gm || !b._gmNotice) return null;
    const r = b.gm.answerSneeze(choice === 'full' ? 'full' : 'calm');
    b._gmCalm = r ? r.calm !== false : true; b._gmOfferDone = true; b._gmNotice = false; b._gmView.notice.on = false; b._gmView.calm = b._gmCalm;
    return b._gmCalm;
  };
  /** Settings > Accessibility > Calm sneezes (session-only, never saved) */
  b.gmSetCalm = (on) => { b._gmCalm = !!on; b._gmView.calm = b._gmCalm; if (b.gm) b.gm.setCalm(b._gmCalm); return b._gmCalm; };
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
    if (b._furnPieces.length) for (const m of furnitureMeshes({ pieces: b._furnPieces }, input.floorY)) input.meshes.push(m); // Q-GE2: placed furniture = surfaces / obstacles for the cats
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
    { // Q-GE2: the furniture bin sits on the floor on the side away from the toy basket, a little ahead; the pieces carry over
      const f = input.forward, fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl, side = opts.leftHanded ? -1 : 1; // left of forward = (fz, -fx)
      b.furn = createFurnitureState({ bin: { x: input.viewer.x + fz * 0.5 * side + fx * 0.35, y: input.floorY, z: input.viewer.z - fx * 0.5 * side + fz * 0.35 }, floor: furnitureFloor(b.room) });
      // GO9b SHOULD 1 (rule 3): pieces carried from a SCANNED-room session (no rug frame) into a play-rug session were last
      // clamped to the real floor plane: clamp them onto the rug and do not save their cells until the player moves them here
      const rugNow = furnitureRugFrame(b.room), fromScan = !!rugNow && !b._rugFrame;
      for (const p of b._furnPieces) { p.held = null; if (fromScan) { furnitureReclamp(b.furn, p); p.noSave = true; } b.furn.pieces.push(p); b.furn.seq = Math.max(b.furn.seq, Number(String(p.id).slice(2)) || 0); }
      b._rugFrame = rugNow; // the play rug only (null in a scanned room: nothing saved / restored there)
      if (b._rugFrame && !b._furnRestored) { b._furnRestored = true; if (!b.furn.pieces.length && opts.furniture) furnitureRestore(b.furn, opts.furniture, b._rugFrame, input.floorY); }
      b._furnPieces = b.furn.pieces; b._furnSavedV = b.furn.version; b._furnSavedJ = null;
    }
    b.director = createDirector({ room: b.room, seed: opts.seed == null ? 1 : opts.seed, viewer: input.viewer, forward: input.forward });
    b.fx = createFx(opts.seed == null ? 1 : opts.seed);
    b.hud = createHudMenu(); b._laserGate = createLaserGate(); // SK-HUD: a fresh menu per session (tool = Laser)
    { // SK-PORT (QUEST-PORT-WIRING 3 / 15): one Feather Pop + one Kitten Needs per session (seeded from the session seed); Yarn Tug per match
      const seed = opts.seed == null ? 1 : opts.seed;
      b.feather = createFeatherPop({ room: b.room, seed: seed + 17 });
      b.needs = createKittenNeeds({ ids: b.state.cats.map((c) => c.id), names: opts.names || {}, seed });
      b.tug = null; b.tugCat = null; b._tugEndAt = -1; b._fStartOff = false; b._fSel.left = false; b._fSel.right = false; b._portCap = null;
      const P = b._port; P.line2 = null; P.needsKey = ''; P.hintText = null; P.hintAt = -1e9; P.hintAction = ''; P.fy = -1; P.ty = -1;
    }
    { // Q-GE2: the host arrives after the kittens are out (gmFrame); his spot: spotM from the player, spotDeg left of the build forward
      const G = GM_HOST_TUNING, f = input.forward, fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
      const a = G.spotDeg * Math.PI / 180 * (opts.leftHanded ? -1 : 1), c = Math.cos(a), s = Math.sin(a); // left of (fx, fz) = (fz, -fx)
      b._gmSpot.x = input.viewer.x + (fx * c + fz * s) * G.spotM; b._gmSpot.z = input.viewer.z + (fz * c - fx * s) * G.spotM;
      b.gm = null; b.gmPlay = null; b._gmOn = false; b._gmOutT = -1; b._gmTick = 0; b._gmHostS = 0; b._gmPrevMode = 'play'; b._gmNotice = false; b._gmCap = null;
      b._gmMegaUntil = -1; b._gmEv.length = 0; b._gmFadeN = 0; b._gmLastFade = -1e9;
      b.oni = createOni(); b._oniPrng = createPrng(((opts.seed == null ? 1 : opts.seed) + 31) >>> 0);
      const V = b._gmView; V.on = false; V.mask = false; V.sneezing = false; V.ring.on = false; V.notice.on = false; V.fur = 'calico'; V.furFrom = 'calico'; V.fade = 1;
      V.calm = b._gmCalm; V.y = input.floorY; V.pose = 'sit';
    }
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
    b.time += dt; dt0 = dt;
    const D = b.director, route = directorRoute(D);
    b._portHapN = 0; portGuard(route); // SK-PORT: Laser Tag / the end card / nap time end a running Feather Pop or Yarn Tug
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
      portGrey(D, route); // laser_tag as before (offer / score card) + SK-PORT feather / tug grey-outs (WIRING 2)
      hm = hudMenuStep(b.hud, { t: b.time, dt, head: b._hudHead, sources: srcs, hide: !!b.endCard || !!hudIn.hide, wristToggle: !!hudIn.wristToggle, enabled: b._hudEnabled });
      for (const e of hm.events) if (e.type === 'command' && e.action === 'laser_tag' && (D.mode === 'offer' || D.mode === 'scorecard')) startLaserTag(D);
      for (const e of hm.events) if (e.type === 'command' && b.furn && e.action.startsWith('furn:')) { // Q-GE2: the Furniture picker
        const k = e.action.slice(5);
        if (k === 'remove') furnitureRemove(b.furn); else furnitureAdd(b.furn, k, { viewer: camera, forward: fwd, floorY: b.roomInput ? b.roomInput.floorY : 0 });
      }
      for (const e of hm.events) if (e.type === 'command' && (e.action === 'feather' || e.action === 'tug')) portCommand(e, camera, fwd); // SK-PORT
      const tc = b._hudTctx; tc.forceLaser = route === 'lt'; tc.head = b._hudHead; // GO1 SHOULD 1: in Laser Tag the controller trigger aims the dot whatever the tool
       tc.floorY = b.roomInput ? b.roomInput.floorY : 0; tc.targets = targets; tc.dt = dt;
      tc.grabs = b.state && b.hud.active === 'toss' ? b.state.cats.filter((c) => c.mode !== 'inbox' && c.mode !== 'carried').map((c) => ({ x: c.x, y: c.y + (ROOMCAT_SIZES[c.size] || ROOMCAT_SIZES.kitten).scruff, z: c.z })) : null;
    }
    // GE2-B: both hands' gestures first (a kitten let go over the OTHER hand's open palm sits on it), then their events
    const gr = b._gr;
    for (const h of T.hands) { const r = gestureStep(b.gestures[h], byHand[h] || null, targets, null, view); b.gestures[h] = r.state; gr[h] = r; }
    b._tapped = false; b.petHaptics.length = 0;
    for (const h of T.hands) {
      const r = gr[h];
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
        if (ev.type === 'pinch_start') b._tapped = true; // any pinch dismisses the tip card
        if (route === 'lt') continue; // Laser Tag: the Play sim is frozen; the point ray goes to lasertag-room below
        if (b.tug && h === b.tugHand && !PORT_TUG_PASS[ev.type]) continue; // SK-PORT (WIRING 11): the tugging hand pulls yarn, not cats (its ENDS still pass)
        if (ev.type === 'pinch_start' || ev.type === 'pinch_hold') { const pp = b._pinchP[h]; if (ev.p) { pp.x = ev.p.x; pp.y = ev.p.y; pp.z = ev.p.z; pp.ok = true; } }
        // GE2-B (Owner #3): the carrier lets go over the other open palm -> she sits there (no toss); a pinch back at her picks her up again
        if (ev.type === 'pinch_release' && seatOnPalm(h)) continue;
        if (ev.type === 'pinch_start' && b.seated && b.seated.carrier === h && !b.seated.down && b.seated.kind === 'palm' && nearScruff(b.seated.cat, ev.p, T.grabNearM * 1.5)) { b.seated = null; continue; }
        if (ev.type === 'pinch_release' || ev.type === 'lost') b._rayPet[h] = null;
        // the wand sees every gesture first: a pinch at its handle picks it up (that pinch is not a scruff / box pinch)
        const w = wandStep(b.wand, ev, wctx);
        b.wand = w.state;
        for (const we of w.events) events.push(we);
        if (w.consumed) continue;
        // Q-GE2: then the furniture: a pinch at a piece (not at a kitten's scruff / the box lid) grabs it; that hand's moves drag it
        if (b.furn && (ev.type === 'pinch_start' ? !grabbable(ev.p) : b.furn.held[h] && (ev.type === 'move' || ev.type === 'pinch_hold' || ev.type === 'pinch_release' || ev.type === 'lost'))) {
          const fe = b._fev; fe.type = ev.type; fe.hand = h; fe.p = ev.p || null; fe.ray = null; fe.yaw = handYaw(byHand[h]);
          if (furnitureStep(b.furn, fe, null).consumed && (ev.type === 'pinch_start' || ev.type === 'pinch_release')) continue;
        }
        // GE2-B: a hand pinch that grabs nothing (no scruff / box lid near) with the hand ray on a kitten pets her while it holds
        if (ev.type === 'pinch_start' && srcs && srcs[h] && srcs[h].kind === 'hand' && !grabbable(ev.p)) { const c = hudPickCat(targets, srcs[h].ray, null, T.rayPetR); b._rayPet[h] = c ? c.id : null; }
        for (const re of gestureToRoomEvents(ev, ctx)) events.push(re); // the Play laser stays live while Laser Tag is offered (review BB S1): the floor ring is the start target
      }
    }
    if (route !== 'lt') handExtras(targets, srcs, events);
    furnSaveCheck();
    const simEvents = b.simEvents; simEvents.length = 0;
    const n = b.loop.advance(dt * 1000);
    let bb;
    if (route === 'lt') {
      // Laser Tag steps on the same fixed loop; Play is frozen (not stepped, not fed); its kittens are the crowd
      ltStep(D, n, pointRay(gest));
      if (b._gmOn) gmEventsFromLaserTag(D.ltEvents, b._gmEv); // Q-GE2: the host reads the round (directorStep clears ltEvents)
      const crowd = b._ltState.cats; crowd.length = 0;
      let shown = 0;
      for (const c of b.state.cats) { if (c.mode === 'inbox') continue; if (shown++ >= HAPPY_TUNING.crowdMax) break; crowd.push(c.mode === 'carried' || c.mode === 'onhand' || c.airborne ? c : Object.assign({}, c, { mode: 'idle', pose: 'sit' })); }
      for (const c of ltCatRecords(D, b.ltCats)) crowd.push(c);
      bb = catsToBillboards(b._ltState, b.room, camera || { x: 0, y: 1.2, z: 0 }, b.views);
    } else {
      b.wand = wandStep(b.wand, null, wctx).state; // time-only rules (a dropped wand returns to the basket)
      if (b.feather && b.feather.stats.active) { // SK-PORT (WIRING 5): the feather owns s.laser; the player's own laser never reaches the session
        let k = 0; for (let i = 0; i < events.length; i++) { const e = events[i]; if (e.type !== 'laser') events[k++] = e; } events.length = k;
      }
      if (b._fStartOff) { b._fStartOff = false; b._laserGate.owner = null; events.push(PORT_START_OFF); } // PORT1 SHOULD 4a: ONE off at the start
      laserGateFilter(b._laserGate, events); // roomcat has ONE dot: an off from the hand that does not own it is dropped (Review row 451)
      if (n > 0) {
        b.session.step(events); // all of this frame's events apply on its first step (logged with that tick)
        for (const ev of b.session.events) simEvents.push(ev);
        for (let i = 1; i < n; i++) { b.session.step(); for (const ev of b.session.events) simEvents.push(ev); }
        b.state = b.session.state();
      } else if (events.length) {
        for (const e of events) b.session.push(e); // no step this frame: queue for the next one (no event is dropped)
      }
      seatPose(simEvents);
      portStep(dt, camera, fwd, srcs, hm, simEvents, targets); // SK-PORT (WIRING 7 / 11 / 16): after the session sub-steps, b.state fresh, never in Laser Tag
      if (b._gmOn) gmEventsFromRoom(simEvents, b._gmEv); // Q-GE2: catches, combos, leaps, treats, phases for the host
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
    gmFrame(dt, n, camera, fwd, srcs, D, route, hm, hudIn); // Q-GE2/113: the Games Master (lowest caption rank)
    const cues = n > 0 ? soundCues(b.state, b._prevState) : [];
    if (b._gmCap) { b.captions = Object.assign({}, b.captions, { text: null, since: null }); cues.unshift(b._gmCap); b._gmCap = null; } // the host speaks (only when no beat / port / menu line spoke: the slot rule)
    if (hm) for (const e of hm.events) { // SK-HUD captions: the picked tool / a greyed tile (captions only, no sound)
      const line = e.type === 'tool' ? HUD_ACTION_LABEL[e.action] + ': ' + HUD_ACTION_TIP[e.action] : e.type === 'blocked' ? (HUD_BLOCKED[b._hudWhy[e.action]] || HUD_CAPTIONS.blocked) : null; // PORT1 SHOULD 3: per action + reason
      if (line) { b.captions = Object.assign({}, b.captions, { text: null, since: null }); cues.unshift(line); }
    }
    if (b._portCap) { b.captions = Object.assign({}, b.captions, { text: null, since: null }); cues.unshift(b._portCap); b._portCap = null; } // SK-PORT moments
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
    // GE2-B (Owner #2): the hint / caption card: small, low and to the side, fades after a few seconds, any tap dismisses it, never over the menu
    const tl = b._tipLines; tl.length = 0;
    if (b.hint && b.hint.text) tl.push(b.hint.text);
    if (b.caption) tl.push(b.caption);
    if (srcs) for (const h of T.hands) { const sc = srcs[h], on = !!(sc && (sc.select || sc.squeeze)); if (on && !b._sel[h]) b._tapped = true; b._sel[h] = on; }
    // GO7 SHOULD 2: the tip-card input is one reused object and the text is joined only when a line changed (strings compare by value)
    const ta = tl.length > 0 ? tl[0] : null, tb = tl.length > 1 ? tl[1] : null;
    if (ta !== b._tipA || tb !== b._tipB) { b._tipA = ta; b._tipB = tb; b._tipText = tl.join('\n'); }
    const ti = b._tipIn; ti.t = b.time; ti.dt = dt; ti.text = b._tipText; ti.head = camera || null; ti.gaze = gaze || null; ti.tap = b._tapped; ti.menuOpen = !!(hm && hm.visual.open); ti.leftHanded = !!opts.leftHanded;
    const tipCard = tipCardStep(b.tip, ti);
    const dir = { mode: dmode, route, meter: D.meter.value, meterFull: D.meter.full, celebrate: D.celebrate, scorecard: D.scorecard, hud: D.hud, dot: route === 'lt' ? dotNow : null, ring: offerRing(D), best: D.best, round: D.ltRound };
    const hud = hm ? { visual: hm.visual, events: hm.events, haptics: hm.haptics, stats: hudStats(dir, b.state, b.hud.active, b._port) } : null;
    return { cats: bb.cats, views: bb.views, state: b.state, events, simEvents, wand: route === 'lt' ? null : wandView(b.wand), hint: b.hint, hintChanged, caption: b.caption, captionChanged: cr.changed, endCard: b.endCard, memory: b.memory, fx: b.fx, director: dir, hud, tipCard, petHaptics: b.petHaptics, seated: b.seated, furniture: route === 'lt' ? null : b.furn,
      gm: b._gmOn ? b._gmView : null, // Q-GE2: the host view (reused object)
      featherPop: route === 'lt' || !b.feather ? null : b.feather.stats, tug: route !== 'lt' && b.tug && b._tugView.on ? b._tugView : null, needs: b._port.needsKey ? b._port.needs : null }; // SK-PORT views (reused objects)
  };


  // ---------------------------------------------------------------- Q-GE2/113: the Games Master host (closures over b)
  function gmArrive() {
    const G = GM_HOST_TUNING, seed = opts.seed == null ? 1 : opts.seed;
    b.gmPlay = createPlaySuggester({ plays: GM_PACK.plays, seed: (seed + 29) >>> 0, room: b.room });
    b.gmPlay.setContext({ arcStartTick: -GM_DIRECTOR.arcGateTicks, blocked: b._gmBlocked, viewer: b.roomInput ? b.roomInput.viewer : null });
    b.gm = createGamesMaster({ pack: GM_PACK, seed: (seed + 23) >>> 0, visit: b._gmVisit, suggestPlay: b.gmPlay, calm: b._gmCalm, offerDone: b._gmOfferDone, log: opts.gmLog === true });
    b._gmOn = true; b._gmTick = 0; b._gmHostS = 0;
    const V = b._gmView, s = b._gmSpot, f = b.roomInput ? b.roomInput.forward : { x: 0, z: -1 }, fl = Math.hypot(f.x, f.z) || 1, side = opts.leftHanded ? -1 : 1;
    V.on = true; V.x = s.x + (f.z / fl) * G.enterM * side; V.z = s.z - (f.x / fl) * G.enterM * side; V.y = b.roomInput ? b.roomInput.floorY : 0; V.pose = 'sit';
    b._gmEv.push(GM_ARC_START); // the arc laser rules follow his intro (B2, once per visit)
    if (onLog) onLog('games master arrives');
  }
  function gmCueText(c) {
    const p = c.play, pl = p && p.caption ? (typeof p.caption === 'string' ? p.caption : p.caption.line1) : null; // B4: the play's own caption replaces the tile line
    const l2 = pl || c.line2;
    return l2 ? c.line1 + '\n' + l2 : c.line1;
  }
  function gmAnnounce(k) { if (!b._gmOn || !b._portCap) return; b._portCap = GM_HOST_TEXT[k] + '\n' + b._portCap; b._gmMegaUntil = b.time + GM_HOST_TUNING.megaS; }
  function gmPlaceNotice() {
    const G = GM_HOST_TUNING, N = b._gmView.notice, h = b._gmLastHead, f = b._gmLastFwd, fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
    N.x = h.x + fx * G.noticeAheadM; N.y = h.y - G.noticeBelowM; N.z = h.z + fz * G.noticeAheadM; N.rx = -fz; N.rz = fx; N.on = true;
  }
  function gmSneeze(evs) {
    const V = b._gmView, Q = b._gmFadeQ;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.type === 'offer_show') { b._gmNotice = true; gmPlaceNotice(); }
      else if (e.type === 'offer_answer') { b._gmNotice = false; V.notice.on = false; }
      else if (e.type === 'sneeze_ah' || e.type === 'sneeze') V.sneezing = true;
      else if (e.type === 'sneeze_step') { if (b._gmFadeN < Q.length) { const q = Q[b._gmFadeN++]; q.fur = e.fur; q.ms = e.fadeMs; q.at = Math.max(b.time, b._gmLastFade + 0.35); b._gmLastFade = q.at; } }
      else if (e.type === 'sneeze_end') { V.sneezing = false; if (e.cut) b._gmFadeN = 0; } // cut: no new fur change starts (a running fade may finish)
    }
  }
  /** one frame of the host: arrival, events -> the director (one step per fixed tick), the notice answer, sneeze fades, walk + Oni */
  function gmFrame(dt, n, camera, fwd, srcs, D, route, hm, hudIn) {
    const G = GM_HOST_TUNING, V = b._gmView, ev = b._gmEv, phase = b.state ? b.state.phase : 'play';
    if (camera && Number.isFinite(camera.x)) { const H = b._gmLastHead; H.x = camera.x; H.y = Number.isFinite(camera.y) ? camera.y : 1.2; H.z = camera.z; }
    if (fwd) { b._gmLastFwd.x = fwd.x; b._gmLastFwd.z = fwd.z; }
    if (!b._gmOn) {
      ev.length = 0;
      if (opts.gm === false || phase !== 'play') return;
      if (b._gmOutT < 0) b._gmOutT = b.time;
      if (b.time - b._gmOutT < G.arriveS || route === 'lt' || b.endCard) return;
      gmArrive();
    }
    const dm = D.mode, prev = b._gmPrevMode;
    if (dm === 'countdown' && prev !== 'countdown' && prev !== 'playing') ev.unshift(GM_LT_START); // he hosts Laser Tag: its rules (first time per visit) + countdown
    b._gmPrevMode = dm;
    if (b._gmNotice && srcs) for (const h of T.hands) { // the notice card: a select / squeeze / pinch with the ray on a button answers it
      const sc = srcs[h], on = !!(sc && (sc.select || sc.squeeze)), edge = on && !b._gmSelWas[h]; b._gmSelWas[h] = on;
      let pinch = false; const gh = b._gr[h]; if (gh && gh.events) for (const e of gh.events) if (e.type === 'pinch_start') pinch = true;
      if ((edge || pinch) && sc && sc.ray) { const pick = gmNoticePick(V.notice, sc.ray); if (pick) { b.gmAnswer(pick); break; } }
    }
    const I = b._gmIn, M = I.moment, S = I.slot, B = b._gmBlocked, hide = !!(hudIn && hudIn.hide);
    M.countdown = dm === 'countdown'; M.scoreCardMs = dm === 'scorecard' ? Math.round(D.modeT * 1000) : -1;
    M.restOffer = phase === 'nap' || phase === 'end'; M.safety = D.hintLine === DIRECTOR_TEXT.turn; M.exit = !!b.endCard; M.sk99 = hide; M.driving = hide;
    M.betweenRounds = dm === 'offer' || dm === 'scorecard' || dm === 'celebrate'; M.idle = dm === 'play' && route !== 'lt'; M.hosting = !M.exit && !M.restOffer;
    S.sk99 = hide; S.controllersHint = !!(b.hint && b.hint.text === CONTROLLER_HINT); S.beatHint = !!(D.caption || b._portCap || (hm && hm.events.length));
    B.safety = M.safety; B.sk99 = hide; B.countdown = M.countdown;
    b._gmCtx.box = b.state ? b.state.box : null; b.gmPlay.setContext(b._gmCtx);
    for (let i = 0; i < n; i++) {
      I.tick = b._gmTick++; I.events = ev.length ? ev : GM_NO_EV; I.arcTick = I.tick === 0 ? GM_DIRECTOR.arcGateTicks : null;
      const out = b.gm.step(I);
      if (ev.length) ev.length = 0;
      if (out.cue) b._gmCap = gmCueText(out.cue);
      if (out.sneeze.length) gmSneeze(out.sneeze);
      V.pose = out.pose;
    }
    if (M.hosting) b._gmHostS += dt;
    // the fur crossfade queue (each change starts >= 350 ms after the previous one: <= 3 changes a second)
    if (V.fade < 1) V.fade = Math.min(1, (b.time - V.fadeAt) * 1000 / Math.max(1, V.fadeMs));
    const Q = b._gmFadeQ;
    if (V.fade >= 1 && b._gmFadeN > 0 && Q[0].at <= b.time + 1e-9) {
      const q = Q[0]; V.furFrom = V.fur; V.fur = q.fur; V.fadeMs = q.ms; V.fadeAt = b.time; V.fade = 0;
      for (let i = 1; i < b._gmFadeN; i++) Q[i - 1] = Q[i];
      Q[b._gmFadeN - 1] = q; b._gmFadeN--;
    }
    // walk + the Oni stalk
    const OI = b._gmOni;
    OI.dt = dt; OI.hostS = b._gmHostS; OI.head = camera ? b._gmLastHead : null; OI.fwd = b._gmLastFwd; OI.gx = V.x; OI.gz = V.z; OI.prng = b._oniPrng;
    OI.allowed = route !== 'lt' && dm === 'play' && phase === 'play' && M.hosting && !M.safety && !hide && !b._gmNotice && !V.sneezing && b._gmFadeN === 0
      && !(b.feather && b.feather.stats.active) && !(b.tug && !b.tug.stats.done) && !b.seated;
    const o = oniStep(b.oni, OI);
    if (o.phase === 'stalk' || o.phase === 'leave') { V.x = o.x; V.z = o.z; }
    else { const dx = b._gmSpot.x - V.x, dz = b._gmSpot.z - V.z, d = Math.hypot(dx, dz), s = Math.min(G.walkMps * dt, d); if (d > 1e-6) { V.x += dx / d * s; V.z += dz / d * s; } }
    V.mask = o.mask; V.ring.on = o.phase === 'stalk';
    if (V.ring.on) { V.ring.x = b._gmLastHead.x; V.ring.z = b._gmLastHead.z; V.pose = 'stalk'; }
    else if (b.time < b._gmMegaUntil) V.pose = 'megaphone';
  }

  // ---------------------------------------------------------------- GE2-B helpers (closures over b / T)
  const sizeOf = (c) => ROOMCAT_SIZES[c && c.size] || ROOMCAT_SIZES.kitten;
  const catOf = (id) => { if (!b.state || id == null) return null; for (const c of b.state.cats) if (c.id === id) return c; return null; };
  function nearScruff(id, p, r) { const c = catOf(id); if (!c || !p) return false; const dx = p.x - c.x, dy = p.y - (c.y + sizeOf(c).scruff), dz = p.z - c.z; return dx * dx + dy * dy + dz * dz <= r * r; }
  /** a pinch at p grabs something in roomcat (a scruff within grabNearM, or the closed box's lid): never a distance pet */
  function grabbable(p) {
    if (!p || !b.state) return false;
    for (const c of b.state.cats) { if (c.mode === 'inbox' || c.mode === 'carried') continue; const dx = p.x - c.x, dy = p.y - (c.y + sizeOf(c).scruff), dz = p.z - c.z; if (dx * dx + dy * dy + dz * dz <= T.grabNearM * T.grabNearM) return true; }
    const bx = b.state.box; if (bx && bx.landed && !bx.open) { const dx = p.x - bx.x, dy = p.y - (bx.y + ROOMCAT_TUNING.boxH), dz = p.z - bx.z; if (dx * dx + dy * dy + dz * dz <= 0.09) return true; }
    return false;
  }
  /** the open palm of hand h (features) facing up enough (on / off threshold), not pinching, else null */
  function openPalm(h, on) {
    const r = b._gr[h], f = r && r.features, g = b.gestures[h];
    if (!f || g.pinch || g.point) return null;
    if (!(f.normal.y >= (on ? T.seatUpOn : T.seatUpOff))) return null;
    const e = f.ext, open = (e.index >= 0.5) + (e.middle >= 0.5) + (e.ring >= 0.5) + (e.pinky >= 0.5);
    return open >= 2 ? f.palm : null;
  }
  /** hand `a` lets go of the kitten it carries: over the other hand's open palm she sits there (Owner #3). true = seated */
  function seatOnPalm(a) {
    if (b.seated || !b.state) return false;
    const pp = b._pinchP[a]; if (!pp.ok) return false;
    let cat = null, bd = 0.12 * 0.12;
    for (const c of b.state.cats) { if (c.mode !== 'carried') continue; const dx = c.x - pp.x, dy = c.y + sizeOf(c).scruff - pp.y, dz = c.z - pp.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 <= bd) { bd = d2; cat = c; } }
    if (!cat) return false;
    const other = a === 'left' ? 'right' : 'left', palm = openPalm(other, true);
    if (!palm) return false;
    const side = Math.hypot(cat.x - palm.x, cat.z - palm.z), up = cat.y - palm.y;
    if (side > T.seatR || up > T.seatAbove || up < -T.seatBelow) return false;
    b.seated = { cat: cat.id, carrier: a, support: other, kind: 'palm', lost: null, since: b.time, down: null, purrUntil: -Infinity, nextPurr: -Infinity };
    return true;
  }
  /** a pet room event at kitten `id`'s back (the point roomcat measures petR from) */
  function petAt(events, hand, id) { const c = catOf(id); if (!c) return false; events.push({ type: 'pet', hand, p: catBackPoint(c) }); return true; } // (one fresh object pair: roomcat LOGS the event by reference, so it is never reused)
  function rumble(hand) {
    const srcs = b._srcs; if (!srcs || !srcs[hand] || srcs[hand].kind === 'hand') return; // hands have no actuator
    if (b.time - b._hapT[hand] < T.petHapEveryS - 1e-9) return;
    for (const h of b.petHaptics) if (h.hand === hand) return;
    const o = b._hapPool[b.petHaptics.length]; if (!o) return;
    b._hapT[hand] = b.time; o.hand = hand; o.strength = T.petHap; o.ms = T.petHapMs; b.petHaptics.push(o);
  }
  /** after the gesture events: distance pets, controller grip (squeeze), the seat (virtual carrier moves, set-down), pets on a seated kitten, rumble */
  function handExtras(targets, srcs, events) {
    b._srcs = srcs;
    // Q-GE2: a held piece turns with the thumbstick (main.js sources[h].stickX)
    if (srcs && b.furn) for (const h of T.hands) { const sc = srcs[h]; if (sc && b.furn.held[h] && Number.isFinite(sc.stickX)) { const fe = b._fev; fe.type = 'rotate'; fe.hand = h; fe.x = sc.stickX; fe.dt = dt0; furnitureStep(b.furn, fe, null); } }
    const seat = b.seated;
    // 1. the seat's carrier hand no longer drives her: its own moves / pinches / releases are dropped (she follows the palm / controller)
    if (seat) {
      let n = 0;
      for (let i = 0; i < events.length; i++) { const e = events[i]; if (e.hand === seat.carrier && (e.type === 'move' || e.type === 'pinch' || e.type === 'release')) continue; if (e.hand === seat.support && seat.kind === 'palm' && e.type === 'treat' && e.on !== false) continue; events[n++] = e; }
      events.length = n;
    }
    // 2. hand pinch + ray distance pet (while the pinch holds)
    for (const h of T.hands) { const id = b._rayPet[h]; if (id == null) continue; if (!b.gestures[h].pinch || !petAt(events, h, id)) b._rayPet[h] = null; }
    // 3. controllers: grip (squeeze) near a kitten picks her up onto the controller; elsewhere it pets the kitten on its ray
    if (srcs) for (const h of T.hands) {
      const sc = srcs[h], sq = !!(sc && sc.kind === 'controller' && sc.squeeze), was = b._sqWas[h]; b._sqWas[h] = sq;
      const grip = sc && (sc.grip || (sc.ray && sc.ray.o));
      if (sq && !was && grip) {
        let best = null, bd = T.sqGrabM * T.sqGrabM;
        if (!b.seated && b.state) for (const c of b.state.cats) { if (c.mode === 'inbox' || c.mode === 'carried' || c.sulk) continue; const dx = grip.x - c.x, dy = grip.y - (c.y + sizeOf(c).scruff), dz = grip.z - c.z, d2 = dx * dx + dy * dy + dz * dz; if (d2 <= bd) { bd = d2; best = c; } }
        if (best) { const q = { x: best.x, y: best.y + sizeOf(best).scruff, z: best.z }; events.push({ type: 'pinch', hand: h, p: q }); b.seated = { cat: best.id, carrier: h, support: h, kind: 'ctl', lost: null, since: b.time, down: null, purrUntil: -Infinity, nextPurr: -Infinity }; b._sq[h] = 'grab'; }
        else if (b.furn && furnStep(h, 'grab_start', sc, grip).consumed) b._sq[h] = 'furn'; // Q-GE2: grip at a piece (or its ray on one) grabs it
        else { const c = hudPickCat(targets, sc.ray, null, T.rayPetR); b._sq[h] = c ? c.id : null; }
      } else if (sq && b._sq[h] === 'furn') { if (!b.furn || !b.furn.held[h]) b._sq[h] = null; else furnStep(h, 'grab_move', sc, grip); }
      else if (sq && b._sq[h] != null && b._sq[h] !== 'grab') { if (!petAt(events, h, b._sq[h])) b._sq[h] = null; }
      else if (!sq && was) { if (b._sq[h] === 'grab' && b.seated && b.seated.kind === 'ctl' && b.seated.carrier === h) setDown(); if (b._sq[h] === 'furn' && b.furn && b.furn.held[h]) furnStep(h, 'grab_end', sc, grip); b._sq[h] = null; }
      else if (!sc && b.furn && b.furn.held[h] && b._sq[h] === 'furn') { const fe = b._fev; fe.type = 'lost'; fe.hand = h; furnitureStep(b.furn, fe, null); b._sq[h] = null; } // controller gone: dropped where it is
    }
    // 4. the seat: she follows the palm / controller; a palm turned over or gone (seatLostS), or seatMaxS, sets her down gently
    const st = b.seated;
    if (st) {
      const c = catOf(st.cat);
      if (!c || (c.mode !== 'carried' && c.mode !== 'onhand' && b.time - st.since > 0.1)) { b.seated = null; }
      else {
        const sz = sizeOf(c);
        if (!st.down) {
          let at = null;
          if (st.kind === 'palm') { const palm = openPalm(st.support, false); if (palm) { at = b._seatAt; at.x = palm.x; at.y = palm.y + T.seatLift; at.z = palm.z; } }
          else { const sc = srcs && srcs[st.support], g = sc && (sc.grip || (sc.ray && sc.ray.o)); if (g) { at = b._seatAt; at.x = g.x; at.y = g.y + T.ctlSeatLift; at.z = g.z; } }
          if (at) { st.lost = null; st.at = at; } else if (st.lost == null) { st.lost = b.time; if (st.at) st.at = { x: st.at.x, y: st.at.y, z: st.at.z }; } // (the last seen spot is kept by value once lost)
          if ((st.lost != null && b.time - st.lost >= T.seatLostS) || b.time - st.since > T.seatMaxS) setDown();
          else { const a = st.at || { x: c.x, y: c.y, z: c.z }; events.push({ type: 'move', hand: st.carrier, p: { x: a.x, y: a.y + sz.scruff, z: a.z } }); }
        }
        if (st.down) {
          const d = st.down; d.y = Math.max(d.yEnd, d.y - T.downV * dt0);
          events.push({ type: 'move', hand: st.carrier, p: { x: d.x, y: d.y + sz.scruff, z: d.z } });
          if (d.y <= d.yEnd + 1e-6) { events.push({ type: 'release', hand: st.carrier, v: { x: 0, y: 0, z: 0 } }); b.seated = null; }
        }
      }
    }
    // 5. a free hand / controller at the seated kitten pets her (roomcat leaves a carried kitten alone: the bridge purrs her)
    const s2 = b.seated;
    if (s2 && !s2.down) {
      const c = catOf(s2.cat);
      if (c) {
        const cx = c.x, cy = c.y + sizeOf(c).h * 0.55, cz = c.z, r2 = T.seatPetR * T.seatPetR;
        let petter = null;
        const near = (p) => !!p && (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy) + (p.z - cz) * (p.z - cz) <= r2;
        for (const h of T.hands) {
          if (h === s2.support) continue; // the palm / controller she sits on is not the one stroking her
          const f = b._gr[h] && b._gr[h].features, sc = srcs && srcs[h];
          if (f && !b.gestures[h].pinch && (near(f.palm) || near(f.indexTip))) { petter = h; break; }
          if (sc && sc.kind === 'controller' && near(sc.grip || (sc.ray && sc.ray.o))) { petter = h; break; }
        }
        if (petter) {
          s2.purrUntil = b.time + 1.2; petAt(events, petter, s2.cat); rumble(petter); if (s2.support !== petter) rumble(s2.support);
        }
      }
    }
    // 6. the purr rumble for every pet a controller sends (proximity, Pet tool, trigger at a kitten, grip + ray)
    if (srcs) for (let i = 0; i < events.length; i++) { const e = events[i]; if (e.type === 'pet' && e.hand && srcs[e.hand] && srcs[e.hand].kind === 'controller') rumble(e.hand); }
  }
  let dt0 = 0;
  /** Q-GE2: a controller grip event for the furniture (scratch event: p = the grip, the ray, yaw = the ray heading) */
  /**: hand the rug list to the host when it changed and nothing is held (only when the save JSON differs). */
  function furnSaveCheck() {
    const F = b.furn; if (!F || !b._rugFrame || typeof opts.saveFurniture !== 'function' || F.version === b._furnSavedV || F.held.left || F.held.right) return;
    b._furnSavedV = F.version;
    const f = furnitureSave(F, b._rugFrame), j = JSON.stringify(f);
    if (j === b._furnSavedJ) return;
    if (b._furnSavedJ === null && !F.pieces.length && !opts.furniture) { b._furnSavedJ = j; return; } // nothing placed yet: no write
    b._furnSavedJ = j;
    try { opts.saveFurniture(f); } catch (e) { /* storage problems never stop play */ }
  }
  function furnStep(h, type, sc, grip) { const fe = b._fev; fe.type = type; fe.hand = h; fe.p = grip || null; fe.ray = sc ? sc.ray : null; fe.yaw = sc && sc.ray ? Math.atan2(sc.ray.d.x, sc.ray.d.z) : NaN; return furnitureStep(b.furn, fe, null); }
  /** Q-GE2: a tracked hand's heading (wrist -> middle knuckle on the floor plane): turning the hand twists a held piece */
  function handYaw(s) { const j = s && s.joints, w = j && j.wrist, m = j && j['middle-finger-metacarpal']; if (!w || !m) return NaN; const dx = m.x - w.x, dz = m.z - w.z; return dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : NaN; }
  /** start lowering the seated kitten to the surface under her (then let go 2 cm over it: no drop, no toss) */
  function setDown() {
    const st = b.seated; if (!st || st.down) return;
    const c = catOf(st.cat); if (!c) { b.seated = null; return; }
    const r = b._down; r.o.x = c.x; r.o.y = c.y + 0.01; r.o.z = c.z;
    const hit = b.room ? roomRaycast(b.room, r.o, r.d) : null;
    const yEnd = (hit ? hit.y : (b.roomInput ? b.roomInput.floorY : 0)) + 0.02;
    st.down = { x: c.x, y: Math.max(c.y, yEnd), z: c.z, yEnd };
  }
  /** the seated kitten's look: sitting (petted while stroked), purring; the sim's carried state is not drawn as a scruff hang */
  // ---------------------------------------------------------------- SK-PORT (Q-GE2): Feather Pop, Yarn Tug, Kitten Needs glue
  // team/briefs/QUEST-PORT-WIRING.md + Review PORT1 (MUST 1 hand-off, SHOULD 3 / 4). The per-frame path writes reused objects only:
  // strings / events are built on a change (a point, a new second, a 10 % step), never every frame.
  const PORT_TUG_PASS = Object.freeze({ move: true, lost: true, pinch_release: true, palm_end: true }); // the tug hand's ENDS still pass (never a stuck carry); its dot is put out at the start
  const PORT_START_OFF = Object.freeze({ type: 'laser', on: false }); // PORT1 SHOULD 4a: the player's own dot goes out when Feather Pop starts
  const nameOf = (id) => (id != null && opts.names && opts.names[id]) || null;
  const r10 = (x) => Math.round(x / 10) * 10;
  function portHead(camera, fwd) {
    const h = b._fHead;
    if (camera) { h.x = camera.x; h.z = camera.z; }
    if (fwd) { h.fx = fwd.x; h.fz = fwd.z; }
    return h;
  }
  function portHaptic(hand, strength, ms) {
    if (b._portHapN >= b._portHapPool.length) return;
    const o = b._portHapPool[b._portHapN++]; o.hand = hand; o.strength = strength; o.ms = ms; b.petHaptics.push(o);
  }
  /** WIRING 2: grey-outs + the reason each tile is greyed (HUD_BLOCKED key; '' = enabled). Strings are constants: no allocation. */
  function portGrey(D, route) {
    const E = b._hudEnabled, W = b._hudWhy;
    const lt = route === 'lt' || D.mode === 'countdown' || D.mode === 'playing';
    const out = !!b.state && b.state.phase === 'play';
    const fOn = !!b.feather && b.feather.stats.active, tOn = !!b.tug && !b.tug.stats.done;
    W.feather = fOn ? '' : lt ? 'lt' : tOn ? 'tug_on' : !out ? 'feather' : '';
    W.tug = tOn ? '' : lt ? 'lt' : fOn ? 'feather_on' : !out ? 'tug' : '';
    W.laser_tag = !(D.mode === 'offer' || D.mode === 'scorecard') ? 'laser_tag' : fOn ? 'feather_on' : tOn ? 'tug_on' : '';
    E.feather = W.feather === ''; E.tug = W.tug === ''; E.laser_tag = W.laser_tag === '';
  }
  /** Laser Tag, the end card or nap time end a running round (the feather's laser-off is handed over at once) */
  function portGuard(route) {
    const over = route === 'lt' || !!b.endCard || (!!b.state && (b.state.phase === 'nap' || b.state.phase === 'end'));
    if (!over) return;
    if (b.feather && b.feather.stats.active) {
      b.feather.stop(); b.feather.step(0, null, null, null, null); // PORT1 MUST 1: the pending off comes out of the NEXT step()
      if (b.feather.roomEvent) b.session.push(b.feather.roomEvent);
      b._laserGate.owner = null;
    }
    if (b.tug) { b.tug = null; b._tugEndAt = -1; b._tugView.on = false; }
  }
  /** WIRING 4 / 10: the HUD's `feather` / `tug` command toggles its round */
  function portCommand(e, camera, fwd) {
    if (e.action === 'feather' && b.feather) {
      if (b.feather.stats.active) { b.feather.stop(); b._laserGate.owner = null; b._portCap = 'Feather Pop stopped'; } // the off comes from the next step()
      else {
        b.feather.start(portHead(camera, fwd)); b._fStartOff = true; b._laserGate.owner = null; b._fHand = e.hand === 'left' ? 'left' : 'right';
        b._portCap = 'Feather Pop! Snatch it just before a kitten pounces'; gmAnnounce('feather');
      }
    } else if (e.action === 'tug') {
      if (b.tug && !b.tug.stats.done) { b.tug = null; b._tugEndAt = -1; b._tugView.on = false; b._portCap = 'Yarn Tug stopped'; return; }
      const c = tugPick(camera, fwd);
      if (!c) { b.tug = null; b._tugView.on = false; b._portCap = HUD_BLOCKED.no_kitten; return; }
      b.tug = createYarnTug({ seed: ((opts.seed == null ? 1 : opts.seed) + b.time) | 0, kittenId: c.id }); // PORT1 NIT 4: (seed + time) | 0
      b.tugHand = e.hand === 'left' ? 'left' : 'right'; b.tugCat = c.id; b._tugEndAt = -1;
      if (b._laserGate.owner === b.tugHand) { b.session.push({ type: 'laser', on: false, hand: b.tugHand }); b._laserGate.owner = null; } // never a stuck dot from the tug hand
      b._portCap = 'Yarn Tug with ' + (nameOf(c.id) || 'a kitten') + '! Hold to pull, tap in rhythm'; gmAnnounce('tug');
    }
  }
  /** the nearest awake, free kitten in front of the player (not in the box / carried / on a hand / seated / napping) */
  function tugPick(camera, fwd) {
    if (!b.state || !camera) return null;
    const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
    let best = null, bd = T.tugPickM * T.tugPickM;
    for (const c of b.state.cats) {
      if (c.mode === 'inbox' || c.mode === 'carried' || c.mode === 'onhand' || c.support === 'hand' || c.pose === 'nap') continue;
      if (b.seated && b.seated.cat === c.id) continue;
      const dx = c.x - camera.x, dz = c.z - camera.z, d2 = dx * dx + dz * dz;
      if (dx * fx + dz * fz <= 0 || d2 > bd) continue;
      bd = d2; best = c;
    }
    return best;
  }
  /** one frame of the three ports, after the session sub-steps (b.state fresh, simEvents = this frame's), never in Laser Tag */
  function portStep(dt, camera, fwd, srcs, hm, simEvents, targets) {
    const ms = dt * 1000, P = b._port;
    // 1. Feather Pop (WIRING 6-8): step EVERY frame (PORT1 MUST 1), snatch = a select EDGE's ray hit (not on the panel, not the tug hand)
    if (b.feather) {
      const F = b.feather; let snatch = null;
      if (srcs) for (let i = 0; i < 2; i++) {
        const h = i ? 'right' : 'left', sc = srcs[h], on = !!(sc && sc.select), was = b._fSel[h]; b._fSel[h] = on;
        if (!on || was || snatch || !F.stats.active || !F.stats.up || !sc.ray || !sc.ray.o || !sc.ray.d) continue;
        if (hm && hm.suppress[h].all) continue; // a press on the panel belongs to the menu
        if (b.tug && h === b.tugHand) continue;
        const hit = roomRaycast(b.room, sc.ray.o, sc.ray.d); // (edge only: a few per round)
        if (hit) { const sp = b._snatch.p; sp.x = hit.x; sp.y = hit.y; sp.z = hit.z; snatch = b._snatch; b._fHand = h; }
      } else { b._fSel.left = false; b._fSel.right = false; }
      const fo = F.step(ms, portHead(camera, fwd), simEvents, b.state.cats, snatch);
      if (F.roomEvent) b.session.push(F.roomEvent); // pushed once: the session logs it, so a replay stays exact
      for (let i = 0; i < fo.length; i++) {
        const e = fo[i];
        if (e.type === 'point' && e.who === 'you') { portHaptic(b._fHand, 0.6, 45); b._portCap = e.perfect ? 'Perfect steal! +2' : 'Got it!'; }
        else if (e.type === 'point') b._portCap = (nameOf(e.cat) || 'A kitten') + ' got it!';
        else if (e.type === 'too_early') b._portCap = 'Too early: wait for a kitten';
        else if (e.type === 'round_end') { b._portCap = e.winner === 'you' ? 'You win!' : e.winner === 'kittens' ? 'Kittens win!' : 'Draw'; b._laserGate.owner = null; }
      }
      if (F.stats.active) b._laserGate.owner = 'feather'; // a hand's laser-off can never blank the feather's dot
    }
    // 2. Yarn Tug (WIRING 11-13): the hand that started it pulls (trigger / pinch held; a lost hand = let go)
    if (b.tug) {
      const cat = catOf(b.tugCat);
      if ((b._tugEndAt >= 0 && b.time >= b._tugEndAt) || !cat || cat.mode === 'inbox' || cat.mode === 'carried' || cat.mode === 'onhand') {
        if (b._tugEndAt < 0) b._portCap = 'Yarn Tug: ' + (nameOf(b.tugCat) || 'the kitten') + ' had to go';
        b.tug = null; b._tugEndAt = -1; b._tugView.on = false;
      } else {
        const sh = srcs ? srcs[b.tugHand] : null;
        const down = !!(sh && sh.select) && !(hm && hm.suppress[b.tugHand].all);
        const te = b.tug.step(ms, down);
        for (let i = 0; i < te.length; i++) {
          const e = te[i];
          if (e.type === 'tap' && e.who === 'you' && e.rhythm) portHaptic(b.tugHand, 0.25, 20);
          else if (e.type === 'slip' && e.who === 'you') portHaptic(b.tugHand, 0.7, 80);
          else if (e.type === 'round_win') b._portCap = e.who === 'you' ? 'Round to you!' : e.who === 'tie' ? 'Round tied!' : 'Round to ' + (nameOf(b.tugCat) || 'the kitten') + '!';
          else if (e.type === 'win') { b._portCap = e.who === 'you' ? 'You win the tug!' : e.who === 'draw' ? 'Draw!' : (nameOf(b.tugCat) || 'The kitten') + ' wins the tug!'; b._tugEndAt = b.time + T.tugEndS; }
        }
        const V = b._tugView, hp = sh ? (sh.grip || (sh.ray && sh.ray.o) || null) : null;
        if (hp) { V.hand.x = hp.x; V.hand.y = hp.y; V.hand.z = hp.z; }
        else if (camera && !V.on) { V.hand.x = camera.x + (fwd ? fwd.x : 0) * 0.3; V.hand.y = camera.y - 0.45; V.hand.z = camera.z + (fwd ? fwd.z : -1) * 0.3; }
        V.cat.x = cat.x; V.cat.y = cat.y + sizeOf(cat).h * 0.55; V.cat.z = cat.z;
        V.m = b.tug.stats.m; V.t = 0.5 + 0.5 * V.m * 0.6; V.on = true;
      }
    }
    // 3. Kitten Needs (WIRING 16-18): bars for the kitten under a ray (else the nearest out), a hint at most once per 8 s
    if (b.needs) {
      b.needs.step(ms, simEvents, b.state.cats);
      let id = null;
      if (srcs && !(hm && hm.visual.open)) for (let i = 0; i < 2 && id == null; i++) { const sc = srcs[i ? 'right' : 'left']; if (sc && sc.ray) { const c = hudPickCat(targets, sc.ray, null, T.rayPetR); if (c) id = c.id; } }
      if (id == null && camera) { let bd = Infinity; const cs = b.state.cats; for (let i = 0; i < cs.length; i++) { const c = cs[i]; if (c.mode === 'inbox') continue; const dx = c.x - camera.x, dz = c.z - camera.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; id = c.id; } } }
      const v = id == null ? null : b.needs.view(id), N = P.needs;
      if (!v) P.needsKey = '';
      else {
        const h = r10(v.hunger), p = r10(v.play), c = r10(v.cuddle), s = r10(v.sleepy);
        if (!P.needsKey || id !== N.id || h !== N.hunger || p !== N.play || c !== N.cuddle || s !== N.sleepy) {
          N.id = id; N.name = v.name; N.hunger = h; N.play = p; N.cuddle = c; N.sleepy = s; P.needsKey = id + ':' + h + ',' + p + ',' + c + ',' + s;
        }
      }
      const hh = b.needs.hint(), want = hh ? hh.text : null;
      if (want !== P.hintText && (want === null || b.time - P.hintAt >= T.needsHintS)) { P.hintText = want; P.hintAt = b.time; P.hintAction = hh && hh.action !== 'rest' ? hh.action : ''; }
      if (want === null) P.hintAction = '';
    }
    const busy = (!!b.feather && b.feather.stats.active) || !!b.tug;
    if (b.hud) hudSetHint(b.hud, busy ? '' : P.hintAction);
    // 4. the strip's line 2 (WIRING 9 / 14 / 18): rebuilt only when a shown number changes
    if (b.feather && b.feather.stats.active) {
      const s = b.feather.stats, sec = Math.ceil(s.timeLeftMs / 1000);
      if (s.you !== P.fy || s.kittens !== P.fk || sec !== P.fs) { P.fy = s.you; P.fk = s.kittens; P.fs = sec; P.fLine = 'Feather ' + s.you + ' : ' + s.kittens + '  ' + sec + 's'; }
      P.line2 = P.fLine;
    } else if (b.tug) {
      const s = b.tug.stats, puff = r10(s.puff * 100);
      if (s.round !== P.tr || s.you !== P.ty || s.kitten !== P.tk || puff !== P.tp) { P.tr = s.round; P.ty = s.you; P.tk = s.kitten; P.tp = puff; P.tLine = 'Tug R' + s.round + '  ' + s.you + ' : ' + s.kitten + '  puff ' + puff + '%'; }
      P.line2 = P.tLine;
    } else { P.fy = -1; P.ty = -1; P.line2 = P.hintText; }
  }
  function seatPose(simEvents) {
    const st = b.seated; if (!st || !b.state) return;
    const c = catOf(st.cat); if (!c || c.mode !== 'carried') return;
    const purring = b.time < st.purrUntil;
    c.mode = 'onhand'; c.pose = purring ? 'petted' : 'sit'; c.purr = purring || c.purr;
    if (purring && b.time >= st.nextPurr) { st.nextPurr = b.time + ROOMCAT_TUNING.petCdS; simEvents.push({ type: 'purr', cat: c.id, hearts: c.hearts || 0, bond: c.bond || 0, seated: true }); }
  }

  b.openBox = () => { if (b.session) b.session.openBox(); };
  b.dispose = () => {
    b.session = null; b.room = null; b.state = null; b.roomInput = null; b.ready = false; b.reason = null; b.disposed = true;
    b._firstT = null; b._accepted = null; b._keyT = null; b._lastScene = null; b._liveAccepted = null; b.views = {}; b._prebuilt = null;
    b.wand = null; b.hint = null; b.caption = null; b.endCard = null; b.memory = null; b._prevState = null; b._fxPrev = null; b.time = 0;
    b.feather = null; b.tug = null; b.needs = null; // SK-PORT
    b.director = null; b.fx = null; b.hud = null; b.simEvents.length = 0; b.ltCats.length = 0;
    for (const h of T.hands) b.gestures[h] = createGestureState(h);
  };
  return b;
}

// ---------------------------------------------------------------- the slim Games Master pack (Q-GE2 public-scan fix 2026-10-12)
/* GM_PACK = a byte-for-byte copy of GAME_PACK from vr/src/pawdb/packs.gen.js (generated by pawdb/tools/build-vr-packs.mjs).
   It lives here because packs.gen.js also bundles the Work packs and stays out of the public repo (ops/PUBLIC-REPO.md sec. 11:
   vr/src/pawdb/** not published). vr/test/room-bridge.test.mjs fails if the two drift: after a pack rebuild, re-copy the
   GAME_PACK object literal here. Read only at bridge start (module evaluation is complete by then). */
export const GM_PACK = gmDeepFreeze({
 "cues": [
  {
   "behaviour": "notice",
   "blockedDuring": [
    "countdown",
    "last10s",
    "rulesCaption",
    "safety",
    "driving",
    "peekaboo",
    "exit",
    "scoreCard"
   ],
   "card": {
    "buttons": [
     {
      "id": "keep_calm",
      "label": "Keep calm sneezes"
     },
     {
      "id": "full",
      "label": "Full sneezes"
     }
    ],
    "text": "Heads-up: when the Games Master sneezes, his fur shimmers and changes. Calm sneezes is on: one gentle fur change. Want the full sneeze? Settings > Accessibility > Calm sneezes."
   },
   "followUps": {
    "full": [
     {
      "id": "psn-full-1",
      "line1": "Full sneeze-tacle! Bless me in advance, pals.",
      "line2": "Change it anytime: Settings > Accessibility > Calm sneezes"
     },
     {
      "id": "psn-full-2",
      "line1": "The big ACHOO is on! Hold onto your hats.",
      "line2": "Change it anytime: Settings > Accessibility > Calm sneezes"
     }
    ],
    "keep_calm": [
     {
      "id": "psn-calm-1",
      "line1": "Calm sneezes it is! Soft and slow, just for you.",
      "line2": "Change it anytime: Settings > Accessibility > Calm sneezes"
     },
     {
      "id": "psn-calm-2",
      "line1": "Hush-hush sneezes! One gentle fur change at a time.",
      "line2": "Change it anytime: Settings > Accessibility > Calm sneezes"
     }
    ]
   },
   "id": "pre_sneeze_notice",
   "oncePerProfile": true,
   "tone": "warm",
   "variants": [
    {
     "id": "psn-1",
     "line1": "Pals, a tiny heads-up before my first sneeze!",
     "line2": "Read the card, pick a button, then on with the show."
    },
    {
     "id": "psn-2",
     "line1": "Hold the applause: one quick note about my nose.",
     "line2": "Pick a button and we play on."
    },
    {
     "id": "psn-3",
     "line1": "Whiskers twitching... a sneeze is coming. First, this:",
     "line2": "Your pick, pals. Then round time!"
    }
   ],
   "waitsForAnswer": true
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "last10s",
    "rulesCaption",
    "safety",
    "driving",
    "peekaboo",
    "exit"
   ],
   "cooldownS": 6,
   "id": "sneeze_quip",
   "tone": "showman",
   "variants": [
    {
     "id": "sq-1",
     "line1": "Ah-CHOO! Pardon the fur-works, pals!"
    },
    {
     "id": "sq-2",
     "line1": "Gesundheit to me! New fur, same fabulous hat."
    },
    {
     "id": "sq-3",
     "line1": "ACHOO! Did my stripes just move? Never mind. ROUND TIME!"
    },
    {
     "id": "sq-4",
     "line1": "Sneeze-tacular! Fresh fur, fresh round."
    },
    {
     "id": "sq-5",
     "line1": "Bless me! The hat stays, the fur never does."
    },
    {
     "id": "sq-6",
     "line1": "Ah-choo! Allergic to losing, clearly. On we go!"
    }
   ]
  },
  {
   "behaviour": "B1",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "id": "arc_intro",
   "oncePerSession": true,
   "tone": "showman",
   "variants": [
    {
     "id": "ai-1",
     "line1": "Paws up, pals! The Games Master is in the house.",
     "line2": "Your room is the arena. Let the games begin!"
    },
    {
     "id": "ai-2",
     "line1": "Ta-da! Welcome to YOUR living-room arena!",
     "line2": "Hands ready. Kittens ready. Showtime!"
    },
    {
     "id": "ai-3",
     "line1": "Hats off, whiskers on! Round one is on your rug.",
     "line2": "Point, pounce, cheer. That is the whole job."
    }
   ]
  },
  {
   "behaviour": "B2",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "id": "arc_laser_rules",
   "oncePerSession": true,
   "tone": "showman",
   "variants": [
    {
     "id": "alr-1",
     "line1": "Point your finger. The dot is yours!",
     "line2": "Every pounce has a tell. Catch or whisker-close!"
    },
    {
     "id": "alr-2",
     "line1": "ROUND 1: Keep the dot alive on YOUR floor.",
     "line2": "Watch the crouch, then move the dot. Simple!"
    }
   ]
  },
  {
   "behaviour": "B1",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_countdown",
   "tone": "hype",
   "variants": [
    {
     "id": "acd-1",
     "line1": "3... 2... 1... POUNCE!"
    },
    {
     "id": "acd-2",
     "line1": "Paws on the mark... 3, 2, 1... GO, kittens, GO!"
    },
    {
     "id": "acd-3",
     "line1": "Ready paws? 3... 2... 1... Let the fur fly!"
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_near_miss",
   "tone": "hype",
   "variants": [
    {
     "id": "anm-1",
     "line1": "Whisker-close! That dot felt the breeze."
    },
    {
     "id": "anm-2",
     "line1": "SO close! The crowd gasps (mew mew!)"
    },
    {
     "id": "anm-3",
     "line1": "Near miss! Keep that dot dancing."
    },
    {
     "id": "anm-4",
     "line1": "Oooh, close one! The dot lives another second."
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_catch",
   "tone": "hype",
   "variants": [
    {
     "id": "ac-1",
     "line1": "CAUGHT! Pinned it like a pro."
    },
    {
     "id": "ac-2",
     "line1": "Gotcha! A clean catch on your floor!"
    },
    {
     "id": "ac-3",
     "line1": "Dot down! The kittens cheer from the couch."
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_combo",
   "tone": "hype",
   "variants": [
    {
     "id": "acb-1",
     "line1": "COMBO! Three catches, hearts everywhere!"
    },
    {
     "id": "acb-2",
     "line1": "Triple catch! That is a hat trick, my hat approves."
    },
    {
     "id": "acb-3",
     "line1": "Combo time! The whole couch is mewing for you."
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_streak",
   "tone": "hype",
   "variants": [
    {
     "id": "ast-1",
     "line1": "Streak x2! Keep the dot slippery!"
    },
    {
     "id": "ast-2",
     "line1": "x3 and climbing! Whisker-dodging royalty."
    },
    {
     "id": "ast-3",
     "line1": "Streak alive! The dot is a legend tonight."
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 8,
   "id": "arc_wand_leap",
   "tone": "showman",
   "variants": [
    {
     "id": "awl-1",
     "line1": "BIG LEAP! Straight onto your table!"
    },
    {
     "id": "awl-2",
     "line1": "Whoa, airborne kitten! That wand has power."
    },
    {
     "id": "awl-3",
     "line1": "Sky-high pounce! Ten out of ten, judges agree."
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_treat",
   "tone": "warm",
   "variants": [
    {
     "id": "atr-1",
     "line1": "Snack break! Hearts all round."
    },
    {
     "id": "atr-2",
     "line1": "Nom nom. A happy kitten is a loud kitten."
    },
    {
     "id": "atr-3",
     "line1": "Treat delivered! The crowd purrs."
    }
   ]
  },
  {
   "behaviour": "B1",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "followUps": {
    "ten_left": [
     {
      "id": "azf-10-1",
      "line1": "Ten seconds! Dash, dash, DASH!"
     },
     {
      "id": "azf-10-2",
      "line1": "Final ten! Give them a cheer!"
     }
    ]
   },
   "id": "arc_zoomies_final",
   "oncePerSession": true,
   "tone": "hype",
   "variants": [
    {
     "id": "azf-1",
     "line1": "FINAL ROUND: ZOOMIES! Clear the runway, pals!"
    },
    {
     "id": "azf-2",
     "line1": "Last round! Zoomies on YOUR rug. Hold onto your hat!"
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_round_end",
   "tone": "warm",
   "variants": [
    {
     "id": "are-1",
     "line1": "Great round! Hearts for everyone."
    },
    {
     "id": "are-2",
     "line1": "Round done! The kittens take a bow."
    },
    {
     "id": "are-3",
     "line1": "That was a show! Golden yarn ball for you."
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "arc_new_best",
   "tone": "hype",
   "variants": [
    {
     "id": "anb-1",
     "line1": "NEW BEST! The crowd goes wild (mew mew!)"
    },
    {
     "id": "anb-2",
     "line1": "Personal best! Golden yarn ball, well deserved."
    }
   ]
  },
  {
   "behaviour": "B7",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "id": "rest_offer",
   "oncePerSession": true,
   "tone": "warm",
   "variants": [
    {
     "id": "aro-1",
     "line1": "Great games. Time for a stretch?",
     "line2": "The kittens are napping. Take a break too!"
    },
    {
     "id": "aro-2",
     "line1": "What a show! Rest those hands, champ.",
     "line2": "Come back whenever you like. We will be napping."
    },
    {
     "id": "aro-3",
     "line1": "Curtain call! Water, stretch, blink.",
     "line2": "The arena will be right here."
    }
   ]
  },
  {
   "behaviour": "B2",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "poke_repeat_rules",
   "tone": "showman",
   "variants": [
    {
     "id": "prr-1",
     "line1": "Rules again? Happily!",
     "line2": "Point your finger. The dot is yours!"
    },
    {
     "id": "prr-2",
     "line1": "Once more for the back row:",
     "line2": "Watch the crouch, then move the dot. Simple!"
    }
   ]
  },
  {
   "behaviour": "dodge",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "restOffer",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 6,
   "followUps": {
    "again": [
     {
      "id": "nd-ag-1",
      "line1": "Still asking? Still dodging. Still fabulous."
     },
     {
      "id": "nd-ag-2",
      "line1": "Persistent! I like it. Use it on that dot."
     },
     {
      "id": "nd-ag-3",
      "line1": "A magician never tells. Neither does a cat in a top hat."
     }
    ]
   },
   "id": "name_dodge",
   "tone": "deflect",
   "variants": [
    {
     "id": "nd-1",
     "line1": "My name? Ha! Names are for collars. ROUND TIME!"
    },
    {
     "id": "nd-2",
     "line1": "Call me the Games Master. Now, who wants a countdown?"
    },
    {
     "id": "nd-3",
     "line1": "A name? Sshh, the kittens are listening. 3... 2... 1..."
    },
    {
     "id": "nd-4",
     "line1": "Ask the hat. The hat says: play another round!"
    },
    {
     "id": "nd-5",
     "line1": "Names, schmames! Look, a dot on YOUR couch!"
    },
    {
     "id": "nd-6",
     "line1": "I answer to 'Games Master' and to snacks. Mostly snacks."
    },
    {
     "id": "nd-7",
     "line1": "Ooh, a mystery! Solve this one first: catch that dot."
    },
    {
     "id": "nd-8",
     "line1": "Top secret, pals. Even the hat does not know."
    },
    {
     "id": "nd-9",
     "line1": "Who, me? The Games Master, at your service. Showtime!"
    },
    {
     "id": "nd-10",
     "line1": "My name is... oh look, a kitten doing zoomies!"
    }
   ]
  },
  {
   "behaviour": "dodge",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "restOffer",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 6,
   "followUps": {
    "again": [
     {
      "id": "db-ag-1",
      "line1": "Still no. Still a cat. Still your host. Play on!"
     },
     {
      "id": "db-ag-2",
      "line1": "You again! The answer is dots. The question was dots."
     },
     {
      "id": "db-ag-3",
      "line1": "Ask the kittens. They know nothing. Neither do I."
     }
    ]
   },
   "id": "dodge_b",
   "tone": "deflect",
   "variants": [
    {
     "id": "db-1",
     "line1": "Me? A WHAT? Never. Ahem. Who wants a countdown?"
    },
    {
     "id": "db-2",
     "line1": "Nope! Just a cat in a very good hat. ROUND TIME!"
    },
    {
     "id": "db-3",
     "line1": "Pfft, rumours. Look, a dot on YOUR rug!"
    },
    {
     "id": "db-4",
     "line1": "Absolutely not. Also, is that a kitten on your table?"
    },
    {
     "id": "db-5",
     "line1": "That? That is a regular tail. Very regular. 3... 2... 1..."
    },
    {
     "id": "db-6",
     "line1": "I was never anything but fabulous. Next question: dots?"
    },
    {
     "id": "db-7",
     "line1": "Nuh-uh. Hay fever, pals. Now, pounce practice!"
    },
    {
     "id": "db-8",
     "line1": "Denied, declined, and dancing away. Showtime!"
    },
    {
     "id": "db-9",
     "line1": "No comment, no past, no problem. Round two?"
    },
    {
     "id": "db-10",
     "line1": "Ha! Where do kittens get these ideas? Point that finger!"
    }
   ]
  },
  {
   "behaviour": "B2",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "id": "lt_rules",
   "oncePerSession": true,
   "tone": "showman",
   "variants": [
    {
     "id": "ltr-1",
     "line1": "LASER TAG! Keep your dot away from the kittens.",
     "line2": "Caught = benched to the Nap Zone. Survive the round!"
    },
    {
     "id": "ltr-2",
     "line1": "Your dot vs seven sneaky kittens.",
     "line2": "Dodge the pounce, chase the streak. Ready?"
    }
   ]
  },
  {
   "behaviour": "B1",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "followUps": {
    "countdown": [
     {
      "id": "lti-cd-1",
      "line1": "3... 2... 1... POUNCE!"
     },
     {
      "id": "lti-cd-2",
      "line1": "Lasers ready... 3, 2, 1... GO!"
     }
    ]
   },
   "id": "lt_round_intro",
   "tone": "hype",
   "variants": [
    {
     "id": "lti-1",
     "line1": "ROUND 1! Point your finger. Keep the dot alive!"
    },
    {
     "id": "lti-2",
     "line1": "Next round! More kittens, more glory."
    },
    {
     "id": "lti-3",
     "line1": "Here we go again! The dot must survive."
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 6,
   "id": "lt_near_miss",
   "tone": "hype",
   "variants": [
    {
     "id": "ltn-1",
     "line1": "Whisker-close! +50"
    },
    {
     "id": "ltn-2",
     "line1": "Dodged! The kitten pounced on thin air."
    },
    {
     "id": "ltn-3",
     "line1": "Oooh, that was tight! +50"
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 6,
   "id": "lt_streak",
   "tone": "hype",
   "variants": [
    {
     "id": "lts-1",
     "line1": "Streak x2! Every dodge counts double!"
    },
    {
     "id": "lts-2",
     "line1": "x3! Triple points, the couch is cheering (mew!)"
    },
    {
     "id": "lts-3",
     "line1": "Streak on fire! Keep weaving!"
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving"
   ],
   "cooldownS": 15,
   "id": "lt_comeback",
   "tone": "hype",
   "variants": [
    {
     "id": "ltc-1",
     "line1": "COMEBACK! Out of the kitten pile!"
    },
    {
     "id": "ltc-2",
     "line1": "Slippery dot! Three kittens, zero catches."
    },
    {
     "id": "ltc-3",
     "line1": "What an escape! The crowd is on its paws."
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 6,
   "id": "lt_cat_joins",
   "tone": "showman",
   "variants": [
    {
     "id": "ltj-1",
     "line1": "A new challenger pads in!"
    },
    {
     "id": "ltj-2",
     "line1": "More kittens! The stakes just grew whiskers."
    },
    {
     "id": "ltj-3",
     "line1": "Fresh paws on the floor. Stay sharp!"
    }
   ]
  },
  {
   "behaviour": "B3",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "lt_benched",
   "tone": "warm",
   "variants": [
    {
     "id": "ltb-1",
     "line1": "Mochi is benched to the Nap Zone!"
    },
    {
     "id": "ltb-2",
     "line1": "Caught! Off to the Nap Zone, little champ."
    },
    {
     "id": "ltb-3",
     "line1": "Nap Zone for that one. Purrs all round."
    }
   ]
  },
  {
   "behaviour": "B1",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "lt_final_ten",
   "tone": "hype",
   "variants": [
    {
     "id": "ltf-1",
     "line1": "Ten seconds! Hold that dot!"
    },
    {
     "id": "ltf-2",
     "line1": "Final ten! New best coming... maybe!"
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "followUps": {
    "again": [
     {
      "id": "lte-ag-1",
      "line1": "Again? The arena is yours."
     },
     {
      "id": "lte-ag-2",
      "line1": "One more? Say the word, pinch the tile."
     }
    ]
   },
   "id": "lt_round_end",
   "tone": "warm",
   "variants": [
    {
     "id": "lte-1",
     "line1": "Round over! What a show, pals."
    },
    {
     "id": "lte-2",
     "line1": "Time! The kittens take a bow."
    },
    {
     "id": "lte-3",
     "line1": "Great games! Hearts and a golden yarn ball."
    }
   ]
  },
  {
   "behaviour": "B6",
   "blockedDuring": [
    "countdown",
    "safety",
    "driving"
   ],
   "cooldownS": 6,
   "id": "lt_new_best",
   "tone": "hype",
   "variants": [
    {
     "id": "ltnb-1",
     "line1": "NEW BEST! The crowd goes wild (mew mew!)"
    },
    {
     "id": "ltnb-2",
     "line1": "Personal best! Trophy pose, golden yarn ball."
    }
   ]
  },
  {
   "behaviour": "B7",
   "blockedDuring": [
    "safety",
    "driving"
   ],
   "cooldownS": 60,
   "id": "lt_rest_offer",
   "tone": "warm",
   "variants": [
    {
     "id": "ltro-1",
     "line1": "Three rounds! Stretch those paws?",
     "line2": "Rest or Again: your call, champ."
    },
    {
     "id": "ltro-2",
     "line1": "Great games. Take a break!",
     "line2": "The kittens will nap until you are back."
    }
   ]
  },
  {
   "behaviour": "B4",
   "blockedDuring": [
    "countdown",
    "rulesCaption",
    "restOffer",
    "safety",
    "driving",
    "last10s"
   ],
   "cooldownS": 30,
   "followUps": {
    "accept": [
     {
      "id": "sp-ok-1",
      "line1": "Yes! Switching arenas. Kittens, places!"
     },
     {
      "id": "sp-ok-2",
      "line1": "Excellent choice. New game, same hat."
     }
    ],
    "ignore": [
     {
      "id": "sp-no-1",
      "line1": "Another time, then. Play on!"
     }
    ]
   },
   "id": "suggest_play",
   "tone": "playful",
   "variants": [
    {
     "id": "sp-1",
     "line1": "Psst, pals. I spy a new game in your room!",
     "line2": "Pinch the tile to try it. Or not. No pressure."
    },
    {
     "id": "sp-2",
     "line1": "New idea! Your furniture is begging to join in.",
     "line2": "Pinch to play, ignore to pass."
    },
    {
     "id": "sp-3",
     "line1": "Fancy something different? I found a spot.",
     "line2": "Pinch the tile and we switch."
    }
   ]
  }
 ],
 "manifest": {
  "field": "Game design / hosting",
  "id": "games-master",
  "kind": "game-design",
  "title": "The Games Master",
  "version": "0.1.0"
 },
 "modes": [
  {
   "goal": {
    "line1": "Keep the dot alive. Every pounce has a tell."
   },
   "id": "arc_laser",
   "knobs": [
    {
     "default": 0.25,
     "id": "pounce_tell_s",
     "max": 0.45,
     "min": 0.15,
     "step": 0.05,
     "unit": "s"
    },
    {
     "default": 1.2,
     "id": "pounce_cd_s",
     "max": 2,
     "min": 0.8,
     "step": 0.1,
     "unit": "s"
    },
    {
     "default": 0.05,
     "id": "catch_radius_m",
     "max": 0.08,
     "min": 0.03,
     "step": 0.01,
     "unit": "m"
    },
    {
     "default": 0.1,
     "id": "near_miss_band_m",
     "max": 0.15,
     "min": 0.08,
     "step": 0.01,
     "unit": "m"
    },
    {
     "default": 10,
     "id": "combo_window_s",
     "max": 14,
     "min": 6,
     "step": 1,
     "unit": "s"
    }
   ],
   "name": "Play arc: laser chase",
   "rules": [
    {
     "line1": "Point your finger. The dot is yours!"
    },
    {
     "line1": "Watch the crouch, then move the dot. Simple!"
    }
   ]
  },
  {
   "goal": {
    "line1": "Swing the wand. Make a kitten fly!"
   },
   "id": "arc_wand",
   "knobs": [
    {
     "default": 1.5,
     "id": "leap_speed_mps",
     "max": 2.5,
     "min": 1,
     "step": 0.1,
     "unit": "m/s"
    },
    {
     "default": 8,
     "id": "leap_cd_s",
     "max": 12,
     "min": 4,
     "step": 1,
     "unit": "s"
    }
   ],
   "name": "Play arc: wand",
   "rules": [
    {
     "line1": "Fast swing = BIG LEAP onto your table."
    }
   ]
  },
  {
   "goal": {
    "line1": "Final round: zoomies! Cheer them on."
   },
   "id": "arc_zoomies",
   "knobs": [
    {
     "default": 450,
     "id": "final_round_at_s",
     "max": 480,
     "min": 420,
     "step": 10,
     "unit": "s"
    },
    {
     "default": 10,
     "id": "chip_at_s_left",
     "max": 15,
     "min": 5,
     "step": 1,
     "unit": "s"
    }
   ],
   "name": "Play arc: final round zoomies",
   "rules": [
    {
     "line1": "Clear the runway. Dash, dash, DASH!"
    }
   ]
  },
  {
   "goal": {
    "line1": "Survive the round. Keep the dot away from the kittens."
   },
   "id": "lasertag_vr",
   "knobs": [
    {
     "default": 0,
     "id": "assist_pct",
     "max": 30,
     "min": -20,
     "step": 5,
     "unit": "%"
    },
    {
     "default": 0.04,
     "id": "coach_pounce_p",
     "max": 0.1,
     "min": 0.02,
     "step": 0.01
    },
    {
     "default": 2600,
     "id": "coach_cd_ms",
     "max": 3200,
     "min": 1400,
     "step": 200,
     "unit": "ms"
    },
    {
     "default": 2,
     "id": "streak_x2_at",
     "max": 3,
     "min": 2,
     "step": 1
    },
    {
     "default": 4,
     "id": "streak_x3_at",
     "max": 6,
     "min": 4,
     "step": 1
    },
    {
     "default": 12,
     "id": "streak_dry_s",
     "max": 16,
     "min": 8,
     "step": 1,
     "unit": "s"
    },
    {
     "default": 12,
     "id": "join_pace_s",
     "max": 20,
     "min": 6,
     "step": 1,
     "unit": "s"
    }
   ],
   "name": "VR Laser Tag",
   "rules": [
    {
     "line1": "Caught = benched to the Nap Zone. Dodge the pounce!"
    },
    {
     "line1": "Streaks of dodges score double, then triple."
    }
   ]
  }
 ],
 "plays": [
  {
   "caption": {
    "line1": "Couch Pounce! Run the dot along YOUR couch."
   },
   "game": "arc_laser",
   "id": "play_couch_pounce",
   "label": "couch"
  },
  {
   "caption": {
    "line1": "Table-top Laser! Dot on the table, kittens below."
   },
   "game": "arc_laser",
   "id": "play_table_laser",
   "label": "table"
  },
  {
   "caption": {
    "line1": "Box Ambush! Kittens pop from behind YOUR box."
   },
   "game": "lasertag_vr",
   "id": "play_box_ambush",
   "label": "box"
  },
  {
   "caption": {
    "line1": "Shelf Ambush! Peekaboo kittens, laser ready."
   },
   "game": "lasertag_vr",
   "id": "play_storage_ambush",
   "label": "storage"
  },
  {
   "caption": {
    "line1": "Rug Laser! The virtual rug is your arena."
   },
   "game": "arc_laser",
   "id": "play_rug_laser",
   "label": "none"
  },
  {
   "caption": {
    "line1": "Try Laser Tag? Seven kittens, one dot, your rug."
   },
   "game": "lasertag_vr",
   "id": "play_rug_lasertag",
   "label": "rug"
  }
 ],
 "tuning": [
  {
   "hidden": true,
   "id": "lt_assist_up",
   "knob": "assist_pct",
   "max": 30,
   "min": 0,
   "mode": "lasertag_vr",
   "signal": "first_catch_under_15s",
   "step": 15
  },
  {
   "hidden": true,
   "id": "lt_assist_down",
   "knob": "assist_pct",
   "max": 0,
   "min": -20,
   "mode": "lasertag_vr",
   "signal": "round_over_90s",
   "step": -10
  },
  {
   "hidden": true,
   "id": "lt_coach_ease",
   "knob": "coach_pounce_p",
   "max": 0.04,
   "min": 0.02,
   "mode": "lasertag_vr",
   "signal": "r1_first_catch_under_10s",
   "step": -0.01
  },
  {
   "hidden": true,
   "id": "lt_join_slow",
   "knob": "join_pace_s",
   "max": 18,
   "min": 12,
   "mode": "lasertag_vr",
   "signal": "quick_losses_2",
   "step": 2
  },
  {
   "hidden": true,
   "id": "lt_join_fast",
   "knob": "join_pace_s",
   "max": 12,
   "min": 8,
   "mode": "lasertag_vr",
   "signal": "long_rounds_2_over_90s",
   "step": -2
  }
 ]
});
function gmDeepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) gmDeepFreeze(v); } return o; }

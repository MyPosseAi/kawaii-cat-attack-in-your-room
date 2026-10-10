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

export const BRIDGE_VERSION = 3; // 2: laser clipped by walls / furniture sides, box pinch 0.15 m, treat view gate, input hint
                                 // 3 (W3): posture-aware treat (floorY), feather wand + basket, onboarding hints + captions, end card
export const BRIDGE_TUNING = Object.freeze({
  settleS: 1.0,       // the scene must be unchanged this long before the room is built (planes refine for a while)
  noScanS: 3.0,       // nothing detected after this -> virtual rug (plan 1.1, never dead-end)
  maxWaitS: 8.0,      // a scene that keeps changing is used anyway after this
  hands: ['left', 'right'],
  laserMaxM: 6,       // the finger laser ray reaches this far
  boxPinchM: 0.15,    // a NEW pinch opens the box only this close to its lid (roomcat's own rule is 0.3 m: pinches in the
                      // 0.15..0.3 m ring are swallowed here so a stray pinch near the box cannot pop it open)
  hintAfterS: 2.0,    // controllers tracked and no hands for this long -> "Put your controllers down" hint
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

/** Change key of a scene snapshot: ids + lastChangedTime of every plane / mesh (cheap; no geometry compare). */
export function sceneKey(scene) {
  const part = (list, tag) => (list || []).map((o) => `${tag}:${o.id}:${o.lastChangedTime == null ? '' : Math.round(o.lastChangedTime)}`).sort().join('|');
  return part(scene && scene.planes, 'p') + '#' + part(scene && scene.meshes, 'm');
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
    gestures: {}, views: {}, loop: createFixedLoop({ stepMs: STEP_MS, maxStepsPerFrame: 5, maxFrameMs: 250 }),
    // W3: wand / hints / captions / end card (all plain data from the pure modules)
    wand: null, progress: createProgress(), hints: createHintState(), captions: createCaptionState(), hint: null, caption: null, endCard: null, memory: null, time: 0,
    _firstT: null, _key: null, _keyT: null, _lastScene: null, _lastViewer: null, _lastForward: null, _lastFloorY: 0, _liveKey: null,
    _scratch: {}, _prevState: null,
  };
  for (const h of T.hands) b.gestures[h] = createGestureState(h);

  b.observe = (scene, viewer, forward, floorY, t) => {
    const key = sceneKey(scene);
    const n = (scene.planes ? scene.planes.length : 0) + (scene.meshes ? scene.meshes.length : 0);
    if (b.session) { if (key !== b._liveKey) { b._liveKey = key; b.rescans++; if (onLog) onLog(`room changed mid-session (${n} objects), applied on the next session`); } return; }
    if (b._firstT == null) b._firstT = t;
    if (key !== b._key) { b._key = key; b._keyT = t; }
    b._lastScene = scene; b._lastViewer = viewer; b._lastForward = forward; b._lastFloorY = floorY;
    const since = t - b._firstT, stable = t - b._keyT;
    if (n > 0 && stable >= T.settleS) { b.ready = true; b.reason = 'settled'; }
    else if (n === 0 && since >= T.noScanS) { b.ready = true; b.reason = 'no_scan'; }
    else if (since >= T.maxWaitS) { b.ready = true; b.reason = 'timeout'; }
  };

  b.start = () => {
    const input = buildRoomInput(b._lastScene || { planes: [], meshes: [] }, b._lastViewer, b._lastForward, b._lastFloorY);
    b.roomInput = input;
    b.room = createRoom(input);
    b._liveKey = b._key;
    // W4 kitten memory (return-visit.js): a remembered kitten heads to its favourite spot in THIS room (matched by label)
    let cats = opts.cats == null ? 3 : opts.cats;
    if (opts.memory && Array.isArray(cats)) {
      const fav = spotsForRoom(opts.memory, b.room, cats.map((c) => (c && c.id != null ? String(c.id) : '')));
      cats = cats.map((c) => (c && fav[c.id] ? Object.assign({}, c, { napSurf: fav[c.id] }) : c));
    }
    b.session = createRoomSession({ room: b.room, seed: opts.seed == null ? 1 : opts.seed, cats, size: opts.size || 'kitten', arc: opts.arc !== false });
    b.loop.reset();
    b.state = b.session.state();
    b.time = 0; b.progress = createProgress(); b.hints = createHintState(); b.captions = createCaptionState(); b.hint = null; b.caption = null; b.endCard = null; b.memory = null; b._prevState = null;
    b.wand = createWandState(placeBasket(b.room, input.viewer, input.forward, input.floorY, !!opts.leftHanded));
    if (onLog) {
      const legal = b.room.surfaces.filter((s) => s.legal).map((s) => `${s.kind}:${s.label}`).join(', ');
      onLog(`room built (${b.reason}): ${input.planes.length} planes, ${input.meshes.length} meshes${b.room.rug ? ', virtual rug' : ''}; legal: ${legal || 'none'}`);
    }
    return b.room;
  };

  /** dt seconds; handSamples from readHands (or tests); camera head { x, y, z }; gaze unit direction (optional); floorY
   *  (optional: the treat's lap line is posture-aware with it, seated without it) */
  b.frame = (dt, handSamples, camera, gaze, floorY) => {
    if (!b.session) return { cats: [], views: {}, state: null, events: [], wand: null, hint: null, hintChanged: false, caption: null, captionChanged: false, endCard: null, memory: null };
    b.time += dt;
    const targets = b.state ? b.state.cats.filter((c) => c.mode !== 'inbox' && c.support !== 'hand').map(catBackPoint) : [];
    const ctx = { room: b.room, laserMaxM: T.laserMaxM, boxPinchM: T.boxPinchM, box: b.state && b.state.box };
    const view = camera && Number.isFinite(camera.y) ? { head: camera, gaze: gaze || null, floorY: Number.isFinite(floorY) ? floorY : undefined } : null;
    // the viewer's flat forward (for the wand's feather direction): from the gaze, else the room's build forward
    let fwd = b.roomInput ? b.roomInput.forward : { x: 0, z: -1 };
    if (gaze && (Math.abs(gaze.x) > 1e-6 || Math.abs(gaze.z) > 1e-6)) fwd = { x: gaze.x, z: gaze.z };
    const wctx = { room: b.room, forward: fwd, t: b.time };
    const events = [];
    const byHand = {};
    for (const s of handSamples || []) if (s && b.gestures[s.hand]) byHand[s.hand] = s;
    for (const h of T.hands) {
      const r = gestureStep(b.gestures[h], byHand[h] || null, targets, null, view);
      b.gestures[h] = r.state;
      for (const ev of r.events) {
        // the wand sees every gesture first: a pinch at its handle picks it up (that pinch is not a scruff / box pinch)
        const w = wandStep(b.wand, ev, wctx);
        b.wand = w.state;
        for (const we of w.events) events.push(we);
        if (w.consumed) continue;
        for (const re of gestureToRoomEvents(ev, ctx)) events.push(re);
      }
    }
    b.wand = wandStep(b.wand, null, wctx).state; // time-only rules (a dropped wand returns to the basket)
    const n = b.loop.advance(dt * 1000);
    if (n > 0) {
      b.session.step(events); // all of this frame's events apply on its first step (logged with that tick)
      for (let i = 1; i < n; i++) b.session.step();
      b.state = b.session.state();
    } else if (events.length) {
      for (const e of events) b.session.push(e); // no step this frame: queue for the next one (no event is dropped)
    }
    const bb = catsToBillboards(b.state, b.room, camera || { x: 0, y: 1.2, z: 0 }, b.views);
    b.views = bb.views;
    // W3: what the player has done -> the onboarding hint; sound cues -> caption; the end card once due
    b.progress = progressStep(b.progress, events, b.state);
    const hr = hintStep(b.hints, Object.assign({ t: b.time, phase: b.state.phase, box: b.state.box }, b.progress));
    b.hints = hr.state; b.hint = hr.hint;
    const cr = captionStep(b.captions, n > 0 ? soundCues(b.state, b._prevState) : [], b.time);
    b.captions = cr.state; b.caption = cr.caption;
    if (n > 0) b._prevState = b.state;
    if (!b.endCard && endCardDue(b.state, b.time)) {
      b.endCard = buildEndCard({ state: b.state, room: b.room, roster: opts.roster || b.state.cats.map((c) => c.id), visit: opts.visit || 1, names: opts.names, persisted: opts.persisted === true, playedS: b.time });
      // W4: the memory to SAVE (new object: yesterday's memory + this session's bond gains, first-met visit, nap spot as
      // kind + label words only); the host writes it with return-visit.js writeMemory (main.js, at the end card)
      b.memory = rememberSession(opts.memory || null, b.state, b.room, opts.visit || 1, opts.roster || b.state.cats.map((c) => c.id));
      if (onLog) onLog('end card');
    }
    return { cats: bb.cats, views: bb.views, state: b.state, events, wand: wandView(b.wand), hint: b.hint, hintChanged: hr.changed, caption: b.caption, captionChanged: cr.changed, endCard: b.endCard, memory: b.memory };
  };

  b.openBox = () => { if (b.session) b.session.openBox(); };
  b.dispose = () => {
    b.session = null; b.room = null; b.state = null; b.roomInput = null; b.ready = false; b.reason = null; b.disposed = true;
    b._firstT = null; b._key = null; b._keyT = null; b._lastScene = null; b._liveKey = null; b.views = {};
    b.wand = null; b.hint = null; b.caption = null; b.endCard = null; b.memory = null; b._prevState = null; b.time = 0;
    for (const h of T.hands) b.gestures[h] = createGestureState(h);
  };
  return b;
}

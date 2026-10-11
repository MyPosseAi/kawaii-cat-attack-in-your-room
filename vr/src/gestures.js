/* vr/src/gestures.js - week 2: hand gestures from raw WebXR Hand Input joints (plan 1.2).
   Gaming Engineer 2, 2026-10-09. PURE functions, no DOM / WebXR / three dependency, so node tests (vr/test/gestures.test.mjs)
   run recorded joint traces through the same code the headset runs.
   Input per hand per frame = a sample { hand: 'left' | 'right', t (seconds), joints: { [jointName]: { x, y, z } } } in the
   local-floor frame (metres). The host (room-bridge.js readHands) fills it from XRFrame.fillPoses / getJointPose; a missing
   or null sample = that hand is not tracked this frame.
   Output of gestureStep: { state, events, features }. Events (one hand each):
     { type: 'move', hand, p }                     every tracked frame (host contract, plan 2.9): p = pinch point while
                                                   pinching, else the palm centre
     { type: 'pinch_start' | 'pinch_hold' | 'pinch_release', hand, p, v? }   thumb tip to index tip < pinchOn (2.0 cm), off
                                                   above pinchOff (3.5 cm); v = mean palm velocity over the last velFrames
     { type: 'point_start' | 'point_hold' | 'point_end', hand, origin, dir }   index straight + middle / ring / pinky curled
                                                   for pointHoldS: a laser ray from the index tip along knuckle -> tip, EMA-smoothed (rayEma)
     { type: 'palm_start' | 'palm_hold' | 'palm_end', hand, p, normal }       open hand, palm facing UP, still for palmHoldS
                                                   (treat); once on, the palm may move (the cat follows it). With a `view`
                                                   ({ head, gaze, floorY }) it only STARTS while the palm is inside the head's
                                                   view cone and above the posture-aware lap line (W2 review SHOULD 1: a hand
                                                   resting palm-up on the lap is not a treat; a standing player reaching down
                                                   to a floor cat is), and ends when the palm drops to the lap
     { type: 'pet_start' | 'pet_hold' | 'pet_end', hand, p, target, v }       open hand moving slowly (petVMin..petVMax)
                                                   within petNear of a target point, palm facing it, for petHoldS
     { type: 'lost', hand }                         tracking lost (every active gesture ends first: a pinch releases at v = 0)
   Hysteresis everywhere (on / off thresholds + grace times), ONE gesture active per hand (pinch > point > palm > pet). */

export const GESTURES_VERSION = 5; // 2: straightness from the knuckle, palm normal from the knuckles, view / lap gate
                                   // 3: posture-aware lap line (seated / standing), softer open-palm straightness (W3)
                                   // 4: posture hysteresis (standOnM / seatedOnM), seatedMaxM 1.4 (Code Review B 07:2x)
                                   // 5 (GDXE / GE1, owner's Quest test 2026-10-10): pinchOn 2.0 cm / pinchOff 3.5 cm (joint CENTRES of touching
                                   //    pads sit 1.5-2 cm apart on Quest: 1.5 cm needed a squeeze), the laser ray runs knuckle -> tip (8 cm,
                                   //    not the 4.7 cm distal joint -> tip: 3 mm of joint jitter was 7 deg = a 25 cm dot jump at 2 m) and is
                                   //    smoothed (rayEma) while pointing, so a held dot stays inside roomcat's escapeM / catchR

/** WebXR Hand Input joint names (25), in the XRHand iteration order. */
export const JOINTS = Object.freeze([
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
]);
const FINGERS = Object.freeze({
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
});

export const GESTURE_TUNING = Object.freeze({
  pinchOn: 0.02, pinchOff: 0.035, velFrames: 6, maxDt: 0.1,
  rayEma: 0.3, // per-frame blend of the new finger direction into the held laser ray (0.3 at 72 Hz = ~40 ms lag; std of frame-independent jitter x 0.42; Review CH S3: tuned on the jitter test in vr/test/gestures-jitter.test.mjs with roomcat's laserSmooth / leadDeadM)
  // finger straightness = (tip - knuckle) projected on the metacarpal direction / (sum of the 3 phalanx lengths):
  // ~1 straight, ~0.8 at a 40 deg first bend, ~0.5 half curled, 0 folded into a fist (the metacarpal never counts)
  // the POINTING index stays strict (a deliberate point is a straight finger); an OFFERED / stroking palm is softer
  // (W2 re-review SHOULD 2): a natural open hand keeps a slight bend in every finger, synth curl 0.25 = 0.87, 0.3 = 0.82,
  // 0.35 = 0.76. palmExtOn 0.8 lets curl <= 0.3 count as open; 0.35 does not. TUNE ON QUEST TRACES (QA, W3).
  extOn: 0.9, extOff: 0.8, curlOn: 0.75, curlOff: 0.85, palmExtOn: 0.8, palmExtOff: 0.7,
  pointHoldS: 0.25, pointGraceS: 0.15,
  palmUpOn: 0.7, palmUpOff: 0.45, palmStillV: 0.15, palmHoldS: 1.0, palmGraceS: 0.25, palmFingers: 3,
  // treat gate (only with a `view`): the palm must be inside this half-angle cone around the gaze and higher than the
  // LAP LINE to START; it ENDS once the palm sinks lapSlackM below that line. The lap line is posture-aware (W2
  // re-review SHOULD 1): seated (head less than seatedMaxM above the floor) = head.y - lapBelowM (a hand on the lap);
  // standing = max(head.y - standBelowM, floorY + standMinM), so a standing player reaching DOWN to a floor cat
  // (palm 0.65 m under the head) still offers a treat while a hand hanging at the side (about 1 m under) does not.
  // Without a floorY in the view the player is assumed seated (the W2 rule). Posture has HYSTERESIS (Code Review B
  // 07:2x SHOULD 1a/b): with no prior posture, seated = head less than seatedMaxM over the floor; a seated player
  // becomes standing only above standOnM and a standing one seated only below seatedOnM, so a head near the boundary
  // never flips frame to frame (and an active treat never ends on a posture jump). seatedMaxM 1.4 keeps a tall seated
  // player (head 1.35: tall adult, high stool) seated, so a palm on the lap stays a resting hand. A 13-year-old standing
  // at eye height 1.28 is classed seated: a reach-down to the floor gives no treat (seated-first; noted for QA).
  viewConeDeg: 45, lapBelowM: 0.45, lapSlackM: 0.1, seatedMaxM: 1.4, standOnM: 1.45, seatedOnM: 1.25, standBelowM: 0.8, standMinM: 0.7,
  petVMin: 0.05, petVMax: 0.4, petNear: 0.25, petFar: 0.35, petFace: 0.2, petHoldS: 0.4, petGraceS: 0.2,
});

function gLen(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }
function gDist(a, b) { return gLen(a.x - b.x, a.y - b.y, a.z - b.z); }
function gSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function gNorm(v) { const l = gLen(v.x, v.y, v.z); return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 0, z: 0 }; }
function gDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function gCross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
function gPt(p) { return { x: p.x, y: p.y, z: p.z }; }
function gOk(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }

/** straightness of one finger, 0..1, measured from the KNUCKLE (phalanx-proximal) to the tip: the knuckle-to-tip vector
 *  projected on the metacarpal direction (metacarpal -> knuckle), over the summed phalanx lengths. The metacarpal is
 *  always straight, so it is only the reference direction and never pads the score (W2 review SHOULD 1). */
export function fingerStraightness(joints, finger) {
  const names = FINGERS[finger];
  if (!names) return 0;
  for (const n of names) if (!gOk(joints[n])) return 0;
  const mc = joints[names[0]], kn = joints[names[1]], tip = joints[names[names.length - 1]];
  let seg = 0;
  for (let i = 2; i < names.length; i++) seg += gDist(joints[names[i - 1]], joints[names[i]]);
  if (seg < 1e-6) return 0;
  const axis = gNorm(gSub(kn, mc));
  if (!(gLen(axis.x, axis.y, axis.z) > 0.5)) return 0;
  return Math.max(0, Math.min(1, gDot(gSub(tip, kn), axis) / seg));
}

/** Per-frame hand features from the joints (null when the essential joints are missing).
 *  normal = the direction the PALM faces: right hand cross(index knuckle - wrist, pinky knuckle - wrist), left hand negated.
 *  The knuckles (phalanx-proximal) sit 8-10 cm from the wrist on a real hand; the metacarpal bases are 2-3 cm away, so a
 *  normal from them wobbled ~7 deg per 3 mm of jitter (W2 review SHOULD 2). */
export function handFeatures(joints, hand) {
  if (!joints) return null;
  const wrist = joints.wrist, tt = joints['thumb-tip'], it = joints['index-finger-tip'];
  const ikn = joints['index-finger-phalanx-proximal'], pkn = joints['pinky-finger-phalanx-proximal'], mpp = joints['middle-finger-phalanx-proximal'];
  const iint = joints['index-finger-phalanx-intermediate'];
  if (!gOk(wrist) || !gOk(tt) || !gOk(it) || !gOk(ikn) || !gOk(pkn) || !gOk(mpp)) return null;
  let normal = gNorm(gCross(gSub(ikn, wrist), gSub(pkn, wrist)));
  if (hand === 'left') normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  const palm = { x: (wrist.x + mpp.x) / 2, y: (wrist.y + mpp.y) / 2, z: (wrist.z + mpp.z) / 2 };
  const ext = {};
  for (const f of Object.keys(FINGERS)) ext[f] = fingerStraightness(joints, f);
  return {
    pinchD: gDist(tt, it),
    pinchP: { x: (tt.x + it.x) / 2, y: (tt.y + it.y) / 2, z: (tt.z + it.z) / 2 },
    palm, normal, ext,
    indexTip: gPt(it),
    indexDir: gNorm(gSub(it, gOk(ikn) ? ikn : gOk(iint) ? iint : wrist)), // knuckle -> tip: the whole finger aims, not the last 4.7 cm
  };
}

/** Fresh per-hand state (plain data, replaceable; gestureStep never mutates its input). */
export function createGestureState(hand) {
  return {
    hand: hand || 'right', tracked: false, t: null,
    pinch: false, point: false, palm: false, pet: false,
    pointSince: null, pointLost: null, palmSince: null, palmLost: null, petSince: null, petLost: null, petTarget: -1,
    hist: [], // last velFrames palm samples [{ t, p }]
    rayDir: null, // the smoothed laser direction while pointing (rayEma)
    v: { x: 0, y: 0, z: 0 }, // smoothed palm velocity (m/s)
    posture: null, // last lap-line posture ('seated' / 'standing'), the hysteresis memory
  };
}

function gVel(hist) {
  if (hist.length < 2) return { x: 0, y: 0, z: 0 };
  const a = hist[0], b = hist[hist.length - 1], dt = b.t - a.t;
  if (!(dt > 1e-4)) return { x: 0, y: 0, z: 0 };
  return { x: (b.p.x - a.p.x) / dt, y: (b.p.y - a.p.y) / dt, z: (b.p.z - a.p.z) / dt };
}

/** Which target point (if any) the palm could be stroking: index into targets, -1 when none within `far` (prefers `near`). */
export function nearestTarget(p, targets, far) {
  let best = -1, bd = far;
  if (!Array.isArray(targets)) return -1;
  for (let i = 0; i < targets.length; i++) { const q = targets[i]; if (!gOk(q)) continue; const d = gDist(p, q); if (d <= bd) { bd = d; best = i; } }
  return best;
}

/** The lap line (world y): a palm below it is resting, not offered. view = { head, floorY?, posture? }. Seated (head.y -
 *  floorY < seatedMaxM, or no floorY) = head.y - lapBelowM; standing = max(head.y - standBelowM, floorY + standMinM).
 *  view.posture = the previous answer (hysteresis: seated -> standing only above standOnM, standing -> seated only
 *  below seatedOnM). Also returns the posture so the host / hints can read it (and feed it back). */
export function lapLine(view, T) {
  const Tn = T || GESTURE_TUNING;
  const head = view && view.head;
  const prev = view && (view.posture === 'seated' || view.posture === 'standing') ? view.posture : null;
  // no / NaN head (tracking loss): no line, and the remembered posture survives (Code Review B2 SHOULD 3)
  if (!head || !Number.isFinite(head.y)) return { y: -Infinity, posture: prev || 'unknown' };
  const floorY = Number.isFinite(view.floorY) ? view.floorY : null;
  const h = floorY == null ? -Infinity : head.y - floorY;
  let seated;
  if (floorY == null) seated = true;
  else if (prev === 'seated') seated = h < (Number.isFinite(Tn.standOnM) ? Tn.standOnM : Tn.seatedMaxM);
  else if (prev === 'standing') seated = h < (Number.isFinite(Tn.seatedOnM) ? Tn.seatedOnM : Tn.seatedMaxM);
  else seated = h < Tn.seatedMaxM;
  if (seated) return { y: head.y - Tn.lapBelowM, posture: 'seated' };
  return { y: Math.max(head.y - Tn.standBelowM, floorY + Tn.standMinM), posture: 'standing' };
}

/** Is the palm somewhere a player deliberately holds it: inside the view cone around the gaze and above the lap line?
 *  view = { head: {x,y,z}, gaze: {x,y,z} (unit, may be null -> no cone test), floorY? (posture) }. `slack` lowers the lap
 *  line (hysteresis). */
export function palmInView(palm, view, T, slack) {
  if (!view || !gOk(view.head)) return true;
  const Tn = T || GESTURE_TUNING;
  if (!(palm.y > lapLine(view, Tn).y - (slack || 0))) return false;
  if (!gOk(view.gaze)) return true;
  const d = gNorm(gSub(palm, view.head));
  if (!(gLen(d.x, d.y, d.z) > 0.5)) return true; // palm at the head: no direction to test
  return gDot(d, gNorm(view.gaze)) >= Math.cos(Tn.viewConeDeg * Math.PI / 180);
}

/**
 * One frame for one hand. sample = { hand, t, joints } or null (untracked). targets = pet-able points (cat backs) in
 * world metres. view (optional) = { head, gaze } for the treat gate (palmInView). Returns { state (new), events, features }.
 */
export function gestureStep(prev, sample, targets, tuning, view) {
  const T = tuning || GESTURE_TUNING;
  const st = Object.assign({}, prev || createGestureState(sample && sample.hand));
  const hand = st.hand, events = [];
  const feat = sample && Number.isFinite(sample.t) ? handFeatures(sample.joints, hand) : null;
  if (!feat) {
    // tracking lost: end everything (a pinch releases gently; the host's roomcat timer also lets go after handLostS)
    if (st.tracked) {
      if (st.pinch) events.push({ type: 'pinch_release', hand, p: st.lastP || null, v: { x: 0, y: 0, z: 0 } });
      if (st.point) events.push({ type: 'point_end', hand });
      if (st.palm) events.push({ type: 'palm_end', hand });
      if (st.pet) events.push({ type: 'pet_end', hand, target: st.petTarget });
      events.push({ type: 'lost', hand });
    }
    const fresh = createGestureState(hand);
    return { state: fresh, events, features: null };
  }
  const t = sample.t;
  let dt = st.t == null ? 0 : t - st.t;
  if (!(dt >= 0)) dt = 0;
  if (dt > T.maxDt) { dt = T.maxDt; }
  // palm velocity over the last velFrames samples (also the toss velocity at release)
  const hist = st.hist.slice(st.t == null || t - st.t > T.maxDt ? st.hist.length : 0);
  hist.push({ t, p: feat.palm });
  while (hist.length > T.velFrames) hist.shift();
  const v = gVel(hist), speed = gLen(v.x, v.y, v.z);
  st.hist = hist; st.v = v; st.t = t; st.tracked = true;

  // ---- pinch (highest priority)
  const wasPinch = st.pinch;
  if (!wasPinch && feat.pinchD < T.pinchOn) st.pinch = true;
  else if (wasPinch && feat.pinchD > T.pinchOff) st.pinch = false;
  const p = st.pinch ? feat.pinchP : feat.palm;
  st.lastP = p;
  events.push({ type: 'move', hand, p });
  if (st.pinch && !wasPinch) {
    // a pinch cancels the other gestures (one gesture per hand)
    if (st.point) { st.point = false; events.push({ type: 'point_end', hand }); }
    if (st.palm) { st.palm = false; events.push({ type: 'palm_end', hand }); }
    if (st.pet) { st.pet = false; events.push({ type: 'pet_end', hand, target: st.petTarget }); }
    st.pointSince = st.palmSince = st.petSince = null;
    events.push({ type: 'pinch_start', hand, p });
  } else if (st.pinch) {
    events.push({ type: 'pinch_hold', hand, p });
  } else if (wasPinch) {
    events.push({ type: 'pinch_release', hand, p, v });
  }
  if (st.pinch) { st.pointSince = st.palmSince = st.petSince = null; return { state: st, events, features: feat }; }

  const ext = feat.ext;
  const extended = (f, on) => (on ? ext[f] >= T.extOn : ext[f] > T.extOff);
  const curled = (f, on) => (on ? ext[f] <= T.curlOn : ext[f] < T.curlOff);
  // open-palm fingers (treat / pet) use the softer palmExt thresholds (a natural offered hand is not a flat board)
  const pOn = Number.isFinite(T.palmExtOn) ? T.palmExtOn : T.extOn, pOff = Number.isFinite(T.palmExtOff) ? T.palmExtOff : T.extOff;
  const openCount = (on) => ['index', 'middle', 'ring', 'pinky'].reduce((n, f) => n + ((on ? ext[f] >= pOn : ext[f] > pOff) ? 1 : 0), 0);

  // ---- point (index out, the other three curled)
  const pointShape = (on) => extended('index', on) && curled('middle', on) && curled('ring', on) && curled('pinky', on);
  let dir = feat.indexDir;
  if (st.point && st.rayDir && Number.isFinite(T.rayEma) && T.rayEma < 1) { const a = T.rayEma, r = st.rayDir; dir = gNorm({ x: r.x + (dir.x - r.x) * a, y: r.y + (dir.y - r.y) * a, z: r.z + (dir.z - r.z) * a }); }
  const ray = { origin: feat.indexTip, dir };
  st.rayDir = dir;
  if (st.point) {
    if (pointShape(false)) st.pointLost = null;
    else if (st.pointLost == null) st.pointLost = t;
    if (st.pointLost != null && t - st.pointLost >= T.pointGraceS) { st.point = false; st.pointLost = null; st.pointSince = null; st.rayDir = null; events.push({ type: 'point_end', hand }); }
    else events.push(Object.assign({ type: 'point_hold', hand }, ray));
  } else if (!st.palm && !st.pet) {
    if (pointShape(true)) {
      if (st.pointSince == null) st.pointSince = t;
      if (t - st.pointSince >= T.pointHoldS) { st.point = true; st.pointLost = null; events.push(Object.assign({ type: 'point_start', hand }, ray)); }
    } else st.pointSince = null;
  }
  if (st.point) return { state: st, events, features: feat };

  // ---- open palm facing up (treat); the posture memory gives the lap line its hysteresis
  if (view) {
    // a NaN / missing head frame (tracking loss) answers 'unknown': keep the remembered posture (Code Review B2 SHOULD 3)
    const po = lapLine({ head: view.head, floorY: view.floorY, posture: st.posture }, T).posture;
    if (po === 'seated' || po === 'standing') st.posture = po;
    view = { head: view.head, gaze: view.gaze, floorY: view.floorY, posture: st.posture };
  }
  const up = feat.normal.y;
  const palmInfo = { p: feat.palm, normal: feat.normal };
  if (st.palm) {
    const keep = up > T.palmUpOff && openCount(false) >= T.palmFingers && palmInView(feat.palm, view ? { head: view.head, floorY: view.floorY } : null, T, T.lapSlackM);
    if (keep) st.palmLost = null; else if (st.palmLost == null) st.palmLost = t;
    if (st.palmLost != null && t - st.palmLost >= T.palmGraceS) { st.palm = false; st.palmLost = null; st.palmSince = null; events.push({ type: 'palm_end', hand }); }
    else events.push(Object.assign({ type: 'palm_hold', hand }, palmInfo));
  } else if (!st.pet) {
    const shape = up >= T.palmUpOn && openCount(true) >= 4 && speed <= T.palmStillV && palmInView(feat.palm, view, T, 0);
    if (shape) {
      if (st.palmSince == null) st.palmSince = t;
      if (t - st.palmSince >= T.palmHoldS) { st.palm = true; st.palmLost = null; events.push(Object.assign({ type: 'palm_start', hand }, palmInfo)); }
    } else st.palmSince = null;
  }
  if (st.palm) return { state: st, events, features: feat };

  // ---- pet: open hand, slow stroke near a target, palm facing it
  const facing = (i) => { const q = targets[i]; const d = gNorm(gSub(q, feat.palm)); return gDot(d, feat.normal) >= T.petFace; };
  if (st.pet) {
    let i = st.petTarget;
    if (!(i >= 0 && targets && gOk(targets[i]) && gDist(feat.palm, targets[i]) <= T.petFar)) i = nearestTarget(feat.palm, targets, T.petFar);
    const keep = i >= 0 && openCount(false) >= T.palmFingers && speed >= T.petVMin * 0.5 && speed <= T.petVMax * 1.25 && facing(i);
    if (keep) { st.petLost = null; st.petTarget = i; } else if (st.petLost == null) st.petLost = t;
    if (st.petLost != null && t - st.petLost >= T.petGraceS) { st.pet = false; st.petLost = null; st.petSince = null; events.push({ type: 'pet_end', hand, target: st.petTarget }); st.petTarget = -1; }
    else events.push({ type: 'pet_hold', hand, p: feat.palm, target: st.petTarget, v });
  } else {
    const i = nearestTarget(feat.palm, targets, T.petNear);
    const shape = i >= 0 && openCount(true) >= T.palmFingers && speed >= T.petVMin && speed <= T.petVMax && facing(i);
    if (shape) {
      if (st.petSince == null) st.petSince = t;
      if (t - st.petSince >= T.petHoldS) { st.pet = true; st.petLost = null; st.petTarget = i; events.push({ type: 'pet_start', hand, p: feat.palm, target: i, v }); }
    } else st.petSince = null;
  }
  return { state: st, events, features: feat };
}

/** Convenience: a stateful detector for one hand (wraps gestureStep). */
export function createGestureDetector(hand, tuning) {
  let state = createGestureState(hand);
  return {
    get state() { return state; },
    update(sample, targets, view) { const r = gestureStep(state, sample, targets || [], tuning, view); state = r.state; return r; },
    reset() { state = createGestureState(hand); },
  };
}

// ---- test / fixture helpers: build a plausible joint set from a few parameters (no real traces yet; the Quest 3 traces
// recorded by QA (plan 2.6) replace these in W3). All pure; the shape is a right hand, fingers along `fwd`, palm facing
// `normal`; curl bends each finger toward the palm.
/**
 * synthHand({ hand, palm: {x,y,z}, fwd: {x,y,z}, normal: {x,y,z}, curl: { index, middle, ring, pinky } (0 straight .. 1 fist),
 *             pinch: metres between thumb tip and index tip (default 0.06) }) -> joints map
 */
export function synthHand(o) {
  const hand = o.hand || 'right', palm = o.palm || { x: 0, y: 1, z: -0.3 };
  const fwd = gNorm(o.fwd || { x: 0, y: 0, z: -1 }), nrm = gNorm(o.normal || { x: 0, y: 1, z: 0 });
  // side = direction from pinky to index (thumb side) so that cross(index - wrist, pinky - wrist) == normal for a right hand
  let side = gCross(fwd, nrm); if (hand === 'left') side = { x: -side.x, y: -side.y, z: -side.z };
  const curl = Object.assign({ index: 0, middle: 0, ring: 0, pinky: 0 }, o.curl || {});
  const add = (a, b, k) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
  const wrist = add(palm, fwd, -0.04);
  const J = { wrist };
  const lanes = { index: 0.02, middle: 0.0, ring: -0.02, pinky: -0.04 };
  const segs = { index: [0.06, 0.04, 0.025, 0.022], middle: [0.06, 0.045, 0.028, 0.024], ring: [0.055, 0.04, 0.026, 0.022], pinky: [0.05, 0.03, 0.02, 0.02] };
  for (const f of ['index', 'middle', 'ring', 'pinky']) {
    const names = FINGERS[f], base = add(add(wrist, side, lanes[f]), fwd, 0.02);
    let p = base, dir = fwd;
    J[names[0]] = base;
    for (let i = 0; i < 4; i++) {
      // metacarpal straight, then each phalanx bends by curl * 60 deg toward the palm (-normal)
      if (i > 0) { const a = i * curl[f] * (Math.PI / 3); dir = gNorm(add({ x: fwd.x * Math.cos(a), y: fwd.y * Math.cos(a), z: fwd.z * Math.cos(a) }, nrm, -Math.sin(a))); }
      p = add(p, dir, segs[f][i]);
      J[names[i + 1]] = p;
    }
  }
  // thumb: from the index side of the wrist, toward the index tip; the tip ends `pinch` metres from the index tip
  const tm = add(add(wrist, side, 0.03), fwd, 0.01);
  J['thumb-metacarpal'] = tm;
  const it = J['index-finger-tip'], pinch = Number.isFinite(o.pinch) ? o.pinch : 0.06;
  const tip = add(it, gNorm(add(side, nrm, 0.3)), pinch);
  J['thumb-tip'] = tip;
  J['thumb-phalanx-proximal'] = add(tm, gSub(tip, tm), 0.4);
  J['thumb-phalanx-distal'] = add(tm, gSub(tip, tm), 0.72);
  return J;
}

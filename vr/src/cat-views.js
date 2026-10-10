/* vr/src/cat-views.js - W2 (plan 2.2): which view sprite a 2.5D billboard cat shows, from the camera angle.
   Gaming Engineer 2, 2026-10-09. PURE functions (no three / DOM), tested in vr/test/cat-views.test.mjs.
   Rule (plan 2.2): the vector from the cat to the camera in the cat's own frame. Elevation above `aboveDeg` (55) -> the
   'above' view (a seated player looks DOWN at floor cats). Elevation below -`belowDeg` (35) -> 'below' (only a cat on a
   high shelf over the head). Otherwise the azimuth quadrant picks front / right / back / left. `hystDeg` (8) of hysteresis
   keeps the previous view near every boundary (no flicker); the host crossfades over VIEW_FADE_MS (120) instead of the
   desktop 220 ms card flip. The quad also tilts toward the camera by up to `tiltMaxDeg` (25) of pitch.
   Output also carries the sprite transform in the view.js convention (sprite: side / front / back / above / below,
   flipX, rotDeg clockwise, |rotDeg| <= 90) so the art (side art faces RIGHT; above / below art points RIGHT) is drawn
   the same way as on the desktop. */
export const CAT_VIEWS_VERSION = 1;
export const VIEW_FADE_MS = 120;
export const CAT_VIEW_TUNING = Object.freeze({ aboveDeg: 55, belowDeg: 35, hystDeg: 8, tiltMaxDeg: 25, minDist: 0.02 });
export const CAT_VIEW_NAMES = Object.freeze(['front', 'right', 'back', 'left', 'above', 'below']);

const DEG = 180 / Math.PI;

/** cat frame: forward (fx, fz) on the floor, right = forward x up = (-fz, fx) */
function cvFrame(cat) {
  let fx = Number.isFinite(cat.fx) ? cat.fx : 0, fz = Number.isFinite(cat.fz) ? cat.fz : 1;
  const l = Math.sqrt(fx * fx + fz * fz);
  if (l < 1e-9) { fx = 0; fz = 1; } else { fx /= l; fz /= l; }
  return { fx, fz, rx: -fz, rz: fx };
}

/**
 * Camera angles in the cat's frame. cat = { x, y, z, fx, fz } (feet position + facing), camera = { x, y, z } (head).
 * Returns { az, el, dist }: az in degrees, 0 = the camera is in FRONT of the cat (sees its face), +90 = on the cat's RIGHT,
 * +-180 = behind; el = elevation of the camera above the cat's eye line (cat.y + eyeH), degrees, +up.
 */
export function catCameraAngles(cat, camera, eyeH = 0.12) {
  const F = cvFrame(cat);
  const dx = camera.x - cat.x, dz = camera.z - cat.z, dy = camera.y - (cat.y + eyeH);
  const h = Math.sqrt(dx * dx + dz * dz), dist = Math.sqrt(h * h + dy * dy);
  const fwd = (dx * F.fx + dz * F.fz), right = (dx * F.rx + dz * F.rz);
  const az = h < 1e-9 ? 0 : Math.atan2(right, fwd) * DEG;
  const el = dist < 1e-9 ? 90 : Math.atan2(dy, h) * DEG;
  return { az, el, dist };
}

function cvQuadrant(az) {
  const a = Math.abs(az);
  if (a <= 45) return 'front';
  if (a >= 135) return 'back';
  return az > 0 ? 'right' : 'left';
}
/** does azimuth `az` still lie inside `view`'s quadrant widened by `h` degrees? */
function cvInside(view, az, h) {
  const a = Math.abs(az);
  if (view === 'front') return a <= 45 + h;
  if (view === 'back') return a >= 135 - h;
  if (view === 'right') return az > 0 && a >= 45 - h && a <= 135 + h;
  if (view === 'left') return az < 0 && a >= 45 - h && a <= 135 + h;
  return false;
}

/**
 * Pick the view. prev = the view chosen last frame (or null); the thresholds move by hystDeg in its favour.
 * Returns { view, az, el, sprite, flipX, rotDeg, tiltDeg }.
 */
export function pickCatView(cat, camera, prev, tuning) {
  const T = tuning || CAT_VIEW_TUNING;
  const { az, el, dist } = catCameraAngles(cat, camera);
  const h = T.hystDeg;
  let view;
  if (dist < T.minDist) view = prev || 'above';
  else if (prev === 'above' ? el > T.aboveDeg - h : el > T.aboveDeg) view = 'above';
  else if (prev === 'below' ? el < -T.belowDeg + h : el < -T.belowDeg) view = 'below';
  else if (prev && prev !== 'above' && prev !== 'below' && cvInside(prev, az, h)) view = prev;
  else view = cvQuadrant(az);
  const tr = catSpriteTransform(view, cat, camera);
  const tiltDeg = Math.max(-T.tiltMaxDeg, Math.min(T.tiltMaxDeg, el));
  return Object.assign({ view, az, el, tiltDeg }, tr);
}

/**
 * Sprite transform for a yaw-billboarded quad (it faces the camera; +u = the camera's right, +v = up / away).
 * Side art faces RIGHT: 'right' view = the camera on the cat's right sees its forward pointing to the camera's right
 * (flipX false); 'left' flips. 'above' / 'below' art points RIGHT (+u): rotDeg turns it to the cat's heading as seen on
 * the quad, |rotDeg| <= 90 with flipX for headings toward the viewer's left (no upside-down cats, view.js rule).
 */
export function catSpriteTransform(view, cat, camera) {
  const F = cvFrame(cat);
  // quad right (= camera right, horizontal) for a quad facing d = camera - cat: right = up x d = (d.z, 0, -d.x) normalised
  let dx = camera.x - cat.x, dz = camera.z - cat.z;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l < 1e-9) { dx = 0; dz = 1; } else { dx /= l; dz /= l; }
  const ux = dz, uz = -dx; // camera right
  const u = F.fx * ux + F.fz * uz; // heading along the quad's +u
  const v = -(F.fx * dx + F.fz * dz); // heading away from the camera (= screen up when seen from above)
  if (view === 'above' || view === 'below') {
    const rot = -Math.atan2(view === 'below' ? -v : v, Math.abs(u)) * DEG;
    return { sprite: view, flipX: u < 0, rotDeg: Math.round(rot * 10) / 10 + 0 };
  }
  if (view === 'left' || view === 'right') return { sprite: 'side', flipX: u < 0, rotDeg: 0 };
  return { sprite: view === 'back' ? 'back' : 'front', flipX: false, rotDeg: 0 };
}

/** Crossfade helper: 0..1 opacity of the NEW view `elapsedMs` after a switch (the old view shows 1 - alpha). */
export function viewFadeAlpha(elapsedMs, fadeMs = VIEW_FADE_MS) {
  if (!(elapsedMs > 0)) return 0;
  if (elapsedMs >= fadeMs) return 1;
  const t = elapsedMs / fadeMs;
  return t * t * (3 - 2 * t);
}

/** Yaw (radians, about +y) that turns a quad at `cat` to face `camera` (three.js: rotation.y). */
export function billboardYaw(cat, camera) {
  return Math.atan2(camera.x - cat.x, camera.z - cat.z);
}

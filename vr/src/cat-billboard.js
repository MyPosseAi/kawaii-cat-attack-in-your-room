// Placeholder flat cat (original art: simple shapes, no brands). One textured quad,
// yaw-billboarded so it stays upright on its surface (plan 2.2), plus a soft contact
// shadow so it never looks like it hovers (no-hover rule).
// W3 (Gaming Engineer 2): one CanvasTexture PER SPRITE KEY (cat-sprites.js resolveSprite: view x pose, with the fallbacks
// the art has) from a shared cache, and a second quad that crossfades the old sprite out over VIEW_FADE_MS (cat-sprites
// faderStep). The drawing is still the placeholder, varied per view (side / front / back / above / below) and pose; the
// rig drawers plug into createSpriteCache({ draw }) when Design hands them over (one call:
// draw(ctx, size, { sprite, pose, catId, size }) -> original art, no brands).
import { resolveSprite, createFader, faderStep } from './cat-sprites.js';
import {
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';

export const KITTEN_HEIGHT_M = 0.28; // ~1 kitten body length tall incl. ears (plan 2.3: 0.18 m BL)
import { ART_SCALE } from './art-glue.js'; // P0a: Design's atlas frames scaled to this kitten height

/** Placeholder per view: side (the W1 drawing), front / back (round face or tail end), above / below (top-down loaf
 *  pointing RIGHT, belly + paw pads from below). Poses only squash / lean (cat-billboard apply()). Original shapes. */
function drawSprite(ctx, s, o) {
  const sprite = (o && o.sprite) || 'side';
  if (sprite === 'side') return drawCat(ctx, s);
  ctx.clearRect(0, 0, s, s);
  const fur = '#f6b26b', dark = '#4a2c2a', pink = '#ff9ec7', pale = '#fff3e6';
  ctx.lineWidth = s * 0.02; ctx.strokeStyle = dark; ctx.fillStyle = fur;
  if (sprite === 'above' || sprite === 'below') {
    // top-down: body ellipse along +x (art points right), head at the right end, tail curling left
    ctx.beginPath(); ctx.moveTo(s * 0.22, s * 0.5); ctx.quadraticCurveTo(s * 0.02, s * 0.3, s * 0.1, s * 0.62); ctx.lineWidth = s * 0.06; ctx.stroke(); ctx.lineWidth = s * 0.02;
    ctx.beginPath(); ctx.ellipse(s * 0.45, s * 0.5, s * 0.26, s * 0.17, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 0.74, s * (0.5 + d * 0.08)); ctx.lineTo(s * 0.9, s * (0.5 + d * 0.2)); ctx.lineTo(s * 0.8, s * (0.5 + d * 0.22)); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(s * 0.76, s * 0.5, s * 0.15, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (sprite === 'below') { ctx.fillStyle = pale; ctx.beginPath(); ctx.ellipse(s * 0.45, s * 0.5, s * 0.18, s * 0.1, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = pink; for (const [px, py] of [[0.3, 0.38], [0.3, 0.62], [0.62, 0.38], [0.62, 0.62]]) { ctx.beginPath(); ctx.arc(s * px, s * py, s * 0.03, 0, Math.PI * 2); ctx.fill(); } }
    else { ctx.fillStyle = dark; for (const d of [-1, 1]) { ctx.beginPath(); ctx.arc(s * 0.84, s * (0.5 + d * 0.06), s * 0.02, 0, Math.PI * 2); ctx.fill(); } }
    return;
  }
  // front / back: upright sitting cat seen end-on; bottom edge = paws on the plane
  ctx.beginPath(); ctx.ellipse(s * 0.5, s * 0.74, s * 0.22, s * 0.24, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  for (const d of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * (0.5 + d * 0.1), s * 0.24); ctx.lineTo(s * (0.5 + d * 0.22), s * 0.05); ctx.lineTo(s * (0.5 + d * 0.25), s * 0.32); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(s * 0.5, s * 0.37, s * 0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (sprite === 'front') {
    ctx.fillStyle = dark; for (const d of [-1, 1]) { ctx.beginPath(); ctx.arc(s * (0.5 + d * 0.08), s * 0.36, s * 0.03, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = pink; ctx.beginPath(); ctx.moveTo(s * 0.48, s * 0.42); ctx.lineTo(s * 0.52, s * 0.42); ctx.lineTo(s * 0.5, s * 0.445); ctx.closePath(); ctx.fill();
    ctx.fillStyle = pale; for (const d of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * (0.5 + d * 0.1), s * 0.95, s * 0.06, s * 0.04, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  } else {
    // back: tail curled on the floor to the right, no face
    ctx.beginPath(); ctx.moveTo(s * 0.62, s * 0.9); ctx.quadraticCurveTo(s * 0.95, s * 0.95, s * 0.9, s * 0.6); ctx.lineWidth = s * 0.06; ctx.stroke(); ctx.lineWidth = s * 0.02;
  }
}

/**
 * Shared texture cache: one CanvasTexture per cat-sprites key, drawn on first use. draw(ctx, px, { sprite, pose, catId,
 * size }) defaults to the placeholder. dispose() frees every texture (one cache per XR session, room-hook owns it).
 */
export function createSpriteCache(opts = {}) {
  const px = opts.px || 256, draw = typeof opts.draw === 'function' ? opts.draw : drawSprite;
  const map = new Map();
  return {
    get(key, o) {
      let tex = map.get(key);
      if (!tex) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = px;
        draw(canvas.getContext('2d'), px, o || {});
        tex = new CanvasTexture(canvas);
        tex.colorSpace = SRGBColorSpace;
        map.set(key, tex);
      }
      return tex;
    },
    get size() { return map.size; },
    dispose() { for (const t of map.values()) t.dispose(); map.clear(); },
  };
}

function drawCat(ctx, s) {
  ctx.clearRect(0, 0, s, s);
  const fur = '#f6b26b', dark = '#4a2c2a', pink = '#ff9ec7';
  ctx.lineWidth = s * 0.02;
  ctx.strokeStyle = dark;
  ctx.fillStyle = fur;
  // tail (curl up on the right)
  ctx.beginPath();
  ctx.moveTo(s * 0.70, s * 0.86);
  ctx.quadraticCurveTo(s * 0.95, s * 0.80, s * 0.88, s * 0.52);
  ctx.lineWidth = s * 0.06;
  ctx.stroke();
  ctx.lineWidth = s * 0.02;
  // body (sitting loaf); bottom touches the texture's bottom edge = paws on the plane
  ctx.beginPath();
  ctx.ellipse(s * 0.5, s * 0.76, s * 0.25, s * 0.23, 0, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // ears
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(s * (0.5 + dir * 0.10), s * 0.22);
    ctx.lineTo(s * (0.5 + dir * 0.22), s * 0.04);
    ctx.lineTo(s * (0.5 + dir * 0.25), s * 0.30);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  // head
  ctx.beginPath();
  ctx.arc(s * 0.5, s * 0.36, s * 0.2, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke();
  // eyes, nose, blush
  ctx.fillStyle = dark;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(s * (0.5 + dir * 0.08), s * 0.35, s * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = pink;
  ctx.beginPath();
  ctx.moveTo(s * 0.48, s * 0.41); ctx.lineTo(s * 0.52, s * 0.41); ctx.lineTo(s * 0.5, s * 0.435);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 0.5;
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * (0.5 + dir * 0.13), s * 0.42, s * 0.035, s * 0.02, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // front paws
  ctx.fillStyle = '#fff3e6';
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(s * (0.5 + dir * 0.08), s * 0.95, s * 0.06, s * 0.04, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
  }
}

const DEG2RAD = Math.PI / 180;
export const HOLD_MAX_S = 0.25; // cat-billboard holdFrame: the longest a kitten keeps a stale atlas frame while the next sheet uploads

/** Create one billboard. Returns { root, quad, shadow, setView, setPose, setShadow }:
 *  setView({ sprite, flipX, rotDeg, tiltDeg }) applies the cat-views.js transform (flip = scale.x, rotDeg clockwise ->
 *  -z rotation, tilt = pitch toward the camera, the quad's top leaning away from a camera above it). The placeholder has
 *  ONE drawing for every sprite; the views (kitten rigs) become one CanvasTexture per sprite with a 120 ms
 *  crossfade (W3). setPose(pose) is a cheap placeholder read of roomcat poses (nap / loaf squash, carried / poof lean);
 *  setShadow(y, alpha) keeps the contact shadow on the surface below (world y) while the cat hops or is carried. */
export function createCatBillboard(opts = {}) {
  const size = 256; // plan 2.2: 256 x 256 canvas per cat
  const cache = opts.cache || null; // W3: shared per-sprite textures; without one, the single W1 drawing
  const catId = opts.catId || 'preview', catSize = opts.size || 'kitten';
  let tex;
  if (cache) tex = cache.get(`${catId}:${catSize}:side:sit`, { sprite: 'side', pose: 'sit', catId, size: catSize });
  else {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    drawCat(canvas.getContext('2d'), size);
    tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
  }

  const root = new Group(); // root origin = contact point on the surface
  root.name = 'kca-cat';

  const quad = new Mesh(
    new PlaneGeometry(KITTEN_HEIGHT_M, KITTEN_HEIGHT_M),
    // Unlit: passthrough rooms have no scene lighting we control.
    new MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05, side: DoubleSide }),
  );
  quad.position.y = KITTEN_HEIGHT_M / 2; // bottom edge (paws) on the plane
  root.add(quad);
  // W3 crossfade: the OLD sprite fades out on a second quad behind the new one
  const fadeQuad = new Mesh(quad.geometry, new MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.05, side: DoubleSide, opacity: 0, depthWrite: false }));
  fadeQuad.visible = false;
  fadeQuad.position.copy(quad.position);
  fadeQuad.position.z = -0.001;
  root.add(fadeQuad);
  let fader = createFader(cache ? `${catId}:${catSize}:side:sit` : null, 0);

  const shadow = new Mesh(
    new CircleGeometry(KITTEN_HEIGHT_M * 0.42, 24),
    new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(1, 0.55, 1);
  shadow.position.y = 0.002; // avoid z-fighting with an emulated floor
  root.add(shadow);

  const view = { sprite: 'side', flipX: false, rotDeg: 0, tiltDeg: 0 };
  let pose = 'sit';
  let jx = 1, jy = 1; // P0a juice (fx.js juiceStep): squash & stretch multipliers, applied about the paws
  let frame = null;   // P0a atlas mode (Design's VR1 sprites): the current atlas frame { sizeM, centerM, liftM, flipX, uv }
  let holdSince = null; // perf: sim time the current frame started being HELD (its successor's sheet not resident yet), see holdFrame
  const apply = () => {
    const lean = pose === 'carried' ? 18 : pose === 'poof' ? -12 : pose === 'fall' ? 8 : 0;
    if (frame) {
      // atlas mode: the frame is already the pose's drawing (flip baked into its UVs); only the juice squashes it, about the paws
      const w = frame.sizeM[0] * ART_SCALE / KITTEN_HEIGHT_M, h = frame.sizeM[1] * ART_SCALE / KITTEN_HEIGHT_M;
      quad.scale.set(w * jx, h * jy, 1);
      quad.position.set(frame.centerM[0] * ART_SCALE * jx, (frame.centerM[1] * ART_SCALE + frame.liftM) * jy, 0);
      quad.rotation.set(-view.tiltDeg * DEG2RAD, 0, (-view.rotDeg + lean) * DEG2RAD);
      return;
    }
    const squash = (pose === 'nap' || pose === 'loaf' ? 0.62 : pose === 'crouch' || pose === 'eat' ? 0.8 : pose === 'stare' || pose === 'beg' ? 1.08 : 1) * jy;
    for (const q of [quad, fadeQuad]) {
      q.scale.set((view.flipX ? -1 : 1) * jx, squash, 1);
      q.position.set(0, (KITTEN_HEIGHT_M * squash) / 2, q === fadeQuad ? -0.001 : 0);
      q.rotation.set(-view.tiltDeg * DEG2RAD, 0, (-view.rotDeg + lean) * DEG2RAD);
    }
  };
  const uvAttr = quad.geometry.attributes.uv;
  /** W3: pick the texture for (sprite, pose) through cat-sprites and run the crossfade (nowMs from the host clock) */
  const setSprite = (nowMs) => {
    if (!cache || frame) return;
    const r = resolveSprite({ sprite: view.sprite, pose, size: catSize, catId });
    if (!r) return;
    fader = faderStep(fader, r.key, nowMs);
    if (fader.changed || fader.from) {
      quad.material.map = cache.get(fader.to, { sprite: r.sprite, pose: r.pose, catId, size: catSize });
      quad.material.needsUpdate = true;
      if (fader.from) {
        fadeQuad.material.map = cache.get(fader.from); fadeQuad.material.needsUpdate = true;
        fadeQuad.material.opacity = 1 - fader.alpha; fadeQuad.visible = true;
        quad.material.opacity = fader.alpha; // a real crossfade: the new sprite fades in as the old one fades out (Code Review B NIT 2)
      } else { fadeQuad.visible = false; quad.material.opacity = 1; }
    }
  };
  return {
    root, quad, shadow,
    setView(v) { view.sprite = v.sprite; view.flipX = !!v.flipX; view.rotDeg = v.rotDeg || 0; view.tiltDeg = v.tiltDeg || 0; apply(); },
    setPose(p) { if (p !== pose) { pose = p; apply(); } },
    /** P0a: squash & stretch (sx wider, sy taller) from fx.js; cheap when unchanged */
    setSquash(sx, sy) { if (Math.abs(sx - jx) > 1e-4 || Math.abs(sy - jy) > 1e-4) { jx = sx; jy = sy; apply(); } },
    /** P0a atlas mode: show atlas frame f (vr/src/art/atlas.js getFrame) from texture tex (one per cat atlas file). The quad's UVs
     *  become the frame's rect (flip included), its size / offset the frame's metres; the crossfade quad is parked. null = back
     *  to the canvas sprites. Cheap when the same frame index repeats. */
    setAtlasFrame(f, tex) {
      holdSince = null;
      if (!f) { if (frame) { frame = null; quad.material.opacity = 1; uvAttr.setXY(0, 0, 1); uvAttr.setXY(1, 1, 1); uvAttr.setXY(2, 0, 0); uvAttr.setXY(3, 1, 0); uvAttr.needsUpdate = true; fader = createFader(cache ? `${catId}:${catSize}:side:sit` : null, 0); apply(); } return; }
      const same = frame && frame.file === f.file && frame.index === f.index && frame.view === f.view && frame.anim === f.anim && frame.flipX === f.flipX && frame.lod === f.lod;
      frame = f;
      if (quad.material.map !== tex) { quad.material.map = tex; quad.material.needsUpdate = true; quad.material.opacity = 1; fadeQuad.visible = false; }
      if (!same) {
        const u = f.uv; // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right
        uvAttr.setXY(0, u.u0, u.v1); uvAttr.setXY(1, u.u1, u.v1); uvAttr.setXY(2, u.u0, u.v0); uvAttr.setXY(3, u.u1, u.v0); uvAttr.needsUpdate = true;
        apply();
      }
    },
    get atlasMode() { return !!frame; },
    /** perf: keep showing the current atlas frame while its successor's sheet uploads (the host calls this instead of
     *  setAtlasFrame(null)); true while the hold is <= HOLD_MAX_S of sim time, false = give up and fall back (tS in seconds) */
    holdFrame(tS) { if (!frame) return false; if (holdSince == null) holdSince = tS; return tS - holdSince <= HOLD_MAX_S; },
    /** W3: call after setView / setPose each frame with the host clock in ms */
    update(nowMs) { setSprite(nowMs); },
    setShadow(y, alpha) {
      if (y == null || !(alpha > 0)) { shadow.visible = false; return; }
      shadow.visible = true;
      shadow.position.y = y - root.position.y + 0.002;
      shadow.material.opacity = 0.28 * alpha;
      const s = 1 + Math.max(0, root.position.y - y) * 0.6; // a higher cat throws a bigger, fainter blob
      shadow.scale.set(s, 0.55 * s, 1);
    },
  };
}

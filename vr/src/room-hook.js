// W2 (Gaming Engineer 2): the IWSDK-side glue between main.js and the room sim.
// room-bridge.js owns the logic (scene -> createRoom input, gestures -> roomcat events, state -> billboards) and is
// node-tested; this file only keeps three.js objects in step with the bridge's plain data: a billboard per cat
// (cat-billboard.js), the cardboard box, the laser dot. No IWSDK import here either (plain three + the bridge).
//
// HOST CONTRACT (plan 2.9), honoured by room-bridge.frame(): a { type: 'move', hand, p } goes to roomcat for EVERY
// tracked hand on EVERY tracked frame (not only while pinching / holding a treat): 3 s with no event from a hand
// (ROOMCAT_TUNING.handLostS) = tracking lost, so its carried cat is released and a cat on its palm hops down.
// Meshes reach room.js as { id, label, min, max, footprint } with footprint = the convex hull of the mesh's local box
// corners after its pose (room-bridge meshToRoom): a yawed couch is couch-sized, not AABB-sized.
// W3 (GE2): the feather wand + toy basket (wand.js state -> a stick, a feather, a basket), the head-locked hint /
// caption card and the end card (hints.js / end-card.js data -> one CanvasTexture card), per-sprite textures through
// cat-billboard's shared cache. Still only three + the bridge's plain data.
// P0a slice (docs/P0A-SLICE.md GE2): the lid swings open on a hinge, the box thumps / jiggles (fx.js boxAnim), hearts /
// dust / sparks are three InstancedMeshes fed by the fx.js pools (2 + 1 draw calls, fixed size), the Kitten Happiness
// meter is two quads over the hint card, the Laser Tag dot is a white core + coral #ff7a6b ring (audit 3.2 read rule), the
// score card reuses the end-card canvas, and every billboard gets fx.js's squash & stretch. Sprite drawing comes through
// cat-art.js (Design's atlas loader registers itself there; placeholder until then).
import { BoxGeometry, CanvasTexture, CircleGeometry, CylinderGeometry, DoubleSide, Group, InstancedMesh, Mesh, MeshBasicMaterial, Object3D, PlaneGeometry, RingGeometry, SRGBColorSpace, Vector3 } from 'three';
const UP = new Vector3(0, 1, 0), tmpV = new Vector3();
import { createCatBillboard, createSpriteCache } from './cat-billboard.js';
import { createRoomBridge, GM_HOST_TUNING, GM_HOST_TEXT, grownArtFor } from './room-bridge.js';
import { WAND_TUNING, furnitureKind, FURN_VR_TUNING } from './wand.js';
import { boxAnim, FX_TUNING } from './fx.js';
import { catArtDraw } from './cat-art.js';
// P0a: Design's VR1 sprites (vr/public/art, loader vr/src/art/atlas.js) through the bundled slim manifest (no fetch; the
// PNG atlases are build files loaded by three's TextureLoader). hi for the 3 nearest kittens, lo for the rest (pickLod).
import { createAtlas, createMoveSeq, moveAnimFor } from './art/atlas.js';
import { sheetTextureOrientation, bitmapFlipWorked, pickLodStable, checkArtCell } from './art-glue.js';
import { ART_MANIFEST } from './art-manifest.gen.js';
import { artIdOf, artPose, boxFaceUV, createResidency } from './art-glue.js';
import { LT_ROOM_STARTERS } from '../../game/core/lasertag-room.js';
import { HAPPY_TUNING } from './director.js';
import { Matrix4, Line, LineBasicMaterial, BufferGeometry, Float32BufferAttribute } from 'three';
import { HUD_TUNING, hudLayout } from './hud-menu.js';
import { TIP_TUNING } from './hints.js'; // GE2-B (Owner #2): the hint card is small, low + to the side, fades, any tap dismisses it
import { DataTexture, ImageLoader, LinearFilter, RGBAFormat, Texture, UnsignedByteType } from 'three';
import { SphereGeometry } from 'three'; // SK-PORT: the Yarn Tug pompom

const BOX_SIZE_M = 0.28; // roomcat: boxR 0.14, boxH 0.3
const CARD_W = 0.42, CARD_H = 0.12, CARD_AHEAD = 0.9, CARD_BELOW = 0.22; // head-locked hint card (metres)
const END_W = 0.6, END_H = 0.42;
const METER_W = 0.3, METER_H = 0.022, METER_ABOVE = 0.09; // the Happiness bar sits this far above the hint card's centre
const ART_BASE = './art/'; // vr/public/art -> dist/art (vite publicDir), relative like every other build file (base './')
/** a small canvas texture: heart / soft disc / spark (original shapes, no brands) */
function particleTexture(kind) {
  const px = 64, canvas = document.createElement('canvas'); canvas.width = canvas.height = px;
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, px, px);
  if (kind === 'heart') {
    ctx.fillStyle = '#ff9ec7'; ctx.beginPath(); ctx.moveTo(32, 58); ctx.bezierCurveTo(6, 38, 2, 16, 18, 10); ctx.bezierCurveTo(26, 7, 32, 14, 32, 20); ctx.bezierCurveTo(32, 14, 38, 7, 46, 10); ctx.bezierCurveTo(62, 16, 58, 38, 32, 58); ctx.closePath(); ctx.fill();
  } else if (kind === 'dust') {
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30); g.addColorStop(0, 'rgba(255,243,230,0.9)'); g.addColorStop(1, 'rgba(255,243,230,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, px, px);
  } else {
    ctx.fillStyle = '#ffe08a'; ctx.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, r = i % 2 ? 10 : 28; ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); } ctx.closePath(); ctx.fill();
  }
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace; return tex;
}

/** A text card on a quad (original look: dark rounded panel, pale text). lines = string[]. */
function makeCard(w, h, px) {
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = Math.round(px * h / w);
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
  mesh.renderOrder = 999; mesh.visible = false;
  const draw = (lines, big) => {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!lines || !lines.length) { tex.needsUpdate = true; return; }
    ctx.fillStyle = 'rgba(29, 22, 38, 0.82)';
    const r = H * 0.18; ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r); ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H); ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff3e6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.min(H * 0.42, W / Math.max(12, Math.max(...lines.map((l) => l.length)) * 0.62), big ? H / (lines.length + 1) : H * 0.42);
    ctx.font = `600 ${Math.round(fs)}px system-ui, sans-serif`;
    const step = fs * 1.3, y0 = H / 2 - step * (lines.length - 1) / 2;
    lines.forEach((l, i) => { if (i === 0 && big) ctx.font = `700 ${Math.round(fs * 1.15)}px system-ui, sans-serif`; ctx.fillText(l, W / 2, y0 + i * step, W * 0.92); if (i === 0 && big) ctx.font = `600 ${Math.round(fs)}px system-ui, sans-serif`; });
    tex.needsUpdate = true;
  };
  return { mesh, draw, tex };
}

/** SK-HUD: a canvas quad for the HUD (same dark rounded look as the cards). draw(fn) paints with fn(ctx, W, H). */
function makeHudCanvas(w, h, px) {
  const canvas = document.createElement('canvas'); canvas.width = px; canvas.height = Math.round(px * h / w);
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
  mesh.visible = false;
  return { mesh, tex, canvas, draw(fn) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); fn(ctx, canvas.width, canvas.height); tex.needsUpdate = true; } };
}
/** SK-PORT (WIRING 17): the looked-at kitten's needs as 4 small bars (0..100, higher = wants it more) with drawn icons (fish = Hunger,
 *  yarn = Play, heart = Cuddle, Z = Sleepy; original vector shapes) in the strip's line-1 row from x0 to x1. Redrawn only on a 10 % step. */
function hudNeedsBars(ctx, nd, x0, x1, H) {
  ctx.save();
  const nameW = (x1 - x0) * 0.28, cy = H * 0.3, gw = ((x1 - x0) - nameW) / 4;
  ctx.fillStyle = '#fff3e6'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `600 ${Math.round(H * 0.24)}px system-ui, sans-serif`;
  ctx.fillText(String(nd.name || ''), x0, cy, nameW - H * 0.06);
  const vals = [nd.hunger, nd.play, nd.cuddle, nd.sleepy], cols = ['#9fe3cf', '#ffb38a', '#ff9ec7', '#c9a7f5'], r = H * 0.09;
  for (let i = 0; i < 4; i++) {
    const gx = x0 + nameW + i * gw, ix = gx + r * 1.2, bx = gx + r * 2.6, bw = gw - r * 3.2, bh = H * 0.16;
    ctx.fillStyle = cols[i]; ctx.strokeStyle = cols[i]; ctx.lineWidth = H * 0.035;
    ctx.beginPath();
    if (i === 0) { ctx.ellipse(ix - r * 0.2, cy, r * 0.8, r * 0.5, 0, 0, Math.PI * 2); ctx.moveTo(ix + r * 0.5, cy); ctx.lineTo(ix + r * 1.1, cy - r * 0.5); ctx.lineTo(ix + r * 1.1, cy + r * 0.5); ctx.closePath(); ctx.fill(); }
    else if (i === 1) { ctx.arc(ix, cy, r * 0.8, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(ix - r * 0.9, cy - r * 0.2, r * 0.9, -0.6, 0.6); ctx.stroke(); }
    else if (i === 2) { ctx.moveTo(ix, cy + r * 0.8); ctx.bezierCurveTo(ix - r * 1.4, cy - r * 0.2, ix - r * 0.5, cy - r * 1.2, ix, cy - r * 0.4); ctx.bezierCurveTo(ix + r * 0.5, cy - r * 1.2, ix + r * 1.4, cy - r * 0.2, ix, cy + r * 0.8); ctx.fill(); }
    else { ctx.font = `700 ${Math.round(H * 0.22)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText('z', ix, cy); ctx.textAlign = 'left'; }
    ctx.fillStyle = 'rgba(255, 243, 230, 0.22)'; hudRound(ctx, bx, cy - bh / 2, bw, bh, bh / 2); ctx.fill();
    const v = Math.max(0, Math.min(100, Number(vals[i]) || 0)) / 100;
    if (v > 0) { ctx.fillStyle = cols[i]; hudRound(ctx, bx, cy - bh / 2, Math.max(bh, bw * v), bh, bh / 2); ctx.fill(); }
  }
  ctx.restore();
}
function hudRound(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h); ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r); ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath(); }

/**
 * createRoomHook({ seed, cats, size, arc, onLog, roster, visit, names, persisted, leftHanded, memory, draw }) -> { bridge, group, sync(result, head, gaze), cats, dispose() }
 * (persisted = the visit was saved locally, visit-store.js: only then does the end card promise a new kitten tomorrow)
 *   group: add it to the scene (persistent entity). sync() is called every frame with bridge.frame()'s result (+ the head
 *   position / gaze so the hint card can float in front of the player).
 *   dispose(): removes every child, frees geometries / materials / textures and the bridge; the hook is dead after it.
 *   One hook = one XR session (W2 review MUST 1): main.js builds a fresh one on every session so the room is re-scanned
 *   in the new local-floor frame.
 */
export function createRoomHook(opts = {}) {
  const bridge = createRoomBridge({ seed: opts.seed, cats: opts.cats, size: opts.size, arc: opts.arc, onLog: opts.onLog, roster: opts.roster, visit: opts.visit, names: opts.names, persisted: opts.persisted, leftHanded: opts.leftHanded, memory: opts.memory, furniture: opts.furniture, saveFurniture: opts.saveFurniture });
  const group = new Group();
  group.name = 'kca-room';
  const cats = new Map(); // cat id -> billboard
  const cache = createSpriteCache({ draw: opts.draw || catArtDraw() || undefined }); // W3: one texture per (cat, view, pose), shared by the billboards (the fallback when a cat has no atlas art)
  // P0a: Design's atlas sprites, 7 sheets per kitten (review BC MUST 2 + Design's 11:2x asks). Two layers:
  //   images: every sheet (hi + lo) a kitten can need is fetched and DECODED upfront at hook creation (today's kittens + the Laser
  //           Tag starters + the box) into a CPU image cache: no network and no decode mid-play;
  //   GPU:    a sheet becomes a Texture only when first drawn (the upload of a decoded image), the residency LRU (art-glue
  //           createResidency) keeps the GPU at <= 8 MB incl. the box and frees any sheet not drawn for ~1 s. A sheet whose image
  //           is not decoded yet (first seconds) or that cannot fit draws the other lod, else the canvas sprite.
  const atlas = opts.atlas === null ? null : createAtlas(opts.atlas || ART_MANIFEST);
  const M = atlas ? atlas.manifest : null;
  const images = new Map();   // file -> HTMLImageElement (decoded) | 'loading'
  const atlasTex = new Map(); // file -> Texture (GPU resident)
  const residency = createResidency(8 * 1024 * 1024, 1.0);
  const onPerf = typeof opts.onPerf === 'function' ? opts.onPerf : null; // DEV smoke only: (what, detail) for every upload / free / card redraw / warm step
  const pinned = new Set(); // sheets uploaded by warm() before their first draw: kept through the stale sweep until drawn once (the budget still counts them)
  const sheetBytes = (file) => { const b = atlas.sheetGpuBytes ? atlas.sheetGpuBytes(file) : null; return b != null ? b : /\.lo\.png$/.test(file) ? M.lods.lo.gpuBytesPerCat : M.lods.hi.gpuBytesPerCat; }; // Q-GE2: an adult hi sheet (1024 x 512) = 2 MB
  const imgLoader = typeof document !== 'undefined' ? new ImageLoader() : null;
  // Quest fix (2026-10-10, the owner's "flashing parts in a rectangle"): WebGL ignores texture.flipY for an ImageBitmap source, so a
  // sheet must be decoded with imageOrientation 'flipY' and uploaded with flipY = false (art-glue sheetTextureOrientation). A
  // 1 x 2 probe checks the browser really flips the bitmap; if not, sheets stay <img> (flipY true, honoured for <img>).
  const bitmapOk = (typeof createImageBitmap === 'function' && typeof document !== 'undefined') ? new Promise((res) => {
    try {
      const c = document.createElement('canvas'); c.width = 1; c.height = 2; const g = c.getContext('2d');
      g.fillStyle = 'rgba(255,0,0,1)'; g.fillRect(0, 0, 1, 1); g.fillStyle = 'rgba(0,0,255,1)'; g.fillRect(0, 1, 1, 1);
      const before = g.getImageData(0, 0, 1, 2).data, topB = before[0], botB = before[4];
      createImageBitmap(c, sheetTextureOrientation('bitmap').bitmapOptions).then((bmp) => {
        const d = document.createElement('canvas'); d.width = 1; d.height = 2; const h = d.getContext('2d'); h.drawImage(bmp, 0, 0);
        const after = h.getImageData(0, 0, 1, 2).data; if (typeof bmp.close === 'function') bmp.close();
        res(bitmapFlipWorked(topB, botB, after[0]));
      }, () => res(false));
    } catch (e) { res(false); }
  }) : Promise.resolve(false);
  let bitmapMode = null; bitmapOk.then((ok) => { bitmapMode = ok; if (onPerf) onPerf('bitmap-probe', { flipOk: ok }); });
  const imageKind = (img) => (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap ? 'bitmap' : 'img');
  function preloadImage(file) {
    if (!imgLoader || images.has(file)) return;
    images.set(file, 'loading');
    // decode upfront into an ImageBitmap when the browser has it AND flips it on creation (its pixels stay decoded; an <img> may
    // drop them under memory pressure and decode again at upload time: review BF S2b), else a decoded <img>
    imgLoader.load(ART_BASE + file, (img) => {
      const keep = (bmp) => images.set(file, bmp);
      const asImg = () => { if (img && typeof img.decode === 'function') img.decode().then(() => keep(img), () => keep(img)); else keep(img); };
      bitmapOk.then((ok) => { if (ok) createImageBitmap(img, sheetTextureOrientation('bitmap').bitmapOptions).then(keep, asImg); else asImg(); });
    }, undefined, () => images.delete(file));
  }
  const todayIds = (opts.cats || []).map((c) => grownArtFor(atlas, artIdOf(c && c.id != null ? c.id : c), c && c.size).artId).filter((id) => atlas && atlas.resolveCat(id)); // Q-GE2: a grown cat preloads its adult sheets
  const ltIds = atlas ? LT_ROOM_STARTERS.slice(0, HAPPY_TUNING.ltCats).filter((id) => atlas.resolveCat(id)) : [];
  if (atlas) for (const id of [...todayIds, ...ltIds]) for (const lod of ['lo', 'hi']) for (const f of atlas.sheetFiles(id, lod)) preloadImage(f);
  /** the RESIDENT texture for a sheet, uploading it from the decoded image if the budget allows; null = draw something else */
  let uploadsThisFrame = 0, uploads = 0; // review BF S2a: at most one GPU upload per frame (the others draw the other lod / canvas for a frame)
  function atlasTexture(file, tNowS) {
    let t = atlasTex.get(file);
    if (t) { residency.touch(file, 0, tNowS); return t; }
    const img = images.get(file);
    if (!img || img === 'loading' || uploadsThisFrame >= 1) return null;
    const evicted = residency.touch(file, sheetBytes(file), tNowS);
    if (evicted === null) return null; // no room: the frame's upload slot stays free for this kitten's lo sheet (review BI S2)
    uploadsThisFrame++; uploads++;
    for (const f of evicted) freeTexture(f, true);
    t = new Texture(img); t.flipY = sheetTextureOrientation(imageKind(img)).flipY; t.colorSpace = SRGBColorSpace; t.generateMipmaps = false; t.minFilter = LinearFilter; t.magFilter = LinearFilter; t.needsUpdate = true;
    const t0 = onPerf ? now() : 0;
    if (opts.renderer && typeof opts.renderer.initTexture === 'function') { try { opts.renderer.initTexture(t); } catch (e) { /* upload at first draw */ } }
    if (onPerf) onPerf('upload', { file, bytes: sheetBytes(file), ms: +(now() - t0).toFixed(2), evicted: evicted.length, resident: residency.bytes });
    atlasTex.set(file, t);
    return t;
  }
  function freeTexture(file, keepBook) { const t = atlasTex.get(file); if (t) { t.dispose(); atlasTex.delete(file); if (onPerf) onPerf('free', { file }); } pinned.delete(file); if (!keepBook) residency.drop(file); }
  function evictStale(tNowS) { for (const f of residency.stale(tNowS)) { if (pinned.has(f)) continue; freeTexture(f, true); residency.drop(f); } }
  /** a sheet drawn for real: a warmed sheet is no longer pinned (the normal stale rule applies from here) */
  function drawTexture(file, tNowS) { const t = atlasTexture(file, tNowS); if (t && pinned.size && pinned.has(file)) pinned.delete(file); return t; }
  const anim = new Map(); // billboard id -> { key, since, x, z, t, speed, lod }
  const seenScratch = new Set(); // reused every frame (review BF S4)
  let lodT = -Infinity;
  let disposed = false;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // W3: toy basket (a short open cylinder) + the feather wand (a thin stick from the handle to the tip, a feather disc at the tip)
  const basket = new Mesh(new CylinderGeometry(WAND_TUNING.basketR, WAND_TUNING.basketR * 0.8, WAND_TUNING.basketH, 20, 1, true), new MeshBasicMaterial({ color: 0xd9b382, side: DoubleSide }));
  basket.visible = false; group.add(basket);
  const stick = new Mesh(new CylinderGeometry(0.004, 0.004, 1, 6), new MeshBasicMaterial({ color: 0x6b4a3a }));
  stick.visible = false; group.add(stick);
  const feather = new Mesh(new CircleGeometry(0.035, 12), new MeshBasicMaterial({ color: 0xff9ec7, side: DoubleSide, transparent: true, opacity: 0.95 }));
  feather.visible = false; group.add(feather);
  // SK-PORT (Q-GE2): the Feather Pop feather (original canvas art: a curved quill with soft lilac vanes and a mint tip, drawn here) and the
  // Yarn Tug strand (a 2-point line) + pompom bead. Built once; sync() only moves / shows them (no per-frame allocation).
  const fpTex = (() => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 128);
    g.fillStyle = '#c9a7f5'; g.beginPath(); g.moveTo(32, 6); g.bezierCurveTo(58, 30, 54, 84, 34, 112); g.bezierCurveTo(12, 86, 8, 32, 32, 6); g.fill();
    g.fillStyle = '#9fe3cf'; g.beginPath(); g.moveTo(32, 6); g.bezierCurveTo(44, 16, 44, 30, 33, 38); g.bezierCurveTo(22, 30, 22, 16, 32, 6); g.fill();
    g.strokeStyle = 'rgba(255, 255, 255, 0.55)'; g.lineWidth = 2; for (let i = 0; i < 6; i++) { const y = 46 + i * 10; g.beginPath(); g.moveTo(33, y); g.lineTo(46 - i, y - 8); g.moveTo(33, y); g.lineTo(20 + i, y - 8); g.stroke(); }
    g.strokeStyle = '#f6efe6'; g.lineWidth = 3; g.beginPath(); g.moveTo(32, 10); g.quadraticCurveTo(36, 70, 33, 124); g.stroke();
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  })();
  const fpFeather = new Mesh(new PlaneGeometry(0.06, 0.12), new MeshBasicMaterial({ map: fpTex, transparent: true, side: DoubleSide, depthWrite: false }));
  fpFeather.visible = false; group.add(fpFeather);
  const tugLine = (() => { const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3)); const l = new Line(g, new LineBasicMaterial({ color: 0xff9ec7 })); l.visible = false; l.frustumCulled = false; group.add(l); return l; })();
  const tugBead = new Mesh(new SphereGeometry(0.025, 12, 8), new MeshBasicMaterial({ color: 0xffe08a })); tugBead.visible = false; group.add(tugBead);
  // Q-GE2: the Games Master. PLACEHOLDER original silhouette (no VR sprite sheet for him exists yet): two stacked
  // quads painted ONCE on canvases: the FUR layer (white, tinted by the fur colour: the sneeze crossfades only this tint) and the
  // OUTFIT layer (purple jacket + top hat, bottle-green bow tie + band, small neon-green trim; never changes). The Oni mask is one
  // small static quad (shown / hidden only, no flash); the distance ring is a faint floor ring around the player while he stalks;
  // the Calm sneezes notice is one card painted once (text, "Keep calm sneezes" outlined as the default). No per-frame allocation.
  const GM_W = 0.42, GM_H = 0.62;
  const GM_FUR_RGB = { calico: [0.91, 0.64, 0.36], bengal: [0.79, 0.55, 0.25], marble: [0.66, 0.5, 0.34], mau: [0.62, 0.62, 0.6], polka: [0.95, 0.82, 0.45], stars: [0.36, 0.39, 0.64], splat: [0.48, 0.76, 0.7], glass: [0.68, 0.85, 0.92] };
  const GM_FUR_ELSE = [0.8, 0.78, 0.74];
  function gmCanvasTex(w, h, paint) {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h; paint(c.getContext('2d'), w, h);
    const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; return t;
  }
  const gmPaintFur = (g) => { // white: tinted by the material colour
    g.fillStyle = '#ffffff';
    g.beginPath(); g.ellipse(128, 270, 66, 92, 0, 0, Math.PI * 2); g.fill();            // body (mostly under the jacket)
    g.beginPath(); g.arc(128, 150, 50, 0, Math.PI * 2); g.fill();                         // head
    g.beginPath(); g.moveTo(84, 128); g.lineTo(92, 82); g.lineTo(118, 110); g.fill();     // ear
    g.beginPath(); g.moveTo(172, 128); g.lineTo(178, 96); g.lineTo(150, 108); g.fill();   // the folded ear
    g.lineWidth = 14; g.strokeStyle = '#ffffff'; g.beginPath(); g.moveTo(186, 336); g.quadraticCurveTo(246, 300, 226, 214); g.stroke(); // tail
    g.beginPath(); g.arc(226, 206, 18, 0, Math.PI * 2); g.fill();                        // poofy tuft
    g.beginPath(); g.ellipse(100, 368, 22, 12, 0, 0, Math.PI * 2); g.ellipse(156, 368, 22, 12, 0, 0, Math.PI * 2); g.fill(); // paws
  };
  const gmPaintOutfit = (g) => {
    g.fillStyle = '#7f3fe0'; g.beginPath(); g.moveTo(80, 214); g.lineTo(176, 214); g.lineTo(194, 356); g.lineTo(62, 356); g.closePath(); g.fill(); // jacket
    g.fillStyle = '#4b1f8f'; g.beginPath(); g.moveTo(128, 222); g.lineTo(96, 216); g.lineTo(112, 290); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(128, 222); g.lineTo(160, 216); g.lineTo(144, 290); g.closePath(); g.fill();                                          // lapels
    g.fillStyle = '#1f6b3a'; g.fillRect(62, 346, 132, 10);                                                                                       // hem
    g.strokeStyle = '#7dff6a'; g.lineWidth = 2; g.beginPath(); g.moveTo(80, 214); g.lineTo(62, 356); g.moveTo(176, 214); g.lineTo(194, 356); g.stroke(); // piping
    g.fillStyle = '#7dff6a'; for (const y of [300, 322]) { g.beginPath(); g.arc(128, y, 4, 0, Math.PI * 2); g.fill(); }                          // buttons
    g.fillStyle = '#1f6b3a'; g.beginPath(); g.moveTo(128, 206); g.lineTo(106, 196); g.lineTo(106, 218); g.closePath(); g.moveTo(128, 206); g.lineTo(150, 196); g.lineTo(150, 218); g.closePath(); g.fill(); // bow tie
    g.fillStyle = '#5a2aa8'; g.fillRect(70, 100, 116, 12);                                                                                       // hat brim
    g.fillStyle = '#7f3fe0'; g.fillRect(90, 24, 76, 78);                                                                                         // crown
    g.fillStyle = '#1f6b3a'; g.fillRect(90, 86, 76, 12);                                                                                         // band
    g.strokeStyle = '#7dff6a'; g.lineWidth = 1.5; g.beginPath(); for (const x of [104, 128, 152]) { g.moveTo(x, 26); g.lineTo(x, 84); } g.stroke(); // pinstripe
    g.fillStyle = '#2a1d33'; g.beginPath(); g.ellipse(110, 150, 7, 9, 0, 0, Math.PI * 2); g.ellipse(146, 150, 7, 9, 0, 0, Math.PI * 2); g.fill(); // eyes
    g.fillStyle = '#ffffff'; g.beginPath(); g.moveTo(134, 176); g.lineTo(140, 176); g.lineTo(137, 186); g.closePath(); g.fill();                // one-fang smirk
  };
  const gmPaintMask = (g) => { // an original Oni-style festival mask: muted crimson, ivory horns, gold brows (static; no saturated red)
    g.fillStyle = '#efe6cf'; g.beginPath(); g.moveTo(30, 34); g.lineTo(40, 2); g.lineTo(50, 30); g.moveTo(78, 30); g.lineTo(88, 2); g.lineTo(98, 34); g.fill();
    g.fillStyle = '#b8443f'; g.beginPath(); g.ellipse(64, 70, 50, 54, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e0b040'; g.fillRect(28, 50, 30, 7); g.fillRect(70, 50, 30, 7);
    g.fillStyle = '#2a1d33'; g.beginPath(); g.ellipse(44, 70, 9, 7, 0, 0, Math.PI * 2); g.ellipse(84, 70, 9, 7, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#efe6cf'; g.fillRect(40, 96, 48, 8);
  };
  const gmGroup = new Group(); gmGroup.visible = false; group.add(gmGroup);
  const gmFurMat = new MeshBasicMaterial({ map: gmCanvasTex(256, 384, gmPaintFur), transparent: true, depthWrite: false, side: DoubleSide, alphaTest: 0.05 });
  const gmFur = new Mesh(new PlaneGeometry(GM_W, GM_H), gmFurMat); gmFur.position.y = GM_H / 2;
  const gmOutfit = new Mesh(new PlaneGeometry(GM_W, GM_H), new MeshBasicMaterial({ map: gmCanvasTex(256, 384, gmPaintOutfit), transparent: true, depthWrite: false, side: DoubleSide, alphaTest: 0.05 }));
  gmOutfit.position.set(0, GM_H / 2, 0.002);
  const gmMask = new Mesh(new PlaneGeometry(0.15, 0.15), new MeshBasicMaterial({ map: gmCanvasTex(128, 128, gmPaintMask), transparent: true, depthWrite: false, side: DoubleSide }));
  gmMask.position.set(0, GM_H * 0.62, 0.004); gmMask.visible = false;
  gmGroup.add(gmFur, gmOutfit, gmMask);
  const gmRing = new Mesh(new RingGeometry(GM_HOST_TUNING.oniRingM - 0.025, GM_HOST_TUNING.oniRingM, 48), new MeshBasicMaterial({ color: 0xc9b6ff, transparent: true, opacity: 0.3, depthWrite: false, side: DoubleSide }));
  gmRing.rotation.x = -Math.PI / 2; gmRing.visible = false; group.add(gmRing);
  const gmNotice = typeof document !== 'undefined' ? makeHudCanvas(GM_HOST_TUNING.noticeW, GM_HOST_TUNING.noticeH, 640) : null;
  if (gmNotice) {
    gmNotice.mesh.renderOrder = 999; group.add(gmNotice.mesh);
    gmNotice.draw((g, W, H) => {
      const N = GM_HOST_TEXT;
      g.fillStyle = 'rgba(29, 22, 38, 0.9)'; hudRound(g, 0, 0, W, H, H * 0.08); g.fill();
      g.fillStyle = '#fff3e6'; g.textAlign = 'left'; g.textBaseline = 'top'; g.font = `600 ${Math.round(H * 0.075)}px system-ui, sans-serif`;
      const words = N.notice.split(' '), lh = H * 0.095; let line = '', y = H * 0.06;
      for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > W * 0.9 && line) { g.fillText(line, W * 0.05, y); y += lh; line = w; } else line = t; }
      if (line) g.fillText(line, W * 0.05, y);
      const T2 = GM_HOST_TUNING, bw = W * 0.34, bh = H * 0.18, by = H * (0.5 - T2.btnDY / T2.noticeH) - bh / 2;
      for (const [k, label] of [[-1, N.keep], [1, N.full]]) {
        const bx = W * (0.5 + k * T2.btnDX / T2.noticeW) - bw / 2;
        g.fillStyle = k < 0 ? '#ff9ec7' : 'rgba(255, 243, 230, 0.16)'; hudRound(g, bx, by, bw, bh, bh * 0.3); g.fill();
        if (k < 0) { g.strokeStyle = '#fff3e6'; g.lineWidth = 4; hudRound(g, bx, by, bw, bh, bh * 0.3); g.stroke(); } // the default focus
        g.fillStyle = k < 0 ? '#1d1626' : '#fff3e6'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `700 ${Math.round(H * 0.07)}px system-ui, sans-serif`;
        g.fillText(label, bx + bw / 2, by + bh / 2, bw * 0.92);
      }
    });
  }
  /** the host view (room-bridge result.gm) -> his quads, the mask, the ring, the notice card */
  function syncGm(gm, head, tNow) {
    if (!gm || !gm.on) { gmGroup.visible = false; gmRing.visible = false; if (gmNotice) gmNotice.mesh.visible = false; return; }
    gmGroup.visible = true;
    const p = gm.pose, hop = p === 'cheer' || p === 'trophy' ? 0.03 * Math.abs(Math.sin(tNow / 160)) : 0;
    gmGroup.position.set(gm.x, gm.y + hop, gm.z);
    if (head) gmGroup.rotation.set(0, Math.atan2(head.x - gm.x, head.z - gm.z), p === 'megaphone' || p === 'point' ? 0.08 : 0);
    gmGroup.scale.set(1, p === 'nap' ? 0.85 : p === 'stalk' ? 0.92 : 1, 1);
    const a = GM_FUR_RGB[gm.furFrom] || GM_FUR_ELSE, c = GM_FUR_RGB[gm.fur] || GM_FUR_ELSE, k = gm.fade >= 1 ? 1 : gm.fade <= 0 ? 0 : gm.fade;
    gmFurMat.color.setRGB(a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k);
    gmMask.visible = !!gm.mask;
    gmRing.visible = !!gm.ring.on; if (gmRing.visible) gmRing.position.set(gm.ring.x, gm.y + 0.005, gm.ring.z);
    if (gmNotice) {
      const N = gm.notice; gmNotice.mesh.visible = !!N.on;
      if (N.on) { gmNotice.mesh.position.set(N.x, N.y, N.z); gmNotice.mesh.rotation.set(0, Math.atan2(-N.rz, N.rx), 0); } // faces the player (its +x = the card's right)
    }
  }
  // Q-GE2: furniture meshes, one Group per piece id (built once from its parts, dropped + disposed when the piece goes)
  const furnGroups = new Map(), furnSeen = new Set();
  const bin = new Mesh(new RingGeometry(FURN_VR_TUNING.binR * 0.75, FURN_VR_TUNING.binR, 32), new MeshBasicMaterial({ color: 0xe597b5, side: DoubleSide, transparent: true, opacity: 0.8 }));
  bin.rotation.x = -Math.PI / 2; bin.visible = false; group.add(bin);
  function furnGroup(p) {
    const g = new Group(), k = furnitureKind(p.kind);
    for (const q of k.parts) {
      const geo = q.t === 'box' ? new BoxGeometry(q.x1 - q.x0, q.y1 - q.y0, q.z1 - q.z0) : new CylinderGeometry(q.r, q.r, q.y1 - q.y0, 16);
      const m = new Mesh(geo, new MeshBasicMaterial({ color: q.c }));
      m.position.set(q.t === 'box' ? (q.x0 + q.x1) / 2 : q.cx, (q.y0 + q.y1) / 2, q.t === 'box' ? (q.z0 + q.z1) / 2 : q.cz); g.add(m);
    }
    group.add(g); return g;
  }
  function syncFurniture(fs) {
    furnSeen.clear();
    if (fs) for (const p of fs.pieces) { let g = furnGroups.get(p.id); if (!g) { g = furnGroup(p); furnGroups.set(p.id, g); } g.position.set(p.x, p.y + (p.held ? 0.01 : 0), p.z); g.rotation.set(0, p.yaw, 0); g.visible = true; furnSeen.add(p.id); }
    if (furnGroups.size !== furnSeen.size) for (const [id, g] of furnGroups) if (!furnSeen.has(id)) { group.remove(g); g.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); furnGroups.delete(id); }
    const showBin = !!(fs && fs.bin && (fs.held.left || fs.held.right)); bin.visible = showBin; // the bin shows while a piece is held
    if (showBin) bin.position.set(fs.bin.x, fs.bin.y + 0.005, fs.bin.z);
  }
  // cards: hint / caption (GE2-B: small, low and to the side, placed + faded by tip-card.js via result.tipCard) and the end card (bigger, centred)
  const card = makeCard(TIP_TUNING.w, TIP_TUNING.h, 512); group.add(card.mesh);
  const endCard = makeCard(END_W, END_H, 768); group.add(endCard.mesh);
  let cardLines = '';

  const BOX_H = BOX_SIZE_M * 1.07;
  const box = new Group(); box.visible = false; group.add(box); // origin = the box's bottom centre on its spot
  // Design's brand box (box/box.png faces): side_a toward the player (+z), side_b on the other walls, top_closed under the flaps,
  // inner_wall / inner_floor (the pink blanket) on the inside; plain cardboard colours when the art is missing
  const boxFile = atlas && atlas.boxFace('side_a') ? atlas.boxFace('side_a').file : null;
  if (boxFile) preloadImage(boxFile);
  let boxArt = boxFile ? atlasTexture(boxFile, 0) : null; // usually still decoding here: sync() swaps the art in when it lands
  let boxFreed = false;
  // a 1 x 1 white map stands in until the art decodes, so the box material's shader program (USE_MAP) is the same before and after
  // the swap: the swap is a texture bind, never a mid-play shader compile (CI #11 frame 9)
  const whiteTex = boxFile ? new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType) : null; if (whiteTex) { whiteTex.colorSpace = SRGBColorSpace; whiteTex.needsUpdate = true; }
  const boxMat = boxFile ? new MeshBasicMaterial({ map: boxArt || whiteTex, color: 0xc8a165 }) : new MeshBasicMaterial({ color: 0xc8a165 }); // cardboard colour until the art decodes (map x colour: set the colour white once the map lands)
  const bodyGeom = new BoxGeometry(BOX_SIZE_M, BOX_H, BOX_SIZE_M);
  if (boxFile) { const A = atlas.boxFace('side_a').uv, B = atlas.boxFace('side_b').uv, T = atlas.boxFace('top_closed').uv; [B, B, T, T, A, B].forEach((uv, i) => boxFaceUV(bodyGeom, i, uv)); }
  const boxBody = new Mesh(bodyGeom, boxMat);
  boxBody.position.y = BOX_H / 2; box.add(boxBody);
  const innerGeom = new BoxGeometry(BOX_SIZE_M * 0.92, BOX_H * 0.9, BOX_SIZE_M * 0.92);
  if (boxFile) { const W = atlas.boxFace('inner_wall').uv, F = atlas.boxFace('inner_floor').uv; [W, W, F, F, W, W].forEach((uv, i) => boxFaceUV(innerGeom, i, uv)); }
  const boxInner = new Mesh(innerGeom, boxFile ? new MeshBasicMaterial({ map: boxArt || whiteTex, side: DoubleSide, color: 0xc8a165 }) : new MeshBasicMaterial({ color: 0x6b4a3a, side: DoubleSide })); // the inside, seen once the flaps are up
  boxInner.position.y = BOX_H * 0.5; boxInner.visible = false; box.add(boxInner);
  // two cardboard flaps hinged on the back / front top edges: each a thin box whose pivot group sits on the edge (hinge = the art's top edge)
  const flaps = [];
  for (const sgn of [-1, 1]) {
    const pivot = new Group(); pivot.position.set(0, BOX_H, sgn * BOX_SIZE_M / 2); box.add(pivot);
    const fg = new BoxGeometry(BOX_SIZE_M, 0.01, BOX_SIZE_M / 2);
    if (boxFile && atlas.boxFace('flap')) { const Fl = atlas.boxFace('flap').uv; for (let i = 0; i < 6; i++) boxFaceUV(fg, i, Fl); } // was gated on boxArt, which is still decoding here: the flaps never got the art
    const flap = new Mesh(fg, boxFile ? boxMat : new MeshBasicMaterial({ color: 0xb08a50 }));
    flap.position.z = -sgn * BOX_SIZE_M / 4; pivot.add(flap); flaps.push({ pivot, sgn });
  }
  const boxOut = { jiggle: 0, squash: 0, lid: 0 };
  let playDotAlpha = 0, lastSyncMs = now();
  // the Laser Tag start target: a soft coral ring on the floor ahead while the offer / score card stands. STATIC (no swell):
  // every brightness change near the kittens is counted by the fx limiter (review BB MUST 3), so the ring makes none
  const targetRing = new Mesh(new RingGeometry(0.16, 0.2, 40), new MeshBasicMaterial({ color: 0xff7a6b, transparent: true, opacity: 0.5, depthWrite: false, side: DoubleSide }));
  targetRing.rotation.x = -Math.PI / 2; targetRing.visible = false; group.add(targetRing);

  // the dot: a white core with a soft CORAL ring (#ff7a6b: R share 0.53, no saturated red per Legal / plan 17.3) on a dark
  // halo (light floors); the Play laser and the Laser Tag dot share it. Size scales with the distance to the head (>= 0.6 deg, audit 3.2)
  const laser = new Group(); laser.visible = false; group.add(laser);
  const dotHalo = new Mesh(new CircleGeometry(0.03, 20), new MeshBasicMaterial({ color: 0x1d1626, transparent: true, opacity: 0.35, depthWrite: false }));
  const dotRing = new Mesh(new RingGeometry(0.012, 0.022, 20), new MeshBasicMaterial({ color: 0xff7a6b, transparent: true, opacity: 0.95, depthWrite: false }));
  const dotCore = new Mesh(new CircleGeometry(0.011, 16), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
  for (const m of [dotHalo, dotRing, dotCore]) { m.rotation.x = -Math.PI / 2; laser.add(m); }
  dotRing.position.y = 0.001; dotCore.position.y = 0.002;

  // particles: one InstancedMesh per kind, instance count = the fx pool size (fixed, never grows); unused instances scale to 0
  const dummy = new Object3D();
  const pools = {}, POOL_KINDS = ['heart', 'dust', 'spark'], poolWasAlive = { heart: true, dust: true, spark: true };
  for (const kind of POOL_KINDS) {
    const n = kind === 'heart' ? FX_TUNING.heartsMax : kind === 'dust' ? FX_TUNING.dustMax : FX_TUNING.sparkMax;
    const im = new InstancedMesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ map: particleTexture(kind), transparent: true, depthWrite: false, side: DoubleSide, alphaTest: 0.02 }), n);
    im.frustumCulled = false; im.renderOrder = 10; im.count = n;
    dummy.position.set(0, -10, 0); dummy.scale.set(0, 0, 0); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
    for (let i = 0; i < n; i++) im.setMatrixAt(i, dummy.matrix);
    im.instanceMatrix.needsUpdate = true; group.add(im); pools[kind] = im;
  }
  // Kitten Happiness meter: a dark track + a pink fill (scaled in x from its left end) + a tiny label card, head-locked
  const meter = new Group(); meter.visible = false; group.add(meter);
  const track = new Mesh(new PlaneGeometry(METER_W, METER_H), new MeshBasicMaterial({ color: 0x1d1626, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false, side: DoubleSide }));
  const fill = new Mesh(new PlaneGeometry(METER_W, METER_H * 0.7), new MeshBasicMaterial({ color: 0xff9ec7, depthTest: false, depthWrite: false, side: DoubleSide }));
  fill.geometry.translate(METER_W / 2, 0, 0); fill.position.set(-METER_W / 2, 0, 0.001); fill.scale.x = 0.0001;
  track.renderOrder = 998; fill.renderOrder = 999; meter.add(track); meter.add(fill);
  const label = makeCard(METER_W, 0.04, 384); label.draw(['Kitten Happiness'], false); label.mesh.visible = true; label.mesh.position.set(0, METER_H * 0.5 + 0.024, 0); meter.add(label.mesh);
  let meterShown = -1;
  // SK-HUD: the quick-stat strip (always on, lazy-follow) + the action tiles (open menu) + one ray cursor per hand. Two canvas
  // cards redrawn ONLY when their text / hover / active tile changes (user-driven, never a flash), placed from hud-menu.js's pose.
  const HL = hudLayout(), HT = HUD_TUNING;
  const hudStrip = makeHudCanvas(HT.stripW, HT.stripH, 640), hudTiles = makeHudCanvas(HL.gridW, HL.gridH, 640);
  hudTiles.mesh.renderOrder = 1001; hudStrip.mesh.renderOrder = 1001; group.add(hudStrip.mesh); group.add(hudTiles.mesh);
  const cursorGeo = new CircleGeometry(0.009, 20), cursorMat = new MeshBasicMaterial({ color: 0xfff3e6, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  const hudCursors = { left: new Mesh(cursorGeo, cursorMat), right: new Mesh(cursorGeo, cursorMat) };
  for (const k in hudCursors) { hudCursors[k].visible = false; hudCursors[k].renderOrder = 1002; group.add(hudCursors[k]); }
  const hudM4 = new Matrix4(), hudR = new Vector3(), hudU = new Vector3(), hudN = new Vector3();
  let hudStripKey = '', hudTilesKey = '';
  // coach review MUST 1: a thin aim beam per hand / controller while the menu is open or the ray is near the panel
  const beamMat = new LineBasicMaterial({ color: 0xfff3e6, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
  const mkBeam = () => { const g = new BufferGeometry(); g.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3)); const l = new Line(g, beamMat); l.visible = false; l.frustumCulled = false; l.renderOrder = 1002; group.add(l); return l; };
  const hudBeams = { left: mkBeam(), right: mkBeam() };
  // score card (Laser Tag): the same look as the end card, redrawn only when its lines change
  const scoreCard = makeCard(END_W, END_H * 0.8, 768); group.add(scoreCard.mesh);
  let scoreLines = '';

  // ---- perf: warm-up during the scan window (CI #11 frames 8 / 9: 254 + 123 ms at 'room ready' = shader compiles + first texture
  // uploads + the room build). warm(renderer, camera, scene) is called by the host on every frame BEFORE the room starts (the
  // 1-8 s scan, where only the preview cat draws) and does ONE step per call: (1) renderer.compileAsync of every material in the
  // hook's group (cats, box, cards, particles, dot, ring, wand: compile() walks invisible objects too; the GL link runs in parallel
  // where KHR_parallel_shader_compile exists), (2) one GPU upload per frame: the particle / card canvases, the box sheet, then each
  // of today's kittens' first sheets (side-walk hi + lo: the climb-out) through the same residency bookkeeping (<= 8 MB, box + 3 x
  // 1.25 MB = 4.75 MB on day 1), pinned until first drawn. Returns true while work remains; a no-op after start.
  const warmQueue = []; let warmed = false, warmSteps = 0, warmTries = 0;
  function warm(renderer, camera, scene) {
    if (disposed || !renderer) return false;
    if (!warmed) {
      warmed = true;
      // today's billboards exist before the compile (their map + alphaTest program is the one every kitten draws with); hidden until sync()
      for (const c of opts.cats || []) if (c && c.id != null) billboardFor(c.id, c.size).root.visible = false;
      warmQueue.push(() => { if (typeof renderer.compileAsync === 'function') renderer.compileAsync(group, camera, scene || undefined).catch(() => {}); else if (typeof renderer.compile === 'function') renderer.compile(group, camera, scene || undefined); return 'compile'; });
      // CB S3: inside an XR session, ALSO draw the (hidden) group once at zero scale so the XR variant of every program (multiview /
      // the XR render target) is the one compiled; compileAsync alone compiles the non-XR variant when the two differ
      warmQueue.push(() => {
        const xr = renderer.xr; if (!(xr && xr.isPresenting && typeof renderer.render === 'function')) return 'draw:skipped';
        const vis = []; group.traverse((o) => { if (o !== group) { vis.push([o, o.visible]); o.visible = true; } });
        const sc = group.scale.clone(); group.scale.setScalar(1e-6); group.updateMatrixWorld(true);
        const ac = renderer.autoClear; renderer.autoClear = false;
        try { renderer.render(group, camera); } catch (e) { /* the XR frame may refuse a second render: compileAsync covered it */ } finally { renderer.autoClear = ac; group.scale.copy(sc); for (const [o, v] of vis) o.visible = v; group.updateMatrixWorld(true); }
        return 'draw';
      });
      for (const tex of [pools.heart.material.map, pools.dust.material.map, pools.spark.material.map, card.tex, endCard.tex, scoreCard.tex, label.tex, whiteTex].filter(Boolean)) {
        warmQueue.push(() => { if (typeof renderer.initTexture === 'function') renderer.initTexture(tex); return 'tex'; });
      }
      if (atlas) {
        const sheets = [];
        if (boxFile) sheets.push(boxFile);
        // CB S1: only the hi sheet (the kittens climb out 0.6 m from the head = inside HI_WITHIN_M, so hi is what the LOD rule picks); any sheet still pinned 2 s after start is unpinned in sync()
        for (const id of todayIds) { const r = atlas.resolveCat(id), S = r && M.cats[r] && M.cats[r].sheets && M.cats[r].sheets['side-walk']; if (S && S.hi && images.has(S.hi)) sheets.push(S.hi); }
        for (const f of sheets) warmQueue.push(() => { if (atlasTex.has(f)) return 'sheet'; const t = atlasTexture(f, 0); if (!t) return null; pinned.add(f); return 'sheet:' + f; }); // null = not decoded yet / no slot: retry next frame
      }
    }
    uploadsThisFrame = 0;
    while (warmQueue.length) {
      const t0 = now(); let r = null;
      try { r = warmQueue[0](); } catch (e) { r = 'error'; }
      if (r === null) { if (++warmTries > 600) warmQueue.shift(); return true; } // ~8 s of retries at most (the maxWaitS scan cap)
      warmQueue.shift(); warmSteps++;
      if (onPerf) onPerf('warm', { step: r, ms: +(now() - t0).toFixed(2) });
      if (r !== 'sheet') return true; // one real step per frame
    }
    return false;
  }

  function billboardFor(id, size) {
    let b = cats.get(id);
    if (!b) { b = createCatBillboard({ cache, catId: id, size }); const gs = grownArtFor(atlas, artIdOf(id), size).scale; if (gs !== 1) b.root.scale.setScalar(gs); group.add(b.root); cats.set(id, b); } // Q-GE2: adult art at scale 1.0; the kitten art x GROWN_TUNING.scale only when the cat has no adultId
    return b;
  }

  /** place a card in front of the head: `ahead` metres along the flat gaze, `below` metres under the eye line, facing back */
  function placeCard(mesh, head, gaze, ahead, below) {
    if (!head) return;
    let gx = gaze ? gaze.x : 0, gz = gaze ? gaze.z : -1; const l = Math.sqrt(gx * gx + gz * gz) || 1; gx /= l; gz /= l;
    mesh.position.set(head.x + gx * ahead, head.y - below, head.z + gz * ahead);
    mesh.rotation.set(0, Math.atan2(head.x - mesh.position.x, head.z - mesh.position.z), 0);
  }

  /** result = bridge.frame(...) return value; head / gaze = the viewer this frame (for the cards) */
  function sync(result, head, gaze) {
    const st = result && result.state;
    if (!st || disposed) return;
    const tNow = now();
    const fx = result.fx, dir = result.director, t = bridge.time;
    uploadsThisFrame = 0;
    if (pinned.size && t >= 2) pinned.clear(); // CB S1: nothing stays pinned past 2 s of play (the normal stale rule from here)
    // box: drops with a squash, jiggles while it waits, the flaps swing open on their hinges, the box leaves after the climb
    box.visible = !st.box.gone;
    if (boxFile && !boxFreed) {
      if (st.box.gone) { boxFreed = true; freeTexture(boxFile); boxArt = null; } // the box's 1 MB leaves with it (budget rule)
      else { const bt = drawTexture(boxFile, t); if (bt && bt !== boxArt) { boxArt = bt; for (const m of [boxMat, boxInner.material]) { m.map = bt; m.color.setHex(0xffffff); } } } // same program: no needsUpdate
    }
    if (box.visible) {
      boxAnim(st.box, fx ? fx.box : { landedAt: null, openedAt: null }, t, boxOut);
      box.position.set(st.box.x, st.box.y, st.box.z);
      box.rotation.y = boxOut.jiggle;
      box.scale.set(1 + boxOut.squash, 1 - boxOut.squash * 0.8, 1 + boxOut.squash);
      for (const f of flaps) f.pivot.rotation.x = f.sgn * boxOut.lid * 2.1; // ~120 deg open, outward
      boxInner.visible = boxOut.lid > 0.05;
    }
    // the dot: Laser Tag's (director) or the Play laser (the sim's dot is already snapped to the nearest legal point)
    const dot = dir && dir.dot ? dir.dot : st.laser;
    // the Play laser has no alpha of its own: ramp it over 150 ms here (NIT 3: no one-frame pop); the Laser Tag dot brings GE1's alpha
    const want = dot ? (Number.isFinite(dot.alpha) ? dot.alpha : 1) : 0, step = Math.min(1, Math.max(0, tNow - lastSyncMs) / 150);
    lastSyncMs = tNow;
    if (dot && Number.isFinite(dot.alpha)) playDotAlpha = want; else playDotAlpha += Math.max(-step, Math.min(step, want - playDotAlpha));
    const dotAlpha = playDotAlpha;
    if (dot) laser.position.set(dot.x, dot.y + 0.003, dot.z); // a fading-out dot keeps its last spot
    if (dotAlpha > 0.001) { // drawn through opacity, never a visible toggle
      laser.visible = true;
      dotHalo.material.opacity = 0.35 * dotAlpha; dotRing.material.opacity = 0.95 * dotAlpha; dotCore.material.opacity = 0.95 * dotAlpha;
      if (head) { const dx = head.x - laser.position.x, dy = head.y - laser.position.y, dz = head.z - laser.position.z; laser.scale.setScalar(Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 1.5)); } // >= 0.6 deg at any distance
    } else laser.visible = false;
    // the floor ring target (director.offerRing) while Laser Tag is offered or the score card is up
    const ring = dir && dir.ring;
    if (ring) { targetRing.visible = true; targetRing.position.set(ring.x, ring.y + 0.004, ring.z); }
    else targetRing.visible = false;
    // cats (+ fx.js squash & stretch); LOD ranks by distance to the head, refreshed twice a second
    const seen = seenScratch; seen.clear();
    const juice = fx ? fx.juice.cats : null;
    if (atlas && head && tNow - lodT > 500) {
      const order = result.cats.slice().sort((p, q) => ((head.x - p.x) ** 2 + (head.z - p.z) ** 2) - ((head.x - q.x) ** 2 + (head.z - q.z) ** 2));
      order.forEach((c, i) => { const a = anim.get(c.id); if (a) a.rank = i; });
    }
    for (const c of result.cats) {
      seen.add(c.id);
      const b = billboardFor(c.id, c.size); // size = kitten / adult sprite keys (Code Review B NIT 3)
      b.root.visible = true;
      b.root.position.set(c.x, c.y, c.z);
      b.root.rotation.set(0, c.yaw, 0);
      b.setView(c);
      b.setPose(c.pose);
      const j = juice && juice[c.id]; if (j) b.setSquash(j.sx, j.sy);
      const a0 = anim.get(c.id), spd = Number.isFinite(c.speed) ? c.speed : a0 ? a0.speed : 0; // Q-GE2: roomcat's eased speed first
      b.setMotion(spd, c.tell, c.stalk, t); // Q-GE2: rump wiggle / freeze squash / walk bob / play-bow (procedural, no art)
      // P0a: the atlas frame for (view, pose, time since this anim started, walk speed), hi / lo by distance rank
      let pose = artPose(c.pose); const ga = grownArtFor(atlas, artIdOf(c.id), c.size), aid = ga.artId; // Q-GE2: grown cat -> its adult art id
      let f = null;
      if (atlas && pose && atlas.resolveCat(aid)) {
        let a = anim.get(c.id);
        if (!a) { a = { kS: '', kA: '', since: tNow, x: c.x, z: c.z, t: tNow, speed: 0, lod: 'hi', cyc: 0, ct: tNow, seq: createMoveSeq() }; anim.set(c.id, a); }
        const dt = (tNow - a.t) / 1000; if (dt > 0.001) { const dx = c.x - a.x, dz = c.z - a.z; a.speed += (Math.sqrt(dx * dx + dz * dz) / dt - a.speed) * 0.3; a.x = c.x; a.z = c.z; a.t = tNow; }
        // Q-GE2 move art: stalk / crouch / wiggle / launch / land / miss / run / bow from roomcat state, wiggle + launch only after stalk + crouch
        pose = moveAnimFor(a.seq, c, pose);
        if (c.sprite !== a.kS || pose !== a.kA) { a.kS = c.sprite; a.kA = pose; a.since = tNow; a.cyc = 0; } // (two compares: no key string per frame)
        // Q-GE2 scurry fix: walk / run / stalk cycles run on their own clock, dt x the clamped speed scale, so easing never skips frames; the stalk FREEZE stops it (holds the frame)
        const sp = Number.isFinite(c.speed) ? c.speed : a.speed, cdt = Math.min(0.1, Math.max(0, (tNow - a.ct) / 1000)); a.ct = tNow;
        // Q-GE2: adult art carries its own animOverride fps (inside the atlas): ga.fpsX = idleFpsX = 1; the x1.7 kitten-art fallback keeps the slower cycle
        if (!a.seq.hold) a.cyc += cdt * atlas.fpsScale(pose, sp * ga.fpsX, aid, c.sprite);
        // LOD by distance only (Design 11:2x): hi within 2.5 m, lo beyond
        if (head && tNow - lodT > 500) { a.lod = pickLodStable(Math.sqrt((head.x - c.x) ** 2 + (head.z - c.z) ** 2), a.lod); } // hysteresis: no hi <-> lo churn at the 2.5 m line
        // cat-views decides the sprite sheet (side / front / back / above / below) + the mirror (flipX = the heading points to the
        // camera's left) + rotDeg for the top view; the atlas only supplies the frame (side art faces right, top art head +x)
        f = atlas.getFrame(aid, c.sprite, pose, (tNow - a.since) / 1000 * ga.idleFpsX, { lod: a.lod, speedMps: sp, cycleT: a.cyc, flipX: !!c.flipX });
      }
      let ftex = f ? drawTexture(f.file, t) : null;
      if (f && !ftex) { // this sheet is not drawable yet (still decoding / no GPU room): the other lod, else the canvas sprite
        const g = atlas.getFrame(aid, c.sprite, pose, (tNow - anim.get(c.id).since) / 1000 * ga.idleFpsX, { lod: f.lod === 'hi' ? 'lo' : 'hi', speedMps: Number.isFinite(c.speed) ? c.speed : anim.get(c.id).speed, cycleT: anim.get(c.id).cyc, flipX: !!c.flipX });
        const gt = g ? drawTexture(g.file, t) : null; if (gt) { f = g; ftex = gt; }
      }
      if (f && ftex) { b.setAtlasFrame(f, ftex); const a = anim.get(c.id); if (a) { const sh = a.shown || (a.shown = {}); sh.cat = f.cat; sh.view = f.view; sh.anim = f.anim; sh.index = f.index; sh.count = f.count; sh.sheet = f.sheet; sh.lod = f.lod; sh.file = f.file; sh.rect = f.rect; sh.uv = f.uv; sh.flipX = f.flipX; sh.flipY = ftex.flipY; sh.kind = imageKind(ftex.image); sh.sprite = c.sprite; sh.pose = pose; } } // CG NIT: reuse the record (no per-kitten object per frame)
      else if (!(f && b.atlasMode && b.holdFrame(t))) b.setAtlasFrame(null); // perf: a kitten already in atlas art keeps its LAST frame (<= 0.25 s) while the new sheet uploads, instead of a one-frame canvas placeholder (a 256 px canvas draw + upload mid-play, then back)
      b.update(tNow); // W3: per-sprite texture + crossfade (canvas sprites only)
      if (c.shadow) b.setShadow(c.shadow.y, c.shadow.alpha); else b.setShadow(null, 0);
    }
    for (const [id, b] of cats) if (!seen.has(id)) b.root.visible = false; // still in the box / not this mode's cats
    if (atlas && head && tNow - lodT > 500) lodT = tNow;
    if (atlas) evictStale(t); // sheets not drawn for ~1 s leave the GPU (the image stays decoded in RAM: re-upload only)
    // particles: pool -> instance matrices (a quad facing the head, scaled by the particle's size x scale)
    if (fx) {
      for (const kind of POOL_KINDS) {
        const ps = kind === 'heart' ? fx.hearts : kind === 'dust' ? fx.dust : fx.sparks, im = pools[kind];
        // an empty pool is neither re-uploaded nor drawn (3 draw calls + 3 buffer uploads a frame saved while nothing is in the air)
        const alive = ps.alive > 0;
        if (!alive && !poolWasAlive[kind]) continue;
        poolWasAlive[kind] = alive; im.visible = alive;
        for (let i = 0; i < ps.items.length; i++) {
          const p = ps.items[i];
          if (!p.alive || p.scale <= 0) { dummy.position.set(0, -10, 0); dummy.scale.set(0, 0, 0); }
          else { dummy.position.set(p.x, p.y, p.z); const sz = p.size * p.scale; dummy.scale.set(sz, sz, sz); if (head) dummy.rotation.set(0, Math.atan2(head.x - p.x, head.z - p.z), 0); }
          dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix);
        }
        im.instanceMatrix.needsUpdate = true;
      }
    }
    // Kitten Happiness meter (Play beats only; hidden during Laser Tag and the score card)
    if (dir && head && (dir.mode === 'play' || dir.mode === 'offer' || dir.mode === 'celebrate')) {
      meter.visible = true;
      const tcv = result.tipCard; // GE2-B: the meter rides above the tip card's spot (low + to the side), out of the kittens' way
      if (tcv && tcv.placed) { meter.position.set(tcv.x, tcv.y + TIP_TUNING.h / 2 + 0.045, tcv.z); meter.rotation.set(0, tcv.yaw, 0); meter.scale.setScalar(0.8); }
      else placeCard(meter, head, gaze, CARD_AHEAD, CARD_BELOW - METER_ABOVE);
      if (dir.meter !== meterShown) { meterShown = dir.meter; fill.scale.x = Math.max(0.0001, dir.meter); fill.material.color.setHex(dir.meterFull ? 0xffe08a : 0xff9ec7); }
    } else meter.visible = false;
    // SK-HUD: quick-stat strip + action tiles + ray cursors (hud-menu.js visual via bridge.frame's result.hud)
    const hud = result.hud, hv = hud && hud.visual;
    if (hv && !hv.hidden && hv.placed) {
      const P = hv.pose;
      hudR.set(P.r.x, P.r.y, P.r.z); hudU.set(P.u.x, P.u.y, P.u.z); hudN.set(P.n.x, P.n.y, P.n.z);
      hudM4.makeBasis(hudR, hudU, hudN);
      hudStrip.mesh.quaternion.setFromRotationMatrix(hudM4); hudStrip.mesh.position.set(P.c.x, P.c.y, P.c.z); hudStrip.mesh.visible = true;
      const sk = hud.stats.key + '|' + hv.hoverTip + '|' + (hv.button.hover ? 1 : 0) + (hv.open ? 1 : 0);
      if (sk !== hudStripKey) {
        hudStripKey = sk;
        hudStrip.draw((ctx, W, H) => {
          const bw = W * HT.btnW / HT.stripW;
          ctx.fillStyle = 'rgba(29, 22, 38, 0.86)'; hudRound(ctx, 0, 0, W - bw - 6, H, H * 0.22); ctx.fill();
          ctx.fillStyle = '#fff3e6'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          const nd = hud.stats.needs, textW = W - bw - H * 0.5;
          ctx.font = `700 ${Math.round(H * 0.36)}px system-ui, sans-serif`; ctx.fillText(hud.stats.line1, H * 0.25, H * 0.3, nd ? textW * 0.42 : textW);
          if (nd) hudNeedsBars(ctx, nd, H * 0.25 + textW * 0.45, W - bw - 6 - H * 0.15, H); // SK-PORT (WIRING 17): Kitten Needs, 4 small bars
          ctx.font = `600 ${Math.round(H * 0.32)}px system-ui, sans-serif`; ctx.fillText(hv.hoverTip || hud.stats.line2, H * 0.25, H * 0.72, W - bw - H * 0.5); // the hovered tile's tip replaces line 2
          ctx.fillStyle = hv.button.hover ? '#fff3e6' : hv.open ? '#ff9ec7' : 'rgba(29, 22, 38, 0.86)'; hudRound(ctx, W - bw, 0, bw, H, H * 0.22); ctx.fill();
          ctx.strokeStyle = '#ff9ec7'; ctx.lineWidth = H * 0.06; hudRound(ctx, W - bw + 2, 2, bw - 4, H - 4, H * 0.2); ctx.stroke();
          ctx.fillStyle = hv.button.hover || hv.open ? '#1d1626' : '#fff3e6'; ctx.textAlign = 'center';
          ctx.font = `700 ${Math.round(H * 0.36)}px system-ui, sans-serif`; ctx.fillText(hv.open ? 'Close' : 'Menu', W - bw / 2, H / 2, bw * 0.9);
        });
        if (onPerf) onPerf('card', { which: 'hud' });
      }
      if (hv.open) {
        const cu = HT.stripH / 2 + HT.gap + HL.gridH / 2; // the grid centre sits this far above the strip centre
        hudTiles.mesh.quaternion.copy(hudStrip.mesh.quaternion);
        hudTiles.mesh.position.set(P.c.x + P.u.x * cu, P.c.y + P.u.y * cu, P.c.z + P.u.z * cu); hudTiles.mesh.visible = true;
        let tk = hv.page || ''; for (const t of hv.tiles) tk += t.id + (t.hover ? 'h' : '-') + (t.pressed ? 'p' : '-') + (t.active ? 'a' : '-') + (t.disabled ? 'd' : '-') + (t.hint ? 'n' : '-');
        if (tk !== hudTilesKey) {
          hudTilesKey = tk;
          hudTiles.draw((ctx, W, H) => {
            const sx = W / HL.gridW, sy = H / HL.gridH;
            for (const t of hv.tiles) {
              if (!t.id) continue; // SK-PORT: an empty picker slot is not drawn
              const x = (t.u - HT.tileW / 2 + HL.gridW / 2) * sx, y = (HL.gridH / 2 - (t.v - (HT.stripH / 2 + HT.gap + HL.gridH / 2)) - HT.tileH / 2) * sy, w = HT.tileW * sx, h = HT.tileH * sy;
              ctx.globalAlpha = t.disabled ? 0.45 : 1;
              ctx.fillStyle = t.pressed ? '#ffd1e3' : t.active ? '#ff9ec7' : t.hover ? '#4a3a5c' : 'rgba(29, 22, 38, 0.9)'; hudRound(ctx, x, y, w, h, h * 0.18); ctx.fill();
              if (t.hint && !t.hover) { ctx.strokeStyle = '#ffe08a'; ctx.lineWidth = h * 0.07; ctx.setLineDash([h * 0.12, h * 0.08]); hudRound(ctx, x + h * 0.04, y + h * 0.04, w - h * 0.08, h - h * 0.08, h * 0.16); ctx.stroke(); ctx.setLineDash([]); } // SK-PORT: the Kitten Needs hint
              if (t.hover) { ctx.strokeStyle = '#fff3e6'; ctx.lineWidth = h * 0.08; hudRound(ctx, x + h * 0.04, y + h * 0.04, w - h * 0.08, h - h * 0.08, h * 0.16); ctx.stroke(); }
              ctx.fillStyle = t.active || t.pressed ? '#1d1626' : '#fff3e6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
              ctx.font = `700 ${Math.round(h * 0.26)}px system-ui, sans-serif`; ctx.fillText(t.label, x + w / 2, y + h * 0.42, w * 0.9);
              ctx.font = `600 ${Math.round(h * 0.15)}px system-ui, sans-serif`; ctx.fillText(t.active ? 'ON' : t.disabled ? 'not yet' : '', x + w / 2, y + h * 0.75, w * 0.9);
            }
            ctx.globalAlpha = 1;
          });
          if (onPerf) onPerf('card', { which: 'hud-tiles' });
        }
      } else hudTiles.mesh.visible = false;
      for (const k in hudCursors) {
        const cp = hv.cursors[k], m = hudCursors[k];
        if (cp) { m.visible = true; m.position.set(cp.x + P.n.x * 0.003, cp.y + P.n.y * 0.003, cp.z + P.n.z * 0.003); m.quaternion.copy(hudStrip.mesh.quaternion); } else m.visible = false;
      }
      for (const k in hudBeams) {
        const bm = hv.beams ? hv.beams[k] : null, l = hudBeams[k];
        if (bm && bm.show) { const a = l.geometry.attributes.position; a.setXYZ(0, bm.o.x, bm.o.y, bm.o.z); a.setXYZ(1, bm.e.x, bm.e.y, bm.e.z); a.needsUpdate = true; l.visible = true; } else l.visible = false;
      }
    } else { hudStrip.mesh.visible = false; hudTiles.mesh.visible = false; hudCursors.left.visible = false; hudCursors.right.visible = false; hudBeams.left.visible = false; hudBeams.right.visible = false; }
    // Q-GE2 (owner #7): placed furniture (wand.js pieces: F1 / B5 original art as boxes + cylinders) and the bin ring
    syncFurniture(result.furniture);
    // SK-PORT (WIRING 8 / 13): the Feather Pop feather over its dot (a gentle bob, turned to the head) and the Yarn Tug strand + pompom
    const fp = result.featherPop;
    if (fp && fp.up) {
      const f = fp.feather; fpFeather.visible = true; fpFeather.position.set(f.x, f.y + 0.07 + 0.012 * Math.sin(tNow / 260), f.z);
      if (head) fpFeather.rotation.set(0, Math.atan2(head.x - f.x, head.z - f.z), 0.25 * Math.sin(tNow / 410));
    } else fpFeather.visible = false;
    const tg = result.tug;
    if (tg && tg.on) {
      const a = tugLine.geometry.attributes.position; a.setXYZ(0, tg.cat.x, tg.cat.y, tg.cat.z); a.setXYZ(1, tg.hand.x, tg.hand.y, tg.hand.z); a.needsUpdate = true; tugLine.visible = true;
      const k = Math.max(0, Math.min(1, tg.t)); tugBead.visible = true;
      tugBead.position.set(tg.cat.x + (tg.hand.x - tg.cat.x) * k, tg.cat.y + (tg.hand.y - tg.cat.y) * k, tg.cat.z + (tg.hand.z - tg.cat.z) * k);
    } else { tugLine.visible = false; tugBead.visible = false; }
    syncGm(result.gm, head, tNow); // Q-GE2: the Games Master (placeholder art)
    // W3: wand + basket (wand.js view)
    const w = result.wand;
    if (w) {
      basket.visible = true; basket.position.set(w.basket.x, w.basket.y + WAND_TUNING.basketH / 2, w.basket.z);
      const from = w.base || w.handle; // resting = a tall wand standing in the basket (stick from the basket bottom); held = from the handle
      const dx = w.tip.x - from.x, dy = w.tip.y - from.y, dz = w.tip.z - from.z, len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      stick.visible = true; stick.scale.set(1, len, 1);
      stick.position.set((from.x + w.tip.x) / 2, (from.y + w.tip.y) / 2, (from.z + w.tip.z) / 2);
      // a unit-y cylinder turned onto the handle -> tip direction
      stick.quaternion.setFromUnitVectors(UP, tmpV.set(dx / len, dy / len, dz / len));
      feather.visible = true; feather.position.set(w.tip.x, w.tip.y, w.tip.z);
      feather.scale.setScalar(1 + 0.6 * (w.excitement || 0)); // a wiggled feather fluffs up
      if (head) feather.rotation.set(0, Math.atan2(head.x - w.tip.x, head.z - w.tip.z), 0);
    } else { basket.visible = false; stick.visible = false; feather.visible = false; }
    // P0a: the Laser Tag score card (head-locked, centred) while the director shows one
    const sc = dir && dir.scorecard;
    if (sc) {
      const key = sc.join('\n');
      if (key !== scoreLines) { scoreLines = key; scoreCard.draw(sc, true); scoreCard.mesh.visible = true; if (onPerf) onPerf('card', { which: 'score' }); }
      placeCard(scoreCard.mesh, head, gaze, CARD_AHEAD, 0.02);
    } else if (scoreCard.mesh.visible) { scoreCard.mesh.visible = false; scoreLines = ''; }
    // W3: hint / caption card (head-locked, under the gaze); the end card replaces it
    if (result.endCard) {
      if (cardLines !== 'end') { cardLines = 'end'; endCard.draw(result.endCard.lines, true); endCard.mesh.visible = true; card.mesh.visible = false; if (onPerf) onPerf('card', { which: 'end' }); }
      placeCard(endCard.mesh, head, gaze, CARD_AHEAD, 0.05);
    } else {
      const lines = [];
      if (result.hint) for (const l of String(result.hint.text).split('\n')) lines.push(l); // a two-line hint = two card lines at full size
      if (result.caption) for (const l of String(result.caption).split('\n')) lines.push(l); // a two-line caption (the host's line 1 + 2) = two card lines
      const key = lines.join('\n');
      if (key !== cardLines) { cardLines = key; card.draw(lines, false); card.mesh.visible = lines.length > 0; if (onPerf) onPerf('card', { which: 'hint', lines: lines.length }); }
      const tc = result.tipCard;
      if (tc) { // GE2-B (Owner #2): world-locked with a lazy follow, auto-fade, tap to dismiss, hidden while the menu is open
        card.mesh.visible = tc.show && lines.length > 0;
        if (card.mesh.visible) { card.mesh.position.set(tc.x, tc.y, tc.z); card.mesh.rotation.set(0, tc.yaw, 0); card.mesh.material.opacity = tc.alpha; }
      } else if (card.mesh.visible) placeCard(card.mesh, head, gaze, CARD_AHEAD, CARD_BELOW);
    }
  }

  /** free three resources of one object (geometry, material(s), their maps) */
  function freeObject(obj, keepMaps) {
    if (!obj) return;
    if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) { if (!keepMaps && m.map && typeof m.map.dispose === 'function') m.map.dispose(); if (typeof m.dispose === 'function') m.dispose(); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [, b] of cats) { b.root.traverse((o) => freeObject(o, true)); group.remove(b.root); } // maps belong to the cache
    cats.clear();
    cache.dispose();
    for (const t of atlasTex.values()) t.dispose(); atlasTex.clear(); images.clear(); anim.clear();
    box.traverse((o) => freeObject(o)); group.remove(box);
    if (whiteTex) whiteTex.dispose(); // N1
    laser.traverse((o) => freeObject(o)); group.remove(laser);
    for (const o of [fpFeather, tugLine, tugBead]) { group.remove(o); freeObject(o); } // SK-PORT
    gmGroup.traverse((o) => freeObject(o)); group.remove(gmGroup); group.remove(gmRing); freeObject(gmRing); if (gmNotice) { group.remove(gmNotice.mesh); freeObject(gmNotice.mesh); } // Q-GE2
    group.remove(targetRing); freeObject(targetRing);
    for (const kind in pools) { group.remove(pools[kind]); freeObject(pools[kind]); if (typeof pools[kind].dispose === 'function') pools[kind].dispose(); }
    meter.traverse((o) => freeObject(o)); group.remove(meter);
    for (const o of [basket, stick, feather, card.mesh, endCard.mesh, scoreCard.mesh, hudStrip.mesh, hudTiles.mesh]) { group.remove(o); freeObject(o); }
    group.remove(hudCursors.left); group.remove(hudCursors.right); cursorGeo.dispose(); cursorMat.dispose();
    for (const k in hudBeams) { group.remove(hudBeams[k]); hudBeams[k].geometry.dispose(); } beamMat.dispose(); // SK-HUD (shared geometry / material: freed once)
    if (group.parent) group.parent.remove(group);
    bridge.dispose();
  }

  /** DEV smoke: the atlas cell every kitten showed last (+ checkArtCell problems), for CI to assert a real frame is on the quad */
  function artState() { const out = []; for (const [id, a] of anim) if (a.shown) out.push(Object.assign({ id, problems: M ? checkArtCell(a.shown, M) : [] }, a.shown)); return { bitmapMode, cells: out }; }
  return { bridge, group, sync, warm, cats, dispose, artState, get disposed() { return disposed; }, get residency() { return { bytes: residency.bytes, files: residency.files, images: images.size, uploads, pinned: pinned.size, warmSteps }; } };
}

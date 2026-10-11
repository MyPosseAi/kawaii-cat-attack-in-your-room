/* vr/src/art/atlas.js - VR1 headset sprites (Design 1 + Design 2, ALL HANDS P0a, 2026-10-10): the loader for the kitten
   billboard atlases in vr/public/art/ (manifest.json + cats/<id>.<lod>.png + box/box.png). PURE: no three, no DOM, no fetch
   at import; node-tested in vr/test/art-atlas.test.mjs. GE2 owns the wiring (cat-billboard.js / room-hook.js).
   The art is our own website real-cat rig (B1.1 side, B4 front / back, B3 top), kitten proportions, the 8 starter cats only.

   const atlas = createAtlas(await loadManifest('art/manifest.json'));
   const f = atlas.getFrame('biscuit', 'side', 'walk', tSec, { flipX: true, speedMps: 0.2, lod: 'hi' });
   // f.file -> the texture to bind (one per cat + lod), f.uv -> quad UVs (three, flipY true), f.sizeM -> quad size (m),
   // f.centerM -> where the quad centre sits relative to the kitten's floor point (m, y up; 'carried' frames: the scruff), f.liftM -> extra lift.
   Sizes are real metres (fix round 2026-10-10: a kitten is ~0.28 m tall at the tail tip, ~0.22 m sitting): no extra scale needed. */

export const ATLAS_VERSION = 3;
export const VIEWS = Object.freeze(['side', 'front', 'back', 'top']);
export const ANIMS = Object.freeze(['idle', 'walk', 'sit', 'pounce', 'purr', 'sleep', 'carried', 'eat', 'poof', 'bat']);
/** cat-views / cat-sprites view names -> atlas view (+ whether that already implies a mirror) */
export const VIEW_ALIAS = Object.freeze({ side: 'side', right: 'side', left: 'side', front: 'front', back: 'back', top: 'top', above: 'top', below: 'top' });
/** roomcat poses (cat-sprites POSE_MAP keys) -> atlas anim. `hold0` = show only the first frame (the crouch). */
export const ANIM_ALIAS = Object.freeze({
  idle: 'idle', stand: 'idle', stare: 'idle', land: 'idle',
  walk: 'walk', run: 'walk', trot: 'walk', climb: 'walk', fall: 'walk', twist: 'walk',
  sit: 'sit', beg: 'sit', pin: 'sit',
  carried: 'carried', held: 'carried', eat: 'eat', nom: 'eat', poof: 'poof', startle: 'poof', bat: 'bat', swipe: 'bat',
  pounce: 'pounce', hop: 'pounce', crouch: 'pounce:hold0', tell: 'pounce:hold0',
  purr: 'purr', petted: 'purr', loaf: 'purr',
  sleep: 'sleep', nap: 'sleep',
  // roomcat v5 idle cycle (owner's Quest test 2026-10-10 fixes): no groom / stretch art yet -> nearest existing frames
  groom: 'sit', stretch: 'pounce:hold0', pause: 'idle',
});
const RUN_FPS_X = 1.8; // run / trot / fall play the walk cycle faster when no speed is given

/** fetch + parse the manifest (fetchFn for tests / custom loaders). Same origin only: the art ships with the build. */
export async function loadManifest(url, fetchFn) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('atlas: no fetch');
  const r = await f(url || 'art/manifest.json');
  if (!r.ok) throw new Error('atlas: manifest ' + r.status);
  return r.json();
}

/** LOD by DISTANCE only (Review BC fix round): hi for every kitten within 2.5 m, lo beyond. The 8 MB budget holds because a
 *  kitten only ever needs ONE 512 x 512 sheet resident (1 MB hi): 8 kittens <= 8 MB (manifest.budget.rule). kittensOut is accepted
 *  for the API (pickLod(distance, kittensOut)) and ignored; a third argument (the old rank call) is ignored too. No hd any more. */
export const HI_WITHIN_M = 2.5;
export function pickLod(distM /* , kittensOut */) {
  return Number(distM) <= HI_WITHIN_M ? 'hi' : 'lo';
}

export function createAtlas(manifest, opt) {
  const M = manifest, o = opt || {};
  if (!M || !M.cats) throw new Error('atlas: bad manifest');
  const ids = Object.keys(M.cats);
  /** exact id, else the main.js placeholder ids k1..k8 map onto the starter order */
  function resolveCat(id) {
    if (M.cats[id]) return id;
    const m = /^k(\d+)$/.exec(String(id));
    if (m) { const k = (Number(m[1]) - 1) % ids.length; return ids[k < 0 ? 0 : k]; }
    return null;
  }
  /** sheet size + ppm for a LOD (every sheet of a kitten has the same size); file = the sheet's file (default: the first sheet) */
  function lodInfo(cat, lod, sheet) {
    const L = M.cats[cat].atlas, want = lod === 'lo' ? 'lo' : 'hi', a = L[want];
    const sh = sheet || null, S = M.cats[cat].sheets;
    const file = sh ? (S && S[sh] && S[sh][want]) || `cats/${cat}/${sh}.${want}.png` : a.file;
    return { lod: want, file, w: a.w, h: a.h, ppm: a.ppm, half: a.half || null, sheet: sh };
  }
  /** every sheet file of a kitten at a LOD (preload / eviction bookkeeping) */
  function sheetFiles(cat, lod) {
    const r = resolveCat(cat); if (!r) return [];
    const want = lod === 'lo' ? 'lo' : 'hi', out = new Set();
    for (const v of Object.values(M.cats[r].frames)) for (const list of Object.values(v)) for (const f of list) out.add(lodInfo(r, want, f.hi.s).file);
    return [...out];
  }
  /**
   * One frame. t = seconds since this anim started. opt: { lod, flipX, speedMps (walk), holdFirstS (pounce stalk), viewName }.
   * Returns null for an unknown cat.
   */
  function getFrame(catId, view, anim, t, fo) {
    fo = fo || {};
    const cat = resolveCat(catId); if (!cat) return null;
    const v = VIEW_ALIAS[view] || 'side', fellView = !VIEW_ALIAS[view] || (view === 'below');
    let a = ANIM_ALIAS[anim] || 'idle'; const hold0 = a.endsWith(':hold0'); a = a.replace(':hold0', '');
    const list = M.cats[cat].frames[v][a], n = list.length, spec = M.anims[a];
    let fps = spec.fps[v] || 1;
    if (a === 'walk') {
      if (fo.speedMps > 0 && spec.noSlideMps) fps *= fo.speedMps / spec.noSlideMps;
      else if (anim === 'run' || anim === 'trot' || anim === 'fall') fps *= RUN_FPS_X;
    }
    const tt = Math.max(0, Number(t) || 0);
    let idx, done = false;
    if (hold0) idx = 0;
    else if (spec.loop) idx = Math.floor(tt * fps) % n;
    else { const hold = Math.max(0, fo.holdFirstS || 0), k = tt < hold ? 0 : Math.floor((tt - hold) * fps); idx = Math.min(n - 1, k); done = k >= n; }
    const fr = list[idx], L = lodInfo(cat, fo.lod, fr.hi.s), src = fr.hi, s = L.half ? 0.5 : 1;
    const [x, y, w, h] = src.r.map((q) => q * s), [ax, ay] = src.a.map((q) => q * s);
    const flipX = !!fo.flipX || view === 'left';
    let u0 = x / L.w, u1 = (x + w) / L.w; const v0 = 1 - (y + h) / L.h, v1 = 1 - y / L.h;
    if (flipX) { const k = u0; u0 = u1; u1 = k; }
    const cx = (w / 2 - ax) / L.ppm, cy = (ay - h / 2) / L.ppm;
    return {
      cat, view: v, anim: a, index: idx, count: n, done, lod: L.lod, file: L.file, sheet: L.sheet, atlasW: L.w, atlasH: L.h,
      rect: [x, y, w, h], uv: { u0, v0, u1, v1 }, flipX,
      sizeM: [w / L.ppm, h / L.ppm], centerM: [flipX ? -cx : cx, cy], liftM: fr.liftM || 0,
      fell: { view: fellView, anim: !M.anims[anim] },
    };
  }
  /** GE2 adapter for createSpriteCache({ draw }): draw frame f (from getFrame) out of its loaded atlas image into a px x px
   *  canvas that spans spanM metres (default 0.5), the floor point / body centre at (px / 2, 0.85 px). Same scale every frame. */
  function drawFrame(ctx, image, f, px, spanM) {
    const s = px / ((spanM || 0.5) * (f.rect[2] / f.sizeM[0])), [x, y, w, h] = f.rect;
    const ax = w / 2 - f.centerM[0] * (f.flipX ? -1 : 1) * (w / f.sizeM[0]), ay = h / 2 + f.centerM[1] * (h / f.sizeM[1]);
    ctx.clearRect(0, 0, px, px); ctx.save(); ctx.translate(px / 2, px * 0.85);
    if (f.flipX) ctx.scale(-1, 1);
    ctx.drawImage(image, x, y, w, h, -ax * s, -ay * s, w * s, h * s);
    ctx.restore();
  }
  /** files to load for a set of cats at a lod (dedup) */
  function files(cats, lod) { const out = new Set(); for (const c of cats || ids) for (const f of sheetFiles(c, lod)) out.add(f); return [...out]; }
  /** GPU bytes for { hi: n, lo: m } resident kitten SHEETS (one per kitten at a time) + the box (RGBA8, no mipmaps) */
  function gpuBytes(counts, o) {
    let b = M.box && !(o && o.box === false) ? M.box.atlas.w * M.box.atlas.h * 4 : 0;
    for (const [lod, n] of Object.entries(counts || {})) b += (M.lods[lod] ? M.lods[lod].gpuBytesPerCat : 0) * n;
    return b;
  }
  /** box face rect + uv: name = side_a | side_b | top_closed | flap | inner_wall | inner_floor */
  function boxFace(name) {
    const B = M.box, f = B && B.faces[name]; if (!f) return null;
    const [x, y, w, h] = f.r;
    return { file: B.atlas.file, rect: f.r, uv: { u0: x / B.atlas.w, v0: 1 - (y + h) / B.atlas.h, u1: (x + w) / B.atlas.w, v1: 1 - y / B.atlas.h } };
  }
  return { version: ATLAS_VERSION, manifest: M, cats: () => ids.slice(), resolveCat, getFrame, drawFrame, files, sheetFiles, gpuBytes, boxFace, lodInfo };
}

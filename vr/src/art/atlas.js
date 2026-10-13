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
  idle: 'idle', stand: 'idle', stare: 'idle', land: 'land',
  walk: 'walk', run: 'run', trot: 'walk', climb: 'walk', fall: 'walk', twist: 'walk',
  sit: 'sit', beg: 'sit', pin: 'sit',
  carried: 'carried', held: 'carried', eat: 'eat', nom: 'eat', poof: 'poof', startle: 'poof', bat: 'bat', swipe: 'bat',
  pounce: 'pounce', hop: 'pounce', crouch: 'crouch', tell: 'crouch',
  purr: 'purr', petted: 'purr', loaf: 'purr',
  sleep: 'sleep', nap: 'sleep',
  // roomcat v5 idle cycle (owner's Quest test 2026-10-10 fixes): no groom / stretch art yet -> nearest existing frames
  // Q-GE2 (brief B 4/7): stretch is the idle frame + cat-billboard's procedural play-bow, never the crouch (pounce frame 0)
  groom: 'sit', stretch: 'bow', pause: 'idle',
  // Q-GE2 move art (CAT-MOVEMENT-B C, Design 2026-10-12): the 8 move anims by name; moveAnimFor() picks them from roomcat state.
  // A manifest without move frames falls back through MOVE_FALLBACK (the v3.2 frames), so old art never breaks.
  stalk: 'stalk', wiggle: 'wiggle', launch: 'launch', miss: 'miss', bow: 'bow',
});
/** Q-GE2: the move anims (manifest m.move fps / loop) and what each falls back to when a manifest has no frames for it */
export const MOVE_ANIMS = Object.freeze(['stalk', 'crouch', 'wiggle', 'launch', 'land', 'miss', 'run', 'bow']);
export const MOVE_FALLBACK = Object.freeze({ stalk: 'walk', crouch: 'pounce:hold0', wiggle: 'pounce:hold0', launch: 'pounce', land: 'idle', miss: 'idle', run: 'walk', bow: 'idle' });
/** loops that follow the cat's speed (clamped 0.6-2.5x like the walk): the speed at which the base fps does not slide */
export const MOVE_REF_MPS = Object.freeze({ stalk: 0.4, run: 0.8 });
/** Q-GE2 sequence rule (brief C transitions): per-kitten scratch, allocated once; stage 0 none, 1 stalk, 2 crouch, 3 wiggle,
 *  4 launch, 5 land, 6 miss. hold = the stalk FREEZE (the host stops the cycle clock: the current stalk frame is held). */
export function createMoveSeq() { return { stage: 0, hold: false }; }
/** Which anim a kitten shows. c = a room-bridge billboard cat (mode, pose, tell, stalk, airborne), pose = artPose(c.pose).
 *  Returns a string literal (no allocation). wiggle and launch play ONLY after stalk -> crouch (a tell straight out of a run, a
 *  leap tell or a re-tell after a miss shows the crouch held instead of the wiggle, and the v3.2 pounce leap instead of launch). */
export function moveAnimFor(q, c, pose) {
  q.hold = false;
  const st = q.stage, mode = c.mode, tell = c.tell;
  if (tell) {
    if (tell.phase === 'wiggle' && (st === 2 || st === 3)) { q.stage = 3; return 'wiggle'; }
    q.stage = st === 1 || st === 2 ? 2 : st === 3 ? 3 : 0;
    return 'crouch';
  }
  if (mode === 'stalk') { q.stage = 1; q.hold = c.stalk === 'freeze'; return 'stalk'; }
  if (mode === 'hop') { if (st === 3 || st === 4) { q.stage = 4; return 'launch'; } q.stage = 0; return pose; }
  if (pose === 'land') { q.stage = st === 4 || st === 5 ? 5 : 0; return 'land'; }
  if (pose === 'stare' && (st === 5 || st === 6)) { q.stage = 6; return 'miss'; } // the pounce missed: miss-look, then idle
  if (pose === 'stare' && (st === 1 || st === 2)) return pose; // GE1-B hesitation stare inside the approach keeps the stalk
  q.stage = 0;
  return pose;
}
const RUN_FPS_X = 1.8; // run / trot / fall play the walk cycle faster when no speed is given
/** Q-GE2 (brief B A1, scurry fix): the walk cycle's rate follows the cat's real speed, clamped to 0.6-2.5x the base fps,
 *  so a 0.35 m/s kitten no longer plays ~39 fps and a 0.9 m/s run never aliases past 2.5x */
export const WALK_FPS_X_MIN = 0.6, WALK_FPS_X_MAX = 2.5;
export function walkFpsScale(speedMps, noSlideMps) {
  const v = Number(speedMps), ns = Number(noSlideMps);
  if (!(v > 0) || !(ns > 0)) return 1;
  const k = v / ns;
  return k < WALK_FPS_X_MIN ? WALK_FPS_X_MIN : k > WALK_FPS_X_MAX ? WALK_FPS_X_MAX : k;
}

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
  // Q-GE2: move anim specs from m.move { fps, loop } (merge-move-manifest.py leaves m.anims[move] = {}), built once
  const SPEC = {}, MV = M.move || null;
  for (const a of Object.keys(M.anims || {})) SPEC[a] = M.anims[a];
  if (MV && MV.fps) for (const a of MOVE_ANIMS) if (MV.fps[a] > 0) {
    const f = MV.fps[a]; SPEC[a] = { fps: { side: f, front: f, back: f, top: f }, loop: !!(MV.loop && MV.loop[a]), noSlideMps: MOVE_REF_MPS[a] || 0 };
  }
  const SPEED_ANIMS = { walk: true, run: true, stalk: true };
  // Q-GE2 adult art (Design 2026-10-12): grown forms live in M.adults (NOT M.cats: ids / cats() / k1..k8 stay the 8 kittens).
  // catEntry() is the one lookup for frames / sheets / atlas; an adult's animOverride (walk / run fps + noSlideMps, moveFps)
  // replaces those specs for that cat only, every other anim keeps manifest.anims.
  const AD = M.adults || null;
  const catEntry = (id) => M.cats[id] || (AD && AD[id]) || null;
  const CSPEC = {}; // adult id -> spec table (built once)
  if (AD) for (const [id, c] of Object.entries(AD)) {
    const ao = c.animOverride; if (!ao) continue;
    const t = Object.assign({}, SPEC);
    for (const a of ['walk', 'run']) if (ao[a] && ao[a].fps) t[a] = { fps: ao[a].fps, loop: ao[a].loop !== false, noSlideMps: ao[a].noSlideMps || 0 };
    if (ao.moveFps) for (const a of MOVE_ANIMS) if (ao.moveFps[a] > 0 && a !== 'run') {
      const f = ao.moveFps[a]; t[a] = { fps: { side: f, front: f, back: f, top: f }, loop: !!(MV && MV.loop && MV.loop[a]), noSlideMps: MOVE_REF_MPS[a] || 0 };
    }
    CSPEC[id] = t;
  }
  const specOf = (cat) => CSPEC[cat] || SPEC;
  /** alias -> [base anim, hold0] per (cat, view): a move anim the sheet lacks takes its MOVE_FALLBACK (no allocation per call) */
  function resolveAnim(cat, v, anim) {
    let a = ANIM_ALIAS[anim] || 'idle';
    const fr = catEntry(cat).frames[v], S = specOf(cat);
    if (MOVE_FALLBACK[a] && !(S[a] && S[a].fps && fr[a] && fr[a].length)) a = MOVE_FALLBACK[a];
    return a;
  }
  /** exact id (kitten or Q-GE2 adult id), else the main.js placeholder ids k1..k8 map onto the starter order (kittens only) */
  function resolveCat(id) {
    if (M.cats[id] || (AD && AD[id])) return id;
    const m = /^k(\d+)$/.exec(String(id));
    if (m) { const k = (Number(m[1]) - 1) % ids.length; return ids[k < 0 ? 0 : k]; }
    return null;
  }
  /** sheet size + ppm for a LOD (every sheet of one cat has the same size: kitten 512 x 512, adult 1024 x 512); file = the sheet's file (default: the first sheet) */
  function lodInfo(cat, lod, sheet) {
    const E = catEntry(cat), L = E.atlas, want = lod === 'lo' ? 'lo' : 'hi', a = L[want];
    const sh = sheet || null, S = E.sheets;
    const file = sh ? (S && S[sh] && S[sh][want]) || `cats/${cat}/${sh}.${want}.png` : a.file;
    return { lod: want, file, w: a.w, h: a.h, ppm: a.ppm, half: a.half || null, sheet: sh };
  }
  /** every sheet file of a kitten at a LOD (preload / eviction bookkeeping) */
  function sheetFiles(cat, lod) {
    const r = resolveCat(cat); if (!r) return [];
    const want = lod === 'lo' ? 'lo' : 'hi', out = new Set();
    for (const v of Object.values(catEntry(r).frames)) for (const list of Object.values(v)) for (const f of list) out.add(lodInfo(r, want, f.hi.s).file);
    return [...out];
  }
  /**
   * One frame. t = seconds since this anim started. opt: { lod, flipX, speedMps (walk), holdFirstS (pounce stalk), viewName,
   * cycleT }. cycleT (Q-GE2): the host's own speed-integrated clock (sum of dt * fpsScale) in base-fps seconds; when finite it
   * replaces t * speed scaling, so an easing speed never jumps frames (frame = floor(cycleT * base fps)).
   * Returns null for an unknown cat.
   */
  function getFrame(catId, view, anim, t, fo) {
    fo = fo || {};
    const cat = resolveCat(catId); if (!cat) return null;
    const v = VIEW_ALIAS[view] || 'side', fellView = !VIEW_ALIAS[view] || (view === 'below');
    let a = resolveAnim(cat, v, anim); const hold0 = a.endsWith(':hold0'); if (hold0) a = a.slice(0, -6);
    const SP = specOf(cat), list = catEntry(cat).frames[v][a], n = list.length, spec = SP[a];
    let fps = spec.fps[v] || 1;
    const cyc = SPEED_ANIMS[a] === true && Number.isFinite(fo.cycleT); // walk / run / stalk: the host's speed clock; other anims keep t
    if (SPEED_ANIMS[a] === true && !cyc) fps *= fpsScaleOf(anim, a, spec, fo.speedMps);
    const tt = Math.max(0, cyc ? fo.cycleT : (Number(t) || 0));
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
      fell: { view: fellView, anim: !SPEC[anim] || !SPEC[anim].fps },
    };
  }
  /** walk-rate multiplier for a roomcat pose at a speed (1 for non-walk anims): run / trot / fall without a speed = RUN_FPS_X */
  function fpsScaleOf(anim, a, spec, speedMps) {
    if (SPEED_ANIMS[a] !== true) return 1;
    if (speedMps > 0 && spec.noSlideMps) return walkFpsScale(speedMps, spec.noSlideMps);
    return a === 'walk' && (anim === 'run' || anim === 'trot' || anim === 'fall') ? RUN_FPS_X : 1;
  }
  /** Q-GE2: the host integrates cycleT += dt * fpsScale(pose, speed) per kitten (no allocation) */
  function fpsScale(anim, speedMps, catId, view) {
    const cat = catId != null ? resolveCat(catId) : ids[0];
    let a = cat ? resolveAnim(cat, VIEW_ALIAS[view] || 'side', anim) : (ANIM_ALIAS[anim] || 'idle');
    if (a.endsWith(':hold0')) return 1;
    return fpsScaleOf(anim, a, (cat ? specOf(cat) : SPEC)[a] || {}, speedMps);
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
  /** Q-GE2: GPU bytes (RGBA8, no mipmaps) of one sheet file from its cat's atlas size (kitten hi 1 MB, adult hi 2 MB); null = unknown file */
  const FILE_BYTES = new Map();
  for (const id of [...ids, ...(AD ? Object.keys(AD) : [])]) for (const lod of ['hi', 'lo']) { const a = catEntry(id).atlas[lod]; for (const f of sheetFiles(id, lod)) FILE_BYTES.set(f, a.w * a.h * 4); }
  function sheetGpuBytes(file) { return FILE_BYTES.has(file) ? FILE_BYTES.get(file) : null; }
  /** Q-GE2: the adult art id for a kitten id (M.cats[id].adultId when that adult is bundled), else null */
  function adultIdOf(id) { const r = M.cats[id] ? id : null, a = r && M.cats[r].adultId; return a && AD && AD[a] ? a : null; }
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
  /** Q-GE2: true when this atlas has frames for every move anim (the art from CAT-MOVEMENT-B C is bundled) */
  const hasMove = !!MV && ids.every((id) => MOVE_ANIMS.every((a) => VIEWS.every((v) => M.cats[id].frames[v] && M.cats[id].frames[v][a] && M.cats[id].frames[v][a].length)));
  return { version: ATLAS_VERSION, manifest: M, hasMove, cats: () => ids.slice(), resolveCat, getFrame, fpsScale, drawFrame, files, sheetFiles, gpuBytes, boxFace, lodInfo, catEntry, adultIdOf, adults: () => (AD ? Object.keys(AD) : []), sheetGpuBytes };
}

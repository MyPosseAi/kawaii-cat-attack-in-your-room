/* vr/src/cat-sprites.js - W3: which view SPRITE (art pose per view) a billboard cat shows, and the crossfade
   between sprites. cat-views.js picks the VIEW (front / right / back / left / above / below) from the camera angle; this
   file turns (view, roomcat pose, size) into a texture key the host can bake once per cat and cache, with the fallbacks the
   art actually has (design/batches/VIEWS.md: side kittens, top-down kittens, below, front / back).
   Gaming Engineer 2, 2026-10-09. PURE (no three / canvas), node-tested in vr/test/cat-sprites.test.mjs. The host
   (cat-billboard.js) owns the CanvasTextures: one per key, drawn by the rig code when first needed, kept per session.
   Poof rule (product owner): the kawaii / chibi look is a temporary involuntary poof form (a hard toss), never a user setting, so
   'poof' is a pose here, not a style switch. */
import { viewFadeAlpha, VIEW_FADE_MS } from './cat-views.js';

export const CAT_SPRITES_VERSION = 1;

/** Art poses that EXIST per sprite sheet today (design/batches/VIEWS.md, 2026-10-08): 'side' = the kitten rig
 *  (walk / trot / run / hop / sit / tumble / burst) + the rig's sit / loaf / sleep; above = top-down kittens;
 *  below = art; front / back = art. Missing art falls back down the POSE_MAP lists, then the SPRITE_FALLBACK views. */
export const SPRITE_POSES = Object.freeze({
  side: Object.freeze(['stand', 'walk', 'trot', 'run', 'hop', 'sit', 'loaf', 'sleep', 'tumble', 'burst']),
  above: Object.freeze(['stand', 'walk', 'trot', 'run', 'hop', 'pounce', 'tumble', 'sit', 'loaf', 'climb']),
  below: Object.freeze(['stand', 'walk', 'trot', 'run', 'sit', 'loaf', 'knead', 'peer', 'hop']),
  front: Object.freeze(['stand', 'walk', 'sit', 'loaf', 'sleep', 'groom']),
  back: Object.freeze(['stand', 'walk', 'sit', 'loaf', 'sleep', 'groom']),
});
/** Poses the VR entry would LIKE per sheet (the Design ask for W3 / W4; until they exist the fallbacks above are used). */
export const SPRITE_ASKS = Object.freeze({
  side: Object.freeze(['carried', 'eat', 'poof', 'pounce', 'bat', 'climb', 'beg']),
  above: Object.freeze(['sleep', 'carried', 'eat', 'poof', 'bat']),
  below: Object.freeze(['pounce', 'tumble', 'sleep']),
  front: Object.freeze(['run', 'hop', 'pounce', 'eat', 'beg']),
  back: Object.freeze(['run', 'hop']),
});

/** roomcat pose -> art poses in order of preference (the first one the sheet has wins). */
export const POSE_MAP = Object.freeze({
  inbox: [], // nothing is drawn while in the box
  climb: ['climb', 'hop', 'run'],
  hop: ['hop', 'run', 'walk'],
  pounce: ['pounce', 'hop', 'run'],
  bat: ['bat', 'hop', 'stand', 'sit'],
  poof: ['poof', 'tumble', 'hop', 'sit'],
  fall: ['tumble', 'hop', 'run'],
  twist: ['tumble', 'hop', 'run'],
  land: ['stand', 'sit'],
  carried: ['carried', 'sit', 'stand'],
  eat: ['eat', 'sit', 'loaf'],
  sit: ['sit', 'stand'],
  loaf: ['loaf', 'sit'],
  beg: ['sit', 'stand'],
  stare: ['stand', 'sit'],
  crouch: ['loaf', 'sit', 'stand'],
  pin: ['loaf', 'sit', 'stand'], // / roomcat v2: holding the caught laser dot (grounded)
  run: ['run', 'trot', 'walk'],
  walk: ['walk', 'trot', 'run'],
  petted: ['loaf', 'sit'],
  nap: ['sleep', 'loaf', 'sit'],
});

/** Sprite fallback order when a whole sheet is missing for a kind (e.g. no below art yet): the next best view. */
export const SPRITE_FALLBACK = Object.freeze({ below: ['above', 'side'], above: ['side'], front: ['side'], back: ['side'], side: [] });

/**
 * Resolve the art for one billboard. { sprite (cat-views: side / front / back / above / below), pose (roomcat), size, catId,
 * have?: { [sprite]: string[] | true } (what the host has baked / can bake; default = SPRITE_POSES) }.
 * Returns { sprite, pose, key, fell: { sprite: bool, pose: bool } } or null (nothing to draw, e.g. inbox).
 */
export function resolveSprite(o, have) {
  const H = have || SPRITE_POSES;
  const wantPose = POSE_MAP[o.pose] || ['sit', 'stand'];
  if (!wantPose.length) return null;
  const chain = [o.sprite].concat(SPRITE_FALLBACK[o.sprite] || ['side']);
  for (const sp of chain) {
    const list = H[sp] === true ? SPRITE_POSES[sp] : H[sp];
    if (!list || !list.length) continue;
    for (const p of wantPose) if (list.indexOf(p) >= 0) {
      return { sprite: sp, pose: p, key: spriteKey(o.catId, o.size, sp, p), fell: { sprite: sp !== o.sprite, pose: p !== wantPose[0] } };
    }
    // the sheet exists but has none of the wanted poses: its first pose beats another view
    const p = list.indexOf('sit') >= 0 ? 'sit' : list[0];
    return { sprite: sp, pose: p, key: spriteKey(o.catId, o.size, sp, p), fell: { sprite: sp !== o.sprite, pose: true } };
  }
  return null;
}

/** Texture cache key (one CanvasTexture per key). */
export function spriteKey(catId, size, sprite, pose) { return `${catId}:${size || 'kitten'}:${sprite}:${pose}`; }

/**
 * Crossfade state per billboard: the quad shows `to` at `alpha` over `from` at 1 - alpha. faderStep(prev, key, nowMs) ->
 * { from, to, alpha, since, changed }. A new key mid-fade starts a fade from the CURRENT look (no pop); the same key is a
 * no-op; alpha reaches 1 after VIEW_FADE_MS and the old texture can be released by the host.
 */
export function createFader(key, nowMs) { return { from: null, to: key || null, alpha: 1, since: Number.isFinite(nowMs) ? nowMs : 0, changed: false }; }
export function faderStep(prev, key, nowMs, fadeMs) {
  const F = fadeMs || VIEW_FADE_MS;
  const st = Object.assign({}, prev || createFader(null, nowMs));
  st.changed = false;
  if (key !== st.to) {
    // switch: the old target becomes the new source; if mid-fade, keep the source that is more visible
    st.from = st.alpha < 0.5 && st.from ? st.from : st.to;
    st.to = key; st.since = nowMs; st.alpha = 0; st.changed = true;
  } else {
    st.alpha = st.from ? viewFadeAlpha(nowMs - st.since, F) : 1;
  }
  if (st.alpha >= 1 && st.from) { st.from = null; st.changed = true; }
  return st;
}

/**
 * Texture budget for a session (plan 2.4: the Quest GPU budget; keep every baked sprite accounted for). cats = number of
 * cats, px = sprite edge in pixels (256 per plan 2.2), have = sheets available. Returns { textures, bytes, mb } for the
 * worst case (every cat, every sprite, every pose baked) and `perCat`.
 */
export function spriteBudget(cats, px, have) {
  const H = have || SPRITE_POSES;
  let perCat = 0;
  for (const sp of Object.keys(H)) { const list = H[sp] === true ? SPRITE_POSES[sp] : H[sp]; perCat += list ? list.length : 0; }
  const textures = perCat * Math.max(0, cats | 0), bytes = textures * px * px * 4;
  return { perCat, textures, bytes, mb: Math.round(bytes / 1048576 * 10) / 10 };
}

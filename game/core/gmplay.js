/* game/core/gmplay.js — the Games Master "opportunities for play" (room-scan suggestions), pure core. GE1, 2026-10-11.
   Spec: dev/impl/SK-113.md step 1 (+ the director contract of step 2, already in game/core/gamesmaster.js B4),
   docs/GAMES-MASTER-PLAN.md B4 row, §4 (no dark patterns), §12 cut item 7 (generic rug / Laser Tag fallback).
   Build rule: only `export function` / `export const`; private names carry the `gp` prefix. No three / WebXR / DOM, no
   Math.random / Date, no file or network reads. Every random choice comes from a prng.js Prng (deterministic).
   No caption text lives here: captions are the pack's plays[].caption.line1, passed through unchanged; `label` is the room
   vocabulary token of the matched object (room.js roomLabel), never a sentence. Nothing here builds a name string.

   suggestPlay(room, st, plays, prng, out?) -> out | null
     room  = createRoom() output (room.js) or null (no room built yet = no scan: rug plays only).
     st    = { tick, arcS (arc clock in seconds from the HOST; null / < 0 / absent = unknown -> no suggestion), reason? ('idle' | 'losses' | 'repeat': a trigger already
              decided by the director; absent -> computed by playTrigger(st)), mode (current game id or null),
              lastDeedTick, losses: [ticks], recentModes: [game ids, oldest first], lastSuggestTick, lastPlayTick: { playId: tick },
              blocked: { safety, sk99, countdown, last10s, rulesCaption }, viewer?: { x, z } (default room.viewer),
              box?: the arc box (roomcat state().box: { x, z, landed, gone }) }.
              On a suggestion st.lastSuggestTick and st.lastPlayTick[playId] are set to st.tick (st is the caller's record).
     plays = GAME_PACK.plays rows { id, label, game, caption: { line1 }, priority?, need? } (slim pack: plays[].needs is prose
              and stripped; the numeric needs below stand in until the pack carries them, see PLAY_NEEDS).
     out   = optional reused result object (fixed shape); a fresh one is made when absent.
     result { playId, surfaceId, caption, label, game, reason, expiresTick }  (surfaceId null only when room is null, or for
              the arc box: 'box').
   Rules: only LEGAL room surfaces count (room.js reasons: vertical, back, not_a_seat, ceiling, too_high, too_small are never
   named); a couch BACK never counts; each object's box edge must be within seated reach of the viewer (PLAY_NEEDS.reachM); the table must be
   clear (no obstacle footprint over it inside the body band). No scan (room.rug and no legal non-floor surface, or no room) -> rug plays only ('none' /
   'rug' labels). 'none' plays only when there is no scan data at all (room.rug). Triggers: no deed 20 s, 2 losses within
   60 s, or 3 rounds of one game. Limits: at most 1 per 60 s; never before arc 300 s (First Five Minutes); never while any
   blocked flag is set; after 3 rounds of one game never that game; the same play is not offered again within 3 minutes
   (not a nag). Pick: highest priority, ties by a seeded prng pick; the nearest matching surface (ties by id).
   Fails safe: the director may drop an offered suggestion (caption slot busy > 3 s, blocked moment); it still consumes the
   60 s limit and that play's 3-minute window (a missed tile is never re-pushed sooner).

   createPlaySuggester({ plays, seed, room? }) -> fn(ctx) for createGamesMaster({ suggestPlay }) (B4): ctx = { reason, mode,
     tick } (the director's one reused object; it carries no arc clock). fn.setRoom(room), fn.setContext({ arcS? |
     arcStartTick?, blocked?, viewer?, box? }) (host, per frame or on change; references are kept, nothing is copied).
     arcS = the arc clock in seconds now; arcStartTick = the director tick the arc started at (arcS is then
     (ctx.tick - arcStartTick) / 60, negative = no arc yet); whichever was set last wins; null clears it. Without either the
     suggester NEVER suggests (no guessing of the First Five Minutes). fn.state(), fn.reset() (fresh prng + history AND the
     whole context: arc clock, blocked, viewer, box).
     cue.play is ONE reused result object, overwritten by the next suggestion (>= 60 s later; the tile lasts 8 s): read it
     when the cue shows.
   REPLAY (replayGamesMaster): the suggester lives outside the director log, so a replay matches only when the suggester
     sees the same context at the same ticks: either reset() and repeat the same setContext calls (e.g. one
     setContext({ arcStartTick }) before stepping), or wrap the live suggester with recordPlays(fn) and replay with
     replayPlays(records) (returns the recorded results by tick; host context then no longer matters). */
import { createPrng } from './prng.js';

export const PLAY_LIMITS = Object.freeze({
  noDeedTicks: 1200,        // 20 s with no deed = energy dip
  lossWindowTicks: 3600,    // 2 losses within 60 s
  lossCount: 2,
  sameModeRounds: 3,        // 3 rounds of one game
  rateTicks: 3600,          // at most 1 suggestion per 60 s
  firstFiveS: 300,          // never in the First Five Minutes (arc t < 300 s)
  expireTicks: 480,         // the tile fades in 8 s
  repeatPlayTicks: 10800,   // the same play is not offered again within 3 minutes
  captionMax: 60,           // pack captions longer than this are skipped (judges read them)
});
/** Numeric scene needs per play label (stand-in for the prose plays[].needs; a row's own `need` object wins).
 *  minLenM: longest side of the surface; minSideM: both sides; reachM: PLAY distance (nearest edge of the surface box to the
 *  seated viewer, the game is played over / around it), not arm reach; clear: no
 *  obstacle inside the body band on the surface (room.js obs). */
export const PLAY_NEEDS = Object.freeze({
  couch: Object.freeze({ minLenM: 1.2, minSideM: 0, reachM: 2.0, clear: false }),
  table: Object.freeze({ minLenM: 0, minSideM: 0.5, reachM: 2.5, clear: true }),
  storage: Object.freeze({ minLenM: 0, minSideM: 0, reachM: 2.5, clear: false }),
  box: Object.freeze({ minLenM: 0, minSideM: 0, reachM: 2.5, clear: false }),
  rug: Object.freeze({ minLenM: 0, minSideM: 0, reachM: Infinity, clear: false }),
  none: Object.freeze({ minLenM: 0, minSideM: 0, reachM: Infinity, clear: false }),
});
/** Default priority per label (a row's numeric `priority` wins): real objects first, the rug fallbacks last. */
export const PLAY_PRIORITY = Object.freeze({ couch: 4, table: 3, storage: 2, box: 2, rug: 1, none: 1 });

const GP_KIND = Object.freeze({ couch: 'seat', table: 'table', storage: 'shelf' });
const GP_ROOMS = new WeakMap(); // room -> per-surface facts (legal surfaces only), built once per room
const GP_NO_LIST = Object.freeze([]);

function gpFacts(room) {
  let f = GP_ROOMS.get(room);
  if (f) return f;
  const list = [];
  let scan = false;
  const surfaces = Array.isArray(room.surfaces) ? room.surfaces : GP_NO_LIST;
  for (const s of surfaces) {
    if (!s || s.legal !== true || s.kind === 'back' || s.kind === 'vertical' || s.kind === 'ceiling' || s.kind === 'object') continue;
    if (s.kind !== 'floor' && s.kind !== 'rug') scan = true;
    const w = s.bb ? s.bb.x1 - s.bb.x0 : 0, d = s.bb ? s.bb.z1 - s.bb.z0 : 0;
    list.push({ id: s.id, label: s.label, kind: s.kind, len: w > d ? w : d, side: w < d ? w : d, clear: gpClear(s), bb: s.bb || null,
      floor: s.kind === 'floor' });
  }
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  f = { list, noScan: room.rug === true && !scan, rug: room.rug === true };
  GP_ROOMS.set(room, f);
  return f;
}

/** clear top: no obstacle footprint (room.js obs = objects inside the body band above it) overlaps the surface box */
function gpClear(s) {
  if (!s.obs || !s.obs.length || !s.bb) return true;
  for (const o of s.obs) if (o.bb && o.bb.x0 < s.bb.x1 && o.bb.x1 > s.bb.x0 && o.bb.z0 < s.bb.z1 && o.bb.z1 > s.bb.z0) return false;
  return true;
}
/** horizontal distance from the viewer to the nearest point of the surface box (the edge the seated player can reach) */
function gpDist(bb, vx, vz) {
  if (!bb) return Infinity;
  const dx = vx < bb.x0 ? bb.x0 - vx : vx > bb.x1 ? vx - bb.x1 : 0, dz = vz < bb.z0 ? bb.z0 - vz : vz > bb.z1 ? vz - bb.z1 : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

function gpNeed(p) {
  const base = Object.hasOwn(PLAY_NEEDS, p.label) ? PLAY_NEEDS[p.label] : null;
  const n = p.need && typeof p.need === 'object' ? p.need : null;
  if (!n) return base;
  const b = base || PLAY_NEEDS.storage;
  return { minLenM: typeof n.minLenM === 'number' ? n.minLenM : b.minLenM, minSideM: typeof n.minSideM === 'number' ? n.minSideM : b.minSideM,
    reachM: typeof n.reachM === 'number' ? n.reachM : b.reachM, clear: typeof n.clear === 'boolean' ? n.clear : b.clear };
}

function gpPriority(p) { return typeof p.priority === 'number' && Number.isFinite(p.priority) ? p.priority : Object.hasOwn(PLAY_PRIORITY, p.label) ? PLAY_PRIORITY[p.label] : 0; }

function gpRowOk(p) {
  return !!p && typeof p.id === 'string' && typeof p.label === 'string' && p.caption && typeof p.caption.line1 === 'string'
    && p.caption.line1.length > 0 && p.caption.line1.length <= PLAY_LIMITS.captionMax;
}

/** The surface id a play would use in this room for this state, or undefined when the play is not possible. 'box' = the arc
 *  box, null = rug play with no room. */
function gpMatch(room, f, p, st) {
  const need = gpNeed(p);
  if (!need) return undefined; // unknown label: never guess an object
  const L = p.label;
  if (L === 'none') { if (!room) return null; if (!f.rug) return undefined; for (const s of f.list) if (s.floor) return s.id; return undefined; }
  if (L === 'rug') { if (!room) return null; for (const s of f.list) if (s.floor) return s.id; return undefined; }
  if (!room || f.noScan) return undefined; // no scan -> rug plays only
  const v = st && st.viewer && typeof st.viewer.x === 'number' ? st.viewer : room.viewer || { x: 0, z: 0 };
  if (L === 'box') {
    const b = st && st.box;
    if (!b || b.landed !== true || b.gone === true || typeof b.x !== 'number') return undefined;
    const dx = b.x - v.x, dz = b.z - v.z;
    return Math.sqrt(dx * dx + dz * dz) <= need.reachM ? 'box' : undefined;
  }
  const kind = Object.hasOwn(GP_KIND, L) ? GP_KIND[L] : null;
  let best, bd = Infinity;
  for (const s of f.list) {
    if (s.label !== L || (kind && s.kind !== kind)) continue;
    if (s.len < need.minLenM || s.side < need.minSideM || (need.clear && !s.clear)) continue;
    const d = gpDist(s.bb, v.x, v.z);
    if (d <= need.reachM && d < bd) { bd = d; best = s.id; }
  }
  return best;
}

/** Energy-dip trigger from the state: 'idle' (no deed 20 s), 'losses' (2 within 60 s), 'repeat' (3 rounds of one game) or
 *  null. A director-decided st.reason wins. */
export function playTrigger(st) {
  if (!st) return null;
  if (st.reason === 'idle' || st.reason === 'losses' || st.reason === 'repeat') return st.reason;
  const K = PLAY_LIMITS, t = st.tick;
  if (typeof st.lastDeedTick === 'number' && st.lastDeedTick >= 0 && t - st.lastDeedTick >= K.noDeedTicks) return 'idle';
  if (Array.isArray(st.losses)) { let n = 0; for (const l of st.losses) if (t - l >= 0 && t - l <= K.lossWindowTicks) n++; if (n >= K.lossCount) return 'losses'; }
  if (gpRepeatMode(st) !== null) return 'repeat';
  return null;
}

function gpRepeatMode(st) {
  const r = st.recentModes, n = PLAY_LIMITS.sameModeRounds;
  if (!Array.isArray(r) || r.length < n) return null;
  const m = r[r.length - 1];
  for (let i = r.length - n; i < r.length; i++) if (r[i] !== m) return null;
  return m;
}

function gpBlocked(b) {
  return !!b && (b.safety === true || b.sk99 === true || b.countdown === true || b.last10s === true || b.rulesCaption === true);
}

/** Every play possible in this room right now (no trigger / rate checks): [{ playId, surfaceId, label, game, priority }].
 *  For tests, tools and the GE2 tile preview; allocates. */
export function playCandidates(room, plays, st) {
  const out = [];
  if (!Array.isArray(plays)) return out;
  const f = room ? gpFacts(room) : null;
  for (const p of plays) {
    if (!gpRowOk(p)) continue;
    const sid = gpMatch(room, f, p, st);
    if (sid !== undefined) out.push({ playId: p.id, surfaceId: sid, label: p.label, game: typeof p.game === 'string' ? p.game : null, priority: gpPriority(p) });
  }
  return out;
}

/** A blank result object (fixed shape) for suggestPlay's `out`. */
export function newPlayResult() { return { playId: null, surfaceId: null, caption: null, label: null, game: null, reason: null, expiresTick: -1 }; }

export function suggestPlay(room, st, plays, prng, out) {
  if (!st || typeof st.tick !== 'number' || !Array.isArray(plays) || !prng) return null;
  const K = PLAY_LIMITS, t = st.tick;
  const arcS = st.arcS;
  if (typeof arcS !== 'number' || !(arcS >= K.firstFiveS)) return null; // unknown arc clock = no suggestion
  if (gpBlocked(st.blocked)) return null;
  if (typeof st.lastSuggestTick === 'number' && st.lastSuggestTick >= 0 && t - st.lastSuggestTick < K.rateTicks) return null;
  const reason = playTrigger(st);
  if (reason === null) return null;
  const skipGame = reason === 'repeat' ? (gpRepeatMode(st) || (typeof st.mode === 'string' ? st.mode : null)) : null;
  const f = room ? gpFacts(room) : null;
  const seen = st.lastPlayTick && typeof st.lastPlayTick === 'object' ? st.lastPlayTick : null;
  // two passes, no arrays: best priority + tie count, then the seeded k-th tie
  let bestPr = -Infinity, ties = 0;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    if (!gpOpen(p, skipGame, seen, t)) continue;
    if (gpMatch(room, f, p, st) === undefined) continue;
    const pr = gpPriority(p);
    if (pr > bestPr) { bestPr = pr; ties = 1; } else if (pr === bestPr) ties++;
  }
  if (ties === 0) return null;
  let k = ties > 1 ? prng.int(ties) : 0, pick = null, sid;
  for (let i = 0; i < plays.length && !pick; i++) {
    const p = plays[i];
    if (!gpOpen(p, skipGame, seen, t) || gpPriority(p) !== bestPr) continue;
    const m = gpMatch(room, f, p, st);
    if (m === undefined) continue;
    if (k-- === 0) { pick = p; sid = m; }
  }
  const r = out && typeof out === 'object' ? out : newPlayResult();
  r.playId = pick.id; r.surfaceId = sid; r.caption = pick.caption.line1; r.label = pick.label;
  r.game = typeof pick.game === 'string' ? pick.game : null; r.reason = reason; r.expiresTick = t + K.expireTicks;
  st.lastSuggestTick = t;
  if (seen) seen[pick.id] = t;
  return r;
}

function gpOpen(p, skipGame, seen, t) {
  if (!gpRowOk(p)) return false;
  if (skipGame !== null && p.game === skipGame) return false;
  if (seen && Object.hasOwn(seen, p.id) && t - seen[p.id] < PLAY_LIMITS.repeatPlayTicks) return false;
  return true;
}

/** The B4 adapter for createGamesMaster({ suggestPlay }): see the header. */
export function createPlaySuggester(opts) {
  const o = opts || {};
  if (!Array.isArray(o.plays)) throw new TypeError('gp: plays (GAME_PACK.plays) required');
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new TypeError('gp: numeric seed required');
  const plays = o.plays;
  let room = o.room || null;
  let prng = createPrng(o.seed);
  const st = { tick: 0, arcS: null, reason: null, mode: null, lastDeedTick: -1, losses: GP_NO_LIST, recentModes: GP_NO_LIST,
    lastSuggestTick: -1, lastPlayTick: {}, blocked: null, viewer: null, box: null };
  const res = newPlayResult();
  let calls = 0, made = 0, arcS = null, arcStart = null;
  function suggest(ctx) {
    if (!ctx || typeof ctx.tick !== 'number') return null;
    calls++;
    st.tick = ctx.tick; st.reason = ctx.reason; st.mode = typeof ctx.mode === 'string' ? ctx.mode : null;
    st.arcS = arcStart !== null ? (ctx.tick - arcStart) / 60 : arcS;
    const r = suggestPlay(room, st, plays, prng, res);
    if (r) made++;
    return r;
  }
  suggest.setRoom = (r) => { room = r || null; };
  suggest.setContext = (c) => {
    if (!c || typeof c !== 'object') return;
    if ('arcS' in c) { arcS = typeof c.arcS === 'number' && Number.isFinite(c.arcS) ? c.arcS : null; arcStart = null; }
    if ('arcStartTick' in c) { arcStart = typeof c.arcStartTick === 'number' && Number.isFinite(c.arcStartTick) ? c.arcStartTick : null; if (arcStart !== null) arcS = null; }
    if ('blocked' in c) st.blocked = c.blocked || null;
    if ('viewer' in c) st.viewer = c.viewer || null;
    if ('box' in c) st.box = c.box || null;
  };
  suggest.state = () => ({ calls, made, lastSuggestTick: st.lastSuggestTick, lastPlayTick: { ...st.lastPlayTick }, arcS, arcStartTick: arcStart, prng: prng.getState() });
  suggest.reset = () => {
    prng = createPrng(o.seed); st.lastSuggestTick = -1; st.lastPlayTick = {}; calls = 0; made = 0;
    arcS = null; arcStart = null; st.arcS = null; st.blocked = null; st.viewer = null; st.box = null;
  };
  return suggest;
}

/** Wrap a suggester (or any ctx -> result fn) and record every non-null result by tick: fn.records = [{ tick, result }]
 *  (result = a copy). For replayGamesMaster with replayPlays(records). */
export function recordPlays(fn) {
  if (typeof fn !== 'function') throw new TypeError('gp: suggester function required');
  const records = [];
  function rec(ctx) {
    const r = fn(ctx);
    if (r != null) records.push({ tick: ctx.tick, result: { ...r } });
    return r;
  }
  rec.records = records;
  return rec;
}

/** A suggester that returns the recorded results at their ticks (null elsewhere), into one reused object. */
export function replayPlays(records) {
  const list = Array.isArray(records) ? records : GP_NO_LIST;
  const res = newPlayResult();
  return function gpReplayed(ctx) {
    if (!ctx || typeof ctx.tick !== 'number') return null;
    for (let i = 0; i < list.length; i++) if (list[i].tick === ctx.tick) return Object.assign(res, list[i].result);
    return null;
  };
}

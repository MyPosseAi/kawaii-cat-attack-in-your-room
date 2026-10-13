/* game/core/lifecycle.js — life-cycle loop engine + activity defs. Gaming Engineer, 2026-10-07 shift 4.
   Spec: design/concepts/SK20-life-cycle/spec.md (Design 1). A deterministic DAILY-LIFE SCHEDULER per cat: six needs
   (hunger, energy, play, bathroom, social, curiosity) drift over on-screen time; when a cat is free it scores every enabled
   activity (base weight x need factor x persona x time of day x rarity gate x 2-deep memory) and picks by weighted random
   among the TOP 4; the activity runs as approach (walk to a prop / spot) -> wait (shared prop busy) -> do (clip phases) and
   then resets the needs it serves and arms its cooldown. Multiple cats share one bowl / box / pillow (the hungrier eats first,
   the other waits <= 15 s then gives up). Rare activities are globally throttled (one per 10 min, one prop start per 20 s).
   Host-agnostic and deterministic: randomness only from the seeded prng, time = fixed steps (dtMs), no DOM, no Date.
   Time scale: need rates are PER LC_HOUR ON SCREEN (spec 1). `timeScale` multiplies the drift only (durations stay real) so the
   desktop's 20-40 min visits can run a cat's whole "day" across a few visits (DESKTOP.md: visits every 20-40 min; a 3x scale
   makes a 10 min visit = 30 min of cat life); needs are persisted (exportState) so a cat that ate on the last visit is not
   hungry again on the next. Hidden tab / game mode / paused: needs freeze and nothing starts (spec 7).
   Hosts: Dev 1's overlay (its own cats) or core createFreeRoam({ lifecycle }) (core cats). Each fixed step the host passes
   what the sim cannot know: ctx = { cats: [{ id, x, onGround, busy }], gameMode, paused, visible, typing, reduced,
   pointerIdleMs, pointerX, hour (0-23 local, optional), dayKey (string, optional: "max N/day" counts reset when it changes) }
   and reads intent(catId) -> { phase: 'idle'|'approach'|'wait'|'do', activity, targetX, msLeft, clip, clipMsLeft, prop }
   to move / pose its cat, plus drainEvents():
     activity_start { cat, activity, durationMs, clips: [{clip, ms, loop}], prop, targetX }   (phase 'do' begins)
                    (external activities, i.e. Simba's chew: durationMs null + external: true; the furniture sim ends it, clips sized to the def's max)
     activity_clip  { cat, activity, clip, ms, loop, index }                                    (next clip phase; index 0 is in activity_start too)
     activity_end   { cat, activity, reason: 'done'|'interrupt'|'gave_up'|'timeout'|'blocked'|'off'|'import'|'external' }
     activity_wait  { cat, activity, prop, by }     need_urgent { cat, need, value }    activity_target { cat, activity, targetX, prop }
   Clip ids are the rig's (extension/src/rc-rig.js): eat_down/eat/eat_up (B1.1), sit_down, loaf, cinnamon_bun, stand_up, pounce,
   pounce_to_sit, walk, stretch, chase_tail + the real idles (paw_lick, yawn, slow_blink, look_around, head_tilt). Unknown ids
   (motions not shipped yet) are marked `draft: true` on the def: hosts fall back to 'rest'.
  : Simba's chew is activity 'chew' with `external: true`: the furniture sim (its frequency / off setting / schedule) stays
   the authority on WHEN; the host calls external(catId, 'chew', active) each step and the life-cycle books it (interrupts the
   cat's current activity, emits activity_start/end, resets curiosity). The scheduler never picks an external activity itself.
   API:
     const lc = createLifeCycle({ seed, cats: [{ id, persona }], world: { width }, props: { bowl: {x}, litter: {x}, pillow: {x} },
                                  activities, enabled, timeScale, tuning })
     lc.step(dtMs, ctx)   lc.intent(id)   lc.needs(id)   lc.actionsFor(cat)   lc.external(id, activity, active)
     lc.interrupt(id, reason)   lc.setEnabled(ids)   lc.setProps(props)   lc.setCats(cats)   lc.catchUp(id|null, elapsedMs, factor)
     lc.exportState() / lc.importState(data)   lc.state()   lc.hash()   lc.drainEvents()
   Build rule: only `export function` / `export const`. */
import { createPrng, createHasher } from './prng.js';
import { TUNING } from './tuning.js';
import { emptyActions } from './input.js';
import { setCatMode } from './cat.js';

export const LIFECYCLE_STATE_VERSION = 1;
export const NEEDS = Object.freeze(['hunger', 'energy', 'play', 'bathroom', 'social', 'curiosity']);
/** spec 1: rise per hour on screen (persona multiplies) */
export const NEED_RATES = Object.freeze({ hunger: 30, energy: 25, play: 35, bathroom: 12, social: 20, curiosity: 25 });
const LC_MIN = 60000, LC_HOUR = 3600000;
const NO_EVENTS_LC = Object.freeze([]);

/** activity defs (spec 3), data only. serves: needs it lowers (resets: value after; delta: change). approach: 'prop'
    (walk to props[prop].x), 'spot' (a seeded floor spot), 'cat' (another cat), 'none' (where it stands). clips: phases in order,
    `loop: true` stretches to fill the duration. movement: false = allowed under reduced motion. gate(needs, ctx, cat) -> bool.
    boost: a need that raises the score without being reset by the activity (explore is weighted by curiosity, bird_jump / knock_off reset it).
    rare: counts for the global rare guard. maxPerDay. external: never self-picked (host books it, see chew). */
export const ACTIVITIES = Object.freeze([
  { id: 'eat', serves: ['hunger'], resets: { hunger: 5 }, after: { need: 'bathroom', delta: 20, delayMs: 30 * LC_MIN }, durationMs: [6000, 12000], weight: 3, cooldownMs: 20 * LC_MIN, prop: 'bowl', shared: true, approach: 'prop', movement: true,
    clips: [{ clip: 'eat_down', ms: 700 }, { clip: 'eat', loop: true }, { clip: 'eat_up', ms: 1500 }], waitClip: 'sit_down', urgentAt: 60 },
  { id: 'litter', serves: ['bathroom'], resets: { bathroom: 0 }, durationMs: [8000, 10000], weight: 2, cooldownMs: 45 * LC_MIN, prop: 'litter', shared: true, approach: 'prop', movement: true, draft: true,
    clips: [{ clip: 'litter_in', ms: 1500 }, { clip: 'litter', loop: true }, { clip: 'litter_out', ms: 1500 }], waitClip: 'sit_down', urgentAt: 75, zoomiesAfter: 0.5 },
  { id: 'gift_mouse', serves: ['play', 'social'], delta: { play: -40, social: -30 }, durationMs: [6000, 6000], weight: 0.4, cooldownMs: 6 * LC_HOUR, maxPerDay: 1, rare: true, prop: 'pillow', approach: 'prop', movement: true, draft: true,
    gate: (n, ctx) => (ctx.pointerIdleMs || 0) > 2 * LC_MIN, clips: [{ clip: 'gift_drop', ms: 2000 }, { clip: 'sit_down', ms: 1000 }, { clip: 'slow_blink', loop: true }] },
  { id: 'bird_jump', serves: ['play', 'curiosity'], delta: { play: -40, curiosity: -10 }, durationMs: [5000, 5000], weight: 0.8, cooldownMs: 15 * LC_MIN, rare: true, approach: 'none', movement: true, draft: true,
    gate: (n) => n.curiosity > 40, clips: [{ clip: 'chatter', ms: 1500 }, { clip: 'bird_leap', ms: 1200 }, { clip: 'goofy_fall', loop: true }] },
  { id: 'feather', serves: ['play'], delta: { play: -40 }, tires: true, durationMs: [6000, 15000], weight: 1.5, cooldownMs: 5 * LC_MIN, prop: 'feather', approach: 'none', movement: true,
    clips: [{ clip: 'stand_up', ms: 600 }, { clip: 'pounce', loop: true }, { clip: 'pounce_to_sit', ms: 620 }] },
  { id: 'laser', serves: ['play'], delta: { play: -40 }, tires: true, durationMs: [8000, 14000], weight: 1.2, cooldownMs: 8 * LC_MIN, prop: 'laser', approach: 'none', movement: true, draft: true,
    clips: [{ clip: 'stalk', ms: 2000 }, { clip: 'laser_chase', loop: true }, { clip: 'look_around', ms: 1500 }] },
  { id: 'zoomies', serves: ['play'], delta: { play: -40, energy: 20 }, tires: true, durationMs: [4000, 7000], weight: 1, cooldownMs: 12 * LC_MIN, approach: 'none', movement: true, dash: true,
    gate: (n, ctx, cat) => n.play > 50 || cat.postLitter, clips: [{ clip: 'walk', loop: true }, { clip: 'sit_down', ms: 800 }] },
  { id: 'knock_off', serves: ['curiosity'], delta: { curiosity: -50 }, durationMs: [5000, 5000], weight: 0.3, cooldownMs: 30 * LC_MIN, maxPerDay: 3, rare: true, prop: 'ledge', approach: 'prop', movement: true, draft: true,
    gate: (n) => n.curiosity > 70, clips: [{ clip: 'look_around', ms: 1200 }, { clip: 'paw_push', loop: true }, { clip: 'sit_down', ms: 800 }] },
  { id: 'tug_of_war', serves: ['play'], delta: { play: -40 }, tires: true, durationMs: [6000, 10000], weight: 0.6, cooldownMs: 10 * LC_MIN, prop: 'tug', approach: 'none', movement: true, draft: true,
    gate: (n, ctx) => (ctx.pointerIdleMs || 0) < 3000 && Number.isFinite(ctx.pointerX), clips: [{ clip: 'tug', loop: true }] },
  { id: 'nap', serves: ['energy'], resets: { energy: 10 }, durationMs: [30000, 180000], weight: 2, cooldownMs: 0, approach: 'spot', movement: false, catMode: 'nap',
    gate: (n) => n.energy > 50, clips: [{ clip: 'loaf', ms: 10600 }, { clip: 'cinnamon_bun', loop: true }, { clip: 'stand_up', ms: 600 }], urgentAt: 90 },
  { id: 'groom', serves: [], delta: { social: -5 }, durationMs: [3000, 6000], weight: 2, cooldownMs: 1 * LC_MIN, approach: 'none', movement: false,
    clips: [{ clip: 'paw_lick', loop: true }] },
  { id: 'explore', serves: [], boost: 'curiosity', durationMs: [2000, 4000], weight: 2, cooldownMs: 1 * LC_MIN, approach: 'spot', movement: true, sneak: true,
    clips: [{ clip: 'look_around', loop: true }] },
  { id: 'sit_watch', serves: [], durationMs: [5000, 30000], weight: 4, cooldownMs: 0, approach: 'none', movement: false,
    clips: [{ clip: 'sit_down', ms: 800 }, { clip: 'rest', loop: true }] },
  { id: 'visit', serves: ['social'], delta: { social: -30 }, durationMs: [4000, 8000], weight: 1.5, cooldownMs: 2 * LC_MIN, approach: 'cat', movement: true,
    gate: (n, ctx) => ctx.cats.length > 1, clips: [{ clip: 'head_tilt', ms: 1200 }, { clip: 'slow_blink', loop: true }] },
  { id: 'chew', serves: ['curiosity'], delta: { curiosity: -30 }, durationMs: [3000, 4000], weight: 0, cooldownMs: 0, approach: 'none', movement: true, external: true, clips: [{ clip: 'chew', loop: true }] },
]);
/** activities whose motions / props exist today (not `draft`); the default enabled set */
export const ACTIVITIES_READY = Object.freeze(ACTIVITIES.filter((a) => !a.draft).map((a) => a.id));

/** scratch for pick() (no per-pick allocation) */
const LC_SCORES = new Float64Array(64), LC_CANDS = new Array(64);
/** tunables (also under TUNING.lifecycle when tuning.js carries it) */
export const LIFECYCLE_DEFAULTS = Object.freeze({
  gapMsMin: 1500, gapMsMax: 5000,     // free time between activities (wander fills it in freeroam)
  arriveBL: 0.25, propStandBL: 0.6,   // stand this far from a prop's centre (B1.1: bowl bottom-centre at side x EAT_BOWL_X)
  visitBL: 1.2, nearBL: 2,            // social: sit this close to the visited cat; "near another cat" for the social need
  approachMsMax: 30000, waitMsMax: 15000, // never walk for ever; a queued cat gives up after 15 s (spec 4)
  rareEveryMs: 10 * 60000, propEveryMs: 20000, // spec 3 global rarity guard
  urgentAt: 85, tiredMs: 5 * 60000, offscreenFactor: 0,
});

export function createLifeCycle({ seed = 1, cats = [], world = { width: 16 }, props = {}, activities = ACTIVITIES, enabled = null, timeScale = 1, tuning = TUNING } = {}) {
  const L = tuning.lifecycle || TUNING.lifecycle || LIFECYCLE_DEFAULTS;
  const prng = createPrng(seed);
  const defs = activities.map((a) => ({ ...a }));
  if (defs.length > LC_SCORES.length) throw new Error(`createLifeCycle: at most ${LC_SCORES.length} activities (got ${defs.length})`); // pick() scratch size (Review SHOULD 2)
  const maxAfterMs = defs.reduce((m, d) => (d.after && Number.isFinite(d.after.delayMs) ? Math.max(m, d.after.delayMs) : m), 0);
  const defById = new Map(defs.map((a) => [a.id, a]));
  let on = new Set(enabled || defs.filter((a) => !a.draft).map((a) => a.id));
  let propMap = { ...props };
  let W = { width: world.width || 16 };
  let scale = timeScale > 0 ? timeScale : 1;
  let tick = 0, timeMs = 0, dayKey = null;
  let lastRareMs = -Infinity, lastPropStartMs = -Infinity;
  const events = [];
  const emit = (event, extra) => events.push({ type: 'lifecycle', event, tick, ...extra });
  /** per-cat records */
  let recs = [];
  const recById = new Map();
  const propOwner = new Map(); // prop -> cat id doing / approaching it

  function mkRec(c, old) {
    const r = old || { id: String(c.id), needs: {}, cool: {}, dayCount: {}, memory: [], phase: 'idle', act: null, targetX: NaN, prop: null,
      msLeft: 0, waitMs: 0, approachMs: 0, gapMs: 0, clips: null, clipIx: 0, clipMs: 0, durationMs: 0, tiredMs: 0, pendingAfter: null, postLitter: false, urgent: {} };
    r.persona = { ...(c.persona || {}) };
    if (!old) { for (const n of NEEDS) r.needs[n] = 10 + prng.next() * 30; r.gapMs = prng.next() * L.gapMsMax; } // spec 1: start 10-40, cats differ
    return r;
  }
  const rebuild = () => { recById.clear(); for (const r of recs) recById.set(r.id, r); };
  const clamp100 = (v) => (v < 0 ? 0 : v > 100 ? 100 : v);
  const clipsFor = (def, durationMs) => {
    const fixed = def.clips.reduce((s, c) => s + (c.loop ? 0 : c.ms || 0), 0);
    const loopMs = Math.max(0, durationMs - fixed);
    return def.clips.map((c) => ({ clip: c.clip, ms: c.loop ? loopMs : c.ms || 0, loop: !!c.loop }));
  };

  const lc = {
    get tick() { return tick; },
    get timeMs() { return timeMs; },
    get timeScale() { return scale; },
    get activities() { return defs; },
    get enabled() { return [...on]; },
    get cats() { return recs; },
    events,
    setEnabled(ids) { on = new Set(ids); for (const r of recs) if (r.act && !on.has(r.act) && !defById.get(r.act).external) end(r, 'off'); return lc.enabled; },
    setProps(p) { propMap = { ...p }; for (const r of recs) if (r.prop && !propMap[r.prop] && r.phase !== 'do') end(r, 'blocked'); return propMap; },
    setWorld(w) { W = { width: w.width || W.width }; for (const r of recs) if (Number.isFinite(r.targetX)) r.targetX = Math.min(Math.max(r.targetX, 0.5), Math.max(0.5, W.width - 0.5)); }, // NIT 1: no walking into the new wall
    setTimeScale(s) { scale = s > 0 ? s : 1; },
    /** roster changed: records kept by id, new cats get fresh needs, gone cats are dropped */
    setCats(list) {
      const old = new Map(recs.map((r) => [r.id, r]));
      recs = list.map((c) => mkRec(c, old.get(String(c.id))));
      for (const [id, r] of old) if (!recById.has(id) && !recs.includes(r) && r.act) end(r, 'interrupt');
      rebuild();
      for (const [p, id] of propOwner) if (!recById.has(id)) propOwner.delete(p);
      return recs;
    },
    needs(id) { const r = recById.get(String(id)); return r ? { ...r.needs } : null; },
    intent(id) {
      const r = recById.get(String(id)); if (!r) return null;
      const cur = r.clips && r.clips[r.clipIx];
      return { phase: r.phase, activity: r.act, targetX: r.targetX, msLeft: r.msLeft, prop: r.prop, clip: r.phase === 'do' ? (cur ? cur.clip : null) : r.phase === 'wait' ? (defById.get(r.act).waitClip || 'sit_down') : null, clipMsLeft: r.phase === 'do' ? r.clipMs : 0, clipIndex: r.clipIx };
    },
    /** true while the cat is approaching / waiting / doing (hosts: let the life-cycle drive the cat's actions) */
    active(id) { const r = recById.get(String(id)); return !!r && r.phase !== 'idle'; },
    /** host books an activity the host itself runs (chew via furniture.js): active true starts it (once), false ends it */
    external(id, activity, active) {
      const r = recById.get(String(id)); const def = defById.get(activity); if (!r || !def) return false;
      if (active) {
        if (r.act === activity) return true;
        if (r.act) end(r, 'interrupt');
        r.act = activity; r.phase = 'do'; r.durationMs = def.durationMs[0]; r.msLeft = Infinity; r.clips = clipsFor(def, def.durationMs[1]); r.clipIx = 0; r.clipMs = r.clips[0].ms; r.prop = null; r.targetX = NaN;
        emit('activity_start', { cat: r.id, activity, durationMs: null, clips: r.clips, prop: null, targetX: NaN, external: true });
      } else if (r.act === activity) finish(r, 'external');
      return true;
    },
    interrupt(id, reason = 'interrupt') { const r = recById.get(String(id)); if (!r || !r.act) return false; end(r, reason); r.gapMs = L.gapMsMin; return true; },
    /** apply off-screen drift: factor 0 (spec default: needs only change on screen) .. 1 (full rate); id null = every cat */
    catchUp(id, elapsedMs, factor = L.offscreenFactor) {
      if (!(elapsedMs > 0) || !(factor > 0)) return;
      for (const r of recs) if (id == null || r.id === String(id)) for (const n of NEEDS) r.needs[n] = clamp100(r.needs[n] + NEED_RATES[n] * (r.persona[n] || 1) * factor * elapsedMs / LC_HOUR);
    },

    step(dtMs, ctx = {}) {
      const hostCats = ctx.cats || [];
      const frozen = !!ctx.gameMode || !!ctx.paused || ctx.visible === false;
      if (ctx.dayKey != null && ctx.dayKey !== dayKey) { dayKey = ctx.dayKey; for (const r of recs) r.dayCount = {}; }
      if (frozen) {
        // spec 5/7: game mode / hidden tab / paused: needs freeze, running activities cancel cleanly (prop fades), nothing starts
        for (const r of recs) if (r.act && !defById.get(r.act).external) { end(r, 'blocked'); r.gapMs = L.gapMsMin; }
        tick++; return lc;
      }
      const dh = dtMs * scale / LC_HOUR; // on-screen hours this step (scaled)
      const nightK = ctx.hour != null && (ctx.hour >= 22 || ctx.hour < 6) ? 1.5 : 1;
      const duskK = ctx.hour != null && ((ctx.hour >= 6 && ctx.hour < 8) || (ctx.hour >= 18 && ctx.hour < 21)) ? 1.4 : 1;
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        const hc = hostCatById(hostCats, r.id);
        // 1. needs drift (spec 1)
        const near = hc ? anyCatNear(hostCats, hc, L.nearBL) : false;
        for (const n of NEEDS) {
          let rate = NEED_RATES[n] * (r.persona[n] || 1);
          if (n === 'social') rate = near ? -10 : rate;
          if (n === 'energy' && r.tiredMs > 0) rate *= 2;
          r.needs[n] = clamp100(r.needs[n] + rate * dh);
        }
        if (r.tiredMs > 0) r.tiredMs -= dtMs;
        if (r.pendingAfter) { r.pendingAfter.ms -= dtMs * scale; if (r.pendingAfter.ms <= 0) { r.needs[r.pendingAfter.need] = clamp100(r.needs[r.pendingAfter.need] + r.pendingAfter.delta); r.pendingAfter = null; } }
        for (const k in r.cool) { r.cool[k] -= dtMs; if (r.cool[k] <= 0) delete r.cool[k]; }
        for (const n of NEEDS) { const u = r.needs[n] >= L.urgentAt; if (u && !r.urgent[n]) { r.urgent[n] = 1; emit('need_urgent', { cat: r.id, need: n, value: Math.round(r.needs[n]) }); } else if (!u && r.urgent[n] && r.needs[n] < L.urgentAt - 10) r.urgent[n] = 0; }
        // 2. the running activity
        if (r.phase === 'approach') {
          r.approachMs += dtMs;
          const def = defById.get(r.act);
          if (!hc) end(r, 'blocked');
          else if (r.approachMs > L.approachMsMax) end(r, 'timeout');
          else if (def.approach === 'cat') { const o = hostCatById(hostCats, r.visitId); if (!o) end(r, 'blocked'); else { r.targetX = o.x + (hc.x < o.x ? -L.visitBL : L.visitBL); if (Math.abs(hc.x - r.targetX) <= L.arriveBL && hc.onGround && !hc.busy) begin(r, def, ctx); } }
          else if (Math.abs(hc.x - r.targetX) <= L.arriveBL && hc.onGround && !hc.busy) {
            if (def.prop && def.shared && propOwner.get(def.prop) && propOwner.get(def.prop) !== r.id) { r.phase = 'wait'; r.waitMs = 0; emit('activity_wait', { cat: r.id, activity: r.act, prop: def.prop, by: propOwner.get(def.prop) }); }
            else begin(r, def, ctx);
          }
        } else if (r.phase === 'wait') {
          r.waitMs += dtMs;
          const def = defById.get(r.act), owner = propOwner.get(def.prop);
          if (!owner || owner === r.id) begin(r, def, ctx);
          else if (r.waitMs > L.waitMsMax) end(r, 'gave_up'); // hunger keeps rising: it comes back later
        } else if (r.phase === 'do') {
          if (r.msLeft !== Infinity) {
            r.msLeft -= dtMs; r.clipMs -= dtMs;
            if (r.clipMs <= 0 && r.clipIx < r.clips.length - 1) { r.clipIx++; r.clipMs += r.clips[r.clipIx].ms; const c = r.clips[r.clipIx]; emit('activity_clip', { cat: r.id, activity: r.act, clip: c.clip, ms: c.ms, loop: c.loop, index: r.clipIx }); }
            if (r.msLeft <= 0) finish(r, 'done');
          }
        } else {
          // 3. free: gap, then pick (spec 2)
          r.gapMs -= dtMs;
          if (r.gapMs <= 0 && hc && hc.onGround && !hc.busy && !ctx.typing) pick(r, hc, ctx, hostCats, nightK, duskK);
        }
      }
      tick++; timeMs += dtMs;
      return lc;
    },

    /** ACTIONS for a CORE cat (createFreeRoam): walk to the target while approaching, hold still (and set nap mode) while doing. */
    actionsFor(cat) {
      const r = recById.get(cat.id); const a = emptyActions(); if (!r || r.phase === 'idle') return a;
      const def = defById.get(r.act);
      if (r.phase === 'approach') {
        const d = r.targetX - cat.body.x;
        if (Math.abs(d) > L.arriveBL) { a.moveX = (d > 0 ? 1 : -1) * (def.sneak ? 0.3 : 0.6); if (def.sneak) a.sneak = 1; }
      } else if (r.phase === 'do') {
        if (def.dash) { // zoomies: dart between two spots (dash), flip at the walls
          if (!Number.isFinite(r.targetX) || Math.abs(r.targetX - cat.body.x) < 0.4) r.targetX = cat.body.x < W.width * 0.5 ? W.width - 1 : 1;
          a.moveX = r.targetX > cat.body.x ? 1 : -1; a.sprint = 1;
        } else if (def.catMode && cat.mode !== def.catMode && cat.body.onGround) setCatMode(cat, def.catMode);
      }
      return a;
    },
    /** host-side end of a core cat's activity: leave nap mode cleanly (freeroam calls this on activity_end) */
    releaseCat(cat) { if (cat.mode === 'nap') setCatMode(cat, 'wake'); },

    state() {
      return { tick, timeMs, timeScale: scale, enabled: [...on], cats: recs.map((r) => ({ id: r.id, needs: { ...r.needs }, phase: r.phase, activity: r.act, targetX: r.targetX, msLeft: r.msLeft, prop: r.prop, clip: lc.intent(r.id).clip, cooldowns: { ...r.cool } })), props: { ...propMap } };
    },
    exportState() {
      return { v: LIFECYCLE_STATE_VERSION, prng: prng.getState(), dayKey, rareAgoMs: Math.round(timeMs - lastRareMs) || 0,
        cats: recs.map((r) => ({ id: r.id, needs: mapRound(r.needs), cool: mapRound(r.cool), dayCount: { ...r.dayCount }, memory: r.memory.slice(), pendingAfter: r.pendingAfter ? { ...r.pendingAfter, ms: Math.round(r.pendingAfter.ms) } : null })) };
    },
    importState(data) {
      if (!data || data.v !== LIFECYCLE_STATE_VERSION) return false;
      if (Number.isFinite(data.prng)) prng.setState(data.prng);
      if (data.dayKey != null) dayKey = String(data.dayKey);
      lastRareMs = Number.isFinite(data.rareAgoMs) ? timeMs - Math.max(0, data.rareAgoMs) : -Infinity;
      const saved = new Map((Array.isArray(data.cats) ? data.cats : []).filter((c) => c && typeof c === 'object').map((c) => [String(c.id), c])); // Review SHOULD 3a
      for (const r of recs) {
        if (r.act) end(r, 'import');
        const s = saved.get(r.id); if (!s) continue;
        for (const n of NEEDS) if (Number.isFinite(+(s.needs || {})[n])) r.needs[n] = clamp100(+s.needs[n]);
        r.cool = {}; for (const k in s.cool || {}) if (defById.has(k) && Number.isFinite(+s.cool[k]) && +s.cool[k] > 0) r.cool[k] = Math.min(+s.cool[k], Math.max(0, defById.get(k).cooldownMs || 0)); // 3b: never longer than the def's cooldown
        for (const k in r.cool) if (!(r.cool[k] > 0)) delete r.cool[k];
        r.dayCount = {}; for (const k in s.dayCount || {}) if (Number.isFinite(+s.dayCount[k])) r.dayCount[k] = +s.dayCount[k] | 0;
        r.memory = Array.isArray(s.memory) ? s.memory.filter((k) => defById.has(k)).slice(-2) : [];
        r.pendingAfter = s.pendingAfter && NEEDS.includes(s.pendingAfter.need) && Number.isFinite(+s.pendingAfter.ms) ? { need: s.pendingAfter.need, delta: +s.pendingAfter.delta || 0, ms: Math.min(maxAfterMs, Math.max(0, +s.pendingAfter.ms)) } : null; // 3c: clamped to the longest after.delayMs
        r.gapMs = L.gapMsMin;
      }
      return true;
    },
    hash() {
      const h = createHasher();
      h.num(tick).num(prng.getState()).num(timeMs - lastRareMs);
      for (const r of recs) { h.str(r.id).str(r.phase).str(r.act || '-').num(r.targetX || 0).num(r.msLeft === Infinity ? -1 : r.msLeft).num(r.clipIx).num(r.gapMs); for (const n of NEEDS) h.num(r.needs[n]); for (const k in r.cool) h.str(k).num(r.cool[k]); }
      return h.digest();
    },
    drainEvents() { if (!events.length) return NO_EVENTS_LC; const out = events.slice(); events.length = 0; return out; },
  };

  /** spec 2: score every enabled activity, weighted pick among the top 4 */
  function pick(r, hc, ctx, hostCats, nightK, duskK) {
    const reduced = !!ctx.reduced;
    let n = 0;
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      if (d.external || !on.has(d.id) || r.cool[d.id] || (reduced && d.movement)) continue;
      if (d.maxPerDay && (r.dayCount[d.id] || 0) >= d.maxPerDay) continue;
      if (d.prop && d.approach === 'prop' && !propMap[d.prop]) continue; // no prop placed on this page: not this activity
      if (d.rare && timeMs - lastRareMs < L.rareEveryMs) continue;
      if (d.prop && !d.shared && timeMs - lastPropStartMs < L.propEveryMs) continue; // shared props (bowl, box) queue instead (spec 4)
      if (d.gate && !d.gate(r.needs, ctx, r)) continue;
      let needK = 1;
      for (const nd of d.serves) { const v = r.needs[nd] / 100; needK = Math.max(needK, 1 + v * v * 4); }
      if (d.boost) { const v = r.needs[d.boost] / 100; needK = Math.max(needK, 1 + v * v * 4); } // weighted by a need it does not reset (explore / sniff)
      if (d.prop && d.shared && propOwner.get(d.prop) && propOwner.get(d.prop) !== r.id && needOf(r, d) < (d.urgentAt || 60)) continue; // allocation-free (Review SHOULD 1) // bowl busy and not hungry enough to queue
      let s = d.weight * needK * (r.persona[d.id] || 1);
      if (d.serves.includes('energy')) s *= nightK;
      if (d.serves.includes('play')) s *= duskK * (r.needs.play > 60 ? 3 : 1);
      if (d.id !== 'sit_watch' && r.memory.includes(d.id)) s *= 0.3;
      if (s <= 0) continue;
      LC_SCORES[n] = s; LC_CANDS[n] = d; n++;
    }
    if (!n) { r.gapMs = L.gapMsMin + prng.next() * (L.gapMsMax - L.gapMsMin); return; }
    // spec 5: an URGENT need (>= 85) outranks the normal pick: only the activities serving an urgent need stay in the draw
    let m = 0;
    for (let i = 0; i < n; i++) { const d = LC_CANDS[i]; let urg = false; for (const nd of d.serves) if (r.needs[nd] >= L.urgentAt) urg = true; if (urg) { LC_SCORES[m] = LC_SCORES[i]; LC_CANDS[m] = d; m++; } }
    if (m) n = m;
    // top 4 by score (partial selection sort: n is small)
    const top = Math.min(4, n);
    for (let i = 0; i < top; i++) { let b = i; for (let j = i + 1; j < n; j++) if (LC_SCORES[j] > LC_SCORES[b]) b = j; if (b !== i) { const ts = LC_SCORES[i]; LC_SCORES[i] = LC_SCORES[b]; LC_SCORES[b] = ts; const td = LC_CANDS[i]; LC_CANDS[i] = LC_CANDS[b]; LC_CANDS[b] = td; } }
    let sum = 0; for (let i = 0; i < top; i++) sum += LC_SCORES[i];
    let u = prng.next() * sum, ix = top - 1;
    for (let i = 0; i < top; i++) { u -= LC_SCORES[i]; if (u <= 0) { ix = i; break; } }
    start(r, LC_CANDS[ix], hc, ctx, hostCats);
  }
  function start(r, def, hc, ctx, hostCats) {
    r.act = def.id; r.prop = def.prop || null; r.approachMs = 0; r.waitMs = 0; r.visitId = null;
    if (def.rare) lastRareMs = timeMs;
    if (def.prop && !def.shared) lastPropStartMs = timeMs;
    if (def.prop && def.shared) {
      const owner = propOwner.get(def.prop) ? recById.get(propOwner.get(def.prop)) : null;
      // spec 4: the hungrier cat eats first: a cat still only WALKING to the bowl yields to a hungrier one (a cat already eating never does)
      if (!owner) propOwner.set(def.prop, r.id);
      else if (owner.phase !== 'do' && needOf(r, def) > needOf(owner, def)) propOwner.set(def.prop, r.id);
    }
    if (def.approach === 'prop') { const p = propMap[def.prop]; r.targetX = Math.min(Math.max(p.x + (p.side || (hc.x < p.x ? -1 : 1)) * (p.standBL == null ? L.propStandBL : p.standBL), 0.5), W.width - 0.5); }
    else if (def.approach === 'spot') r.targetX = 0.6 + prng.next() * Math.max(0.2, W.width - 1.2);
    else if (def.approach === 'cat') { const others = hostCats.filter((c) => c.id !== r.id); if (!others.length) { r.act = null; r.prop = null; r.gapMs = L.gapMsMin; return; } const o = prng.pick(others); r.visitId = o.id; r.targetX = o.x + (hc.x < o.x ? -L.visitBL : L.visitBL); }
    else r.targetX = hc.x;
    r.phase = 'approach';
    emit('activity_target', { cat: r.id, activity: def.id, targetX: r.targetX, prop: r.prop });
    if (def.approach === 'none') begin(r, def, ctx);
  }
  function begin(r, def, ctx) {
    if (def.prop && def.shared) propOwner.set(def.prop, r.id);
    r.phase = 'do'; r.durationMs = Math.round(def.durationMs[0] + prng.next() * (def.durationMs[1] - def.durationMs[0]));
    r.msLeft = r.durationMs; r.clips = clipsFor(def, r.durationMs); r.clipIx = 0; r.clipMs = r.clips[0].ms;
    if (def.dash) r.targetX = NaN;
    if (def.maxPerDay) r.dayCount[def.id] = (r.dayCount[def.id] || 0) + 1;
    emit('activity_start', { cat: r.id, activity: def.id, durationMs: r.durationMs, clips: r.clips, prop: r.prop, targetX: r.targetX });
  }
  /** the activity completed: apply its effects */
  function finish(r, reason) {
    const def = defById.get(r.act);
    if (def.resets) for (const n in def.resets) r.needs[n] = def.resets[n];
    if (def.delta) for (const n in def.delta) r.needs[n] = clamp100(r.needs[n] + def.delta[n]);
    if (def.after) { if (r.pendingAfter) r.needs[r.pendingAfter.need] = clamp100(r.needs[r.pendingAfter.need] + r.pendingAfter.delta); r.pendingAfter = { need: def.after.need, delta: def.after.delta, ms: def.after.delayMs }; } // a second meal before the first landed: land the first now
    if (def.tires) r.tiredMs = L.tiredMs;
    r.postLitter = def.id === 'litter' && prng.chance(def.zoomiesAfter || 0);
    if (def.cooldownMs) r.cool[def.id] = def.cooldownMs;
    r.memory.push(def.id); if (r.memory.length > 2) r.memory.shift();
    end(r, reason);
    r.gapMs = L.gapMsMin + prng.next() * (L.gapMsMax - L.gapMsMin);
    if (r.postLitter) r.gapMs = L.gapMsMin;
  }
  function end(r, reason) {
    const act = r.act; if (!act) return;
    if (r.prop && propOwner.get(r.prop) === r.id) propOwner.delete(r.prop);
    const wasDo = r.phase === 'do';
    r.act = null; r.phase = 'idle'; r.prop = null; r.targetX = NaN; r.msLeft = 0; r.clips = null; r.clipIx = 0; r.clipMs = 0; r.visitId = null;
    if (reason !== 'done' && reason !== 'external') r.postLitter = false;
    emit('activity_end', { cat: r.id, activity: act, reason, completed: reason === 'done' || reason === 'external', wasDoing: wasDo });
  }
  function needOf(r, def) { let m = 0; for (const n of def.serves) if (r.needs[n] > m) m = r.needs[n]; return m; }
  function hostCatById(list, id) { for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function anyCatNear(list, hc, bl) { for (let i = 0; i < list.length; i++) { const o = list[i]; if (o !== hc && o.id !== hc.id && Math.abs(o.x - hc.x) <= bl) return true; } return false; }
  function mapRound(m) { const o = {}; for (const k in m) o[k] = Math.round(m[k] * 100) / 100; return o; }

  lc.setCats(cats);
  return lc;
}

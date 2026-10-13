/* game/core/gamesmaster.js — the Games Master runtime DIRECTOR (pure core, deterministic). GE1, 2026-10-11.
   Spec: dev/impl/SK-112.md steps 1-8, docs/GAMES-MASTER-PLAN.md §3.1 (B1-B7 + caption-slot priority), §4 (no dark patterns),
   §7 (pack sections + runtime), §17.3 (sneeze, via gmsneeze.js), §17.8 (name rules). Step 9 (vr/src/gm-host.js) is GE2's.
   Events in -> at most ONE caption cue + hidden knob values + a host pose + the sneezer's events out. No AI, no network.
   Build rule: only `export function` / `export const`; private names carry the `gm` prefix. No three / WebXR / DOM, no
   Math.random / Date, no file or network reads: every random choice comes from a prng.js Prng owned here (variants) or by the
   sneezer, so the same seed + the same input log replays bit-for-bit (replayGamesMaster -> hash()).

   PACK SHAPE (decided): the director takes the pack OBJECT in the slim GAME_PACK shape that the headset loads
   (vr/src/pawdb/packs.gen.js, made by slimGamePack() in pawdb/tools/build-vr-packs.mjs): { manifest, modes, cues, plays, tuning }
   with cues[].blockedDuring as MOMENT CODES (countdown, last10s, rulesCaption, safety, driving, peekaboo, exit, scoreCard,
   restOffer) and tuning[].signal as SIGNAL CODES (GM_SIGNALS). The raw field pack (pawdb/fields/games-master/pack.json) carries
   prose there and is REFUSED at create (RangeError): run it through slimGamePack() first. No caption text lives in this file:
   every line comes from pack variants / followUps / modes[].rules. The host is "the Games Master" only through pack text; the
   director never builds a name string.

   API: createGamesMaster({ pack, seed, visit = { rulesSeen: {} }, suggestPlay?, calm?, forceCalm?, offerDone?, furs?, startFur?,
          log = true, sneezeTuning? (TESTS ONLY) })
     -> { step(input) -> out, answerSneeze(choice), setCalm(on), state(), hash(), log }
     input = { tick (integer, fixed 60 Hz, loop.js STEP_MS), events: [normalised], arcTick? (arc clock in ticks: >= 0 sets it,
               < 0 stops it, absent = keeps counting), slot: { sk99, controllersHint, beatHint }, moment: { countdown, last10s,
               rulesCaption, scoreCardMs, restOffer, safety, suggestionTile, peekaboo, exit, betweenRounds, idle, hosting?, sk99?,
               driving? } } (absent fields read as off).
     out (ONE reused object: read it before the next step) = { cue: { id, variantId, line1, line2, behaviour, play } | null,
               knobs: { joinScale, tellMs, dotAssist, coachPounceP } (reused, always inside pack bounds), pose: 'sit' | 'point' |
               'cheer' | 'countdown' | 'megaphone' | 'trophy' | 'nap', sneeze: the sneezer's reused event array (gmsneeze.js) }.
     A new cue object is allocated only on a step that emits one; idle steps allocate nothing (the log only on changed input).
   NORMALISED EVENTS (GM_EVENTS; adapters gmEventsFromLaserTag / gmEventsFromRoom make them, glue may push plain objects too):
     round_start, mode_start { mode }, streak { n }, near_miss { quiet? }, comeback, new_best, pb_close, cat_join { n },
     benched, round_end { reason?, timeS?, ranked? }, caught, combo { n }, big_leap, hand_climb, phase { phase },
     poke_host, arc_time { arcTick }, treat, ask_name, ask_past.
   BEHAVIOURS:
     B1 round_start -> countdown cue (lt_round_intro + its `countdown` follow-up as line 2 / arc_countdown), pose countdown;
        arc arrival (arc t >= 150 s) -> arc_intro once; phase 'wind' / mode arc_zoomies -> arc_zoomies_final; last10s edge ->
        lt_final_ten / the zoomies `ten_left` follow-up; pb_close -> lt_final_ten.
     B2 the first mode_start of a mode per VISIT (visit.rulesSeen[mode], set when shown) -> the mode's rules cue (one cue, <= 2
        lines); again only on poke_host (poke_repeat_rules in arc_laser, else the mode's rules cue). A mode with no rules cue
        uses its modes[].rules lines (<= 2).
     B3 commentary (pack behaviour 'B3'): >= 6 s (360 ticks) since the last B3 cue, never the same event type twice in a row,
        plus each cue's own cooldownS.
     B4 energy dip (no deed 20 s in a mode, 2 quick losses, 3 rounds of one game) -> the INJECTED suggestPlay(ctx) (
        game/core/gmplay.js); ctx = { reason: 'idle' | 'losses' | 'repeat', mode, tick } (one reused object). A non-null result
        -> suggest_play cue with cue.play = that result. No suggestPlay -> no suggestion (default).
     B5 hidden tuning at round_end (non-arc modes, never ranked runs): signals -> pack tuning rows -> knob values; each change
        moves a knob at most ONE row step toward/inside the row's [min, max] (tuneKnob), then the mode knob's [min, max].
        Never produces a cue, never announced. A round_end with no active round is ignored (no double count).
     B6 round_end / new_best / combo / treat -> celebrate cue, pose trophy.
     B7 rest offer at arc t >= 570 s (rest_offer, once) or 3 Laser Tag rounds in a row (lt_rest_offer, cooldown 60 s; a 60 s
        gap between rounds is a break and restarts the count); never blocks exit.
   CAPTION SLOT: > controllers hint > beat hint > the Games Master: any slot flag -> no cue this step. At most ONE pending
     cue, dropped when older than 3 s (180 ticks); a newer candidate of the same or higher rank replaces it. "Due" items (rest,
     pre-sneeze notice, arc intro, rules) wait in flags instead (they must not be lost). A cue is held while its blockedDuring
     moment is open, and for 1.5 s after the previous cue (2.5 s after a rules cue) so captions never stomp each other.
   ARC GATE: no cue before arc t 150 s (9000 ticks) unless a non-arc mode (lasertag_vr) has started; candidates before are
     discarded (the rules / intro flags wait for the gate).
   SNEEZE (§17.3): the director owns the 16-field moment and calls sneezer.step(tick * STEP_MS, moment) after choosing its cue
     (so its own countdown / rules / rest / suggestion windows count). offer_show -> the pre_sneeze_notice cue (due, never
     dropped); a finished (not cut) sneeze -> sneeze_quip. calm / forceCalm / offerDone pass through; answerSneeze(choice).
   REPLAY: `log` holds one entry per step whose input changed anything ({ tick, events, slot, moment, arcTick, ops });
     replayGamesMaster(opts, log, ticks) steps ticks 0..ticks-1 (one step per tick) and returns hash(). Pass the SAME initial
     options (a fresh visit object: rulesSeen is written to). hash() covers the prng, cooldown ticks, last event type, knobs,
     pending cue, due flags (incl. queued questions), windows, rounds, visit.rulesSeen (pack modes) and the sneezer's hash. */
import { createPrng, createHasher } from './prng.js';
import { STEP_MS } from './loop.js';
import { createSneezer } from './gmsneeze.js';

export const GM_DIRECTOR = Object.freeze({
  arcGateTicks: 9000,    // 150 s: the Games Master hosts from the laser beat
  restAtTicks: 34200,    // 570 s: arc rest offer
  restRounds: 3,         // rounds in a row -> rest offer
  breakTicks: 3600,      // >= 60 s between a round end and the next start = a break (rounds in a row restart)
  b3GapTicks: 360,       // B3 commentary cooldown >= 6 s
  pendingTicks: 180,     // a pending cue is dropped when older than 3 s
  minShowTicks: 90,      // a caption stays at least 1.5 s before the next one
  rulesShowTicks: 150,   // a rules caption stays 2.5 s
  countdownTicks: 180,   // countdown window (pose + blocked moment) 3 s
  restShowTicks: 480,    // rest offer window 8 s
  tileTicks: 480,        // suggestion tile fades in 8 s
  poseTicks: 150,        // other poses last 2.5 s
  pokeGapTicks: 360,     // rules repeat at most every 6 s
  againTicks: 3600,      // a second name / past question within 60 s gets the `again` follow-up
  noDeedTicks: 1200,     // B4: no deed for 20 s
  quickLossS: 30,        // a round lost (caught) in < 30 s is a quick loss
  firstCatchS: 15,
  r1FirstCatchS: 10,
  longRoundS: 90,
  scoreCardMs: 3000,
});

/** Cue ids the director maps events to (ids, not caption text). A missing id disables that behaviour. */
export const GM_CUE_IDS = Object.freeze(['pre_sneeze_notice', 'sneeze_quip', 'arc_intro', 'arc_laser_rules', 'arc_countdown',
  'arc_near_miss', 'arc_catch', 'arc_combo', 'arc_streak', 'arc_wand_leap', 'arc_treat', 'arc_zoomies_final', 'arc_round_end',
  'arc_new_best', 'rest_offer', 'poke_repeat_rules', 'name_dodge', 'dodge_b', 'lt_rules', 'lt_round_intro', 'lt_near_miss',
  'lt_streak', 'lt_comeback', 'lt_cat_joins', 'lt_benched', 'lt_final_ten', 'lt_round_end', 'lt_new_best', 'lt_rest_offer',
  'suggest_play']);
/** Tuning signal codes (GAME_PACK tuning[].signal) the director computes at round end. */
export const GM_SIGNALS = Object.freeze(['first_catch_under_15s', 'round_over_90s', 'r1_first_catch_under_10s', 'quick_losses_2',
  'long_rounds_2_over_90s']);
export const GM_EVENTS = Object.freeze(['round_start', 'mode_start', 'streak', 'near_miss', 'comeback', 'new_best', 'pb_close',
  'cat_join', 'benched', 'round_end', 'caught', 'combo', 'big_leap', 'hand_climb', 'phase', 'poke_host', 'arc_time', 'treat',
  'ask_name', 'ask_past']);
/** GAME_PACK moment codes (cues[].blockedDuring). */
export const GM_MOMENT_CODES = Object.freeze(['countdown', 'last10s', 'rulesCaption', 'safety', 'driving', 'peekaboo', 'exit',
  'scoreCard', 'restOffer']);
export const GM_POSES = Object.freeze(['sit', 'point', 'cheer', 'countdown', 'megaphone', 'trophy', 'nap']);

// role indexes into GM_CUE_IDS
const gmR = Object.freeze({ NOTICE: 0, QUIP: 1, A_INTRO: 2, A_RULES: 3, A_CD: 4, A_NEAR: 5, A_CATCH: 6, A_COMBO: 7, A_STREAK: 8,
  A_LEAP: 9, A_TREAT: 10, A_ZOOM: 11, A_END: 12, A_BEST: 13, A_REST: 14, POKE: 15, NAME: 16, PAST: 17, L_RULES: 18, L_INTRO: 19,
  L_NEAR: 20, L_STREAK: 21, L_COMEBACK: 22, L_JOIN: 23, L_BENCH: 24, L_TEN: 25, L_END: 26, L_BEST: 27, L_REST: 28, SUGGEST: 29 });
// event codes (index + 1 into GM_EVENTS; 21 = the internal sneeze event)
const gmE = Object.freeze({ ROUND_START: 1, MODE_START: 2, STREAK: 3, NEAR: 4, COMEBACK: 5, NEW_BEST: 6, PB_CLOSE: 7, JOIN: 8,
  BENCHED: 9, ROUND_END: 10, CAUGHT: 11, COMBO: 12, LEAP: 13, CLIMB: 14, PHASE: 15, POKE: 16, ARC_TIME: 17, TREAT: 18, ASK_NAME: 19,
  ASK_PAST: 20, SNEEZE: 21 });
const gmMB = Object.freeze({ countdown: 1, last10s: 2, rulesCaption: 4, safety: 8, driving: 16, peekaboo: 32, exit: 64, scoreCard: 128, restOffer: 256 });
const gmRank = Object.freeze({ B7: 8, notice: 7, B2: 6, dodge: 5, B1: 4, B6: 3, B4: 2, B3: 1 });
const gmModeRulesId = Object.freeze({ arc_laser: 'arc_laser_rules', lasertag_vr: 'lt_rules' });
const gmModeIntroId = Object.freeze({ arc_zoomies: 'arc_zoomies_final' });
const gmFuKeys = Object.freeze(['countdown', 'ten_left', 'again']);
const gmNoEvents = Object.freeze([]);
const gmNoSlot = Object.freeze({ sk99: false, controllersHint: false, beatHint: false });
const gmNoMoment = Object.freeze({});

function gmEvCode(type) {
  switch (type) {
    case 'round_start': return 1; case 'mode_start': return 2; case 'streak': return 3; case 'near_miss': return 4;
    case 'comeback': return 5; case 'new_best': return 6; case 'pb_close': return 7; case 'cat_join': return 8;
    case 'benched': return 9; case 'round_end': return 10; case 'caught': return 11; case 'combo': return 12;
    case 'big_leap': return 13; case 'hand_climb': return 14; case 'phase': return 15; case 'poke_host': return 16;
    case 'arc_time': return 17; case 'treat': return 18; case 'ask_name': return 19; case 'ask_past': return 20;
    default: return 0;
  }
}

function gmVariants(cueId, list) {
  if (!Array.isArray(list) || list.length === 0) throw new RangeError('gm: cue ' + cueId + ' needs variants');
  const out = [];
  for (const v of list) {
    if (!v || typeof v.id !== 'string' || typeof v.line1 !== 'string') throw new RangeError('gm: cue ' + cueId + ' variant needs id + line1');
    out.push({ id: v.id, line1: v.line1, line2: typeof v.line2 === 'string' ? v.line2 : null });
  }
  return out;
}

function gmPoseFor(role, behaviour) {
  if (role === gmR.A_CD || role === gmR.L_INTRO) return 'countdown';
  if (role === gmR.A_INTRO || role === gmR.A_ZOOM || role === gmR.L_TEN) return 'megaphone';
  switch (behaviour) {
    case 'B2': case 'B4': return 'point';
    case 'B3': return 'cheer';
    case 'B6': return 'trophy';
    case 'B7': return 'nap';
    default: return 'sit';
  }
}

function gmRec(c, role) {
  const beh = typeof c.behaviour === 'string' ? c.behaviour : 'B3';
  let mask = 0;
  if (c.blockedDuring !== undefined) {
    if (!Array.isArray(c.blockedDuring)) throw new RangeError('gm: cue ' + c.id + ' blockedDuring must be a list of moment codes');
    for (const code of c.blockedDuring) {
      if (!Object.hasOwn(gmMB, code)) throw new RangeError('gm: cue ' + c.id + ' blockedDuring "' + code + '" is not a GAME_PACK moment code (pass the slim GAME_PACK, see slimGamePack)');
      mask |= gmMB[code];
    }
  }
  const fu = { countdown: null, ten_left: null, again: null };
  if (c.followUps && typeof c.followUps === 'object') {
    for (const k of gmFuKeys) if (Array.isArray(c.followUps[k]) && c.followUps[k].length) fu[k] = { items: gmVariants(c.id, c.followUps[k]), last: -1 };
  }
  const rank = role === gmR.A_INTRO ? gmRank.B2 : Object.hasOwn(gmRank, beh) ? gmRank[beh] : 1;
  return { id: c.id, behaviour: beh, rank, b3: beh === 'B3', mask, cdTicks: typeof c.cooldownS === 'number' && c.cooldownS > 0 ? Math.round(c.cooldownS * 60) : 0,
    once: c.oncePerSession === true, variants: gmVariants(c.id, c.variants), fu, pose: gmPoseFor(role, beh), lastTick: -1, lastVar: -1, shown: false };
}

function gmClamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** B5: one hidden knob change (Planner ruling, review row 456 SHOULD 1): the knob moves AT MOST one row.step, in the step's
 *  direction, and never past the row's bound in that direction (a positive step stops at row.max, a negative one at row.min);
 *  a value already past that bound does not move; it never jumps to the far bound in one go. Then the mode knob's
 *  [min, max] (knobDef = { min, max, def } | null). |result - value| <= |row.step| whenever value is inside the knob bounds. */
export function tuneKnob(value, row, knobDef) {
  let v = Number.isFinite(value) ? value : knobDef ? knobDef.def : row.min;
  const st = row.step;
  if (st > 0) { if (v < row.max) v = Math.min(v + st, row.max); }
  else if (st < 0) { if (v > row.min) v = Math.max(v + st, row.min); }
  if (knobDef) v = gmClamp(v, knobDef.min, knobDef.max);
  return Math.round(v * 1e6) / 1e6;
}

function gmNev(type) { return { type, n: 0, mode: null, phase: null, reason: null, timeS: -1, ranked: false, quiet: false, arcTick: -1 }; }

/** lasertag.js / lasertag-room.js / lasertag-fun.js events -> normalised (pushed onto `out`, returned). Allocates only per event. */
export function gmEventsFromLaserTag(evs, out) {
  const o = out || [];
  if (!evs) return o;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]; let ne = null;
    switch (e.type) {
      case 'countdown': ne = gmNev('round_start'); break;               // the director ignores repeats inside a round
      case 'join': ne = gmNev('cat_join'); ne.n = e.n | 0; break;
      case 'near_miss': ne = gmNev('near_miss'); ne.quiet = e.quiet === true; break;
      case 'streak': if (e.n >= 2) { ne = gmNev('streak'); ne.n = e.n; } break; // a lapse (n 0) is never captioned (§4)
      case 'comeback': ne = gmNev('comeback'); break;
      case 'new_best': ne = gmNev('new_best'); break;
      case 'pb_close': ne = gmNev('pb_close'); break;
      case 'caught': ne = gmNev('benched'); break;                      // a kitten caught the dot: benched to the Nap Zone
      case 'laser_tag_result': ne = gmNev('round_end'); ne.reason = typeof e.reason === 'string' ? e.reason : null;
        ne.timeS = typeof e.timeS === 'number' ? e.timeS : -1; ne.ranked = e.ranked === true; break;
      default: break;
    }
    if (ne) o.push(ne);
  }
  return o;
}

/** roomcat.js (Play arc) events -> normalised (pushed onto `out`, returned). */
export function gmEventsFromRoom(evs, out) {
  const o = out || [];
  if (!evs) return o;
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]; let ne = null;
    switch (e.type) {
      case 'near_miss': ne = gmNev('near_miss'); ne.quiet = e.quiet === true; break;
      case 'catch': ne = gmNev('caught'); break;
      case 'combo': ne = gmNev('combo'); ne.n = e.n | 0; break;
      case 'big_leap': ne = gmNev('big_leap'); break;
      case 'hand_climb': ne = gmNev('hand_climb'); break;
      case 'eat': ne = gmNev('treat'); break;
      case 'phase': ne = gmNev('phase'); ne.phase = typeof e.phase === 'string' ? e.phase : null; break;
      default: break;
    }
    if (ne) o.push(ne);
  }
  return o;
}

function gmScm(m) { const sc = m.scoreCardMs; return typeof sc === 'number' && Number.isFinite(sc) ? sc : -1; }
function gmMomentCopy(m) {
  return { countdown: m.countdown === true, last10s: m.last10s === true, rulesCaption: m.rulesCaption === true, scoreCardMs: gmScm(m),
    restOffer: m.restOffer === true, safety: m.safety === true, suggestionTile: m.suggestionTile === true, peekaboo: m.peekaboo === true,
    exit: m.exit === true, betweenRounds: m.betweenRounds === true, idle: m.idle === true, hosting: m.hosting !== false,
    sk99: m.sk99 === true, driving: m.driving === true };
}
function gmSameMoment(a, m) {
  return a.countdown === (m.countdown === true) && a.last10s === (m.last10s === true) && a.rulesCaption === (m.rulesCaption === true)
    && a.scoreCardMs === gmScm(m) && a.restOffer === (m.restOffer === true) && a.safety === (m.safety === true)
    && a.suggestionTile === (m.suggestionTile === true) && a.peekaboo === (m.peekaboo === true) && a.exit === (m.exit === true)
    && a.betweenRounds === (m.betweenRounds === true) && a.idle === (m.idle === true) && a.hosting === (m.hosting !== false)
    && a.sk99 === (m.sk99 === true) && a.driving === (m.driving === true);
}
function gmEvCopy(e) {
  return { type: e.type, n: typeof e.n === 'number' ? e.n : 0, mode: typeof e.mode === 'string' ? e.mode : null,
    phase: typeof e.phase === 'string' ? e.phase : null, reason: typeof e.reason === 'string' ? e.reason : null,
    timeS: typeof e.timeS === 'number' ? e.timeS : -1, ranked: e.ranked === true, quiet: e.quiet === true,
    arcTick: typeof e.arcTick === 'number' ? e.arcTick : -1 };
}

export function createGamesMaster(opts) {
  const o = opts || {};
  const pack = o.pack;
  if (!pack || typeof pack !== 'object' || !Array.isArray(pack.cues) || !Array.isArray(pack.modes)) throw new TypeError('gm: the pack OBJECT (GAME_PACK shape: manifest, modes, cues, plays, tuning) is required');
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new TypeError('gm: numeric seed required');
  const K = GM_DIRECTOR;
  const visit = o.visit && typeof o.visit === 'object' ? o.visit : { rulesSeen: {} };
  if (!visit.rulesSeen || typeof visit.rulesSeen !== 'object') visit.rulesSeen = {};
  const suggestFn = typeof o.suggestPlay === 'function' ? o.suggestPlay : null;
  const logOn = o.log !== false;
  const prng = createPrng(o.seed);
  const sneezer = createSneezer({ seed: (Math.imul(o.seed >>> 0, 0x9e3779b1) ^ 0x51ed) >>> 0, furs: o.furs, startFur: o.startFur,
    calm: o.calm, offerDone: o.offerDone, forceCalm: o.forceCalm, tuning: o.sneezeTuning });

  // ---- cue table ----
  const byId = new Map();
  for (const c of pack.cues) if (c && typeof c.id === 'string') byId.set(c.id, c);
  const recs = [];
  const roleIdx = new Int16Array(GM_CUE_IDS.length).fill(-1);
  for (let r = 0; r < GM_CUE_IDS.length; r++) { const c = byId.get(GM_CUE_IDS[r]); if (c) { roleIdx[r] = recs.length; recs.push(gmRec(c, r)); } }
  const recByCueId = (id) => { const r = GM_CUE_IDS.indexOf(id); return r < 0 ? -1 : roleIdx[r]; };

  // ---- modes ----
  const modeIds = [], modeArc = [], modeRules = [], modeIntro = [];
  const modeMap = new Map();
  for (const md of pack.modes) {
    if (!md || typeof md.id !== 'string') continue;
    const i = modeIds.length;
    modeIds.push(md.id); modeMap.set(md.id, i);
    modeArc.push(md.arc === true || (md.arc !== false && md.id.startsWith('arc_')));
    let rr = Object.hasOwn(gmModeRulesId, md.id) ? recByCueId(gmModeRulesId[md.id]) : -1;
    const ir = Object.hasOwn(gmModeIntroId, md.id) ? recByCueId(gmModeIntroId[md.id]) : -1;
    if (rr < 0 && ir < 0 && Array.isArray(md.rules) && md.rules.length) { // fallback: the mode's own rule captions (<= 2)
      const r1 = md.rules[0], r2 = md.rules[1];
      if (r1 && typeof r1.line1 === 'string') {
        rr = recs.length;
        recs.push({ id: md.id + '_rules', behaviour: 'B2', rank: gmRank.B2, b3: false, mask: gmMB.countdown | gmMB.safety | gmMB.driving, cdTicks: 0, once: false,
          variants: [{ id: md.id + '_rules_1', line1: r1.line1, line2: r2 && typeof r2.line1 === 'string' ? r2.line1 : null }],
          fu: { countdown: null, ten_left: null, again: null }, pose: 'point', lastTick: -1, lastVar: -1, shown: false });
      }
    }
    modeRules.push(rr); modeIntro.push(ir);
  }

  // ---- knobs + tuning rows (B5) ----
  const knobIds = [], knobDefs = [], knobVals = [];
  function gmKnobSlot(id, modeId) {
    for (let i = 0; i < knobIds.length; i++) if (knobIds[i] === id) return i;
    let def = null;
    for (const md of pack.modes) {
      if (!md || !Array.isArray(md.knobs) || (modeId && md.id !== modeId)) continue;
      for (const k of md.knobs) if (k && k.id === id && typeof k.min === 'number' && typeof k.max === 'number') { def = { min: k.min, max: k.max, def: typeof k.default === 'number' ? k.default : k.min }; break; }
      if (def) break;
    }
    if (!def && modeId) return gmKnobSlot(id, null);
    if (!def) return -1;
    knobIds.push(id); knobDefs.push(def); knobVals.push(def.def);
    return knobIds.length - 1;
  }
  const rowsBySig = GM_SIGNALS.map(() => []);
  const unknownSignals = [];
  for (const t of Array.isArray(pack.tuning) ? pack.tuning : []) {
    if (!t || typeof t !== 'object') continue;
    if (t.hidden !== true) throw new RangeError('gm: tuning row ' + t.id + ' must be hidden (B5)');
    if (typeof t.step !== 'number' || typeof t.min !== 'number' || typeof t.max !== 'number' || !(t.min <= t.max)) throw new RangeError('gm: tuning row ' + t.id + ' needs numeric step and min <= max');
    const si = GM_SIGNALS.indexOf(t.signal);
    if (si < 0) { unknownSignals.push(t.id); continue; }
    let slot = gmKnobSlot(t.knob, t.mode);
    if (slot < 0) { knobIds.push(t.knob); knobDefs.push(null); knobVals.push(t.min); slot = knobIds.length - 1; }
    rowsBySig[si].push({ id: t.id, slot, step: t.step, min: t.min, max: t.max });
  }
  const kAssist = gmKnobSlot('assist_pct', 'lasertag_vr'), kJoin = gmKnobSlot('join_pace_s', 'lasertag_vr');
  const kCoach = gmKnobSlot('coach_pounce_p', 'lasertag_vr'), kTell = gmKnobSlot('pounce_tell_s', 'arc_laser');
  const knobs = { joinScale: 1, tellMs: 0, dotAssist: 0, coachPounceP: 0 };
  function gmKnobsOut() {
    knobs.dotAssist = kAssist >= 0 ? knobVals[kAssist] / 100 : 0;
    knobs.joinScale = kJoin >= 0 && knobDefs[kJoin] && knobDefs[kJoin].def > 0 ? Math.round(knobVals[kJoin] / knobDefs[kJoin].def * 1e6) / 1e6 : 1;
    knobs.coachPounceP = kCoach >= 0 ? knobVals[kCoach] : 0;
    knobs.tellMs = kTell >= 0 ? Math.round(knobVals[kTell] * 1000) : 0;
  }
  gmKnobsOut();

  // ---- state ----
  let tick = -1, arcRun = false, arcTick = -1, modeIdx = -1;
  let round = 0, roundActive = false, roundStartTick = -1, lastRoundEndTick = -1, roundsInRow = 0, roundsSameMode = 0, ltRounds = 0;
  let quickStreak = 0, longStreak = 0, tunes = 0;
  let lastB3Tick = -1, lastB3Ev = 0, lastDeedTick = -1, lastCelebrateTick = -1, lastAskName = -1, lastAskPast = -1;
  let pendRec = -1, pendPool = 0, pendAux = 0, pendEv = 0, pendTick = -1, pendPlay = null; // pool / aux: 0 none, 1 countdown, 2 ten_left, 3 again
  let restDue = -1, noticeDue = false, introDue = false, introDone = false, restAtDone = false, rulesDue = -1, rulesDueMode = -1, rulesPoke = false;
  let cdUntil = -1, rulesUntil = -1, restUntil = -1, tileUntil = -1, showUntil = -1, poseUntil = -1, pose = 'sit';
  let prevLast10 = false, emitted = 0, dropped = 0;
  let askNameDue = 0, askPastDue = 0; // 0 none, 1 first question, 3 `again`: queued while the dodge cue cools down (answered once it can)
  const log = [];
  const ops = [];
  let lastSlot = gmNoSlot, lastMoment = gmMomentCopy(gmNoMoment);
  const sm = { hosting: false, round: 0, betweenRounds: false, idle: false, sinceCelebrateMs: -1, scoreCardMs: -1, countdown: false, last10s: false,
    rulesCaption: false, restOffer: false, safety: false, sk99: false, driving: false, suggestionTile: false, peekaboo: false, exit: false };
  const sctx = { reason: 'idle', mode: null, tick: 0 };
  const out = { cue: null, knobs, pose: 'sit', sneeze: gmNoEvents };

  const ltFamily = () => modeIdx >= 0 && !modeArc[modeIdx];
  const gateOpen = () => (arcRun && arcTick >= K.arcGateTicks) || ltFamily();

  function gmPool(r, p) { return p === 1 ? r.fu.countdown : p === 2 ? r.fu.ten_left : p === 3 ? r.fu.again : null; }

  /** candidate time: arc gate, once, per-cue cooldown, B3 gap + same type, rank vs the pending cue. */
  function gmCanOffer(ri, ev) {
    if (ri < 0 || !gateOpen()) return false;
    const r = recs[ri];
    if (r.once && r.shown) return false;
    if (r.lastTick >= 0 && tick - r.lastTick < r.cdTicks) return false;
    if (r.b3 && ((lastB3Tick >= 0 && tick - lastB3Tick < K.b3GapTicks) || ev === lastB3Ev)) return false;
    if (pendRec >= 0 && recs[pendRec].rank > r.rank && tick - pendTick <= K.pendingTicks) return false;
    return true;
  }
  function gmSetPending(ri, pool, aux, ev, play) {
    if (pendRec >= 0) dropped++;
    pendRec = ri; pendPool = pool; pendAux = aux; pendEv = ev; pendTick = tick; pendPlay = play;
  }
  function gmOffer(role, ev, pool, aux, play) {
    const ri = roleIdx[role];
    if (!gmCanOffer(ri, ev)) return;
    if (pool && !gmPool(recs[ri], pool)) pool = 0;
    gmSetPending(ri, pool, aux, ev, play);
  }

  function gmPick(items, last) {
    const n = items.length;
    if (n <= 1) return 0;
    const ok = last >= 0 && last < n;
    let k = prng.int(ok ? n - 1 : n);
    if (ok && k >= last) k++;
    return k;
  }

  function gmEmit(ri, pool, aux, ev, play) {
    const r = recs[ri];
    const P = pool ? gmPool(r, pool) : null;
    let v;
    if (P) { const k = gmPick(P.items, P.last); P.last = k; v = P.items[k]; }
    else { const k = gmPick(r.variants, r.lastVar); r.lastVar = k; v = r.variants[k]; }
    let line2 = v.line2;
    if (line2 === null && aux) { const A = gmPool(r, aux); if (A) { const k = gmPick(A.items, A.last); A.last = k; line2 = A.items[k].line1; } }
    r.lastTick = tick; r.shown = true; emitted++;
    if (r.b3) { lastB3Tick = tick; lastB3Ev = ev; }
    const b = r.behaviour;
    if (r.pose === 'countdown') { cdUntil = tick + K.countdownTicks; poseUntil = cdUntil; }
    else poseUntil = tick + K.poseTicks;
    pose = r.pose;
    if (b === 'B2') { rulesUntil = tick + K.rulesShowTicks; showUntil = rulesUntil; } else showUntil = tick + K.minShowTicks;
    if (b === 'B7') { restUntil = tick + K.restShowTicks; roundsInRow = 0; }
    if (b === 'B4') { tileUntil = tick + K.tileTicks; roundsSameMode = 0; }
    return { id: r.id, variantId: v.id, line1: v.line1, line2, behaviour: b, play: play === undefined ? null : play };
  }

  function gmSuggest(reason) {
    if (!suggestFn) return;
    if (!gmCanOffer(roleIdx[gmR.SUGGEST], 0)) return;
    sctx.reason = reason; sctx.mode = modeIdx >= 0 ? modeIds[modeIdx] : null; sctx.tick = tick;
    const res = suggestFn(sctx);
    if (res != null) gmOffer(gmR.SUGGEST, 0, 0, 0, res);
  }

  function gmModeStart(id) {
    const i = modeMap.has(id) ? modeMap.get(id) : -1;
    if (i < 0) return;
    if (i !== modeIdx) { roundsSameMode = 0; roundsInRow = 0; }
    modeIdx = i;
    const seen = visit.rulesSeen[id] === true;
    const ir = modeIntro[i];
    if (ir >= 0) {
      const r = recs[ir];
      if (gateOpen() && !(r.once && r.shown) && (pendRec < 0 || recs[pendRec].rank <= r.rank)) gmSetPending(ir, 0, 0, gmE.MODE_START, null);
      if (!seen && modeRules[i] < 0) visit.rulesSeen[id] = true;
    }
    if (!seen && modeRules[i] >= 0) { rulesDue = modeRules[i]; rulesDueMode = i; rulesPoke = false; }
  }

  function gmFire(si) {
    const rows = rowsBySig[si];
    for (let j = 0; j < rows.length; j++) { const w = rows[j]; knobVals[w.slot] = tuneKnob(knobVals[w.slot], w, knobDefs[w.slot]); tunes++; }
  }
  function gmTune(timeS, lost) {
    ltRounds++;
    if (lost && timeS < K.firstCatchS) gmFire(0);
    if (timeS > K.longRoundS) gmFire(1);
    if (ltRounds === 1 && lost && timeS < K.r1FirstCatchS) gmFire(2);
    if (lost && timeS < K.quickLossS) { quickStreak++; if (quickStreak >= 2) { gmFire(3); quickStreak = 0; gmSuggest('losses'); } } else quickStreak = 0;
    if (timeS > K.longRoundS) { longStreak++; if (longStreak >= 2) { gmFire(4); longStreak = 0; } } else longStreak = 0;
    gmKnobsOut();
  }

  function gmOnEvent(e) {
    const c = gmEvCode(e.type);
    if (c === 0) return;
    const lt = ltFamily();
    if (c !== gmE.ARC_TIME && c !== gmE.PHASE && c !== gmE.MODE_START) lastDeedTick = tick;
    switch (c) {
      case gmE.ROUND_START:
        if (roundActive) return;
        if (lastRoundEndTick >= 0 && tick - lastRoundEndTick >= K.breakTicks) roundsInRow = 0;
        roundActive = true; roundStartTick = tick; round++;
        if (lt) gmOffer(gmR.L_INTRO, c, 0, 1, null); else gmOffer(gmR.A_CD, c, 0, 0, null);
        return;
      case gmE.MODE_START: if (typeof e.mode === 'string') gmModeStart(e.mode); return;
      case gmE.STREAK: if (e.n >= 2) gmOffer(lt ? gmR.L_STREAK : gmR.A_STREAK, c, 0, 0, null); return;
      case gmE.NEAR: if (e.quiet !== true) gmOffer(lt ? gmR.L_NEAR : gmR.A_NEAR, c, 0, 0, null); return;
      case gmE.COMEBACK: if (lt) gmOffer(gmR.L_COMEBACK, c, 0, 0, null); return;
      case gmE.NEW_BEST: lastCelebrateTick = tick; gmOffer(lt ? gmR.L_BEST : gmR.A_BEST, c, 0, 0, null); return;
      case gmE.PB_CLOSE: if (lt) gmOffer(gmR.L_TEN, c, 0, 0, null); return;
      case gmE.JOIN: if (lt) gmOffer(gmR.L_JOIN, c, 0, 0, null); return;
      case gmE.BENCHED: if (lt) gmOffer(gmR.L_BENCH, c, 0, 0, null); return;
      case gmE.CAUGHT: if (lt) gmOffer(gmR.L_BENCH, gmE.BENCHED, 0, 0, null); else gmOffer(gmR.A_CATCH, c, 0, 0, null); return;
      case gmE.ROUND_END: {
        if (!roundActive) return; // review row 456 SHOULD 2: a doubled / stray round_end never counts twice
        const timeS = typeof e.timeS === 'number' && e.timeS >= 0 ? e.timeS : roundStartTick >= 0 ? (tick - roundStartTick) * STEP_MS / 1000 : 0;
        roundActive = false; lastRoundEndTick = tick; lastCelebrateTick = tick; roundsInRow++; roundsSameMode++;
        if (lt && e.ranked !== true) gmTune(timeS, e.reason === 'caught');
        gmOffer(lt ? gmR.L_END : gmR.A_END, c, 0, 0, null);
        if (lt && roundsInRow >= K.restRounds) { // rounds = Laser Tag rounds; the arc's rest offer is the 570 s one (once)
          const ri = roleIdx[gmR.L_REST];
          if (ri >= 0 && gateOpen()) { const r = recs[ri]; if (!(r.once && r.shown) && !(r.lastTick >= 0 && tick - r.lastTick < r.cdTicks)) restDue = ri; }
        }
        if (roundsSameMode >= K.restRounds) gmSuggest('repeat');
        return;
      }
      case gmE.COMBO: lastCelebrateTick = tick; if (!lt) gmOffer(gmR.A_COMBO, c, 0, 0, null); return;
      case gmE.LEAP: if (!lt) gmOffer(gmR.A_LEAP, c, 0, 0, null); return;
      case gmE.TREAT: if (!lt) gmOffer(gmR.A_TREAT, c, 0, 0, null); return;
      case gmE.PHASE: if (e.phase === 'wind' && modeMap.has('arc_zoomies')) gmModeStart('arc_zoomies'); return;
      case gmE.POKE: {
        if (modeIdx < 0 || !gateOpen()) return;
        const pr = modeIds[modeIdx] === 'arc_laser' ? roleIdx[gmR.POKE] : -1;
        const ri = pr >= 0 ? pr : modeRules[modeIdx];
        if (ri < 0) return;
        const r = recs[ri];
        if (r.lastTick >= 0 && tick - r.lastTick < Math.max(r.cdTicks, K.pokeGapTicks)) return;
        rulesDue = ri; rulesDueMode = modeIdx; rulesPoke = true;
        return;
      }
      case gmE.ARC_TIME:
        if (typeof e.arcTick === 'number' && Number.isFinite(e.arcTick)) { if (e.arcTick >= 0) { arcRun = true; arcTick = e.arcTick; } else { arcRun = false; arcTick = -1; } }
        return;
      case gmE.ASK_NAME: { const again = lastAskName >= 0 && tick - lastAskName < K.againTicks; lastAskName = tick; askNameDue = again ? 3 : 1; gmAsk(); return; }
      case gmE.ASK_PAST: { const again = lastAskPast >= 0 && tick - lastAskPast < K.againTicks; lastAskPast = tick; askPastDue = again ? 3 : 1; gmAsk(); return; }
      default: return;
    }
  }

  /** queued name / past questions: offered as soon as the dodge cue may be (cooldown, gate, rank); dropped after 60 s unanswered. */
  function gmAsk() {
    if (askNameDue) {
      if (tick - lastAskName > K.againTicks) askNameDue = 0;
      else if (gmCanOffer(roleIdx[gmR.NAME], gmE.ASK_NAME)) { gmOffer(gmR.NAME, gmE.ASK_NAME, askNameDue === 3 ? 3 : 0, 0, null); askNameDue = 0; }
    }
    if (askPastDue) {
      if (tick - lastAskPast > K.againTicks) askPastDue = 0;
      else if (gmCanOffer(roleIdx[gmR.PAST], gmE.ASK_PAST)) { gmOffer(gmR.PAST, gmE.ASK_PAST, askPastDue === 3 ? 3 : 0, 0, null); askPastDue = 0; }
    }
  }

  function gmRecordLog(t, slot, m, events, arcIn) {
    const changed = events.length > 0 || ops.length > 0 || arcIn !== null;
    if (!changed && (slot.sk99 === true) === lastSlot.sk99 && (slot.controllersHint === true) === lastSlot.controllersHint
      && (slot.beatHint === true) === lastSlot.beatHint && gmSameMoment(lastMoment, m)) return;
    lastSlot = { sk99: slot.sk99 === true, controllersHint: slot.controllersHint === true, beatHint: slot.beatHint === true };
    lastMoment = gmMomentCopy(m);
    let evc = null;
    if (events.length) { evc = []; for (let i = 0; i < events.length; i++) evc.push(gmEvCopy(events[i])); }
    log.push({ tick: t, events: evc, slot: lastSlot, moment: lastMoment, arcTick: arcIn, ops: ops.length ? ops.splice(0, ops.length) : null });
  }

  function step(input) {
    if (!input || typeof input !== 'object') throw new TypeError('gm.step: input object required');
    const t = input.tick;
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new TypeError('gm.step: finite integer tick required');
    const dt = tick >= 0 && t > tick ? t - tick : 0;
    tick = t;
    const events = Array.isArray(input.events) ? input.events : gmNoEvents;
    const slot = input.slot && typeof input.slot === 'object' ? input.slot : gmNoSlot;
    const m = input.moment && typeof input.moment === 'object' ? input.moment : gmNoMoment;

    // arc clock (input.arcTick: >= 0 sets, < 0 stops, absent keeps counting); logged only when it is not the predicted value
    if (arcRun) arcTick += dt;
    let arcIn = null;
    const ai = input.arcTick;
    if (typeof ai === 'number' && Number.isFinite(ai)) {
      if (ai >= 0) { if (!arcRun || ai !== arcTick) arcIn = ai; arcRun = true; arcTick = ai; }
      else { if (arcRun) arcIn = ai; arcRun = false; arcTick = -1; }
    }
    if (logOn) gmRecordLog(t, slot, m, events, arcIn);

    for (let i = 0; i < events.length; i++) gmOnEvent(events[i]);

    if (arcRun && arcTick >= K.arcGateTicks && !introDone) { introDone = true; if (roleIdx[gmR.A_INTRO] >= 0) introDue = true; }
    if (arcRun && arcTick >= K.restAtTicks && !restAtDone) { restAtDone = true; const ri = roleIdx[gmR.A_REST]; if (ri >= 0 && !recs[ri].shown) restDue = ri; }
    const l10 = m.last10s === true;
    if (l10 && !prevLast10) {
      if (ltFamily()) gmOffer(gmR.L_TEN, gmE.PB_CLOSE, 0, 0, null);
      else if (modeIdx >= 0 && modeIds[modeIdx] === 'arc_zoomies') {
        const ri = roleIdx[gmR.A_ZOOM];
        if (ri >= 0 && gateOpen() && recs[ri].fu.ten_left && (pendRec < 0 || recs[pendRec].rank <= recs[ri].rank)) gmSetPending(ri, 2, 0, 0, null);
      }
    }
    prevLast10 = l10;
    if (askNameDue || askPastDue) gmAsk();
    if (suggestFn && modeIdx >= 0 && lastDeedTick >= 0 && tick - lastDeedTick >= K.noDeedTicks && gateOpen()) { lastDeedTick = tick; gmSuggest('idle'); }

    // ---- the moment mask (input + the director's own windows) ----
    const scm = gmScm(m);
    const drv = slot.sk99 === true || m.sk99 === true || m.driving === true;
    const cdOn = m.countdown === true || tick < cdUntil, rcOn = m.rulesCaption === true || tick < rulesUntil, roOn = m.restOffer === true || tick < restUntil;
    const mask = (cdOn ? 1 : 0) | (l10 ? 2 : 0) | (rcOn ? 4 : 0) | (m.safety === true ? 8 : 0) | (drv ? 16 : 0) | (m.peekaboo === true ? 32 : 0)
      | (m.exit === true ? 64 : 0) | (scm >= 0 && scm < K.scoreCardMs ? 128 : 0) | (roOn ? 256 : 0);

    // ---- choose and emit at most one cue ----
    if (rulesDue >= 0 && rulesDueMode !== modeIdx) { rulesDue = -1; rulesDueMode = -1; rulesPoke = false; } // the mode changed first
    if (pendRec >= 0 && tick - pendTick > K.pendingTicks) { pendRec = -1; pendPlay = null; dropped++; }
    let cue = null;
    const busy = slot.sk99 === true || slot.controllersHint === true || slot.beatHint === true;
    if (!busy && tick >= showUntil && gateOpen()) {
      let pick = -1, kind = 0, rank = -1; // kind: 1 rest, 2 notice, 3 intro, 4 rules, 5 pending
      if (restDue >= 0 && !(recs[restDue].mask & mask)) { pick = restDue; kind = 1; rank = recs[restDue].rank; }
      const ni = roleIdx[gmR.NOTICE];
      if (noticeDue && ni >= 0 && !(recs[ni].mask & mask) && recs[ni].rank > rank) { pick = ni; kind = 2; rank = recs[ni].rank; }
      const ii = roleIdx[gmR.A_INTRO];
      if (introDue && ii >= 0 && !(recs[ii].mask & mask) && recs[ii].rank > rank) { pick = ii; kind = 3; rank = recs[ii].rank; }
      if (rulesDue >= 0 && !(recs[rulesDue].mask & mask) && recs[rulesDue].rank > rank) { pick = rulesDue; kind = 4; rank = recs[rulesDue].rank; }
      if (pendRec >= 0 && !(recs[pendRec].mask & mask) && recs[pendRec].rank > rank) { pick = pendRec; kind = 5; }
      if (kind === 5) { cue = gmEmit(pick, pendPool, pendAux, pendEv, pendPlay); pendRec = -1; pendPlay = null; }
      else if (kind > 0) {
        cue = gmEmit(pick, 0, 0, 0, null);
        if (kind === 1) restDue = -1;
        else if (kind === 2) noticeDue = false;
        else if (kind === 3) introDue = false;
        else { if (!rulesPoke && rulesDueMode >= 0) visit.rulesSeen[modeIds[rulesDueMode]] = true; rulesDue = -1; rulesDueMode = -1; rulesPoke = false; }
      }
    }

    // ---- the sneezer (after the cue, so this step's own windows count) ----
    sm.hosting = gateOpen() && m.hosting !== false; sm.round = round; sm.betweenRounds = m.betweenRounds === true; sm.idle = m.idle === true;
    sm.sinceCelebrateMs = lastCelebrateTick >= 0 ? (tick - lastCelebrateTick) * STEP_MS : -1; sm.scoreCardMs = scm;
    sm.countdown = m.countdown === true || tick < cdUntil; sm.last10s = l10; sm.rulesCaption = m.rulesCaption === true || tick < rulesUntil;
    sm.restOffer = m.restOffer === true || tick < restUntil; sm.safety = m.safety === true; sm.sk99 = slot.sk99 === true || m.sk99 === true;
    sm.driving = m.driving === true; sm.suggestionTile = m.suggestionTile === true || tick < tileUntil; sm.peekaboo = m.peekaboo === true; sm.exit = m.exit === true;
    const sev = sneezer.step(tick * STEP_MS, sm);
    for (let i = 0; i < sev.length; i++) {
      const se = sev[i];
      if (se.type === 'offer_show') noticeDue = true;
      else if (se.type === 'sneeze_end' && se.cut !== true) gmOffer(gmR.QUIP, gmE.SNEEZE, 0, 0, null);
    }

    out.cue = cue;
    out.pose = tick < poseUntil ? pose : 'sit';
    out.sneeze = sev;
    return out;
  }

  /** the pre-sneeze notice answer (card): 'full' | false -> full sneezes, anything else -> calm. Logged for replay. */
  function answerSneeze(choice) { if (logOn) ops.push(['answer', choice]); return sneezer.answer(choice); }
  /** Settings > Accessibility > Calm sneezes. Logged for replay. */
  function setCalm(on) { if (logOn) ops.push(['calm', !!on]); return sneezer.setCalm(on); }

  function state() {
    const kv = {};
    for (let i = 0; i < knobIds.length; i++) kv[knobIds[i]] = knobVals[i];
    const kd = {};
    for (let i = 0; i < knobIds.length; i++) kd[knobIds[i]] = knobDefs[i] ? { ...knobDefs[i] } : null;
    return { tick, arcTick: arcRun ? arcTick : -1, mode: modeIdx >= 0 ? modeIds[modeIdx] : null, round, roundActive, roundsInRow, roundsSameMode,
      lastB3Tick, lastB3Event: lastB3Ev === gmE.SNEEZE ? 'sneeze' : lastB3Ev > 0 ? GM_EVENTS[lastB3Ev - 1] : null,
      pending: pendRec >= 0 ? recs[pendRec].id : null, due: { rest: restDue >= 0, notice: noticeDue, intro: introDue, rules: rulesDue >= 0, askName: askNameDue > 0, askPast: askPastDue > 0 },
      knobs: { ...knobs }, knobValues: kv, knobDefs: kd, tunes, emitted, dropped, hosting: gateOpen(), unknownSignals: unknownSignals.slice(),
      sneeze: sneezer.state(), rulesSeen: { ...visit.rulesSeen } };
  }

  function hash() {
    const h = createHasher();
    const s = prng.getState();
    const tk = (x) => (x >= 0 ? x / 60 : -1);
    h.num(s & 0xffff).num(s >>> 16).num(tk(tick)).num(arcRun ? 1 : 0).num(tk(arcTick)).num(modeIdx).num(round).num(roundActive ? 1 : 0)
      .num(tk(roundStartTick)).num(tk(lastRoundEndTick)).num(roundsInRow).num(roundsSameMode).num(ltRounds).num(quickStreak).num(longStreak).num(tunes)
      .num(tk(lastB3Tick)).num(lastB3Ev).num(tk(lastDeedTick)).num(tk(lastCelebrateTick)).num(tk(lastAskName)).num(tk(lastAskPast))
      .num(pendRec).num(pendPool).num(pendAux).num(pendEv).num(tk(pendTick)).num(pendPlay === null ? 0 : 1)
      .num(restDue).num(noticeDue ? 1 : 0).num(introDue ? 1 : 0).num(introDone ? 1 : 0).num(restAtDone ? 1 : 0).num(rulesDue).num(rulesDueMode).num(rulesPoke ? 1 : 0)
      .num(tk(cdUntil)).num(tk(rulesUntil)).num(tk(restUntil)).num(tk(tileUntil)).num(tk(showUntil)).num(tk(poseUntil)).str(pose).num(prevLast10 ? 1 : 0)
      .num(emitted).num(dropped).num(askNameDue).num(askPastDue);
    for (let i = 0; i < modeIds.length; i++) h.num(visit.rulesSeen[modeIds[i]] === true ? 1 : 0);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      h.num(tk(r.lastTick)).num(r.lastVar).num(r.shown ? 1 : 0);
      for (const k of gmFuKeys) { const P = r.fu[k]; h.num(P ? P.last : -2); }
    }
    for (let i = 0; i < knobVals.length; i++) h.num(knobVals[i]);
    sneezer.hash(h);
    return h.digest();
  }

  return { step, answerSneeze, setCalm, state, hash, log };
}

/** Re-run a logged session (one step per tick, ticks 0..ticks-1) and return its hash. opts = the SAME initial options. */
export function replayGamesMaster(opts, log, ticks) {
  const d = createGamesMaster(Object.assign({}, opts, { log: false }));
  let slot = gmNoSlot, moment = gmNoMoment, j = 0;
  const input = { tick: 0, events: gmNoEvents, slot, moment, arcTick: null };
  for (let t = 0; t < ticks; t++) {
    input.events = gmNoEvents; input.arcTick = null;
    while (j < log.length && log[j].tick < t) j++;
    if (j < log.length && log[j].tick === t) {
      const L = log[j++];
      if (L.ops) for (const op of L.ops) { if (op[0] === 'answer') d.answerSneeze(op[1]); else if (op[0] === 'calm') d.setCalm(op[1]); }
      slot = L.slot; moment = L.moment;
      if (L.events) input.events = L.events;
      if (L.arcTick !== null) input.arcTick = L.arcTick;
    }
    input.tick = t; input.slot = slot; input.moment = moment;
    d.step(input);
  }
  return d.hash();
}

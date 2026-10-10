/* vr/src/hints.js - W3: onboarding hints for the first five minutes + captions (plan 1.3 beats; W4 accessibility
   row "captions on all prompts" is met from day one: every hint IS a caption, and sound cues get a text caption too).
   Gaming Engineer 2, 2026-10-09. PURE and engine-neutral: plain progress counters in, the hint to show out. The host puts
   the text on a head-locked card (room-hook.js createHintCard) and on the 2D #hint line. Node-tested in
   vr/test/hints.test.mjs.
   How it works:
   - progressStep(prev, events, state) counts what the player has DONE from the roomcat events / state the bridge already
     has (box open, first pet, first carry, first laser, first wand pickup, first treat) -> monotonic counters.
   - HINTS is the ordered beat list (plan 1.3). Each hint has ready(c) (the beat has started), done(c) (the player did it),
     from / until (session seconds). hintStep(prev, c) shows the first ready, not-done hint inside its window, keeps it
     up for showS seconds, then rests it for restS before showing it again (at most maxShows times), so nobody is nagged.
     A hint hides the moment its action happens. Arc beats after 5:00 (wind-down, nap, end) are short mood lines.
   - captionStep(prev, state, t) turns sound cues the sim produces (purr, climb-out mews, pounces, feather swats) into
     "(purring)"-style captions with a minimum show time and no repeat spam.
   Wording rules: original text, no brands, no "buy", no profanity (legal section 12 item 5 / 6). English only. */
export const HINTS_VERSION = 2; // 2: P0a slice pacing (HINTS_SLICE, HINT_TUNING_SLICE) + roomcat v2 event counters
export const HINT_TUNING = Object.freeze({ showS: 20, restS: 40, maxShows: 3, moodS: 8, captionMinS: 1.5, captionGapS: 3 });
/** P0a slice: 3 minutes, so hints show shorter and come back sooner. */
export const HINT_TUNING_SLICE = Object.freeze({ showS: 12, restS: 18, maxShows: 3, moodS: 8, captionMinS: 1.2, captionGapS: 2.5 });

/** Fresh progress counters. */
export function createProgress() {
  return { boxOpen: false, catsOut: 0, pets: 0, carries: 0, lasers: 0, wands: 0, treats: 0, tosses: 0, poofs: 0, naps: 0, hugs: 0,
    catches: 0, nearMisses: 0, combos: 0, bigLeaps: 0, handClimbs: 0, eats: 0, tells: 0 }; // (roomcat v2 events)
}

/**
 * Count the player's deeds. events = the roomcat events the bridge sent this frame ({ type: 'pet' | 'pinch' | 'laser' |
 * 'wand' | 'treat' | 'release' ... }); state = roomcat state after the steps; simEvents (optional) = roomcat v2's
 * `session.events` collected this frame (tell / pounce / near_miss / combo / big_leap / hand_climb). Pure (returns a new object).
 */
export function progressStep(prev, events, state, simEvents) {
  const c = Object.assign({}, prev || createProgress());
  for (const ev of events || []) {
    if (ev.type === 'pet') c.pets++;
    else if (ev.type === 'laser' && ev.on !== false) c.lasers++;
    else if (ev.type === 'wand' && ev.on !== false) c.wands++;
    else if (ev.type === 'treat' && ev.on !== false) c.treats++;
    else if (ev.type === 'release') c.tosses++;
  }
  for (const ev of simEvents || []) {
    if (ev.type === 'pounce') { if (ev.catch) c.catches++; }
    else if (ev.type === 'near_miss') c.nearMisses++;
    else if (ev.type === 'combo') c.combos++;
    else if (ev.type === 'big_leap') c.bigLeaps++;
    else if (ev.type === 'hand_climb') c.handClimbs++;
    else if (ev.type === 'tell') c.tells++;
  }
  if (state) {
    if (state.box && state.box.open) c.boxOpen = true;
    let out = 0, carried = 0, poof = 0, nap = 0, onhand = 0, eat = 0;
    for (const k of state.cats || []) {
      if (k.mode !== 'inbox') out++;
      if (k.mode === 'carried') carried++;
      if (k.poof) poof++;
      if (k.mode === 'nap') nap++;
      if (k.mode === 'onhand') onhand++;
      if (k.pose === 'eat') eat++;
    }
    if (out > c.catsOut) c.catsOut = out;
    if (carried && !(prev && prev._carried)) c.carries++;
    c._carried = carried > 0;
    if (poof && !(prev && prev._poof)) c.poofs++;
    c._poof = poof > 0;
    if (onhand && !(prev && prev._onhand)) c.hugs++;
    c._onhand = onhand > 0;
    if (nap > c.naps) c.naps = nap;
    if (eat && !(prev && prev._eat)) c.eats++;
    c._eat = eat > 0;
  }
  return c;
}

/** The beats. anchor = where the host floats the card: 'box' | 'cat' | 'hand' | 'basket' | 'head'. */
export const HINTS = Object.freeze([
  { id: 'box', text: 'Pinch the box flaps to open it', anchor: 'box', from: 0, until: Infinity,
    ready: (c) => !!(c.box && c.box.landed) && !c.boxOpen, done: (c) => c.boxOpen },
  { id: 'pet', text: 'Pet her: stroke her back slowly', anchor: 'cat', from: 0, until: 150,
    ready: (c) => c.catsOut > 0 && c.t >= c.firstOutT + 6, done: (c) => c.pets > 0 },
  { id: 'carry', text: 'Pinch the scruff of her neck to pick her up', anchor: 'cat', from: 0, until: 150,
    ready: (c) => c.pets > 0 || (c.catsOut > 0 && c.t >= 90), done: (c) => c.carries > 0 },
  { id: 'laser', text: 'Point your finger: the kittens chase the dot', anchor: 'hand', from: 0, until: 300,
    ready: (c) => c.carries > 0 || (c.catsOut > 0 && c.t >= 150), done: (c) => c.lasers > 0 },
  { id: 'wand', text: 'Pinch the feather wand from the basket, then wiggle it', anchor: 'basket', from: 0, until: 450,
    ready: (c) => c.catsOut > 0 && (c.t >= 300 || (c.lasers > 0 && c.t >= 240)), done: (c) => c.wands > 0 },
  { id: 'treat', text: 'Hold your palm up, flat and still, for a treat', anchor: 'hand', from: 0, until: 450,
    ready: (c) => c.catsOut > 0 && (c.wands > 0 || c.t >= 390), done: (c) => c.treats > 0 },
  { id: 'sleepy', text: 'The kittens are getting sleepy', anchor: 'head', from: 0, until: Infinity, mood: true,
    ready: (c) => c.phase === 'wind', done: (c) => c.phase === 'nap' || c.phase === 'end' },
  { id: 'nap', text: 'Shh. Nap time.', anchor: 'head', from: 0, until: Infinity, mood: true,
    ready: (c) => c.phase === 'nap', done: (c) => c.phase === 'end' },
]);

/** P0a slice beats (docs/P0A-SLICE.md GE2; order per GDXE Build 1 item 2: pet -> treat -> carry -> laser): the same deeds in 3 minutes, paced from the first kitten out (no wand: the
 *  Happiness meter + the director's captions carry the rest). Original text, no brands, no "buy". */
export const HINTS_SLICE = Object.freeze([
  { id: 'box', text: 'Pinch the box flaps to open it', anchor: 'box', from: 0, until: Infinity,
    ready: (c) => !!(c.box && c.box.landed) && !c.boxOpen, done: (c) => c.boxOpen },
  { id: 'pet', text: 'Stroke her back slowly', anchor: 'cat', from: 0, until: Infinity,
    ready: (c) => c.catsOut > 0 && c.t >= c.firstOutT + 4, done: (c) => c.pets > 0 },
  { id: 'treat', text: 'Hold your palm up, flat and still, for a treat', anchor: 'hand', from: 0, until: Infinity,
    ready: (c) => c.catsOut > 0 && (c.pets > 0 || c.t >= c.firstOutT + 20), done: (c) => c.handClimbs > 0 || c.hugs > 0 || c.eats > 0 },
  { id: 'carry', text: 'Pinch her scruff, lift her, toss her gently', anchor: 'cat', from: 0, until: Infinity,
    ready: (c) => c.catsOut > 0 && (c.hugs > 0 || c.eats > 0 || c.t >= c.firstOutT + 40), done: (c) => c.carries > 0 },
  { id: 'laser', text: 'Point your finger: she chases the dot', anchor: 'hand', from: 0, until: Infinity,
    ready: (c) => c.catsOut > 0 && (c.carries > 0 || c.t >= c.firstOutT + 55), done: (c) => c.catches > 0 || c.lasers > 90 },
  { id: 'sleepy', text: 'The kittens are getting sleepy', anchor: 'head', from: 0, until: Infinity, mood: true,
    ready: (c) => c.phase === 'wind', done: (c) => c.phase === 'nap' || c.phase === 'end' },
  { id: 'nap', text: 'Shh. Nap time.', anchor: 'head', from: 0, until: Infinity, mood: true,
    ready: (c) => c.phase === 'nap', done: (c) => c.phase === 'end' },
]);

/** Fresh hint state. */
export function createHintState() { return { current: null, since: null, shown: {}, firstOutT: null }; }

/**
 * One frame. c = { t (session seconds), phase, box: { landed, open }, ...progress counters }. Returns { state, hint, changed }:
 * hint = { id, text, anchor } or null; changed = true on show / hide / swap (the host redraws the card only then).
 */
export function hintStep(prev, c, tuning, list) {
  const T = tuning || HINT_TUNING, L = list || HINTS;
  const st = Object.assign({}, prev || createHintState(), { shown: Object.assign({}, (prev || {}).shown || {}) });
  if (st.firstOutT == null && c.catsOut > 0) st.firstOutT = c.t;
  const cc = Object.assign({}, c, { firstOutT: st.firstOutT == null ? Infinity : st.firstOutT });
  const byId = (id) => L.find((h) => h.id === id);
  const before = st.current;
  if (st.current) {
    const h = byId(st.current), rec = st.shown[st.current];
    const maxS = h.mood ? T.moodS : T.showS;
    if (!h || h.done(cc) || !h.ready(cc) || cc.t >= h.until || cc.t - st.since >= maxS) {
      st.shown[st.current] = Object.assign({}, rec, { lastEnd: cc.t });
      st.current = null; st.since = null;
    }
  }
  if (!st.current) {
    for (const h of L) {
      if (cc.t < h.from || cc.t >= h.until) continue;
      if (h.done(cc) || !h.ready(cc)) continue;
      const rec = st.shown[h.id] || { count: 0, lastEnd: -Infinity };
      if (rec.count >= (h.mood ? 1 : T.maxShows)) continue;
      if (cc.t - rec.lastEnd < T.restS) continue;
      st.current = h.id; st.since = cc.t;
      st.shown[h.id] = { count: rec.count + 1, lastEnd: rec.lastEnd };
      break;
    }
  }
  const h = st.current ? byId(st.current) : null;
  return { state: st, hint: h ? { id: h.id, text: h.text, anchor: h.anchor } : null, changed: before !== st.current };
}

/** Sound captions from the sim state (what a hearing player would hear). */
export function soundCues(state, prevState) {
  const cues = [];
  if (!state) return cues;
  const prevBy = {};
  for (const k of (prevState && prevState.cats) || []) prevBy[k.id] = k;
  let purr = 0, mew = 0, pounce = 0, bat = 0, poof = 0, eat = 0, thump = 0;
  for (const k of state.cats || []) {
    const p = prevBy[k.id];
    if (k.purr) purr++;
    if (k.pose === 'climb' && (!p || p.pose !== 'climb')) mew++;
    if (k.pose === 'pounce' && (!p || p.pose !== 'pounce')) pounce++;
    if (k.pose === 'bat' && (!p || p.pose !== 'bat')) bat++;
    if (k.poof && !(p && p.poof)) poof++;
    if (k.pose === 'eat' && (!p || p.pose !== 'eat')) eat++;
    if (p && p.airborne && !k.airborne && (p.mode === 'fly' || p.pose === 'twist') && k.support !== 'hand') thump++;
  }
  if (purr) cues.push(purr > 1 ? '(purring)' : '(purr)');
  if (mew) cues.push('(mew!)');
  if (pounce) cues.push('(pounce)');
  if (bat) cues.push('(swat)');
  if (poof) cues.push('(poof)');
  if (eat) cues.push('(nom nom)');
  if (thump) cues.push('(thump)');
  if (state.box && state.box.landed && !(prevState && prevState.box && prevState.box.landed)) cues.push('(thump)');
  return cues;
}

/** Fresh caption state. */
export function createCaptionState() { return { text: null, since: null, last: {} }; }

/**
 * Caption line for this frame: the newest cue, kept for captionMinS, the same cue not repeated within captionGapS.
 * Returns { state, caption (string | null), changed }.
 */
export function captionStep(prev, cues, t, tuning) {
  const T = tuning || HINT_TUNING;
  const st = Object.assign({}, prev || createCaptionState(), { last: Object.assign({}, (prev || {}).last || {}) });
  const before = st.text;
  if (st.text && t - st.since >= T.captionMinS) { st.text = null; st.since = null; }
  for (const cue of cues || []) {
    const lastT = st.last[cue];
    if (lastT != null && t - lastT < T.captionGapS) continue;
    if (st.text && t - st.since < T.captionMinS && st.text !== cue) continue; // the current caption keeps its minimum
    st.text = cue; st.since = t; st.last[cue] = t;
    break;
  }
  return { state: st, caption: st.text, changed: before !== st.text };
}

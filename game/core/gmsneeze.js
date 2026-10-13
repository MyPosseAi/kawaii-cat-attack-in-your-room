/* game/core/gmsneeze.js — Games Master SNEEZE scheduler + pre-sneeze notice gate (pure, deterministic). GE1, 2026-10-11.
   Spec: docs/GAMES-MASTER-PLAN.md §17.3 (wins over dev/impl/SK-125.md where they differ: owner 2026-10-10 item 2)
   + §17.6 (8 entry furs), design/batches/GM5-games-master/README.md "Photosensitivity", furs.json `frequency`.
   No DOM, no three, no file reads, no Math.random / Date: every random choice comes from a prng.js Prng owned here,
   so the same seed + the same moment stream replays bit-for-bit (hash()).

   What a sneeze is: "ah" (0 ms), "ah" (450 ms), ACHOO (900 ms), then the FUR crossfades to a NEW fur (only the fur + eyes
   change; the outfit never blends, that is the renderer's mask). Two plans:
   - calm (DEFAULT, Calm sneezes ON): exactly one step { fur: to, atMs: 900, fadeMs: 600 }, no in-between furs.
   - full: 2-3 in-between furs + the final fur at 1250, 1600, 1950(, 2300) ms, each fadeMs 350 (>= 350 ms apart, so at
     most 3 fur changes in any rolling 1 s; the ACHOO at 900 is 350 ms before the first change).
   Furs are free and random: there is NO API to choose a fur. The pick is weighted by `frequency` (furs.json: 6 / 3);
   `to !== from`, and no in-between equals its neighbour.

   Timing (all ms; the clock passed to step() is a monotonic session time in ms):
   - about one sneeze per 60 s of HOSTING: gap = 60 s +- seeded 10 s jitter, counted on a hosting clock that only runs while
     moment.hosting !== false, measured from the previous sneeze START (a sneeze that waited does not stack a second one);
   - none in the first 60 s (hosting time) after the host arrives (every arrival: hosting false -> true, and the first step);
   - >= 5 s between the end of one sneeze and the start of the next; <= 1 per round (moment.round, when it is a number);
   - allowed only when betweenRounds || idle || 0 <= sinceCelebrateMs <= 3000, and none of the blocked windows
     (countdown, last10s, rulesCaption, 0 <= scoreCardMs < 3000, restOffer, safety, sk99 / driving, suggestionTile,
     peekaboo, exit) and not while the notice is pending. Due while blocked -> wait for the next allowed step.

   Pre-sneeze notice (§17.3 /, owns the card and its words; this file only emits event names):
   - offerDone false: when the FIRST sneeze would start, `offer_show` is emitted instead (same allowed-moment rules) and the
     notice is pending; no sneeze while pending. answer(choice) ends it: 'full' or false -> full sneezes; 'calm', true or
     anything else -> calm (the safe default, like Enter / Esc on desktop). offerDone = true, the next sneeze is not before
     60 s (+ 0..10 s seeded) of hosting counted from the next step() after the answer, which also emits `offer_answer`.
   - offerDone true at creation: no notice ever.
   - forceCalm (desktop "Limit flashing"): calm forced, no notice (treated as answered), setCalm(false) / answer() ignored.

   Cut (re-review MUST 1 + 2, §17.3 "never during a countdown" + photosensitivity): if a blocked window opens (or hosting goes
   false) while a sneeze plays, it ends on that step() and starts NO new fur change: he stays on the fur already shown or
   already fading in = the fur of the last emitted sneeze_step (none emitted yet, e.g. before the ACHOO or between the ACHOO
   and the first full step = the old fur; calm after the ACHOO = its single step's fur, the target). A fade already running
   may finish. sneeze_end then carries { fur, cut: true, fadeMs: 0 }; the end fur can equal the start fur or an in-between.
   Losing the allowed moment alone (betweenRounds / idle / celebrate going false) does not cut: only blocked windows do.

   MOMENT (one plain object, same shape every frame; absent / null fields read as off):
     hosting (bool, the host is on stage; absent = true), round (number | null), betweenRounds, idle (bool),
     sinceCelebrateMs (ms since the last celebrate, -1 / null = none), scoreCardMs (ms since the score card appeared, -1 / null = none),
     countdown, last10s, rulesCaption, restOffer, safety, sk99, driving, suggestionTile, peekaboo, exit (bool blocked windows).

   API: createSneezer({ seed, furs = ENTRY_FURS, startFur = 'calico', calm = true, offerDone = false, forceCalm = false })
     -> { step(nowMs, moment) -> events, answer(choice) -> { calm } | null, setCalm(on) -> calm, state() -> {...}, hash() }
     (`tuning` = TESTS ONLY timing overrides, e.g. the 5 s minimum-gap test.)
     step() returns ONE reused array (cleared on every call): read it before the next call. Idle steps create no objects;
     event objects are only allocated when an event fires. Every event has one shape:
     { type, atMs, n, plan, fur, calm, fadeMs, cut }; types: 'offer_show', 'offer_answer', 'sneeze_ah' (n = 1 at 0 ms,
     n = 2 at 450 ms), 'sneeze' (the ACHOO at 900 ms), 'sneeze_step' (n = step index, fur + fadeMs: start this crossfade now),
     'sneeze_end' (fur = the fur he ends on; cut + fadeMs as above; fadeMs is always 0 = no new change). The renderer starts
     each crossfade on its sneeze_step event, so a cut on the same step() stops the rest. A long frame can emit SEVERAL
     sneeze_step events in one call: the renderer must schedule each at its atMs (start = atMs, length = fadeMs; one already
     in the past starts late, but never earlier than 350 ms after the previous one started), not play them all instantly. plan = { from, to, calm, startMs, endMs, steps: [{ fur, atMs, fadeMs }] },
     atMs relative to startMs.
   planSneeze(prng, fromFur, furs, calm) -> plan (startMs 0); sneezeAllowed(moment) (start rules); sneezeBlocked(moment).
   Build rule: only `export function` / `export const`; private names carry the `gs` prefix. */
import { createPrng, createHasher } from './prng.js';

export const GM_SNEEZE = Object.freeze({
  gapMs: 60000,           // about one sneeze per 60 s of hosting ...
  jitterMs: 10000,        // ... +- this (seeded)
  arriveMs: 60000,        // none in the first 60 s (hosting) after the host arrives
  minGapMs: 5000,         // >= 5 s from the end of one sneeze to the start of the next
  afterAnswerMs: 60000,   // the first sneeze after the notice answer: not before this (+ 0..jitterMs)
  celebrateMs: 3000,      // allowed right after a celebrate, up to this
  scoreCardMs: 3000,      // blocked during the first 3 s of a score card
  ahMs: Object.freeze([0, 450]),
  achooMs: 900,
  fullStepsMs: Object.freeze([1250, 1600, 1950, 2300]),
  fullFadeMs: 350,
  calmAtMs: 900,
  calmFadeMs: 600,
  minBetween: 2,          // in-between furs (full)
  maxBetween: 3,
});

/** The 8 entry furs (§17.6) with furs.json `frequency` (real 6, impossible 3). A constant: nothing is read at runtime. */
export const ENTRY_FURS = Object.freeze([
  Object.freeze({ id: 'calico', frequency: 6 }),
  Object.freeze({ id: 'bengal', frequency: 6 }),
  Object.freeze({ id: 'marble', frequency: 6 }),
  Object.freeze({ id: 'mau', frequency: 6 }),
  Object.freeze({ id: 'polka', frequency: 3 }),
  Object.freeze({ id: 'stars', frequency: 3 }),
  Object.freeze({ id: 'splat', frequency: 3 }),
  Object.freeze({ id: 'glass', frequency: 3 }),
]);

export const SNEEZE_EVENTS = Object.freeze(['offer_show', 'offer_answer', 'sneeze_ah', 'sneeze', 'sneeze_step', 'sneeze_end']);

/** fur list -> { ids, w } (validated: >= 3 unique ids, finite frequency > 0). */
function gsTable(furs) {
  if (!Array.isArray(furs) || furs.length < 3) throw new RangeError('gmsneeze: at least 3 furs required');
  const ids = [], w = [];
  for (const f of furs) {
    if (!f || typeof f.id !== 'string' || !f.id) throw new TypeError('gmsneeze: each fur needs a string id');
    if (typeof f.frequency !== 'number' || !Number.isFinite(f.frequency) || f.frequency <= 0) throw new RangeError('gmsneeze: fur ' + f.id + ' needs frequency > 0');
    if (ids.indexOf(f.id) !== -1) throw new RangeError('gmsneeze: duplicate fur ' + f.id);
    ids.push(f.id); w.push(f.frequency);
  }
  return { ids, w };
}

/** weighted index, skipping indexes exA / exB (-1 = none). No allocation. */
function gsPick(prng, w, exA, exB) {
  let sum = 0;
  for (let i = 0; i < w.length; i++) if (i !== exA && i !== exB) sum += w[i];
  let r = prng.next() * sum, last = -1;
  for (let i = 0; i < w.length; i++) {
    if (i === exA || i === exB) continue;
    last = i; r -= w[i];
    if (r < 0) return i;
  }
  return last;
}

function gsPlan(prng, tab, fromIdx, calm) {
  const K = GM_SNEEZE, ids = tab.ids;
  const toIdx = gsPick(prng, tab.w, fromIdx, -1);
  const steps = [];
  if (calm) {
    steps.push({ fur: ids[toIdx], atMs: K.calmAtMs, fadeMs: K.calmFadeMs });
  } else {
    const n = K.minBetween + prng.int(K.maxBetween - K.minBetween + 1);
    let prev = fromIdx;
    for (let i = 0; i < n; i++) {
      const b = gsPick(prng, tab.w, prev, i === n - 1 ? toIdx : -1);
      steps.push({ fur: ids[b], atMs: K.fullStepsMs[i], fadeMs: K.fullFadeMs });
      prev = b;
    }
    steps.push({ fur: ids[toIdx], atMs: K.fullStepsMs[n], fadeMs: K.fullFadeMs });
  }
  const lastStep = steps[steps.length - 1];
  return { from: ids[fromIdx], to: ids[toIdx], toIdx, calm: !!calm, startMs: 0, endMs: lastStep.atMs + lastStep.fadeMs, steps };
}

/** One sneeze plan from `fromFur` (pure; advances prng). The target fur is random (weighted), never chosen. */
export function planSneeze(prng, fromFur, furs = ENTRY_FURS, calm = true) {
  const tab = gsTable(furs);
  const fromIdx = tab.ids.indexOf(fromFur);
  if (fromIdx < 0) throw new RangeError('gmsneeze: fromFur not in the fur list');
  const p = gsPlan(prng, tab, fromIdx, calm);
  return { from: p.from, to: p.to, calm: p.calm, startMs: 0, endMs: p.endMs, steps: p.steps };
}

/** A blocked window is open (any of them). The sneezer also treats `hosting === false` as blocked mid-sneeze. */
export function sneezeBlocked(m) {
  const sc = m.scoreCardMs;
  if (m.countdown === true || m.last10s === true || m.rulesCaption === true || m.restOffer === true || m.safety === true
    || m.sk99 === true || m.driving === true || m.suggestionTile === true || m.peekaboo === true || m.exit === true) return true;
  return sc != null && sc >= 0 && sc < GM_SNEEZE.scoreCardMs;
}

/** The start rules (an allowed moment AND no blocked window). The notice-pending block is the sneezer's own state. */
export function sneezeAllowed(m) {
  const cel = m.sinceCelebrateMs;
  const ok = m.betweenRounds === true || m.idle === true || (cel != null && cel >= 0 && cel <= GM_SNEEZE.celebrateMs);
  return ok && !sneezeBlocked(m);
}

function gsEv(type, atMs, n, plan, fur, calm, fadeMs, cut) { return { type, atMs, n, plan, fur, calm, fadeMs, cut }; }

const GS_TUNING_KEYS = ['gapMs', 'jitterMs', 'arriveMs', 'minGapMs', 'afterAnswerMs'];

export function createSneezer(opts = {}) {
  const o = opts || {};
  let K = GM_SNEEZE;
  if (o.tuning) { // TESTS ONLY (the 5 s guard test): timing overrides; shipped code never passes this
    const t = Object.assign({}, GM_SNEEZE);
    for (const k of GS_TUNING_KEYS) if (typeof o.tuning[k] === 'number' && o.tuning[k] >= 0) t[k] = o.tuning[k];
    if (t.minGapMs < GM_SNEEZE.minGapMs) t.minGapMs = GM_SNEEZE.minGapMs;                 // the 5 s floor is never tunable
    if (!(t.jitterMs < t.gapMs - t.minGapMs)) throw new RangeError('createSneezer: tuning needs jitterMs < gapMs - minGapMs');
    K = Object.freeze(t);
  }
  if (typeof o.seed !== 'number' || !Number.isFinite(o.seed)) throw new TypeError('createSneezer: numeric seed required');
  const tab = gsTable(o.furs === undefined ? ENTRY_FURS : o.furs);
  const startFur = o.startFur === undefined ? 'calico' : o.startFur;
  let furIdx = tab.ids.indexOf(startFur);
  if (furIdx < 0) throw new RangeError('createSneezer: startFur not in the fur list');
  const forceCalm = o.forceCalm === true;
  let calm = forceCalm ? true : o.calm !== false;
  let offerDone = forceCalm || o.offerDone === true;
  let offerPending = false;
  const prng = createPrng(o.seed);
  const jitter = () => (prng.next() * 2 - 1) * K.jitterMs;

  let lastT = NaN, wasHosting = false;
  let hostMs = 0, sinceArrive = 0;
  let nextDue = K.gapMs + jitter();
  let lastEndT = -Infinity, lastRound = NaN, sneezes = 0, offers = 0, cuts = 0;
  let playing = false, plan = null, playStart = 0, phase = 0, stepIdx = 0;
  let pendingAnswer = null, answerJitter = 0;
  const ev = [];

  function gsStart(t, m) {
    plan = gsPlan(prng, tab, furIdx, calm);
    plan.startMs = t;
    playing = true; playStart = t; phase = 0; stepIdx = 0; sneezes++;
    if (typeof m.round === 'number') lastRound = m.round;
    nextDue = hostMs + K.gapMs + jitter();
  }

  function gsFinish(t, fur, fadeMs, cut) {
    lastEndT = t;
    ev.push(gsEv('sneeze_end', t, 0, plan, fur, plan.calm, fadeMs, cut));
    playing = false; plan = null; phase = 0; stepIdx = 0;
  }

  function gsAdvance(t, blocked) {
    const e = t - playStart;
    if (blocked) { // MUST (re-review): a blocked window / host away cuts the sneeze NOW
      cuts++;
      // photosensitivity (re-review 2 MUST 2): a cut starts NO new fur change. He ends on the fur already shown or already
      // fading in = the last emitted step's fur (none emitted yet = the old fur); a fade already running may finish.
      if (stepIdx > 0) furIdx = tab.ids.indexOf(plan.steps[stepIdx - 1].fur);
      gsFinish(t, tab.ids[furIdx], 0, true);
      return;
    }
    if (phase === 0) { ev.push(gsEv('sneeze_ah', playStart + K.ahMs[0], 1, plan, null, plan.calm, 0, false)); phase = 1; }
    if (phase === 1 && e >= K.ahMs[1]) { ev.push(gsEv('sneeze_ah', playStart + K.ahMs[1], 2, plan, null, plan.calm, 0, false)); phase = 2; }
    if (phase === 2 && e >= K.achooMs) { ev.push(gsEv('sneeze', playStart + K.achooMs, 0, plan, null, plan.calm, 0, false)); phase = 3; }
    if (phase === 3) {
      const steps = plan.steps;
      while (stepIdx < steps.length && e >= steps[stepIdx].atMs) {
        const st = steps[stepIdx];
        ev.push(gsEv('sneeze_step', playStart + st.atMs, stepIdx, plan, st.fur, plan.calm, st.fadeMs, false));
        stepIdx++;
      }
      if (stepIdx === steps.length && e >= plan.endMs) { furIdx = plan.toIdx; gsFinish(playStart + plan.endMs, plan.to, 0, false); }
    }
  }

  function step(nowMs, m) {
    ev.length = 0;
    const t = +nowMs;
    if (!Number.isFinite(t)) throw new TypeError('sneezer.step: finite nowMs required');
    if (!m || typeof m !== 'object') throw new TypeError('sneezer.step: moment object required');
    let dt = lastT === lastT ? t - lastT : 0;
    if (dt < 0) dt = 0;
    lastT = t;
    const hosting = m.hosting !== false;
    if (hosting) {
      if (!wasHosting) sinceArrive = 0;
      else { hostMs += dt; sinceArrive += dt; }
    }
    wasHosting = hosting;
    if (pendingAnswer !== null) {
      pendingAnswer.atMs = t; ev.push(pendingAnswer); pendingAnswer = null;
      nextDue = hostMs + K.afterAnswerMs + answerJitter;
    }
    if (playing) gsAdvance(t, !hosting || sneezeBlocked(m));
    if (!playing && hosting && !offerPending && hostMs >= nextDue && sinceArrive >= K.arriveMs
      && t - lastEndT >= K.minGapMs && !(typeof m.round === 'number' && m.round === lastRound) && sneezeAllowed(m)) {
      if (!offerDone) { offerPending = true; offers++; ev.push(gsEv('offer_show', t, 0, null, null, calm, 0, false)); }
      else { gsStart(t, m); gsAdvance(t, false); }
    }
    return ev;
  }

  /** Notice answer: 'full' | false -> full sneezes; 'calm' | true | anything else -> calm. null when no notice is pending. */
  function answer(choice) {
    if (!offerPending) return null;
    calm = !(choice === 'full' || choice === false);
    offerPending = false; offerDone = true;
    // the 60 s run from the NEXT step() (answer() has no clock): nextDue is set there, never early
    answerJitter = prng.next() * K.jitterMs;
    pendingAnswer = gsEv('offer_answer', 0, 0, null, null, calm, 0, false);
    nextDue = Infinity;
    return { calm };
  }

  /** Settings > Accessibility > Calm sneezes. Ignored (stays calm) under forceCalm. Applies from the next sneeze. */
  function setCalm(on) { if (!forceCalm) calm = !!on; return calm; }

  function state() {
    return { fur: tab.ids[furIdx], calm, forceCalm, offerDone, offerPending, playing, sneezes, offers, cuts,
      hostMs, sinceArriveMs: sinceArrive, nextDueHostMs: nextDue, lastRound: lastRound === lastRound ? lastRound : null };
  }

  function hash(hasher) {
    const h = hasher || createHasher();
    const s = prng.getState();
    const fin = (x) => (Number.isFinite(x) ? x / 1000 : -1);
    h.num(s & 0xffff).num(s >>> 16).str(tab.ids[furIdx]).num(fin(nextDue)).num(hostMs / 1000).num(sinceArrive / 1000)
      .num(lastRound === lastRound ? lastRound : -1).num(sneezes).num(offers).num(cuts)
      .num(offerPending ? 1 : 0).num(offerDone ? 1 : 0).num(calm ? 1 : 0).num(playing ? 1 : 0).num(phase).num(stepIdx)
      .num(playing ? playStart / 1000 : -1).str(playing ? plan.to : '-').num(pendingAnswer !== null ? 1 : 0).num(answerJitter / 1000)
      .num(fin(lastEndT)).num(fin(lastT)).num(wasHosting ? 1 : 0);
    return hasher ? h : h.digest();
  }

  return { step, answer, setCalm, state, hash };
}

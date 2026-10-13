/* vr/src/ports/yarn-tug.js - SK-PORT pick 2 (GE3, 2026-10-11): YARN TUG in the headset, you vs a kitten. PURE wrapper: the
   rules are game/core/yarntug.js (mode #4) IMPORTED UNCHANGED (no copy): hold to pull (drains puff), tap in rhythm
   (350-800 ms after the previous tap) for a burst, mashing faster than 250 ms = a 400 ms paw slip; the pompom past your line
   wins the round, else the side it is on at 20 s; best of 3. The kitten is the core's own seeded AI (aiExtras), plus a
   seeded "look around" rest so a kitten is beatable (kittenEffort 0..1; 1 = the desktop AI unchanged).
   No DOM, no three, no IWSDK, no Math.random / Date. Fixed 60 Hz sub-steps (loop.js STEP_MS) so any frame rate (Quest 72 /
   90 / 120 Hz) gives the same result for the same input timeline; at most maxSteps per call (a stall is dropped, not replayed).
   API
     const tug = createYarnTug({ seed, kittenId?, kittenEffort?, tuning? })   tuning = createYarnTug options (rounds, roundMs, ...)
     tug.step(dtMs, youDown) -> tug.out   youDown = trigger held (controller) or pinch held (hand); events of this call
     tug.stats  { m: -1 (kitten) .. +1 (you), round, you, kitten, puff (your stamina 0..1), roundMsLeft, inBreak, winner, done }
   Events out (from the core, ids mapped): { type: 'round_start', round }, { type: 'tap', who, rhythm }, { type: 'slip', who },
     { type: 'round_win', who: 'you' | 'kitten' | 'tie', round }, { type: 'win', who: 'you' | 'kitten' | 'draw' }.
   Glue (HUD lane): HUD action id `tug` starts a new tug (create a fresh one; Back / the action again = drop it). Stats
   `tugPos` = stats.m, `tugRound`, `tugScore` = `${you} : ${kitten}`, `tugPuff`. Haptics: { tap, who:'you', rhythm:true } =
   a light tick, slip = a short buzz. Call step() once per rendered frame with the trigger / pinch state of the hand that
   started the tug. Allocation: the WRAPPER allocates nothing per frame (only on events it re-emits); the CORE (game/core/
   yarntug.js: cats.find closures, the pullOf closure, `acts[id] || {}`, event objects) allocates per sub-step, ~35 GCs per
   200k frames. Review PORT1 SHOULD 1: yarntug.js is left UNCHANGED here (shared core, Gaming Engineer owned); FOLLOW-UP for
   the Fable lane: make yarntug.js step() allocation-free (hash-neutral), then tighten ports-yarn-tug.test.mjs's GC test to <= 2.
   That test pins wrapper GCs <= the bare core's + 2 so the wrapper itself stays clean. */
import { createYarnTug as coreYarnTug } from '../../../game/core/yarntug.js';
import { createPrng } from '../../../game/core/prng.js';
import { STEP_MS } from '../../../game/core/loop.js';

export const YARN_TUG_VR = Object.freeze({ kittenEffort: 0.8, restMinMs: 500, restMaxMs: 900, busyMinMs: 1500, busyMaxMs: 4500, maxSteps: 6 });

export function createYarnTug({ seed = 1, kittenId = 'kitten', kittenEffort = YARN_TUG_VR.kittenEffort, tuning = {} } = {}) {
  const prng = createPrng(seed), mask = createPrng((seed ^ 0x5bd1e995) >>> 0);
  const core = coreYarnTug({ width: 0 }, prng, tuning);
  const roundMs = Number.isFinite(tuning.roundMs) ? tuning.roundMs : 20000; // = the core's default
  const you = { id: 'you', body: { x: 0, vx: 0 }, side: 1 }, kit = { id: kittenId, body: { x: 0, vx: 0 }, side: -1 };
  const cats = [you, kit];
  const youAct = { interact: 0 }, kitAct = { interact: 0 };
  const acts = { you: youAct, [kittenId]: kitAct };
  const effort = Math.max(0, Math.min(1, Number.isFinite(kittenEffort) ? kittenEffort : YARN_TUG_VR.kittenEffort));
  let acc = 0, restLeft = 0, busyLeft = nextBusy();
  const out = [];
  const stats = { m: 0, round: 1, you: 0, kitten: 0, puff: 1, roundMsLeft: 0, inBreak: false, winner: null, done: false };
  const who = (id) => (id === 'you' ? 'you' : id === kittenId ? 'kitten' : id);
  function nextBusy() { return (YARN_TUG_VR.busyMinMs + mask.next() * (YARN_TUG_VR.busyMaxMs - YARN_TUG_VR.busyMinMs)) * (0.5 + effort); }
  const tug = {
    out, stats, core,
    step(dtMs, youDown) {
      out.length = 0;
      if (core.winner) return out;
      acc += dtMs > 0 ? dtMs : 0;
      let n = 0;
      while (acc >= STEP_MS && n < YARN_TUG_VR.maxSteps) {
        acc -= STEP_MS; n++;
        youAct.interact = youDown ? 1 : 0;
        core.aiExtras(kit, kitAct); // the desktop AI (seeded period, slips, puff rests)
        if (effort < 1) { // the VR kitten looks around now and then (seeded): a beatable kitten
          if (restLeft > 0) { restLeft -= STEP_MS; kitAct.interact = 0; }
          else if ((busyLeft -= STEP_MS) <= 0) { restLeft = YARN_TUG_VR.restMinMs + mask.next() * (YARN_TUG_VR.restMaxMs - YARN_TUG_VR.restMinMs); busyLeft = nextBusy(); kitAct.interact = 0; }
        }
        core.step(cats, STEP_MS, acts);
        for (let i = 0; i < core.events.length; i++) {
          const e = core.events[i];
          if (e.type === 'round_start') out.push({ type: 'round_start', round: e.round });
          else if (e.type === 'tap') out.push({ type: 'tap', who: who(e.cat), rhythm: e.rhythm });
          else if (e.type === 'slip') out.push({ type: 'slip', who: who(e.cat) });
          else if (e.type === 'round_win') out.push({ type: 'round_win', who: e.cat === 'tie' ? 'tie' : who(e.cat), round: e.round });
          else if (e.type === 'win') out.push({ type: 'win', who: e.cat === 'draw' ? 'draw' : who(e.cat) });
        }
        if (core.winner) break;
      }
      if (n === YARN_TUG_VR.maxSteps && acc >= STEP_MS) acc = 0; // stall: drop, never spiral
      // core m < 0 = toward the LEFT cat = you; the HUD wants + = toward you
      stats.m = 0 - core.m; stats.round = core.round; stats.you = core.score.you || 0; stats.kitten = core.score[kittenId] || 0;
      stats.puff = core.status(you).puff; stats.roundMsLeft = core.breakLeft > 0 ? roundMs : Math.max(0, roundMs - core.roundMs); // PORT1 NIT 1: the break shows the next full round
      stats.inBreak = core.breakLeft > 0; stats.winner = core.winner ? (core.winner === 'draw' ? 'draw' : who(core.winner)) : null; stats.done = !!core.winner;
      return out;
    },
  };
  return tug;
}

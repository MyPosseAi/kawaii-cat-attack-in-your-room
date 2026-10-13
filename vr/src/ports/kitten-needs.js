/* vr/src/ports/kitten-needs.js - SK-PORT pick 3 (GE3, 2026-10-11): KITTEN NEEDS, the desktop life-cycle needs
   (game/core/lifecycle.js NEEDS + NEED_RATES, spec 1: needs drift up over time, activities reset them) as HUD stats.
   PURE: no DOM, no three, no IWSDK, no Math.random / Date. Four needs per kitten, 0 (content) .. 100 (wants it now):
     hunger (lifecycle hunger)  -> lowered by a treat eaten (roomcat 'eat')             HUD action `treat`
     play   (lifecycle play)    -> lowered by pounce / catch / near miss / big leap / happy toss landing   HUD action `laser` (or `feather`)
     cuddle (lifecycle social)  -> lowered by strokes (roomcat 'purr') and hand climbs  HUD action `pet`
     sleepy (lifecycle energy)  -> rises with play, falls while the kitten naps (pose 'nap')   hint "let them nap"
   Rates = NEED_RATES (per hour on the desktop) x timeScale (default 12: a 10-minute visit shows the drift a 2-hour desktop
   day would). Start values are seeded (20..45) so kittens differ. A hard toss (roomcat 'land' hard / 'wander_off') raises cuddle.
   API
     const kn = createKittenNeeds({ ids: ['mochi', ...], names?: { mochi: 'Mochi' }, seed?, timeScale? })
     kn.step(dtMs, roomEvents, cats)   roomEvents = session.events of this frame (or null); cats = session.cats (reads id, pose)
     kn.view(id) -> { id, name, hunger, play, cuddle, sleepy, top, action }   ONE object per kitten, updated in place (no alloc)
     kn.hint()   -> { id, name, need, value, action, text } or null when nobody needs anything (all < hintAt); one object reused
     kn.state()  -> plain snapshot (tests / debug)
   Glue (HUD lane): stat `needs` = kn.view(id of the kitten the player looks at, else the nearest) drawn as 4 small bars;
   stat `needsHint` = kn.hint().text under the stats row, and highlight the menu entry kn.hint().action. step() once per
   rendered frame after the session step (or 4 Hz with the summed dtMs and every frame's events: about the same values;
   clamp order and nap sampling differ slightly). Per-frame path allocates nothing (Review PORT1 MUST 2): named fields, index
   loops, effect tables normalised to all 4 fields, hint texts built once per kitten; ports-kitten-needs.test.mjs pins
   200k frames at <= 2 GCs (--expose-gc). Kittens in the box / carried / on a hand (cats[i].mode 'inbox' | 'carried' |
   'onhand', read in step) are never named by hint() (PORT1 SHOULD 2); until step() sees a kitten's mode it counts as out. */
import { NEED_RATES } from '../../../game/core/lifecycle.js';
import { createPrng } from '../../../game/core/prng.js';

export const KITTEN_NEEDS = Object.freeze({
  timeScale: 12, hintAt: 60, startMin: 20, startMax: 45, napPerMin: 60,
  eat: { hunger: -60, cuddle: -5 }, purr: { cuddle: -12 }, climb: { cuddle: -8 },
  catch: { play: -22, sleepy: 4 }, pounce: { play: -8, sleepy: 3 }, nearMiss: { play: -6 }, bigLeap: { play: -12, sleepy: 5 },
  landHappy: { play: -6 }, landHard: { cuddle: 8 }, wanderOff: { cuddle: 15 },
});
const KN_ACTION = { hunger: 'treat', play: 'laser', cuddle: 'pet', sleepy: 'rest' };
const KN_TEXT = { hunger: 'is hungry: try Treat', play: 'wants to play: try Laser', cuddle: 'wants a cuddle: try Pet', sleepy: 'is sleepy: let them nap' };
const KN_FX_NAMES = ['eat', 'purr', 'climb', 'catch', 'pounce', 'nearMiss', 'bigLeap', 'landHappy', 'landHard', 'wanderOff'];

export function createKittenNeeds({ ids = [], names = {}, seed = 1, timeScale = KITTEN_NEEDS.timeScale, tuning = {} } = {}) {
  const T = { ...KITTEN_NEEDS, ...tuning };
  // every effect as a full { hunger, play, cuddle, sleepy } record (no for-in / keyed stores on the event path)
  const FX = {};
  for (const n of KN_FX_NAMES) { const f = T[n] || {}; FX[n] = Object.freeze({ hunger: +f.hunger || 0, play: +f.play || 0, cuddle: +f.cuddle || 0, sleepy: +f.sleepy || 0 }); }
  const prng = createPrng(seed);
  const views = new Map();
  const list = [];
  for (const id of ids) {
    const name = names[id] || id;
    const v = { id, name, hunger: 0.5, play: 0.5, cuddle: 0.5, sleepy: 0.5, top: 'hunger', action: 'treat', out: true,
      texts: { hunger: name + ' ' + KN_TEXT.hunger, play: name + ' ' + KN_TEXT.play, cuddle: name + ' ' + KN_TEXT.cuddle, sleepy: name + ' ' + KN_TEXT.sleepy } };
    v.hunger = start(); v.play = start(); v.cuddle = start(); v.sleepy = start();
    views.set(id, v); list.push(v); pickTop(v);
  }
  function start() { return T.startMin + prng.next() * (T.startMax - T.startMin); }
  const hintObj = { id: '', name: '', need: '', value: 0.5, action: '', text: '' };
  const pH = (NEED_RATES.hunger * timeScale) / 3600000, pP = (NEED_RATES.play * timeScale) / 3600000;
  const pC = (NEED_RATES.social * timeScale) / 3600000, pS = (NEED_RATES.energy * timeScale) / 3600000;
  const napPerMs = T.napPerMin / 60000;
  function add(v, f) { v.hunger = clamp100(v.hunger + f.hunger); v.play = clamp100(v.play + f.play); v.cuddle = clamp100(v.cuddle + f.cuddle); v.sleepy = clamp100(v.sleepy + f.sleepy); }
  function pickTop(v) {
    let top = 'hunger', val = v.hunger;
    if (v.play > val) { top = 'play'; val = v.play; }
    if (v.cuddle > val) { top = 'cuddle'; val = v.cuddle; }
    if (v.sleepy > val) { top = 'sleepy'; }
    v.top = top; v.action = KN_ACTION[top];
  }
  function topVal(v) { return v.top === 'hunger' ? v.hunger : v.top === 'play' ? v.play : v.top === 'cuddle' ? v.cuddle : v.sleepy; }
  const kn = {
    step(dtMs, roomEvents, cats) {
      const dt = dtMs > 0 ? dtMs : 0;
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        v.hunger = clamp100(v.hunger + pH * dt); v.play = clamp100(v.play + pP * dt); v.cuddle = clamp100(v.cuddle + pC * dt); v.sleepy = clamp100(v.sleepy + pS * dt);
      }
      if (cats) for (let i = 0; i < cats.length; i++) {
        const c = cats[i], v = views.get(c.id); if (!v) continue;
        v.out = !(c.mode === 'inbox' || c.mode === 'carried' || c.mode === 'onhand');
        if (c.pose === 'nap') v.sleepy = clamp100(v.sleepy - napPerMs * dt - pS * dt);
      }
      if (roomEvents) for (let i = 0; i < roomEvents.length; i++) {
        const e = roomEvents[i], v = e.cat != null ? views.get(e.cat) : null;
        if (!v) continue;
        switch (e.type) {
          case 'eat': add(v, FX.eat); break;
          case 'purr': add(v, FX.purr); break;
          case 'hand_climb': add(v, FX.climb); break;
          case 'catch': add(v, FX.catch); break;
          case 'pounce': if (!e.catch) add(v, FX.pounce); break; // a catching pounce is counted once, by 'catch'
          case 'near_miss': add(v, FX.nearMiss); break;
          case 'big_leap': add(v, FX.bigLeap); break;
          case 'land': if (e.from === 'toss') { if (e.hard) add(v, FX.landHard); else if (e.happy) add(v, FX.landHappy); } break;
          case 'wander_off': add(v, FX.wanderOff); break;
          default: break;
        }
      }
      for (let i = 0; i < list.length; i++) pickTop(list[i]);
    },
    view(id) { return views.get(id) || null; },
    /** the neediest kitten that is out, or null; ONE reused object, its text is a per-kitten string built at creation */
    hint() {
      let best = null, bv = -1;
      for (let i = 0; i < list.length; i++) { const v = list[i]; if (!v.out) continue; const x = topVal(v); if (x >= T.hintAt && x > bv) { best = v; bv = x; } }
      if (!best) return null;
      hintObj.value = bv;
      if (hintObj.id !== best.id || hintObj.need !== best.top) {
        hintObj.id = best.id; hintObj.name = best.name; hintObj.need = best.top; hintObj.action = best.action; hintObj.text = best.texts[best.top];
      }
      return hintObj;
    },
    state() { return list.map((v) => ({ id: v.id, hunger: v.hunger, play: v.play, cuddle: v.cuddle, sleepy: v.sleepy, top: v.top })); },
  };
  return kn;
}
function clamp100(x) { return x < 0 ? 0 : x > 100 ? 100 : x; }

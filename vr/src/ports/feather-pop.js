/* vr/src/ports/feather-pop.js - SK-PORT pick 1 (GE3, 2026-10-11): FEATHER POP, the desktop FEATHER DUEL
   (game/core/feather.js, mode #2) re-done for the real room. PURE: no DOM, no three, no IWSDK, no Math.random / Date.
   A feather pops up at a seeded LEGAL spot (room.js roomNearestLegal: floor, rug, couch seat, low table) 0.6-1.6 m in front
   of the player; the kittens chase it because the glue pushes it into the roomcat session as the laser dot (roomcat already
   does stalk -> crouch TELL -> pounce -> catch). The player SNATCHES it with a ray hit (controller ray + trigger, or hand
   pinch ray; never a floor reach: comfort): only when a kitten is close (closeM) = 1 point, during a kitten's pounce tell
   (perfectMs after roomcat's { type: 'tell', kind: 'pounce' }) = 2 points ("perfect steal"); with no kitten close it is
   "too early": the feather teases away (no point; desktop's false start). A kitten catch (roomcat 'catch') = kittens' point.
   A feather nobody gets hides after upMs. First to `target` or `roundMs` (time-up: more points wins, tie = draw).
   API
     const fp = createFeatherPop({ room, seed, tuning? });
     fp.start(head)                       head = { x, z, fx, fz } (flat forward); pops the first feather after a short hide
     fp.step(dtMs, head, roomEvents, cats, snatch) -> fp.out (this call's events; the SAME array, cleared each call)
        roomEvents = session.events of this frame (array or null), cats = session.cats (reads id, x, z only),
        snatch = null, or { p: { x, y, z } } on the FRAME the trigger / pinch went down (the ray hit point; roomRaycast)
     fp.stop()                            ends the round now (no winner); if a feather was up, the NEXT step() call (even
                                          inactive) sets fp.roomEvent = { type: 'laser', on: false } once (start() over a live
                                          feather does the same). Call step() EVERY frame, active or not, and read roomEvent after it.
     fp.roomEvent                         null, or the event to session.push() THIS frame (set by step() on pop / hide / a pending
                                          off only; the glue pushes it once and must not send its own laser while fp.active)
     fp.stats                             { active, you, kittens, timeLeftMs, up, feather: { x, y, z, surf }, winner } (one object, updated in place)
   Events out: { type: 'feather_up', x, y, z, surf }, { type: 'feather_down', why: 'timeout' | 'kitten' | 'player' | 'tease' },
     { type: 'point', who: 'you' | 'kittens', n, perfect?, cat? }, { type: 'too_early' }, { type: 'round_end', winner, you, kittens }.
   Glue (HUD lane): HUD action id `feather` toggles start / stop; stats `featherScore` = `${you} : ${kittens}`, `featherTimeLeft`.
   Call step() once per rendered frame AFTER session.step / the fixed loop (so roomEvents are this frame's). Per-frame path
   allocates nothing unless an event fires (pop / hide / point are a few per 10 s): timers live in one state object S, the
   laser-off event is one shared frozen object; ports-feather-pop.test.mjs pins 200k frames at <= 2 GCs (--expose-gc).
   Kittens in the box / carried / on a hand (cats[i].mode 'inbox' | 'carried' | 'onhand') never count as "close".
   Not hashed into roomcat: the laser events it pushes ARE logged by the session, so a roomcat replay stays exact. */
import { createPrng } from '../../../game/core/prng.js';
import { roomNearestLegal } from '../../../game/core/room.js';

export const FEATHER_POP_TUNING = Object.freeze({
  target: 5, roundMs: 60000,
  hideMsMin: 1200, hideMsMax: 3000, firstHideMs: 1500, upMs: 7000, teaseHideMs: 500,
  ringMin: 0.6, ringMax: 1.6, latMax: 0.7, spotY: 1.0, minHopM: 0.45, tries: 6,
  snatchR: 0.18, closeM: 0.5, perfectMs: 600,
});

const FP_LASER_OFF = Object.freeze({ type: 'laser', on: false }); // shared, read-only: roomcat only reads ev.on / ev.p

export function createFeatherPop({ room, seed = 1, tuning = {} } = {}) {
  const T = { ...FEATHER_POP_TUNING, ...tuning };
  const prng = createPrng(seed);
  const out = [];
  const feather = { x: 0, y: 0, z: 0, surf: null };
  const stats = { active: false, you: 0, kittens: 0, timeLeftMs: T.roundMs + 0.5, up: false, feather, winner: null };
  stats.timeLeftMs = T.roundMs; // (+ 0.5 above, then reset: the field starts as a double, so V8 never changes its shape per frame)
  // timers live in ONE object (Review PORT1 MUST 2: closure-captured doubles are re-boxed on every write = per-frame garbage)
  const S = { elapsed: 0.5, msLeft: 0.5, lastTellMs: -1e9 - 0.5, popped: false, pendingOff: false };
  S.elapsed = 0; S.msLeft = 0; S.lastTellMs = -1e9; // (same trick: double fields from the start)
  const fp = {
    out, stats, roomEvent: null, tuning: T,
    start(head) {
      if (stats.up) S.pendingOff = true; // a restart while a feather is up: the session must drop the old dot (PORT1 MUST 1)
      stats.active = true; stats.you = 0; stats.kittens = 0; stats.winner = null; stats.up = false; stats.timeLeftMs = T.roundMs;
      S.elapsed = 0; S.msLeft = T.firstHideMs; S.lastTellMs = -1e9; S.popped = false; out.length = 0;
      void head;
    },
    stop() {
      if (!stats.active) return;
      stats.active = false;
      if (stats.up) { stats.up = false; S.pendingOff = true; } // handed over by the NEXT step() (PORT1 MUST 1), even though inactive
    },
    step(dtMs, head, roomEvents, cats, snatch) {
      out.length = 0; fp.roomEvent = null;
      if (S.pendingOff) { S.pendingOff = false; fp.roomEvent = FP_LASER_OFF; } // a pop below in this same call replaces it (on wins)
      if (!stats.active) return out;
      const dt = dtMs > 0 ? Math.min(dtMs, 100) : 0;
      S.elapsed += dt; stats.timeLeftMs = Math.max(0, T.roundMs - S.elapsed);
      // 1. what the kittens did this frame (catch while up = their point; a pounce tell opens the perfect window)
      if (roomEvents) for (let i = 0; i < roomEvents.length; i++) {
        const e = roomEvents[i];
        if (e.type === 'tell' && e.kind === 'pounce') S.lastTellMs = S.elapsed;
        else if (e.type === 'catch' && stats.up) { stats.kittens++; out.push({ type: 'point', who: 'kittens', n: 1, cat: e.cat }); hide('kitten'); }
      }
      // 2. the player's snatch (edge only; ray hit point)
      if (snatch && snatch.p && stats.up) {
        const dx = snatch.p.x - feather.x, dy = snatch.p.y - feather.y, dz = snatch.p.z - feather.z;
        if (dx * dx + dy * dy + dz * dz <= T.snatchR * T.snatchR) {
          const perfect = S.elapsed - S.lastTellMs <= T.perfectMs;
          if (perfect || nearestCatM(cats) <= T.closeM) {
            const n = perfect ? 2 : 1; stats.you += n;
            out.push(perfect ? { type: 'point', who: 'you', n, perfect: true } : { type: 'point', who: 'you', n });
            hide('player');
          } else { out.push({ type: 'too_early' }); hide('tease'); S.msLeft = T.teaseHideMs; }
        }
      }
      // 3. win / time-up
      if (stats.you >= T.target || stats.kittens >= T.target || S.elapsed >= T.roundMs) {
        stats.winner = stats.you > stats.kittens ? 'you' : stats.kittens > stats.you ? 'kittens' : 'draw';
        out.push({ type: 'round_end', winner: stats.winner, you: stats.you, kittens: stats.kittens });
        if (stats.up) { stats.up = false; fp.roomEvent = FP_LASER_OFF; }
        stats.active = false; return out;
      }
      // 4. the feather's own clock
      S.msLeft -= dt;
      if (S.msLeft <= 0) { if (stats.up) hide('timeout'); else pop(head); }
      return out;
    },
  };
  // the nearest kitten that is OUT and free (PORT1 SHOULD 2: a kitten still in the box, carried or on a hand does not count)
  function nearestCatM(cats) {
    let best = Infinity;
    if (cats) for (let i = 0; i < cats.length; i++) {
      const c = cats[i]; if (c.mode === 'inbox' || c.mode === 'carried' || c.mode === 'onhand') continue;
      const dx = c.x - feather.x, dz = c.z - feather.z, d = dx * dx + dz * dz; if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
  function hide(why) {
    stats.up = false; S.msLeft = T.hideMsMin + prng.next() * (T.hideMsMax - T.hideMsMin);
    out.push({ type: 'feather_down', why }); fp.roomEvent = FP_LASER_OFF;
  }
  function pop(head) {
    const hx = head && Number.isFinite(head.x) ? head.x : 0, hz = head && Number.isFinite(head.z) ? head.z : 0;
    let fx = head && Number.isFinite(head.fx) ? head.fx : 0, fz = head && Number.isFinite(head.fz) ? head.fz : -1;
    const fl = Math.sqrt(fx * fx + fz * fz); if (fl > 1e-6) { fx /= fl; fz /= fl; } else { fx = 0; fz = -1; }
    let spot = null;
    for (let i = 0; i < T.tries; i++) {
      const d = T.ringMin + prng.next() * (T.ringMax - T.ringMin), lat = (prng.next() * 2 - 1) * T.latMax;
      const q = roomNearestLegal(room, { x: hx + fx * d - fz * lat, y: T.spotY, z: hz + fz * d + fx * lat });
      if (!q) continue;
      spot = q;
      const mx = q.x - feather.x, mz = q.z - feather.z;
      if (!S.popped || mx * mx + mz * mz >= T.minHopM * T.minHopM) break; // a new place each time (desktop: never the same spot)
    }
    if (!spot) { S.msLeft = T.hideMsMin; return; } // no legal surface known yet: try again later
    feather.x = spot.x; feather.y = spot.y; feather.z = spot.z; feather.surf = spot.surf;
    stats.up = true; S.popped = true; S.msLeft = T.upMs;
    out.push({ type: 'feather_up', x: spot.x, y: spot.y, z: spot.z, surf: spot.surf });
    fp.roomEvent = { type: 'laser', on: true, p: { x: spot.x, y: spot.y, z: spot.z } }; // a few per 10 s: allowed
  }
  return fp;
}

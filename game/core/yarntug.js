/* game/core/yarntug.js — battle mode #4: YARN TUG (Design 2 BT1 rules, docs/GAME-DESIGN.md 2). Both cats hold a
   yarn strand; the pompom marker (m in -1..1, 0 = middle, negative = toward the LEFT cat) moves by the difference of
   the two pulls. Pull = HOLD `interact` (steady pull, drains stamina-like `puff`) + TAP it in rhythm (a tap 350-800 ms
   after the previous one adds a burst (an impulse of `tapBurst` on the pompom); mashing faster than 250 ms = a comic paw slip: 400 ms of no pull). The pompom
   past your line (|m| >= 1) wins the round, else the side it is on when the 20 s round ends (dead centre = replay).
   Best of 3 (first to 2). The cats do not walk during a round: the mode parks them left/right of the middle and slides
   them with the pompom; movement input is ignored (the host shows a tug pose). Deterministic (prng only in the AI). */
import { clamp } from './vec.js';

export function createYarnTug(world, prng, { rounds = 3, roundMs = 20000, breakMs = 1500, holdPull = 0.22, tapBurst = 0.04, rhythmMin = 350, rhythmMax = 800, slipBelowMs = 250, slipMs = 400, puffDrain = 0.12, puffRefill = 0.25, puffFloor = 0.35 } = {}) {
  const mid = world.width / 2, gap = 1.5;
  const tug = {
    target: Math.ceil(rounds / 2), timeLimitMs: rounds * (roundMs + breakMs), elapsedMs: 0, score: {}, winner: null, catches: 0, events: [],
    m: 0, round: 1, roundMs: 0, breakLeft: 0, left: null, right: null, st: {},
    status(c) { return tug.st[c.id] || (tug.st[c.id] = { puff: 1, slipMs: 0, lastTapMs: -1e9, sinceTapMs: 1e9, wasDown: false, pull: 0, taps: 0, slips: 0 }); },
    step(cats, dtMs, acts = {}) {
      tug.events.length = 0;
      if (tug.winner) return;
      tug.elapsedMs += dtMs;
      if (!tug.left) { tug.left = cats[0].id; tug.right = cats[1] ? cats[1].id : null; tug.events.push({ type: 'round_start', round: tug.round }); }
      const L = cats.find((c) => c.id === tug.left), R = cats.find((c) => c.id === tug.right);
      // park both cats on the strand (no walking in this mode)
      for (const c of cats) { const s = c === L ? -1 : 1; c.body.x = mid + s * gap + tug.m * 0.6; c.body.vx = 0; c.side = -s; }
      if (tug.breakLeft > 0) { tug.breakLeft -= dtMs; if (tug.breakLeft <= 0) { tug.m = 0; tug.roundMs = 0; tug.events.push({ type: 'round_start', round: tug.round }); } return; }
      tug.roundMs += dtMs;
      const pullOf = (c) => {
        if (!c) return 0;
        const s = tug.status(c), a = acts[c.id] || {}, down = a.interact > 0.5;
        s.sinceTapMs += dtMs;
        if (s.slipMs > 0) { s.slipMs -= dtMs; s.wasDown = down; s.pull = 0; s.puff = Math.min(1, s.puff + puffRefill * dtMs / 1000); return 0; }
        let burst = 0;
        if (down && !s.wasDown) { // a tap
          s.taps++;
          if (s.sinceTapMs < slipBelowMs) { s.slipMs = slipMs; s.slips++; tug.events.push({ type: 'slip', cat: c.id }); }
          else if (s.sinceTapMs >= rhythmMin && s.sinceTapMs <= rhythmMax) { burst = tapBurst; tug.events.push({ type: 'tap', cat: c.id, rhythm: true }); }
          else tug.events.push({ type: 'tap', cat: c.id, rhythm: false });
          s.sinceTapMs = 0;
        }
        s.wasDown = down;
        if (s.slipMs > 0) { s.pull = 0; return 0; }
        const eff = puffFloor + (1 - puffFloor) * s.puff;
        s.puff = clamp(s.puff + (down ? -puffDrain : puffRefill) * dtMs / 1000, 0, 1);
        s.pull = (down ? holdPull : 0) * eff;
        s.burst = burst * eff; // a rhythm tap is an impulse on the pompom (not per-second)
        return s.pull;
      };
      const pl = pullOf(L), pr = pullOf(R);
      const bl = L ? tug.status(L).burst || 0 : 0, br = R ? tug.status(R).burst || 0 : 0;
      tug.m = clamp(tug.m + (pr - pl) * dtMs / 1000 + (br - bl), -1, 1);
      let roundWinner = null;
      if (tug.m <= -1) roundWinner = tug.left; else if (tug.m >= 1) roundWinner = tug.right;
      else if (tug.roundMs >= roundMs) roundWinner = tug.m < 0 ? tug.left : tug.m > 0 ? tug.right : 'tie';
      if (roundWinner) {
        if (roundWinner !== 'tie') { tug.score[roundWinner] = (tug.score[roundWinner] || 0) + 1; tug.catches++; }
        tug.events.push({ type: 'round_win', cat: roundWinner, round: tug.round, m: tug.m });
        const best = Math.ceil(rounds / 2);
        if ((tug.score[roundWinner] || 0) >= best) { tug.winner = roundWinner; tug.events.push({ type: 'win', cat: roundWinner }); return; }
        if (tug.round >= rounds) {
          const a = tug.score[tug.left] || 0, b = tug.score[tug.right] || 0;
          tug.winner = a > b ? tug.left : b > a ? tug.right : 'draw'; tug.events.push({ type: 'win', cat: tug.winner, timeUp: true }); return;
        }
        tug.round++; tug.breakLeft = breakMs;
        for (const c of cats) { const s = tug.status(c); s.puff = 1; s.slipMs = 0; s.sinceTapMs = 1e9; }
      }
    },
    /** AI: hold interact and tap in rhythm (seeded period 450-650 ms), slips now and then, eases off when puffed out */
    aiExtras(cat, a) {
      const s = tug.status(cat);
      a.moveX = 0; a.jump = 0; a.pounce = 0; a.swat = 0; a.sprint = 0;
      if (s.aiPeriod == null) { s.aiPeriod = 450 + prng.next() * 200; s.aiPhase = 0; s.aiRestMs = 0; }
      s.aiPhase += 1000 / 60;
      let down = 1;
      if (s.aiRestMs > 0) { s.aiRestMs -= 1000 / 60; a.interact = 0; return a; } // puffed out: a whole rest, then a clean tap
      if (s.aiPhase >= s.aiPeriod) { s.aiPhase = 0; down = 0; if (prng.chance(0.04)) s.aiPhase = s.aiPeriod - 120; } // release one step = a tap; sometimes too soon = slip
      if (s.puff < 0.2 && prng.chance(0.3)) { s.aiRestMs = 900 + prng.next() * 600; s.aiPhase = 0; down = 0; }
      a.interact = down;
      return a;
    },
    view(cats) { const o = { m: tug.m, round: tug.round, roundMsLeft: Math.max(0, roundMs - tug.roundMs), inBreak: tug.breakLeft > 0, left: tug.left, right: tug.right, cats: {} }; for (const c of cats) { const s = tug.status(c); o.cats[c.id] = { puff: s.puff, slipping: s.slipMs > 0, pulling: s.pull > 0 }; } return o; },
  };
  return tug;
}

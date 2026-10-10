/* game/core/loop.js — fixed-timestep accumulator.
   The renderer calls advance(frameMs) once per animation frame; the sim steps 0..maxStepsPerFrame times at exactly
   STEP_MS each. Render interpolates with `alpha`. A long stall (tab hidden, debugger) is clamped so the sim never
   spirals: the lost time is dropped, not simulated.
   Smoothness (product owner, 2026-10-07): rAF timestamps carry sub-millisecond noise around the display's real
   vsync period (16.67 / 8.33 / 6.94 / 6.06 / 4.17 ms at 60 / 120 / 144 / 165 / 240 Hz). Without care a 60 Hz display
   gets an occasional 0-step then 2-step frame pair, which interpolation hides but the input-to-render lag wobbles.
   So advance() SNAPS a frame time to the nearest known vsync period when it is within `snapTolMs`, and keeps the
   leftover in `drift`, paid back a little every frame (≤ 0.3 ms, |drift| ≤ driftMaxMs), so a 59.94 Hz panel never desyncs the sim from
   wall time (lag stays a few ms at most). Pass snapHz: [] to turn snapping off (tests, replays with raw timings). */
export const STEP_HZ = 60;
export const STEP_MS = 1000 / STEP_HZ;
export const STEP_S = 1 / STEP_HZ;
/** Display refresh rates the loop snaps frame times to (period = 1000 / hz). */
export const SNAP_HZ = Object.freeze([30, 60, 75, 90, 120, 144, 165, 240]);
const EPS = 1e-6;

export function createFixedLoop({ stepMs = STEP_MS, maxStepsPerFrame = 5, maxFrameMs = 250, snapHz = SNAP_HZ, snapTolMs = 0.5, driftMaxMs = 2 } = {}) {
  let acc = 0;
  let tick = 0;
  let drift = 0;
  let snapped = 0;
  const periods = (snapHz || []).map((hz) => 1000 / hz);
  return {
    get tick() { return tick; },
    get stepMs() { return stepMs; },
    /** ms of real time absorbed by snapping and not yet paid back (|drift| <= driftMaxMs, default 2 ms) */
    get drift() { return drift; },
    /** how many frames were snapped so far (HUD / tests) */
    get snapped() { return snapped; },
    /** Feed wall-clock frame time; returns how many fixed steps to run. */
    advance(frameMs) {
      if (!(frameMs >= 0)) frameMs = 0;           // NaN / negative guard
      if (frameMs > maxFrameMs) frameMs = maxFrameMs; // clamp stalls
      // vsync snapping: measured 16.61 or 16.72 ms on a 60 Hz panel IS one 16.667 ms frame
      let best = -1, bestD = snapTolMs;
      for (let i = 0; i < periods.length; i++) { const d = Math.abs(frameMs - periods[i]); if (d < bestD) { bestD = d; best = i; } }
      // ...but never let the absorbed drift exceed driftMaxMs: a panel that really runs 59 or 61 Hz (0.28 ms off the
      // 60 Hz period every frame) would otherwise make the sim run ~1 % slow/fast for ever (Code Review SHOULD 1).
      // When the bound is hit the frame passes raw until the payback below has brought drift down again, so wall time
      // and sim time never part by more than ~1 ms + one step.
      if (best >= 0 && Math.abs(drift + frameMs - periods[best]) <= driftMaxMs) {
        drift += frameMs - periods[best]; frameMs = periods[best]; snapped++;
      }
      // pay the absorbed drift back gently (10 %/frame, at most 0.3 ms/frame = 1.8 % of a step, below anything
      // interpolation can show): a 59.94 Hz panel stays in sync with wall time, and a 59 / 61 Hz panel's 0.28 ms/frame
      // excess is paid in full every frame, so its one extra/missing step per second arrives smoothly, not as a lump
      if (drift !== 0) { const pay = Math.max(-0.3, Math.min(0.3, drift * 0.1)); frameMs += pay; drift -= pay; if (Math.abs(drift) < 1e-4) drift = 0; }
      acc += frameMs;
      let n = 0;
      while (acc >= stepMs - EPS && n < maxStepsPerFrame) { acc -= stepMs; n++; }
      if (acc < 0) acc = 0;
      if (n === maxStepsPerFrame && acc >= stepMs) acc = 0; // drop the rest instead of spiralling
      tick += n;
      return n;
    },
    /** 0..1 fraction of a step since the last sim step (render interpolation). */
    get alpha() { return acc / stepMs; },
    reset() { acc = 0; tick = 0; drift = 0; snapped = 0; },
  };
}

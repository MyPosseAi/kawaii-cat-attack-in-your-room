/* vr/src/haptics.js - P0a slice: controller haptics when a controller is tracked (hand tracking has none). Gaming
   Engineer 2, 2026-10-10. hapticPulse(session, strength, ms) finds every inputSource with a gamepad haptic actuator and
   pulses it; pure helper hapticTargets(inputSources) for tests. Rate-limited to one pulse per minGapMs so a pounce storm
   does not buzz continuously. Nothing is logged or stored. Build rule: `export function` / `export const` only. */
export const HAPTICS_VERSION = 1;
export const HAPTIC_TUNING = Object.freeze({ minGapMs: 70, maxMs: 120, minMs: 20 });

/** The actuators to pulse: [{ actuator, handedness }] from a session's inputSources (any array-like). */
export function hapticTargets(inputSources) {
  const out = [];
  if (!inputSources) return out;
  for (const src of inputSources) {
    const gp = src && src.gamepad, acts = gp && gp.hapticActuators;
    if (acts && acts.length && typeof acts[0].pulse === 'function') out.push({ actuator: acts[0], handedness: src.handedness || 'none' });
  }
  return out;
}
/** Fresh limiter state. */
export function createHaptics() { return { lastMs: -Infinity, pulses: 0 }; }
/** Pulse every controller: strength 0..1 (0 = nothing), nowMs for the rate limit. Returns the number of actuators pulsed. */
export function hapticPulse(h, inputSources, strength, nowMs, tuning) {
  const T = tuning || HAPTIC_TUNING;
  if (!(strength > 0) || nowMs - h.lastMs < T.minGapMs) return 0;
  const targets = hapticTargets(inputSources);
  if (!targets.length) return 0;
  const ms = Math.round(T.minMs + (T.maxMs - T.minMs) * Math.min(1, strength));
  let n = 0;
  for (const t of targets) { try { t.actuator.pulse(Math.min(1, strength), ms); n++; } catch (e) { /* unsupported */ } }
  if (n) { h.lastMs = nowMs; h.pulses += n; }
  return n;
}

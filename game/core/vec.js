/* game/core/vec.js — tiny 2D helpers. Plain objects {x,y}; no classes so state stays JSON-serialisable for snapshots. */
export function v2(x, y) { return { x, y }; }
export function vAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
export function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
export function vScale(a, s) { return { x: a.x * s, y: a.y * s }; }
export function vLen(a) { return Math.sqrt(a.x * a.x + a.y * a.y); }
export function vDist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
export function sign(x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }
/** move `cur` toward `target` by at most `maxDelta` (never overshoots). */
export function approach(cur, target, maxDelta) {
  const d = target - cur;
  if (d > maxDelta) return cur + maxDelta;
  if (d < -maxDelta) return cur - maxDelta;
  return target;
}
/** smoothstep 0..1 — polynomial only (no Math.sin/cos in the sim: transcendental results can differ across engines). */
export function smooth01(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

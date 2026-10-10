/* vr/src/fx.js - P0a slice (docs/P0A-SLICE.md, GE2 section): the JUICE of every interaction, as plain data.
   Gaming Engineer 2, 2026-10-10. PURE and engine-neutral (no three / WebAudio / DOM), node-tested in vr/test/fx.test.mjs.
   The host (room-hook.js) draws what comes out; sound.js / haptics.js play the cue lists.
   What it does, per frame (fxStep):
   - CUES from the sim: diffs the roomcat state against the previous frame's and reads roomcat v2's `session.events`
     (tell / pounce / near_miss / combo / big_leap / hand_climb) -> sound names, a haptic strength, particle spawns, squash
     impulses. Box: thump + dust when it lands, a jiggle + mew while it waits, the lid swings open on a hinge (lidAngle).
   - SQUASH & STRETCH per cat (juiceStep): a critically-damped spring on (sx, sy) toward a pose target (crouch = low and
     wide with a butt-wiggle, airborne = tall and thin, carried = a little stretched) plus impulses (launch stretch, landing
     squash, pet sway) and a celebration bounce. The billboard multiplies these into its quad scale (cat-billboard setSquash).
   - PARTICLES (createParticles / spawnParticles / particleStep): pooled, fixed max, no allocation after creation. Hearts
     rise and drift, dust puffs out low and settles, sparks fan out. Every particle scales IN over >= fadeMinS (0.15 s,
     Legal item 4) and OUT over at least as long (never a pop). ONE GLOBAL LIMITER (fx.limiter, pulseAllowed) counts
     EVERY brightness change the fx make: every spawn event of any kind (a burst, a purr heart, the celebration fountain, a
     landing puff) is one change, <= maxPulsesPerS = 3 in any rolling second, combined (review BB MUST 3; the host's floor
     ring is static for the same reason). Colours are the host's; the recommended ones (hearts #ff9ec7, dust #fff3e6,
     sparks #ffe08a) all keep R / (R + G + B) < 0.8.
   Determinism: particle directions come from a tiny LCG seeded per pool (no Math.random), so tests replay exactly.
   Build rule: only `export function` / `export const`; private names carry the `fx` prefix. */
export const FX_VERSION = 1;
export const FX_TUNING = Object.freeze({
  maxPulsesPerS: 3,           // photosensitivity: brightness changes (any fx spawn) per rolling second, combined (item 4)
  fadeMinS: 0.15,             // every particle fades in over at least this, and out over at least this (item 4)
  springK: 160, springD: 22,  // squash spring (near critical damping at ~2 Hz); dt is clamped to maxDt
  maxDt: 0.05,
  crouchSx: 1.1, crouchSy: 0.84, wiggleHz: 5, wiggleAmp: 0.05, // anticipation crouch (pose 'crouch' from roomcat)
  airSx: 0.9, airSy: 1.14,    // in flight (hop / pounce / fly)
  carrySx: 0.95, carrySy: 1.06,
  pinSx: 1.08, pinSy: 0.9,    // holding the caught dot
  launchImpulse: 0.3, landImpulse: 0.35, tossLandImpulse: 0.5, petSway: 0.08,
  bounceHz: 3, bounceAmp: 0.12, // celebration bounce (per-cat phase offset)
  heartsMax: 32, dustMax: 32, sparkMax: 32,
  heartLife: 1.1, dustLife: 0.6, sparkLife: 0.7,
  heartRise: 0.35, dustSpread: 0.5, dustGravity: 0.8, sparkSpeed: 0.9,
  purrHeartEveryS: 0.8,       // a purring kitten releases a heart this often (with the purr voice; one change per stroke cue)
  fountainEveryS: 0.5,        // the celebration fountain: ONE change (a heart over every kitten) this often
  purrEveryS: 0.8,            // the purr voice re-triggers this often while the stroke holds (GDXE Build 1 item 5)
  pitchMin: 0.85, pitchMax: 1.2, // each kitten's own voice: mew / chirp / purr pitched by a hash of its id
  boxJiggleEveryS: 2.0, boxJiggleS: 0.5, boxMewEveryS: 2.5, lidOpenS: 0.45, boxLandSquash: 0.3,
});

// ---------------------------------------------------------------- pulse limiter (photosensitivity)
/** Fresh limiter: remembers the times of the pulses in the last second. */
export function createPulseLimiter(max) { return { times: [], forced: [], max: Number.isFinite(max) ? max : FX_TUNING.maxPulsesPerS }; }
function fxTrim(lim, t) { const a = lim.times; let k = 0; while (k < a.length && t - a[k] >= 1) k++; if (k) { a.splice(0, k); lim.forced.splice(0, k); } }
/** Ask for a pulse-like effect at time t (seconds). true = allowed (and counted); false = too many in the rolling second.
 *  Mutates the limiter; no allocation once warm (the array is trimmed in place). */
export function pulseAllowed(lim, t, reserve = 0) {
  fxTrim(lim, t);
  const a = lim.times; let forced = 0; for (const f of lim.forced) if (f) forced++;
  // `reserve` = the changes the dot may still need in this second (its cap), less the ones it already made in the window
  if (a.length >= lim.max - Math.max(0, reserve - forced)) return false;
  a.push(t); lim.forced.push(false); return true;
}
/** Count a change that CANNOT be refused (the laser dot lighting / dimming: Legal counts it with the particles): it takes a
 *  slot in the same rolling second, so the fx spawns yield to it. Returns true when the second was already full (over budget:
 *  the dot's own cap in lasertag-room.js keeps that rare; fx.dotOver counts it for the perf HUD). */
export function pulseForce(lim, t) {
  fxTrim(lim, t);
  const a = lim.times, over = a.length >= lim.max;
  a.push(t); lim.forced.push(true); return over;
}

// ---------------------------------------------------------------- particles
function fxLcg(s) { s.v = (s.v * 1664525 + 1013904223) >>> 0; return s.v / 4294967296; }
/** A pool of `max` particles of one kind. kind = 'heart' | 'dust' | 'spark'. */
export function createParticles(kind, max, seed) {
  const n = Number.isFinite(max) ? max : kind === 'heart' ? FX_TUNING.heartsMax : kind === 'dust' ? FX_TUNING.dustMax : FX_TUNING.sparkMax;
  const items = [];
  for (let i = 0; i < n; i++) items.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size: 0.03, scale: 0 });
  return { kind, items, max: n, alive: 0, next: 0, rng: { v: (Number.isFinite(seed) ? seed : 7) >>> 0 } };
}
/** Spawn `count` particles at (x, y, z). Dead slots first, then the oldest are recycled (the pool never grows). */
export function spawnParticles(ps, x, y, z, count) {
  const T = FX_TUNING, items = ps.items;
  for (let c = 0; c < count; c++) {
    let p = null;
    for (let i = 0; i < items.length; i++) { const q = items[(ps.next + i) % items.length]; if (!q.alive) { p = q; ps.next = (ps.next + i + 1) % items.length; break; } }
    if (!p) { p = items[ps.next]; ps.next = (ps.next + 1) % items.length; } else ps.alive++;
    const a = fxLcg(ps.rng) * 6.283185, r = fxLcg(ps.rng), cx = Math.cos(a), sz = Math.sin(a);
    p.alive = true; p.age = 0; p.scale = 0;
    if (ps.kind === 'heart') { p.x = x + cx * 0.05 * r; p.y = y; p.z = z + sz * 0.05 * r; p.vx = cx * 0.08; p.vz = sz * 0.08; p.vy = T.heartRise * (0.8 + 0.4 * r); p.life = T.heartLife * (0.85 + 0.3 * fxLcg(ps.rng)); p.size = 0.035 + 0.02 * r; }
    else if (ps.kind === 'dust') { p.x = x; p.y = y + 0.01; p.z = z; const v = T.dustSpread * (0.5 + 0.5 * r); p.vx = cx * v; p.vz = sz * v; p.vy = 0.25 + 0.2 * fxLcg(ps.rng); p.life = T.dustLife * (0.8 + 0.4 * fxLcg(ps.rng)); p.size = 0.03 + 0.03 * r; }
    else { p.x = x; p.y = y; p.z = z; const v = T.sparkSpeed * (0.6 + 0.4 * r), up = fxLcg(ps.rng); p.vx = cx * v * 0.6; p.vz = sz * v * 0.6; p.vy = v * (0.3 + 0.7 * up); p.life = T.sparkLife; p.size = 0.02 + 0.015 * r; }
  }
  return ps;
}
/** Advance the pool by dt seconds. scale = the host's draw size factor (0 -> 1 quickly, then eases out to 0: never a pop). */
export function particleStep(ps, dt) {
  const T = FX_TUNING; let alive = 0;
  for (const p of ps.items) {
    if (!p.alive) continue;
    p.age += dt;
    if (p.age >= p.life) { p.alive = false; p.scale = 0; continue; }
    const f = p.age / p.life;
    // fade in over fadeMinS (absolute, >= 150 ms), then ease out over the rest of the life (always >= fadeMinS: lives >= 0.48 s)
    const fin = T.fadeMinS, env = p.age < fin ? p.age / fin : 1 - (p.age - fin) / (p.life - fin);
    if (ps.kind === 'heart') { p.vx *= 0.98; p.vz *= 0.98; p.x += p.vx * dt + Math.sin(p.age * 6) * 0.002; p.y += p.vy * dt; p.z += p.vz * dt; p.scale = env; }
    else if (ps.kind === 'dust') { p.vy -= T.dustGravity * dt; p.vx *= 0.94; p.vz *= 0.94; p.x += p.vx * dt; p.y = Math.max(p.y + p.vy * dt, p.y - 0.01); p.z += p.vz * dt; p.scale = env * (1 + f); }
    else { p.vy -= 1.2 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.scale = env; }
    alive++;
  }
  ps.alive = alive;
  return ps;
}

// ---------------------------------------------------------------- squash & stretch
/** Fresh juice state: per cat { sx, sy, vx, vy, phase }. */
export function createJuice(seed) { return { cats: {}, rng: { v: (Number.isFinite(seed) ? seed : 3) >>> 0 } }; }
function fxCat(j, id) { let c = j.cats[id]; if (!c) { c = j.cats[id] = { sx: 1, sy: 1, vx: 0, vy: 0, phase: fxLcg(j.rng) * 6.283185, sway: 0, sulk: -Infinity }; } return c; }
/** Squash impulse: a positive `k` squashes (wider, lower); negative stretches (taller, thinner). */
export function squashImpulse(j, id, k) { const c = fxCat(j, id); c.vx += k * 14; c.vy -= k * 14; return c; }
/**
 * One frame of the spring. cats = this frame's billboard records ({ id, pose, mode, airborne }); t seconds; celebrate =
 * true while the celebration bounce runs. Returns the juice (mutated). Per cat: sx / sy multiply the quad's scale.
 */
export function juiceStep(j, dt, cats, t, celebrate) {
  const T = FX_TUNING, h = Math.min(T.maxDt, Math.max(0, dt));
  for (const c of cats) {
    const q = fxCat(j, c.id);
    let tx = 1, ty = 1;
    if (c.pose === 'crouch') { const w = Math.sin(t * T.wiggleHz * 6.283185 + q.phase) * T.wiggleAmp; tx = T.crouchSx + w; ty = T.crouchSy - w * 0.5; }
    else if (c.airborne || c.pose === 'hop' || c.pose === 'pounce' || c.pose === 'fall' || c.pose === 'climb') { tx = T.airSx; ty = T.airSy; }
    else if (c.pose === 'carried') { tx = T.carrySx; ty = T.carrySy; }
    else if (c.pose === 'pin') { tx = T.pinSx; ty = T.pinSy; }
    if (celebrate) { const b = Math.sin(t * T.bounceHz * 6.283185 + q.phase); ty += Math.max(0, b) * T.bounceAmp; tx -= Math.max(0, b) * T.bounceAmp * 0.6; }
    if (t < q.sulk) { ty *= 0.93; tx *= 1.03; } // the sulky walk-off after too many hard tosses (roomcat wander_off): a small droop
    if (q.sway > 0) { tx += Math.sin(t * 9) * T.petSway * q.sway; q.sway = Math.max(0, q.sway - h * 1.5); }
    q.vx += (T.springK * (tx - q.sx) - T.springD * q.vx) * h; q.vy += (T.springK * (ty - q.sy) - T.springD * q.vy) * h;
    q.sx += q.vx * h; q.sy += q.vy * h;
    if (q.sx < 0.5) q.sx = 0.5; if (q.sx > 1.6) q.sx = 1.6; if (q.sy < 0.5) q.sy = 0.5; if (q.sy > 1.6) q.sy = 1.6;
  }
  return j;
}

// ---------------------------------------------------------------- box animation
/** The box's visual state from the sim box + session time. Returns { jiggle (yaw radians), squash (0..1 extra width), lidAngle (0..1 open fraction) }.
 *  st = { landedAt, openedAt } the host keeps (set by fxStep). Pure; no allocation when `out` is passed. */
export function boxAnim(box, st, t, out) {
  const T = FX_TUNING, o = out || { jiggle: 0, squash: 0, lid: 0 };
  o.jiggle = 0; o.squash = 0; o.lid = 0;
  if (!box) return o;
  if (box.landed && st.landedAt != null) { const a = t - st.landedAt; if (a < T.boxLandSquash) { const f = 1 - a / T.boxLandSquash; o.squash = 0.18 * f * Math.abs(Math.sin(a * 22)); } }
  if (box.landed && !box.open && st.landedAt != null) {
    const a = t - st.landedAt, ph = a % T.boxJiggleEveryS;
    if (a > 1 && ph < T.boxJiggleS) o.jiggle = Math.sin(ph * 40) * 0.06 * (1 - ph / T.boxJiggleS);
  }
  if (box.open) { const a = st.openedAt == null ? 1 : (t - st.openedAt) / T.lidOpenS; const k = Math.min(1, Math.max(0, a)); o.lid = 1 - (1 - k) * (1 - k) * (1 - k); } // ease-out
  return o;
}

// ---------------------------------------------------------------- cues
/** Fresh fx state (the host keeps one per XR session). */
export function createFx(seed) {
  const s = Number.isFinite(seed) ? seed : 1;
  return {
    juice: createJuice(s), hearts: createParticles('heart', undefined, s + 1), dust: createParticles('dust', undefined, s + 2), sparks: createParticles('spark', undefined, s + 3),
    limiter: createPulseLimiter(), box: { landedAt: null, openedAt: null, lastMew: -Infinity }, purrT: {}, prevBy: {}, curBy: {}, landBy: {},
    sounds: [], pitches: [], haptic: 0, pulses: 0, t: 0, purrSoundT: {}, _pts: [], dotLit: false, dotChanges: 0, dotOver: 0,
  };
}
/** A kitten's own voice: a pitch multiplier in [pitchMin, pitchMax] from a stable hash of its id (pure). */
export function catPitch(id) {
  let h = 2166136261; const str = String(id == null ? '' : id).replace(/^lt:/, '');
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return FX_TUNING.pitchMin + (h % 1000) / 999 * (FX_TUNING.pitchMax - FX_TUNING.pitchMin);
}
const FX_CAT_H = 0.18;
/**
 * One frame. inp = { dt, t, state (roomcat state), prevState, simEvents (roomcat session.events collected this frame),
 * cats (billboard records this frame), celebrate (bool), extra (optional [{ sound, haptic, spark: {x,y,z,n}, heart: {...} }]
 * from the director: Laser Tag cues) }. Returns fx (mutated): fx.sounds = this frame's sound names (reused array),
 * fx.haptic = 0..1, particles advanced, juice advanced.
 */
export function fxStep(fx, inp) {
  const T = FX_TUNING, dt = inp.dt || 0, t = inp.t || 0, st = inp.state, prev = inp.prevState;
  fx.t = t; fx.sounds.length = 0; fx.pitches.length = 0; fx.haptic = 0;
  const say = (name, hap, pitch) => { fx.sounds.push(name); fx.pitches.push(pitch || 1); if (hap > fx.haptic) fx.haptic = hap; };
  // EVERY spawn is one brightness change through the one limiter (MUST 3): refused spawns simply do not happen
  // dotReserve: slots of the rolling second kept free for the dot's own lit / dim edges (the bridge passes 2 in Laser Tag, where
  // lasertag-room.js caps the dot at 2 edges per second, and 1 in Play: combined, dot + particles never pass 3)
  const reserve = Number.isFinite(inp.dotReserve) ? inp.dotReserve : 1;
  const burst = (ps, x, y, z, n) => { if (pulseAllowed(fx.limiter, t, reserve)) { spawnParticles(ps, x, y, z, n); fx.pulses++; return true; } return false; };
  // one change that puts particles over several points at once (the fountain, a combo): one limiter slot
  const multi = (ps, pts, n) => { if (!pts.length || !pulseAllowed(fx.limiter, t, reserve)) return false; for (const q of pts) spawnParticles(ps, q.x, q.y, q.z, n); fx.pulses++; return true; };
  const pts = fx._pts; pts.length = 0;
  // MUST (review BF): the dot's lit / dim transitions are brightness changes too (Laser Tag dot alpha, or the Play laser on / off):
  // they are counted FIRST and can never be refused, so the particle spawns below yield when the second is used up
  const lit = !!inp.dot && (Number.isFinite(inp.dot.alpha) ? inp.dot.alpha > 0.001 : true);
  if (lit !== fx.dotLit) { fx.dotLit = lit; fx.dotChanges++; if (pulseForce(fx.limiter, t)) fx.dotOver++; }
  const by = fx.prevBy; for (const k in by) by[k] = undefined; // cheap reuse: ids are stable per session
  if (prev && prev.cats) for (const c of prev.cats) by[c.id] = c;
  const landBy = fx.landBy; for (const k in landBy) landBy[k] = undefined; // GE1's 'land' events carry the impact squash (0..1)
  for (const ev of inp.simEvents || []) if (ev.type === 'land') landBy[ev.cat] = ev;
  if (st) {
    // box: land -> thump + dust; waiting -> mews; open -> pop + lid
    const b = st.box, pb = prev && prev.box;
    if (b.landed && !(pb && pb.landed)) { fx.box.landedAt = t; say('thump', 0.6); burst(fx.dust, b.x, b.y, b.z, 10); }
    if (b.landed && !b.open && fx.box.landedAt != null && t - fx.box.landedAt > 1 && t - fx.box.lastMew >= T.boxMewEveryS) { fx.box.lastMew = t; say('mew', 0.15); }
    if (b.open && !(pb && pb.open)) { fx.box.openedAt = t; say('pop', 0.4); burst(fx.dust, b.x, b.y + 0.3, b.z, 6); }
    for (const c of st.cats) {
      const p = by[c.id];
      if (c.mode === 'inbox') continue;
      const voice = catPitch(c.id);
      if (c.pose === 'climb' && (!p || p.pose !== 'climb')) say('mew', 0.2, voice);
      // landing: airborne -> grounded (a toss lands harder than a hop)
      if (p && p.airborne && !c.airborne && c.support !== 'hand') {
        const toss = p.mode === 'fly' || p.pose === 'poof' || p.pose === 'twist', le = landBy[c.id];
        squashImpulse(fx.juice, c.id, (toss ? T.tossLandImpulse : T.landImpulse) * (le && Number.isFinite(le.squash) ? 0.6 + 0.8 * le.squash : 1));
        burst(fx.dust, c.x, c.y, c.z, toss ? 8 : 4);
        // GE1's land { happy, hard }: a gentle toss landing earns a soft purr (+ a heart), a hard one (floated down) a soft pat, no thump
        if (le && le.happy) { say('purr', 0.2, voice); burst(fx.hearts, c.x, c.y + FX_CAT_H, c.z, 1); }
        else if (le && le.hard) say('pat', 0.2);
        else say(toss ? 'thump' : 'pat', toss ? 0.5 : 0.25);
      }
      // launch: grounded -> airborne (stretch)
      if (p && !p.airborne && c.airborne && p.mode !== 'carried') { squashImpulse(fx.juice, c.id, -T.launchImpulse); if (c.pose === 'pounce') say('whoosh', 0.2); }
      // toss release: carried -> airborne
      if (p && p.mode === 'carried' && c.airborne) { squashImpulse(fx.juice, c.id, -T.launchImpulse); say('whee', 0.3); }
      if (c.poof && !(p && p.poof)) say('poof', 0.3);
      // purr: sound on the edge, hearts while it lasts, a sway
      if (c.purr) {
        if (!(p && p.purr)) { fxCat(fx.juice, c.id).sway = 1; fx.purrT[c.id] = -Infinity; fx.purrSoundT[c.id] = -Infinity; }
        if (t - (fx.purrSoundT[c.id] == null ? -Infinity : fx.purrSoundT[c.id]) >= T.purrEveryS - 1e-9) { fx.purrSoundT[c.id] = t; say('purr', 0.1, voice); } // keeps purring while the stroke holds
        if (t - (fx.purrT[c.id] == null ? -Infinity : fx.purrT[c.id]) >= T.purrHeartEveryS - 1e-9) { fx.purrT[c.id] = t; burst(fx.hearts, c.x, c.y + FX_CAT_H, c.z, 1); }
      }
      if (c.pose === 'eat' && (!p || p.pose !== 'eat')) { say('nom', 0.3, voice); burst(fx.hearts, c.x, c.y + FX_CAT_H, c.z, 3); }
      if (c.pose === 'beg' && (!p || p.pose !== 'beg')) say('mew', 0.1, voice);
    }
  }

  const cur = fx.curBy; for (const k in cur) cur[k] = undefined; // event cats are looked up in the CURRENT state
  if (st) for (const c of st.cats) cur[c.id] = c;
  for (const ev of inp.simEvents || []) {
    const c = cur[ev.cat];
    if (ev.type === 'tell') say('tick', 0.1);
    else if (ev.type === 'pounce' && ev.catch && c) { say('chirp', 0.5, catPitch(c.id)); burst(fx.hearts, c.x, c.y + FX_CAT_H, c.z, 3); }
    else if (ev.type === 'pounce' && c) say('pat', 0.2);
    else if (ev.type === 'near_miss') say('swish', 0.15);
    else if (ev.type === 'combo') { say('combo', 0.6); if (st) { pts.length = 0; for (const k of st.cats) if (k.mode !== 'inbox') pts.push({ x: k.x, y: k.y + FX_CAT_H, z: k.z }); multi(fx.sparks, pts, 4); } }
    else if (ev.type === 'hand_climb') say('chirp', 0.4, catPitch(ev.cat));
    else if (ev.type === 'box_peek') say('mew', 0.1, catPitch(ev.cat));
    else if (ev.type === 'wander_off') { fxCat(fx.juice, ev.cat).sulk = t + (Number.isFinite(ev.s) ? ev.s : 8); say('mew', 0.05, catPitch(ev.cat) * 0.8); } // one low, quiet mew; then a drooping walk-off (juiceStep), nothing more
    else if (ev.type === 'treat_come') say('chirp', 0.1, catPitch(ev.cat));
    else if (ev.type === 'big_leap' && c) { say('whoosh', 0.4); burst(fx.sparks, c.x, c.y, c.z, 6); }
  }
  for (const x of inp.extra || []) {
    if (x.sound) say(x.sound, x.haptic || 0, x.pitch || 1);
    if (x.spark) burst(fx.sparks, x.spark.x, x.spark.y, x.spark.z, x.spark.n || 6);
    if (x.heart) burst(fx.hearts, x.heart.x, x.heart.y, x.heart.z, x.heart.n || 3);
    if (x.dust) burst(fx.dust, x.dust.x, x.dust.y, x.dust.z, x.dust.n || 4);
  }
  if (inp.celebrate && st) { // fountain: ONE change every fountainEveryS (a heart over every kitten at once), through the limiter
    if (Math.floor(t / T.fountainEveryS) !== Math.floor((t - dt) / T.fountainEveryS)) { pts.length = 0; for (const k of st.cats) if (k.mode !== 'inbox') pts.push({ x: k.x, y: k.y + FX_CAT_H, z: k.z }); multi(fx.hearts, pts, 1); }
  }
  juiceStep(fx.juice, dt, inp.cats || [], t, !!inp.celebrate);
  particleStep(fx.hearts, dt); particleStep(fx.dust, dt); particleStep(fx.sparks, dt);
  return fx;
}

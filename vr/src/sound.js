/* vr/src/sound.js - P0a slice: every sound is SYNTHESISED with WebAudio at play time. No audio files, no decode, no
   fetch, no network (vr/test/network-allowlist.test.mjs stays green by construction). Gaming Engineer 2, 2026-10-10.
   createSound(ctx) takes an AudioContext (or any object with the same createOscillator / createGain / createBiquadFilter /
   createBuffer / createBufferSource / destination / currentTime shape, so node tests run it against a fake:
   vr/test/sound.test.mjs). The host builds the real context on the Enter tap (a user gesture; main.js) and resumes it on
   every XR session start. play(name) schedules one short voice; names = SOUND_NAMES. Loudness is modest (master 0.35) and
   every voice is a soft envelope (attack >= 5 ms, no clicks). Rate limits: the same name at most every minGapMs (a purr re-triggers every 0.8 s while the stroke holds, fx.js), at most
   maxVoicesPerFrame per flush, so a pounce storm never becomes noise. Nothing here is time-critical: a missing context
   (no Enter tap yet, autoplay blocked) makes every call a no-op. Build rule: `export function` / `export const` only. */
export const SOUND_VERSION = 1;
export const SOUND_NAMES = Object.freeze(['thump', 'pat', 'pop', 'mew', 'purr', 'whoosh', 'whee', 'poof', 'nom', 'tick', 'chirp', 'swish', 'combo', 'fanfare', 'go', 'caught']);
export const SOUND_TUNING = Object.freeze({ master: 0.35, minGapMs: 60, maxVoicesPerFrame: 6, noiseS: 1.0 });

function sdTone(ctx, out, { type = 'sine', f0 = 440, f1 = f0, dur = 0.2, gain = 0.5, attack = 0.008, at = 0, filter = null, rate = 1 }) {
  const t0 = ctx.currentTime + at, osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(f0 * rate, t0); if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * rate), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let last = osc;
  if (filter) { const bq = ctx.createBiquadFilter(); bq.type = filter.type || 'lowpass'; bq.frequency.setValueAtTime(filter.f, t0); if (filter.q) bq.Q.setValueAtTime(filter.q, t0); osc.connect(bq); last = bq; }
  last.connect(g); g.connect(out); osc.start(t0); osc.stop(t0 + dur + 0.02);
}
function sdNoise(ctx, out, buf, { dur = 0.15, gain = 0.4, f = 1200, type = 'lowpass', f1 = null, attack = 0.006, at = 0 }) {
  const t0 = ctx.currentTime + at, src = ctx.createBufferSource(), g = ctx.createGain(), bq = ctx.createBiquadFilter();
  src.buffer = buf; bq.type = type; bq.frequency.setValueAtTime(f, t0); if (f1) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bq); bq.connect(g); g.connect(out); src.start(t0); src.stop(t0 + dur + 0.02);
}
/** the voices: one function per name (ctx, out, noiseBuffer, rate). rate = the kitten's pitch multiplier (fx.js catPitch,
 *  0.85-1.2) on the voiced sounds (mew / purr / chirp / nom); the others ignore it. */
export const SOUND_VOICES = Object.freeze({
  thump: (c, o, n) => { sdTone(c, o, { f0: 120, f1: 45, dur: 0.22, gain: 0.7 }); sdNoise(c, o, n, { dur: 0.08, gain: 0.25, f: 400 }); },
  pat: (c, o, n) => { sdNoise(c, o, n, { dur: 0.06, gain: 0.2, f: 900 }); sdTone(c, o, { f0: 220, f1: 140, dur: 0.08, gain: 0.25 }); },
  pop: (c, o, n) => { sdTone(c, o, { f0: 300, f1: 900, dur: 0.09, gain: 0.4 }); sdNoise(c, o, n, { dur: 0.05, gain: 0.2, f: 2500, type: 'highpass' }); },
  mew: (c, o, n, r = 1) => { sdTone(c, o, { f0: 620, f1: 980, dur: 0.16, gain: 0.3, attack: 0.02, rate: r }); sdTone(c, o, { f0: 980, f1: 760, dur: 0.14, gain: 0.25, at: 0.16, rate: r }); },
  purr: (c, o, n, r = 1) => { sdNoise(c, o, n, { dur: 0.85, gain: 0.18, f: 160, attack: 0.08 }); sdTone(c, o, { type: 'triangle', f0: 28, f1: 26, dur: 0.85, gain: 0.3, attack: 0.1, rate: r }); },
  whoosh: (c, o, n) => sdNoise(c, o, n, { dur: 0.25, gain: 0.3, f: 500, f1: 2500, type: 'bandpass' }),
  whee: (c, o) => sdTone(c, o, { f0: 400, f1: 1100, dur: 0.3, gain: 0.3, attack: 0.02 }),
  poof: (c, o, n) => sdNoise(c, o, n, { dur: 0.3, gain: 0.3, f: 1800, f1: 300 }),
  nom: (c, o, n, r = 1) => { sdTone(c, o, { type: 'square', f0: 240, f1: 180, dur: 0.07, gain: 0.15, filter: { f: 800 }, rate: r }); sdTone(c, o, { type: 'square', f0: 260, f1: 190, dur: 0.07, gain: 0.15, at: 0.11, filter: { f: 800 }, rate: r }); },
  tick: (c, o) => sdTone(c, o, { f0: 1200, f1: 900, dur: 0.05, gain: 0.25, attack: 0.006 }),
  chirp: (c, o, n, r = 1) => { sdTone(c, o, { f0: 880, f1: 1760, dur: 0.1, gain: 0.3, rate: r }); sdTone(c, o, { f0: 1320, f1: 1980, dur: 0.12, gain: 0.25, at: 0.08, rate: r }); },
  swish: (c, o, n) => sdNoise(c, o, n, { dur: 0.12, gain: 0.25, f: 3000, type: 'highpass' }),
  combo: (c, o) => { [523, 659, 784, 1047].forEach((f, i) => sdTone(c, o, { f0: f, dur: 0.18, gain: 0.25, at: i * 0.06 })); },
  fanfare: (c, o) => { [523, 659, 784, 1047, 1319].forEach((f, i) => sdTone(c, o, { type: 'triangle', f0: f, dur: 0.5, gain: 0.22, at: i * 0.09 })); sdTone(c, o, { type: 'triangle', f0: 262, dur: 0.9, gain: 0.2, attack: 0.05 }); },
  go: (c, o) => { sdTone(c, o, { f0: 660, dur: 0.12, gain: 0.3 }); sdTone(c, o, { f0: 990, dur: 0.3, gain: 0.3, at: 0.12 }); },
  caught: (c, o, n) => { sdTone(c, o, { type: 'triangle', f0: 520, f1: 180, dur: 0.5, gain: 0.35, attack: 0.01 }); sdNoise(c, o, n, { dur: 0.2, gain: 0.2, f: 600 }); },
});

/** Build the player. ctx = AudioContext (or a fake); returns { play(name), flush(), enabled, dispose() }. play() queues; flush()
 *  (once per frame) applies the rate limits and schedules the voices. With no ctx every call is a no-op. */
export function createSound(ctx, tuning) {
  const T = tuning || SOUND_TUNING;
  const s = { ctx: ctx || null, enabled: !!ctx, queue: [], last: {}, played: 0, dropped: 0, master: null, noise: null };
  if (ctx) {
    s.master = ctx.createGain(); s.master.gain.setValueAtTime(T.master, ctx.currentTime); s.master.connect(ctx.destination);
    const rate = ctx.sampleRate || 48000, len = Math.floor(rate * T.noiseS), buf = ctx.createBuffer(1, len, rate), data = buf.getChannelData(0);
    let v = 12345; for (let i = 0; i < len; i++) { v = (v * 1664525 + 1013904223) >>> 0; data[i] = (v / 2147483648) - 1; } // white noise, deterministic (no Math.random)
    s.noise = buf;
  }
  s.play = (name, rate) => { if (s.enabled && SOUND_VOICES[name]) s.queue.push({ name, rate: rate > 0 ? rate : 1 }); };
  s.flush = () => {
    if (!s.enabled || !s.queue.length) { s.queue.length = 0; return 0; }
    const now = ctx.currentTime * 1000; let n = 0;
    for (const q of s.queue) {
      const name = q.name;
      if (n >= T.maxVoicesPerFrame) { s.dropped++; continue; }
      const last = s.last[name];
      if (last != null && now - last < T.minGapMs) { s.dropped++; continue; }
      s.last[name] = now; n++; s.played++;
      try { SOUND_VOICES[name](ctx, s.master, s.noise, q.rate); } catch (e) { /* a closed context: stay quiet */ }
    }
    s.queue.length = 0;
    return n;
  };
  s.resume = () => { if (ctx && typeof ctx.resume === 'function' && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* ignore */ } } };
  s.dispose = () => { s.enabled = false; s.queue.length = 0; if (s.master && typeof s.master.disconnect === 'function') s.master.disconnect(); };
  return s;
}

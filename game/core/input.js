/* game/core/input.js — pure input mapping. Device snapshots in, one ACTIONS record out. No DOM, no listeners:
   the host (proto page, Electron renderer) gathers KeyboardEvent codes / Gamepad state / pointer clicks each frame and
   calls these. The ACTIONS record is what the sim consumes and what the input log records.
   Button map = design/concepts/SK31-control/spec.md section 5 (provisional until the owner's feel call). */

export const ACTION_NAMES = Object.freeze([
  'moveX',      // -1..1 analog
  'jump', 'pounce', 'swat', 'meow', 'emote', 'knead', 'nap', 'interact',
  'sneak', 'sprint',  // holds (0..1 analog for triggers)
  'pause',            // Esc / Start — guard rail, never rebindable away from Esc
  'clickX', 'clickY', 'clickKind', // click-to-move target in world BL (NaN = none); kind 0 none, 1 walk, 2 sprint, 3 pounce-target
  'moveZ',      // floor plane only (above/below views): -1..1, + = up the screen; side games ignore it. LAST so old logs parse (missing = 0)
]);

export function emptyActions() {
  return { moveX: 0, jump: 0, pounce: 0, swat: 0, meow: 0, emote: 0, knead: 0, nap: 0, interact: 0,
    sneak: 0, sprint: 0, pause: 0, clickX: NaN, clickY: NaN, clickKind: 0, moveZ: 0 };
}

/** Default keyboard bindings: action -> KeyboardEvent.code list. Rebindable: pass your own map (saved per user). */
export const DEFAULT_KEYS = Object.freeze({
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], //: moveZ (floor-plane games only)
  jump: ['Space'], pounce: ['KeyE'], swat: ['KeyF'], meow: ['KeyQ'], emote: ['KeyR'],
  knead: ['KeyK'], nap: ['KeyN'], interact: ['KeyG'],
  sneak: ['ControlLeft', 'ControlRight'], sprint: ['ShiftLeft', 'ShiftRight'],
  pause: ['Escape'],
});
/** Never bindable (OS / guard rails). rebind() refuses these. */
export const RESERVED_CODES = Object.freeze(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'Tab', 'F4', 'Delete', 'PrintScreen', 'ContextMenu']);

/** Return a new bindings map with `action` bound to `codes` (Esc stays on pause always; reserved codes refused). */
export function rebind(bindings, action, codes) {
  const list = Array.isArray(codes) ? codes : [codes];
  for (const c of list) if (RESERVED_CODES.includes(c)) throw new Error('reserved key: ' + c);
  // Code Review NIT 1: Escape (and KeyP, the Ctrl+Shift+P second hotkey) belong to pause only, so Esc never also jumps/pounces
  if (action !== 'pause') for (const c of list) if (c === 'Escape' || c === 'KeyP') throw new Error('reserved for pause: ' + c);
  const out = { ...bindings, [action]: list.slice() };
  if (!out.pause || !out.pause.includes('Escape')) out.pause = ['Escape', ...(out.pause || [])];
  return out;
}

/** Gamepad standard-layout indices (Gamepad API "standard" mapping). Generic names only — no console brand art/names in UI. */
export const PAD = Object.freeze({
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, LS: 10, RS: 11,
  DU: 12, DD: 13, DL: 14, DR: 15,
});

/** Radial-ish 1D deadzone with rescale so the first usable value is 0, not 0.15. */
export function applyDeadzone(v, dz) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const s = (a - dz) / (1 - dz);
  return (v < 0 ? -s : s) > 1 ? (v < 0 ? -1 : 1) : (v < 0 ? -s : s);
}

/** Keyboard snapshot: { down: Set<code> | string[], heldMs?: {code: ms} }. heldMs lets a tapped key walk and a held key run. */
export function actionsFromKeyboard(snap, bindings = DEFAULT_KEYS, keyRunAfterMs = 400) {
  const down = snap.down instanceof Set ? snap.down : new Set(snap.down || []);
  const held = snap.heldMs || {};
  // Code Review SHOULD 2: a rebind map saved before an action existed (e.g. up/down for moveZ) falls back to DEFAULT_KEYS for it
  const codes = (action) => (Array.isArray(bindings[action]) ? bindings[action] : DEFAULT_KEYS[action] || []);
  const isDown = (action) => codes(action).some((c) => down.has(c));
  const heldFor = (action) => Math.max(0, ...codes(action).map((c) => (down.has(c) ? held[c] || 0 : 0)));
  const a = emptyActions();
  const l = isDown('left'), r = isDown('right');
  if (l !== r) {
    const ms = heldFor(l ? 'left' : 'right');
    const mag = ms >= keyRunAfterMs ? 1 : 0.6; // tap = walk band, hold = run band (spec 2)
    a.moveX = l ? -mag : mag;
  }
  const u = isDown('up'), dn = isDown('down');
  if (u !== dn) { const ms = heldFor(u ? 'up' : 'down'); const mag = ms >= keyRunAfterMs ? 1 : 0.6; a.moveZ = u ? mag : -mag; }
  for (const k of ['jump', 'pounce', 'swat', 'meow', 'emote', 'knead', 'nap', 'interact', 'pause']) a[k] = isDown(k) ? 1 : 0;
  a.sneak = isDown('sneak') ? 1 : 0;
  a.sprint = isDown('sprint') ? 1 : 0;
  return a;
}

/** Gamepad snapshot: { axes: number[], buttons: [{pressed, value}] | number[] } (plain data copied from navigator.getGamepads()). */
export function actionsFromGamepad(snap, deadZone = 0.15) {
  const a = emptyActions();
  if (!snap) return a;
  const axes = snap.axes || [];
  const b = (i) => { const x = snap.buttons && snap.buttons[i]; return x == null ? 0 : typeof x === 'number' ? x : (x.value != null ? x.value : (x.pressed ? 1 : 0)); };
  let x = applyDeadzone(axes[0] || 0, deadZone);
  if (b(PAD.DL) > 0.5) x = -0.6; else if (b(PAD.DR) > 0.5) x = 0.6; // d-pad = walk
  a.moveX = x;
  a.moveZ = -applyDeadzone(axes[1] || 0, deadZone); //: stick up = up the screen (floor plane only)
  a.jump = b(PAD.A) > 0.5 ? 1 : 0;
  a.swat = b(PAD.B) > 0.5 ? 1 : 0;
  a.pounce = b(PAD.X) > 0.5 ? 1 : 0;
  a.meow = b(PAD.Y) > 0.5 ? 1 : 0;
  a.emote = b(PAD.RB) > 0.5 ? 1 : 0;
  a.knead = b(PAD.LB) > 0.5 ? 1 : 0;
  a.interact = b(PAD.DU) > 0.5 ? 1 : 0;
  a.sneak = applyDeadzone(b(PAD.LT), deadZone);
  a.sprint = Math.max(applyDeadzone(b(PAD.RT), deadZone), b(PAD.LS) > 0.5 ? 1 : 0);
  a.pause = b(PAD.START) > 0.5 ? 1 : 0;
  return a;
}

/** Pointer: { x, y, kind } in WORLD BL units (host converts px -> BL). kind: 'walk' | 'sprint' | 'pounce'. */
export function actionsFromPointer(click) {
  const a = emptyActions();
  if (!click) return a;
  a.clickX = click.x; a.clickY = click.y;
  a.clickKind = click.kind === 'sprint' ? 2 : click.kind === 'pounce' ? 3 : 1;
  return a;
}

/** Merge several device records: digital = OR, analog = largest magnitude, click = the first present. */
export function mergeActions(...records) {
  const out = emptyActions();
  for (const r of records) {
    if (!r) continue;
    for (const k of ACTION_NAMES) {
      if (k === 'clickX' || k === 'clickY' || k === 'clickKind') continue;
      const v = r[k] || 0;
      if (Math.abs(v) > Math.abs(out[k])) out[k] = v;
    }
    if (r.clickKind && !out.clickKind) { out.clickKind = r.clickKind; out.clickX = r.clickX; out.clickY = r.clickY; }
  }
  return out;
}

/** Compact input log entry: only what changed is kept by the caller; here we just serialise deterministically. */
export function serialiseActions(a) {
  return ACTION_NAMES.map((k) => {
    const v = a[k];
    return Number.isNaN(v) ? 'n' : String(Math.round(v * 1000) / 1000);
  }).join(',');
}
export function parseActions(s) {
  const a = emptyActions();
  const parts = s.split(',');
  ACTION_NAMES.forEach((k, i) => { a[k] = parts[i] === 'n' ? NaN : parts[i] === undefined ? (k === 'clickX' || k === 'clickY' ? NaN : 0) : Number(parts[i]); });
  return a;
}

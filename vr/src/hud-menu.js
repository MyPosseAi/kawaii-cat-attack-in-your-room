/* vr/src/hud-menu.js - SK-HUD (owner 2026-10-11 top priority: "I couldn't select the action I wanted to do"): Quest HUD
   quick-stat strip + ACTION MENU, PURE state module (no three / WebXR / DOM / audio). Gaming Engineer 2 (GO run, Opus).
   Meta patterns: a lazy-follow panel 1.0 m ahead (HUD_TUNING.ahead; never the 0.5-0.8 m band), below the eye line, level, yaw
   only; BIG tiles (11 x 8 cm = 6.3 x 4.6 deg at 1.0 m), hover highlight + tip, a ray beam, a haptic tick on hover + a click on
   select (the picked tile stays up 200 ms, then the menu closes), captions + a tick sound in the host.
   GO1 fix round: HANDS keep their natural pinch (scruff / wand / box) and gestures (point = laser, stroke = pet, palm = treat):
   for a hand the menu tool only runs on a pinch for Call cats (the one action with no natural gesture). Controllers pet a kitten
   by holding the controller near its back (any tool); in Laser Tag the controller trigger always aims the dot.
   Input (every source works the same way):
     controllers: the targetRaySpace ray + trigger (WebXR select) picks; X / Y / A / B or a thumbstick click (xr-standard
       buttons 3 / 4 / 5) opens / closes the menu.
     hands: the hand ray + pinch (Quest hands send WebXR select on a pinch) picks; a fingertip POKE on a tile or the strip's
       "Menu" button works too; `wristToggle` (the paw button, wrist-menu.js) opens / closes it from the glue.
   A ray pick LOCKS its target at selectstart and COMMITS at selectend inside a 1.5x sticky box (else 'cancel'); a poke commits on
   its rising edge. QUEST3-HUD-COACH.md (Meta Quest 3 consultant) numbers: 1.0 m, level, yaw only, 6 cm+ targets, 1.2x hover-out.
   The picked action becomes the TOOL: the player's trigger / pinch then DOES it (hudToolEvents turns the press into the
   same gesture events gestures.js emits, so room-bridge routes them exactly like a hand gesture). Laser Tag is a command
   (starts the round while it is offered / on the score card), not a tool.
   Reliable select (the reason this exists): a source whose ray / fingertip is ON the panel is suppressed for the cats
   (suppress[hand].all), and a press that STARTED on the panel stays suppressed until it is released (latch), so the menu
   click never reaches a cat, even though the menu closes on select. hudFilterEvents applies it and fixes the two open
   SHOULDs: a point_end only passes for a hand whose point_start passed (Review row 451: no lone laser-off from a
   suppressed hand), and when suppression STARTS on a live point the hand gets ONE point_end (PM4: never a stuck dot).
   createLaserGate / laserGateFilter make laser-off hand-aware (roomcat shares one s.laser): an off from a hand that does
   not own the dot is dropped.
   hudMenuStep(st, input) -> st._out = { events, haptics, suppress, visual } (REUSED scratch objects, zero allocation per
   frame on the hot path: consume before the next step).
     input = { t, dt, head: { p, fwd } (fwd = flat or full gaze), sources: { left, right }, hide, wristToggle, enabled }
       sources[hand] = { kind: 'controller' | 'hand', ray: { o, d } | null, select: bool (held), button: bool (held, menu
         toggle; controllers), tip: p | null (index fingertip, hands), grip: p | null } or null when not tracked
       hide = true -> menu closed + nothing drawn (end card, vehicle); enabled = { [actionId]: false } greys a tile
     events: menu_open | menu_close | hover { hand, target } | select { hand, action } | tool { action } | command { action } | cancel { hand, target }
       | blocked { action } (a greyed tile was picked)
     haptics: [{ hand, strength, ms }] (controllers only: hand tracking has no actuator)
     suppress = { left: { all, pinch }, right: { ... } }
     visual = { open, hidden, active, pose: { c, r, u, n }, button: { p, hover, w, h }, tiles: [{ id, label, p, hover,
       active, disabled }], cursors: { left: p | null, right: p | null } }
   Build rule: only `export function` / `export const`; private names carry the `hm` / `HM_` prefix. */
export const HUD_MENU_VERSION = 4; // 4 (Q-GE2 SK-PORT wiring, owner yes 2026-10-11 05:06 UTC): Feather Pop + Yarn Tug command tiles (9 tiles = 3 x 3,
                                    // the same 3 rows as v3, so the panel height is unchanged), per-action blocked captions (HUD_BLOCKED), a
                                    // Kitten Needs hint outline on one tile (hudSetHint), a Back tile on the Furniture page, empty tiles inert.
                                    // 3 3 (Q-GE2, owner #7 + GO7 SHOULD 1): a Furniture tile opens a furniture picker page (same 7 tiles); the
                                    // Laser tool's trigger always lights the laser (no pet-lock), the trigger pets only with the Pet tool.
                                    // 2 (GE2-B, the owner's Quest test 2026-10-11 petting): controller pet reach is a column over the kitten
                                    // (petAboveM), a Laser trigger aimed AT a kitten pets her (lockR), pets pass the menu suppression unless that
                                    // source holds a menu press (latch)

export const HUD_TUNING = Object.freeze({
  ahead: 1.0, below: 0.4,            // QUEST3-HUD-COACH 1: 1.0 m ahead (never in the 0.5-0.8 m band), level, yaw-only; the strip 40 cm under
                                     // the eye line (~22 deg down); the tiles open ABOVE it, so the open menu is centred ~15 deg down
  followDeg: 32, followM: 0.3, followRate: 5, settleDeg: 3, // lazy follow: re-centre when the gaze is 32 deg off (or 0.3 m), ease at 5/s
  stripW: 0.36, stripH: 0.06,        // the always-on quick-stat strip
  btnW: 0.09, btnH: 0.06,            // its "Menu" button (right end of the strip): 5.1 x 3.4 deg at 1.0 m
  cols: 3, tileW: 0.11, tileH: 0.08, gap: 0.015, // action tiles 11 x 8 cm (6.3 x 4.6 deg at 1.0 m; coach: >= 6 cm / 3 deg), 1.5 cm gaps, 6 actions = 1 page
  hoverOut: 1.2, sticky: 1.5,        // hover hysteresis (out at 1.2x the box) and the held-press sticky box (commit at release inside 1.5x)
  coolS: 0.2,                        // after a menu commit / cancel the source waits 200 ms before the cats get its selects again
  margin: 0.03,                      // the panel's suppress area reaches this far past its tiles
  rayMax: 3.0,                       // a ray farther than this from the panel does not hit it
  pokeOn: 0.02, pokeOff: 0.035, pokeBack: 0.05, // fingertip poke: within 2 cm of the face (or up to 5 cm through it); off at 3.5 cm
  hoverHaptic: 0.15, hoverMs: 15, clickHaptic: 0.5, clickMs: 40, // coach 5 (own limiter: haptics.pulseHand, not the pounce limiter)
  closeOnSelect: true, closeS: 0.2, // the picked tile stays up (pressed) this long, then the menu closes (coach review MUST 2)
  beamM: 1.5, beamNearM: 0.1,       // the ray beam: to the hit point, else 1.5 m; shown while open or the ray is within 10 cm of the panel
  petNearM: 0.22,                   // a controller this close to a kitten's back pets it (any tool) ...
  petAboveM: 0.3,                   // ... or up to this much higher straight over her (a standing player's controller at ~0.65 m over a floor kitten)
  lockR: 0.15,                      // (unused since v3: GO7 SHOULD 1 / owner, the Laser trigger always lights the laser; kept for old tuning objects)
  petRayR: 0.35, pickMaxM: 5,        // controller pet / grab: the nearest cat within 35 cm of the ray, up to 5 m
  callAheadM: 0.8,                   // "Call cats": a laser dot on the floor 0.8 m in front of the player while held
});

export const HUD_ACTIONS = Object.freeze([
  Object.freeze({ id: 'laser', label: 'Laser', tip: 'Hold trigger (hands: point)' }),
  Object.freeze({ id: 'pet', label: 'Pet', tip: 'Aim at a kitten + hold trigger (or stroke it)' }),
  Object.freeze({ id: 'treat', label: 'Treat', tip: 'Hold trigger (hands: palm up)' }),
  Object.freeze({ id: 'toss', label: 'Grab + Toss', tip: 'Aim + hold to grab, let go to toss' }),
  Object.freeze({ id: 'call', label: 'Call cats', tip: 'Hold trigger / pinch: kittens come' }),
  Object.freeze({ id: 'laser_tag', label: 'Laser Tag', tip: 'Start a round', command: true }),
  Object.freeze({ id: 'feather', label: 'Feather Pop', tip: 'Snatch it before a kitten pounces', command: true }), // SK-PORT (QUEST-PORT-WIRING 1)
  Object.freeze({ id: 'tug', label: 'Yarn Tug', tip: 'Hold to pull, tap in rhythm', command: true }),             // SK-PORT
  Object.freeze({ id: 'furniture', label: 'Furniture', tip: 'Place, move, turn or remove furniture', command: true }), // Q-GE2 (owner #7): opens the picker page
]);
export const HUD_ACTION_IDS = Object.freeze(HUD_ACTIONS.map((a) => a.id));
/** Q-GE2: the Furniture picker page (wand.js FURN_VR_PICKER: 6 pieces + Remove = as many tiles as the main page). Picking one
 *  emits command 'furn:<kind>' (or 'furn:remove') and closes the menu; closing the menu always returns to the main page. */
export const HUD_FURN_TILES = Object.freeze(FURN_VR_PICKER.map((t) => Object.freeze({ id: 'furn:' + t.id, label: t.label, command: true,
  tip: t.id === 'remove' ? 'Remove the piece you touched last (or drop it on the bin)' : 'Grip / pinch it to move, twist or stick to turn' })).concat(
  [Object.freeze({ id: 'furn:back', label: 'Back', tip: 'Back to the actions', command: true })])); // SK-PORT: 9 main tiles, so the picker gets a Back tile
export const HUD_DEFAULT_ACTION = 'laser';
export const HUD_CAPTIONS = Object.freeze({ menu_open: '(actions)', tool: '', blocked: 'Laser Tag: fill the Happiness meter first', command: '' });
/** SK-PORT (Review PORT1 SHOULD 3): the caption for a greyed tile, by the REASON the glue greyed it (room-bridge b._hudWhy[action]) */
export const HUD_BLOCKED = Object.freeze({
  laser_tag: 'Laser Tag: fill the Happiness meter first', feather: 'Feather Pop: wait for the kittens to come out', tug: 'Yarn Tug: wait for the kittens to come out',
  lt: 'Finish Laser Tag first', feather_on: 'Finish the feather round first', tug_on: 'Finish the Yarn Tug first', no_kitten: 'Yarn Tug: no kitten close by. Look at one and try again',
});
export const HAND_IDS = Object.freeze(['left', 'right']);
const HM_BTN = 100, HM_NONE = -1;
import { FURN_VR_PICKER } from './wand.js';

function hmV() { return { x: 0, y: 0, z: 0 }; }
function hmSet(o, x, y, z) { o.x = x; o.y = y; o.z = z; return o; }
function hmSrcState() { return { petLock: false, petId: null, hover: HM_NONE, prevHover: HM_NONE, wasSel: false, wasBtn: false, latch: false, pokeIn: false, onPanel: false, toolOn: false, lock: -1, coolUntil: -1, onLock: false, dist: 0, rayPlane: false, gp: hmV(), lastGrip: hmV(), hasGrip: false, v: hmV(), cur: hmV(), hasCur: false, lu: 0, lv: 0 }; }
function hmEvPool(n) { const a = []; for (let i = 0; i < n; i++) a.push({ type: '', hand: '', target: '', action: '' }); return a; }
function hmGestPool() { return { move: { type: 'move', hand: '', p: hmV() }, ps: { type: 'point_start', hand: '', origin: hmV(), dir: hmV() }, ph: { type: 'point_hold', hand: '', origin: hmV(), dir: hmV() }, pe: { type: 'point_end', hand: '' },
  pet: { type: 'pet_hold', hand: '', p: hmV() }, palmS: { type: 'palm_start', hand: '', p: hmV() }, palmE: { type: 'palm_end', hand: '' }, pinchS: { type: 'pinch_start', hand: '', p: hmV() }, pinchR: { type: 'pinch_release', hand: '', v: hmV() }, ptEnd: { type: 'point_end', hand: '' } }; }

/** Tile centres in panel units (u right, v up) relative to the strip centre: row-major, top row first, the grid above the strip. */
export function hudLayout(tuning) {
  const T = tuning || HUD_TUNING, n = HUD_ACTIONS.length, cols = T.cols, rows = Math.ceil(n / cols);
  const gridW = cols * T.tileW + (cols - 1) * T.gap, out = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    out.push({ u: -gridW / 2 + T.tileW / 2 + c * (T.tileW + T.gap), v: T.stripH / 2 + T.gap + T.tileH / 2 + (rows - 1 - r) * (T.tileH + T.gap) });
  }
  return { tiles: out, gridW, gridH: rows * T.tileH + (rows - 1) * T.gap, btn: { u: T.stripW / 2 - T.btnW / 2, v: 0 } };
}

export function createHudMenu(opts = {}) {
  const T = Object.assign({}, HUD_TUNING, opts.tuning || {});
  const L = hudLayout(T);
  const tiles = HUD_ACTIONS.map((a, i) => ({ id: a.id, label: a.label, tip: a.tip, command: !!a.command, p: hmV(), hover: false, pressed: false, hint: false, active: a.id === HUD_DEFAULT_ACTION, disabled: false, u: L.tiles[i].u, v: L.tiles[i].v }));
  const pose = { c: hmV(), r: hmSet(hmV(), 1, 0, 0), u: hmSet(hmV(), 0, 1, 0), n: hmSet(hmV(), 0, 0, 1) };
  const visual = { page: 'main', open: false, hidden: false, active: HUD_DEFAULT_ACTION, pose, beams: { left: { show: false, o: hmV(), e: hmV() }, right: { show: false, o: hmV(), e: hmV() } }, hoverTip: '', button: { p: hmV(), hover: false, w: T.btnW, h: T.btnH }, tiles, cursors: { left: null, right: null }, placed: false };
  const st = { page: 'main', hint: '', T, L, open: false, active: opts.active && HUD_ACTION_IDS.includes(opts.active) ? opts.active : HUD_DEFAULT_ACTION, placed: false, following: false, opens: 0, selects: 0,
    src: { left: hmSrcState(), right: hmSrcState() }, events: [], haptics: [], _evPool: hmEvPool(16), _hPool: [{ hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }, { hand: '', strength: 0, ms: 0 }],
    _nEv: 0, _nH: 0, _toggled: false, closeAt: -1, picked: -1, _t: 0, _k: 0.5, _probe: { lu: 0, lv: 0 }, suppress: { left: { all: false, pinch: false }, right: { all: false, pinch: false } }, visual, _out: null,
    gest: { left: hmGestPool(), right: hmGestPool() }, live: { left: false, right: false }, toolOut: [], filtOut: [] };
  for (const t of tiles) t.active = t.id === st.active;
  visual.active = st.active;
  st._out = { st, events: st.events, haptics: st.haptics, suppress: st.suppress, visual };
  return st;
}

function hmEmit(st, type, hand, target, action) {
  const e = st._evPool[st._nEv < st._evPool.length ? st._nEv : st._evPool.length - 1];
  e.type = type; e.hand = hand || ''; e.target = target || ''; e.action = action || '';
  if (st._nEv < st._evPool.length) st.events[st._nEv++] = e;
}
function hmHaptic(st, hand, strength, ms) { if (st._nH >= st._hPool.length) return; const h = st._hPool[st._nH]; h.hand = hand; h.strength = strength; h.ms = ms; st.haptics[st._nH++] = h; }

/** Place the panel in front of the head (target pose), or ease toward it (k 0..1). */
function hmPlace(st, head, kIn) {
  const k = kIn < 0 ? st._k : kIn; // -1 = the follow rate in st._k (no computed double crosses a call)
  const T = st.T, p = head.p, f = head.fwd; let fx = f ? f.x : 0, fz = f ? f.z : -1; const fl = Math.sqrt(fx * fx + fz * fz);
  if (fl < 1e-6) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
  const tx = p.x + fx * T.ahead, ty = p.y - T.below, tz = p.z + fz * T.ahead, c = st.visual.pose.c;
  if (k >= 1 || !st.placed) { c.x = tx; c.y = ty; c.z = tz; } else { c.x += (tx - c.x) * k; c.y += (ty - c.y) * k; c.z += (tz - c.z) * k; }
  st.placed = true; st.visual.placed = true;
  hmBasis(st, head);
}
function hmBasis(st, head) {
  const P = st.visual.pose, c = P.c, p = head.p;
  let nx = p.x - c.x, ny = 0, nz = p.z - c.z; let nl = Math.sqrt(nx * nx + nz * nz); if (nl < 1e-6) { nx = 0; nz = 1; nl = 1; } nx /= nl; nz /= nl; // level, yaw only (coach 1 / 7)
  let rx = nz, rz = -nx; const rl = Math.sqrt(rx * rx + rz * rz); if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  // direct field writes: a helper taking a computed double boxes it (V8), and this runs every frame (zero-allocation test)
  P.n.x = nx; P.n.y = ny; P.n.z = nz; P.r.x = rx; P.r.y = 0; P.r.z = rz;
  P.u.x = ny * rz; P.u.y = nz * rx - nx * rz; P.u.z = -ny * rx; // u = n x r (r.y = 0)
}
/** Lazy follow: off by more than followDeg / followM -> ease back; frozen while any source is on the panel. */
function hmFollow(st, head, dt, busy) {
  const T = st.T, c = st.visual.pose.c, p = head.p, f = head.fwd;
  let fx = f ? f.x : 0, fz = f ? f.z : -1; const fl = Math.sqrt(fx * fx + fz * fz); if (fl < 1e-6) { fx = 0; fz = -1; } else { fx /= fl; fz /= fl; }
  const dx = c.x - p.x, dz = c.z - p.z, dl = Math.sqrt(dx * dx + dz * dz) || 1;
  const cos = (dx * fx + dz * fz) / dl, off = Math.abs(dl - T.ahead) + Math.abs((p.y - T.below) - c.y);
  if (!busy && (cos < Math.cos(T.followDeg * Math.PI / 180) || off > T.followM)) st.following = true;
  if (st.following && !busy) {
    st._k = 1 - Math.exp(-T.followRate * (dt > 0 ? dt : 0)); hmPlace(st, head, -1);
    const ex = c.x - p.x, ez = c.z - p.z, el = Math.sqrt(ex * ex + ez * ez) || 1;
    if ((ex * fx + ez * fz) / el > Math.cos(T.settleDeg * Math.PI / 180) && Math.abs(el - T.ahead) < 0.02) st.following = false;
  } // world-locked between re-centres: the basis only turns when the panel is (re)placed (coach 7: no motion while reading)
}

/** Which panel region (panel units lu, lv) is hit: HM_BTN, a tile index, -2 = on the panel but not a target, HM_NONE = off. */
export function hudRegion(st, lu, lv) { const s = st._probe; s.lu = lu; s.lv = lv; return hmRegion(st, s); }
function hmRegion(st, s) {
  const T = st.T, L = st.L, b = L.btn, lu = s.lu, lv = s.lv;
  if (Math.abs(lu - b.u) <= T.btnW / 2 && Math.abs(lv - b.v) <= T.btnH / 2) return HM_BTN;
  if (st.open) for (let i = 0; i < st.visual.tiles.length; i++) { const t = st.visual.tiles[i]; if (!t.id) continue; if (Math.abs(lu - t.u) <= T.tileW / 2 && Math.abs(lv - t.v) <= T.tileH / 2) return i; }
  const m = T.margin, halfW = Math.max(T.stripW, L.gridW) / 2 + m;
  if (Math.abs(lu) <= halfW && lv >= -T.stripH / 2 - m && lv <= (st.open ? T.stripH / 2 + T.gap + L.gridH : T.stripH / 2) + m) return -2;
  return HM_NONE;
}
/** Is (lu, lv) inside target idx (HM_BTN or a tile) grown by `scale` (hysteresis 1.2x, sticky 1.5x)? */
function hmInTarget(st, idx, s, scale) {
  const T = st.T, lu = s.lu, lv = s.lv;
  if (idx === HM_BTN) return Math.abs(lu - st.L.btn.u) <= T.btnW / 2 * scale && Math.abs(lv - st.L.btn.v) <= T.btnH / 2 * scale;
  const t = st.visual.tiles[idx]; if (!t || !st.open) return false;
  return Math.abs(lu - t.u) <= T.tileW / 2 * scale && Math.abs(lv - t.v) <= T.tileH / 2 * scale;
}
/** Ray (o, d) vs the panel's front face: true + writes s.lu / s.lv / s.cur when it hits within rayMax. */
function hmRay(st, s, ray) {
  if (!ray || !ray.o || !ray.d) return false;
  const P = st.visual.pose, o = ray.o, d = ray.d;
  const den = d.x * P.n.x + d.y * P.n.y + d.z * P.n.z;
  if (!(den < -1e-6)) return false; // parallel or from behind
  const t = ((P.c.x - o.x) * P.n.x + (P.c.y - o.y) * P.n.y + (P.c.z - o.z) * P.n.z) / den;
  if (!(t > 0) || t > st.T.rayMax) return false;
  s.rayPlane = true;
  s.cur.x = o.x + d.x * t; s.cur.y = o.y + d.y * t; s.cur.z = o.z + d.z * t;
  const qx = s.cur.x - P.c.x, qy = s.cur.y - P.c.y, qz = s.cur.z - P.c.z;
  s.lu = qx * P.r.x + qy * P.r.y + qz * P.r.z; s.lv = qx * P.u.x + qy * P.u.y + qz * P.u.z;
  return true;
}
/** Fingertip vs the panel: s.dist = signed distance along the normal (+ = in front); false when there is no fingertip. */
function hmTip(st, s, tip) {
  if (!tip) return false;
  const P = st.visual.pose, qx = tip.x - P.c.x, qy = tip.y - P.c.y, qz = tip.z - P.c.z;
  s.lu = qx * P.r.x + qy * P.r.y + qz * P.r.z; s.lv = qx * P.u.x + qy * P.u.y + qz * P.u.z;
  s.dist = qx * P.n.x + qy * P.n.y + qz * P.n.z;
  return true;
}

/** The panel is more than followDeg (or followM) off the head's forward (the lazy-follow test). */
function hmOff(st, head) {
  const T = st.T, c = st.visual.pose.c, p = head.p, f = head.fwd;
  const fx0 = f ? f.x : 0, fz0 = f ? f.z : -1, fl = Math.sqrt(fx0 * fx0 + fz0 * fz0) || 1;
  const dx = c.x - p.x, dz = c.z - p.z, dl = Math.sqrt(dx * dx + dz * dz) || 1;
  return (dx * fx0 + dz * fz0) / (dl * fl) < Math.cos(T.followDeg * Math.PI / 180) || Math.abs(dl - T.ahead) + Math.abs((p.y - T.below) - c.y) > T.followM;
}
/** One open / close per frame, whatever asked (Y / X button, strip button, wrist paw): two paths never both toggle (coach review 7). */
function hmToggle(st, head) { if (st._toggled) return; st._toggled = true; hmSetOpen(st, !st.open, head); }
function hmSetOpen(st, open, head) {
  if (open === st.open) return;
  st.open = open; st.visual.open = open;
  if (open) { st.opens++; if (head && (!st.placed || hmOff(st, head))) hmPlace(st, head, 1); hmEmit(st, 'menu_open'); } else { st.closeAt = -1; st.picked = -1; if (st.page === 'furniture') hmFurnPage(st, false); hmEmit(st, 'menu_close'); } // coach MUST 4: no jump under the pointer
}
/** Q-GE2: show the Furniture picker page (on) or the main actions (off) on the same tile objects */
function hmFurnPage(st, on) {
  const list = on ? HUD_FURN_TILES : HUD_ACTIONS, tiles = st.visual.tiles;
  for (let i = 0; i < tiles.length; i++) { const a = list[i] || null, t = tiles[i]; t.id = a ? a.id : ''; t.label = a ? a.label : ''; t.tip = a ? a.tip : ''; t.command = !!(a && a.command); t.active = !on && t.id === st.active; t.hover = false; t.hint = !on && st.hint !== '' && t.id === st.hint; }
  st.page = on ? 'furniture' : 'main'; st.visual.page = st.page;
}
function hmPick(st, hand, s, idx, input) {
  if (idx === HM_BTN) { hmToggle(st, input.head); hmHaptic(st, hand, st.T.clickHaptic, st.T.clickMs); return; }
  const tile = st.visual.tiles[idx]; if (!tile || !tile.id || st.closeAt >= 0) return; // SK-PORT: an empty picker slot is inert
  if (tile.disabled) { hmHaptic(st, hand, 0.2, 12); hmHaptic(st, hand, 0.2, 12); hmEmit(st, 'blocked', hand, '', tile.id); return; } // a weaker double tick: not a success
  hmHaptic(st, hand, st.T.clickHaptic, st.T.clickMs);
  st.selects++;
  hmEmit(st, 'select', hand, '', tile.id);
  if (tile.id === 'furniture') { hmFurnPage(st, true); return; } // the picker opens in place: the menu stays open
  if (tile.id === 'furn:back') { hmFurnPage(st, false); return; } // SK-PORT: back to the actions, the menu stays open
  if (tile.command) hmEmit(st, 'command', hand, '', tile.id);
  else if (tile.id !== st.active) { st.active = tile.id; for (const t of st.visual.tiles) t.active = t.id === st.active; st.visual.active = st.active; hmEmit(st, 'tool', hand, '', tile.id); }
  if (st.T.closeOnSelect) { st.closeAt = st._t + st.T.closeS; st.picked = idx; }
}

/** One frame. See the file header for input / output. */
export function hudMenuStep(st, input) {
  const T = st.T, inp = input || {}, head = inp.head && inp.head.p ? inp.head : null;
  st._nEv = 0; st._nH = 0; st._toggled = false; st._t = Number.isFinite(inp.t) ? inp.t : st._t;
  if (st.closeAt >= 0 && st._t >= st.closeAt) hmSetOpen(st, false, null);
  const hidden = !!inp.hide || !head;
  st.visual.hidden = hidden;
  const en = inp.enabled || null;
  for (let ti = 0; ti < st.visual.tiles.length; ti++) { const t = st.visual.tiles[ti]; t.disabled = !!(en && en[t.id] === false); }
  if (hidden) {
    if (st.open) hmSetOpen(st, false, null);
    for (let hi = 0; hi < 2; hi++) { const h = hi ? 'right' : 'left', s = st.src[h], sup = st.suppress[h]; const sel = !!(inp.sources && inp.sources[h] && inp.sources[h].select); s.lock = HM_NONE; if (!sel) s.latch = false; s.wasSel = sel; s.hover = HM_NONE; s.prevHover = HM_NONE; s.hasCur = false; s.pokeIn = false; s.onPanel = false; sup.all = s.latch; sup.pinch = false; st.visual.cursors[h] = null; }
    st.events.length = st._nEv; st.haptics.length = st._nH; return st._out;
  }
  if (!st.placed) hmPlace(st, head, 1);
  if (inp.wristToggle) hmToggle(st, head);
  let busy = false;
  for (let hi = 0; hi < 2; hi++) { const h = hi ? 'right' : 'left'; // indexed loops: for-of allocated an iterator per frame here (GC test)
    const src = inp.sources ? inp.sources[h] : null, s = st.src[h], sup = st.suppress[h];
    s.prevHover = s.hover; s.hover = HM_NONE; s.onPanel = false; s.hasCur = false; s.rayPlane = false;
    if (!src) { s.wasSel = false; s.wasBtn = false; s.latch = false; s.pokeIn = false; sup.all = false; sup.pinch = false; st.visual.cursors[h] = null; continue; }
    const sel = !!src.select, btn = !!src.button;
    // 1. menu toggle button (controllers): rising edge
    if (btn && !s.wasBtn) { hmToggle(st, head); hmHaptic(st, h, T.clickHaptic * 0.6, T.clickMs); }
    s.wasBtn = btn;
    // 2. fingertip poke (hands): rising edge into pokeOn, off past pokeOff
    let poked = HM_NONE;
    if (hmTip(st, s, src.tip)) {
      const dist = s.dist;
      const reg = hmRegion(st, s);
      const inside = reg !== HM_NONE && dist <= (s.pokeIn ? T.pokeOff : T.pokeOn) && dist >= -T.pokeBack;
      if (reg !== HM_NONE && dist <= T.pokeOff + 0.03 && dist >= -T.pokeBack) { s.onPanel = true; s.hover = reg >= 0 || reg === HM_BTN ? reg : s.hover; }
      if (inside && !s.pokeIn && (reg >= 0 || reg === HM_BTN)) poked = reg;
      s.pokeIn = inside;
    } else s.pokeIn = false;
    // 3. ray + select (controller trigger / hand pinch)
    const t = Number.isFinite(inp.t) ? inp.t : 0;
    s.onLock = false;
    if (hmRay(st, s, src.ray)) {
      const reg = hmRegion(st, s);
      if (reg !== HM_NONE || (s.prevHover !== HM_NONE && hmInTarget(st, s.prevHover, s, T.hoverOut)) || (s.lock !== HM_NONE && hmInTarget(st, s.lock, s, T.sticky))) {
        s.onPanel = true; s.hasCur = true;
        if (s.hover === HM_NONE) {
          if (s.prevHover !== HM_NONE && hmInTarget(st, s.prevHover, s, T.hoverOut)) s.hover = s.prevHover; // hysteresis: out at 1.2x
          else if (reg >= 0 || reg === HM_BTN) s.hover = reg;
        }
        if (s.lock !== HM_NONE && hmInTarget(st, s.lock, s, T.sticky)) { s.onLock = true; s.hover = s.lock; } // sticky 1.5x while held
      }
    }
    const pressed = sel && !s.wasSel, released = !sel && s.wasSel;
    // coach 3: LOCK the target at selectstart, COMMIT at selectend if the ray is still inside the 1.5x sticky box, else cancel
    // (a pinch moves the ray: a commit on whatever sits under the ray at release picks the wrong item)
    if (pressed && s.onPanel) { s.latch = true; s.lock = s.hover; s.onLock = s.hover !== HM_NONE; } // a press that starts on the panel never reaches a cat (until released)
    if (poked !== HM_NONE) { s.latch = true; hmPick(st, h, s, poked, inp); s.coolUntil = t + T.coolS; }
    else if (released && s.lock !== HM_NONE) {
      const idx = s.lock; s.lock = HM_NONE;
      if (s.onLock) hmPick(st, h, s, idx, inp); else hmEmit(st, 'cancel', h, idx === HM_BTN ? 'menu' : st.visual.tiles[idx].id);
      s.coolUntil = t + T.coolS;
    } else if (released && s.latch) s.coolUntil = t + T.coolS;
    if (!sel && !s.pokeIn) { s.latch = false; s.lock = HM_NONE; } // released (and not poking): the source talks to the cats again after coolS
    s.wasSel = sel;
    // hover feedback: a tick on every NEW target
    if (s.hover !== s.prevHover && s.hover !== HM_NONE) { hmEmit(st, 'hover', h, s.hover === HM_BTN ? 'menu' : st.visual.tiles[s.hover].id); hmHaptic(st, h, T.hoverHaptic, T.hoverMs); }
    sup.all = s.onPanel || s.latch || t < s.coolUntil;
    sup.pinch = false;
    if (s.onPanel) busy = true;
    st.visual.cursors[h] = s.hasCur ? s.cur : null;
    hmBeam(st, st.visual.beams[h], s, src);
  }
  hmFollow(st, head, inp.dt, busy);
  // visual: hover flags + world positions of the button / tiles
  const P = st.visual.pose, L = st.L;
  let hb = false; for (let hi = 0; hi < 2; hi++) if (st.src[hi ? 'right' : 'left'].hover === HM_BTN) hb = true;
  st.visual.button.hover = hb;
  let tipIdx = -1; for (let hi = 0; hi < 2; hi++) { const hv = st.src[hi ? 'right' : 'left'].hover; if (hv >= 0 && hv < st.visual.tiles.length) tipIdx = hv; }
  st.visual.hoverTip = st.open && tipIdx >= 0 ? st.visual.tiles[tipIdx].tip : '';
  const bp = st.visual.button.p; bp.x = P.c.x + P.r.x * L.btn.u + P.u.x * L.btn.v; bp.y = P.c.y + P.r.y * L.btn.u + P.u.y * L.btn.v; bp.z = P.c.z + P.r.z * L.btn.u + P.u.z * L.btn.v;
  for (let i = 0; i < st.visual.tiles.length; i++) {
    const t = st.visual.tiles[i]; t.hover = st.open && (st.src.left.hover === i || st.src.right.hover === i); t.pressed = st.open && (st.picked === i || (st.src.left.lock === i && st.src.left.onLock) || (st.src.right.lock === i && st.src.right.onLock));
    t.p.x = P.c.x + P.r.x * t.u + P.u.x * t.v; t.p.y = P.c.y + P.r.y * t.u + P.u.y * t.v; t.p.z = P.c.z + P.r.z * t.u + P.u.z * t.v;
  }
  st.events.length = st._nEv; st.haptics.length = st._nH;
  return st._out;
}

/** The ray beam for one source: from the ray origin to the panel hit, else beamM; shown while the menu is open or the ray is near. */
function hmBeam(st, b, s, src) {
  const r = src && src.ray; b.show = false;
  if (!r || !r.o || !r.d) return;
  const near = s.hasCur || (Math.abs(s.lu) < st.T.stripW && hmRayNear(st, s));
  if (!st.open && !near) return;
  b.show = true; b.o.x = r.o.x; b.o.y = r.o.y; b.o.z = r.o.z;
  if (s.hasCur) { b.e.x = s.cur.x; b.e.y = s.cur.y; b.e.z = s.cur.z; } else { const L = st.T.beamM; b.e.x = r.o.x + r.d.x * L; b.e.y = r.o.y + r.d.y * L; b.e.z = r.o.z + r.d.z * L; }
}
function hmRayNear(st, s) { // the last ray-plane hit (lu / lv) within beamNearM of the panel's edge (hmRay wrote lu / lv when it hit the plane)
  const T = st.T, m = T.beamNearM, halfW = Math.max(T.stripW, st.L.gridW) / 2 + m;
  return s.rayPlane && Math.abs(s.lu) <= halfW && s.lv >= -T.stripH / 2 - m && s.lv <= T.stripH / 2 + m;
}
/** Glue helper: set the active tool directly (tests / a restored setting). Returns true when it changed. */
export function hudSetActive(st, id) { if (!HUD_ACTION_IDS.includes(id) || HUD_ACTIONS.find((a) => a.id === id).command || st.active === id) return false; st.active = id; st.visual.active = id; for (const t of st.visual.tiles) t.active = t.id === id; return true; }

function hmNorm(o, x, y, z) { const l = Math.sqrt(x * x + y * y + z * z) || 1; return hmSet(o, x / l, y / l, z / l); }
/** The cat nearest the ray (perpendicular distance <= petRayR, ahead, within pickMaxM) or null. cats = [{ x, y, z }]. */
export function hudPickCat(cats, ray, tuning, radius) {
  const T = tuning || HUD_TUNING; if (!cats || !ray || !ray.o || !ray.d) return null;
  let best = null, bd = radius > 0 ? radius : T.petRayR;
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i]; const qx = c.x - ray.o.x, qy = c.y - ray.o.y, qz = c.z - ray.o.z, t = qx * ray.d.x + qy * ray.d.y + qz * ray.d.z;
    if (!(t > 0) || t > T.pickMaxM) continue;
    const px = qx - ray.d.x * t, py = qy - ray.d.y * t, pz = qz - ray.d.z * t, d = Math.sqrt(px * px + py * py + pz * pz);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}

/**
 * The ACTIVE tool -> gesture events (gestures.js shapes) for one hand this frame, written into a reused array.
 * ctx = { head: { p, fwd }, floorY, targets (catBackPoint list: pet), grabs ([{ x, y, z }] scruff points: toss), dt }.
 * Controllers also get a `move` every frame (plan 2.9 host contract: a cat carried by / a treat on that controller follows it).
 * Hands keep their natural gestures (stroke, palm up, point, pinch); their pinch (select) runs the tool too, except
 * 'toss' (the natural pinch already grabs) - and while it does, suppress[hand].pinch drops the natural pinch_start.
 * A suppressed source (on the panel / latched) emits nothing new and ends what it was doing.
 */
export function hudToolEvents(st, hand, src, ctx) {
  const out = st.toolOut; let n = 0;
  const s = st.src[hand], g = st.gest[hand], sup = st.suppress[hand], T = st.T, c = ctx || {};
  if (!src) { if (s.toolOn) { s.toolOn = false; } s.hasGrip = false; out.length = 0; return out; }
  const isCtl = src.kind !== 'hand', tool = isCtl && c.forceLaser ? 'laser' : st.active, grip = src.grip || (src.ray && src.ray.o) || null;
  // controller velocity (for the toss) from the grip track
  if (grip) { if (s.hasGrip && c.dt > 0) hmSet(s.v, (grip.x - s.lastGrip.x) / c.dt, (grip.y - s.lastGrip.y) / c.dt, (grip.z - s.lastGrip.z) / c.dt); hmSet(s.lastGrip, grip.x, grip.y, grip.z); s.hasGrip = true; }
  if (isCtl && grip) { g.move.hand = hand; hmSet(g.move.p, grip.x, grip.y, grip.z); out[n++] = g.move; }
  // GO1 MUST 1: a hand's pinch keeps its natural meaning (scruff / wand / box); only Call cats (no natural gesture) uses it
  const runs = isCtl || tool === 'call';
  const want = runs && !!src.select && !sup.all && !s.latch;
  sup.pinch = false;
  // petting with a controller: held near / over a kitten's back it pets (any tool, not while grabbing); the Pet tool also pets
  // by ray. GE2-B: the reach is a column over her (hmPetD2: a standing player's controller over a floor kitten) and only a
  // MENU press (latch) blocks it (a ray grazing the strip while the controller is down at a kitten must not swallow the pet)
  if (isCtl && grip && !s.latch && !(s.toolOn && s.tool === 'toss') && c.targets) {
    let best = null, bi = -1, bd = T.petNearM * T.petNearM; // squared distances, nearest by index (no double crosses a phi: GC test)
    for (let i = 0; i < c.targets.length; i++) { const d2 = hmPetD2(c.targets[i], grip, T.petAboveM); if (d2 <= bd) { bd = d2; bi = i; } }
    if (bi >= 0) best = c.targets[bi];
    if (best && !(want && (tool === 'pet' || s.petLock))) { const e = g.pet; e.hand = hand; e.p.x = best.x; e.p.y = best.y; e.p.z = best.z; out[n++] = e; }
  }
  // GO7 SHOULD 1 (Q-GE2, owner): no pet-lock for the Laser tool any more: its trigger ALWAYS lights the laser (the natural lure beside a
  // kitten works); the trigger pets only with the Pet tool. Holding the controller at a kitten's back (above) pets with any tool.
  if (want && !s.toolOn) { s.toolOn = true; s.tool = tool; s.petLock = false; s.petId = null; n = hmToolStart(st, hand, src, c, out, n); }
  else if (want && s.toolOn && (s.tool === tool || s.petLock)) n = hmToolHold(st, hand, src, c, out, n);
  else if (s.toolOn) { n = hmToolEnd(st, hand, src, c, out, n); s.toolOn = false; s.petLock = false; s.petId = null; if (want) { s.toolOn = true; s.tool = tool; n = hmToolStart(st, hand, src, c, out, n); } }
  out.length = n;
  return out;
}
function hmD2(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }
/** squared PET REACH distance (gestures.js petDist): height over the back counts only past `above` */
function hmPetD2(q, p, above) { const dx = p.x - q.x, dz = p.z - q.z; let dy = p.y - q.y; if (dy > 0) dy = dy > above ? dy - above : 0; return dx * dx + dy * dy + dz * dz; }
function hmCallRay(g, c, T) {
  const h = c.head && c.head.p ? c.head : null; if (!h) return false;
  let fx = h.fwd ? h.fwd.x : 0, fz = h.fwd ? h.fwd.z : -1; const fl = Math.sqrt(fx * fx + fz * fz) || 1; fx /= fl; fz /= fl;
  const fy = Number.isFinite(c.floorY) ? c.floorY : 0;
  hmSet(g.origin, h.p.x, h.p.y, h.p.z); hmNorm(g.dir, fx * T.callAheadM, fy + 0.01 - h.p.y, fz * T.callAheadM); return true;
}
function hmRayInto(g, src) { if (!src.ray || !src.ray.o || !src.ray.d) return false; hmSet(g.origin, src.ray.o.x, src.ray.o.y, src.ray.o.z); hmSet(g.dir, src.ray.d.x, src.ray.d.y, src.ray.d.z); return true; }
function hmToolStart(st, hand, src, c, out, n) {
  const g = st.gest[hand], tool = st.src[hand].tool, T = st.T;
  if (tool === 'laser' || tool === 'call') { const e = g.ps; e.hand = hand; if (tool === 'laser' ? hmRayInto(e, src) : hmCallRay(e, c, T)) { out[n++] = e; st.live[hand] = true; } return n; }
  if (tool === 'treat') { const p = src.grip || (src.ray && src.ray.o); if (p) { const e = g.palmS; e.hand = hand; hmSet(e.p, p.x, p.y, p.z); out[n++] = e; } return n; }
  if (tool === 'toss') { const cat = hudPickCat(c.grabs, src.ray, T); if (cat) { const e = g.pinchS; e.hand = hand; hmSet(e.p, cat.x, cat.y, cat.z); out[n++] = e; } return n; }
  return hmToolHold(st, hand, src, c, out, n); // pet: every held frame
}
function hmToolHold(st, hand, src, c, out, n) {
  const g = st.gest[hand], tool = st.src[hand].tool, T = st.T;
  if (tool === 'laser' || tool === 'call') { const e = g.ph; e.hand = hand; if (tool === 'laser' ? hmRayInto(e, src) : hmCallRay(e, c, T)) { out[n++] = e; st.live[hand] = true; } return n; }
  if (tool === 'pet') {
    const s = st.src[hand]; let cat = null;
    if (s.petId != null && c.targets) for (let i = 0; i < c.targets.length; i++) if (c.targets[i].id === s.petId) { cat = c.targets[i]; break; } // sticky: the kitten picked at selectstart
    if (!cat) { cat = hudPickCat(c.targets, src.ray, T); if (cat && cat.id != null) s.petId = cat.id; }
    if (cat) { const e = g.pet; e.hand = hand; hmSet(e.p, cat.x, cat.y, cat.z); out[n++] = e; }
    return n;
  }
  return n; // treat / toss: the controller's move carries it
}
function hmToolEnd(st, hand, src, c, out, n) {
  const g = st.gest[hand], tool = st.src[hand].tool, s = st.src[hand];
  if (tool === 'laser' || tool === 'call') { const e = g.pe; e.hand = hand; out[n++] = e; return n; }
  if (tool === 'treat') { const e = g.palmE; e.hand = hand; out[n++] = e; return n; }
  if (tool === 'toss') { const e = g.pinchR; e.hand = hand; hmSet(e.v, s.v.x, s.v.y, s.v.z); out[n++] = e; return n; }
  return n;
}

/**
 * Drop what `suppress` says to drop from a hand's gesture events (natural + tool), written into `into` (reused):
 * all -> only move / lost pass (+ ONE point_end if that hand's laser was live: PM4, never a stuck dot);
 * pinch -> the natural pinch_start is dropped (the pinch is running the tool).
 * point_end passes only for a hand whose point_start / point_hold passed (Review row 451: no lone laser-off).
 */
export function hudFilterEvents(st, events, into) {
  const out = into || st.filtOut; let n = 0;
  if (Array.isArray(events)) for (let i = 0; i < events.length; i++) {
    const e = events[i], h = e.hand === 'left' ? 'left' : 'right', s = st.suppress[h];
    const isPoint = e.type === 'point_start' || e.type === 'point_hold';
    const isPet = e.type === 'pet_start' || e.type === 'pet_hold' || e.type === 'pet_end';
    if (s && s.all && e.type !== 'move' && e.type !== 'lost' && !(isPet && !st.src[h].latch)) { // GE2-B: a pet is AT a kitten, never a menu click
      if ((isPoint || e.type === 'point_end') && st.live[h]) { const pe = st.gest[h].ptEnd; pe.hand = h; out[n++] = pe; st.live[h] = false; }
      continue;
    }
    if (s && s.pinch && e.type === 'pinch_start' && e !== st.gest[h].pinchS) continue;
    if (e.type === 'point_end') { if (!st.live[h]) continue; st.live[h] = false; }
    else if (isPoint) st.live[h] = true;
    out[n++] = e;
  }
  if (out.length > n) out.length = n;
  return out;
}

/** roomcat shares ONE laser dot for both hands: an `off` from a hand that does not own the dot is dropped (filters in place). */
export function createLaserGate() { return { owner: null }; }
export function laserGateFilter(gate, roomEvents) {
  let n = 0;
  for (let i = 0; i < roomEvents.length; i++) {
    const e = roomEvents[i];
    if (e && e.type === 'laser') {
      const h = e.hand || 'right';
      if (e.on === false) { if (gate.owner !== null && gate.owner !== h) continue; gate.owner = null; } else gate.owner = h;
    }
    roomEvents[n++] = e;
  }
  roomEvents.length = n;
  return roomEvents;
}

/** SK-PORT (QUEST-PORT-WIRING 18): outline the tile `id` (a Kitten Needs hint: 'treat' | 'laser' | 'pet'; '' / null = none). No allocation. */
export function hudSetHint(st, id) {
  const h = id && HUD_ACTION_IDS.includes(id) ? id : '';
  if (st.hint === h) return false;
  st.hint = h; for (let i = 0; i < st.visual.tiles.length; i++) { const t = st.visual.tiles[i]; t.hint = st.page === 'main' && h !== '' && t.id === h; }
  return true;
}

/** Quick stats for the strip (short + large): director view + state. Returns plain strings; the host redraws on change.
 *  port (optional, SK-PORT) = { line2: string | null (a Feather Pop / Yarn Tug / Kitten Needs line replaces line 2 outside Laser Tag),
 *  needs: { id, name, hunger, play, cuddle, sleepy } (10 % steps) | null, needsKey: string } */
export function hudStats(dir, state, active, port) {
  const mode = dir ? dir.mode : 'play';
  const label = { play: 'Play', celebrate: 'Yay!', offer: 'Tag ready', countdown: 'Laser Tag', playing: 'Laser Tag', scorecard: 'Score' }[mode] || 'Play';
  let cats = 0; if (state && state.cats) for (const c of state.cats) if (c.mode !== 'inbox') cats++;
  const act = HUD_ACTIONS.find((a) => a.id === active);
  const happy = dir && Number.isFinite(dir.meter) ? Math.round(Math.max(0, Math.min(1, dir.meter)) * 20) * 5 : 0; // 5 % steps: the strip redraws rarely
  const line1 = `${act ? act.label : ''} | ${label}`;
  const line2 = mode === 'playing' && dir.hud ? String(dir.hud) : port && port.line2 ? port.line2 : `Happy ${happy}%  Cats ${cats}`;
  const needs = port && port.needs && port.needsKey ? port.needs : null;
  return { line1, line2, key: line1 + '|' + line2 + (needs ? '|' + port.needsKey : ''), happy, cats, mode: label, action: act ? act.label : '', needs };
}

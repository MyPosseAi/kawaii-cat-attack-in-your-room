// W2 (Gaming Engineer 2): the IWSDK-side glue between main.js and the room sim.
// room-bridge.js owns the logic (scene -> createRoom input, gestures -> roomcat events, state -> billboards) and is
// node-tested; this file only keeps three.js objects in step with the bridge's plain data: a billboard per cat
// (cat-billboard.js), the cardboard box, the laser dot. No IWSDK import here either (plain three + the bridge).
//
// HOST CONTRACT (plan 2.9), honoured by room-bridge.frame(): a { type: 'move', hand, p } goes to roomcat for EVERY
// tracked hand on EVERY tracked frame (not only while pinching / holding a treat): 3 s with no event from a hand
// (ROOMCAT_TUNING.handLostS) = tracking lost, so its carried cat is released and a cat on its palm hops down.
// Meshes reach room.js as { id, label, min, max, footprint } with footprint = the convex hull of the mesh's local box
// corners after its pose (room-bridge meshToRoom): a yawed couch is couch-sized, not AABB-sized.
// W3 (GE2): the feather wand + toy basket (wand.js state -> a stick, a feather, a basket), the head-locked hint /
// caption card and the end card (hints.js / end-card.js data -> one CanvasTexture card), per-sprite textures through
// cat-billboard's shared cache. Still only three + the bridge's plain data.
import { BoxGeometry, CanvasTexture, CircleGeometry, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';
const UP = new Vector3(0, 1, 0), tmpV = new Vector3();
import { createCatBillboard, createSpriteCache } from './cat-billboard.js';
import { createRoomBridge } from './room-bridge.js';
import { WAND_TUNING } from './wand.js';

const BOX_SIZE_M = 0.28; // roomcat: boxR 0.14, boxH 0.3
const CARD_W = 0.42, CARD_H = 0.12, CARD_AHEAD = 0.9, CARD_BELOW = 0.22; // head-locked hint card (metres)
const END_W = 0.6, END_H = 0.42;

/** A text card on a quad (original look: dark rounded panel, pale text). lines = string[]. */
function makeCard(w, h, px) {
  const canvas = document.createElement('canvas');
  canvas.width = px; canvas.height = Math.round(px * h / w);
  const tex = new CanvasTexture(canvas); tex.colorSpace = SRGBColorSpace;
  const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
  mesh.renderOrder = 999; mesh.visible = false;
  const draw = (lines, big) => {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!lines || !lines.length) { tex.needsUpdate = true; return; }
    ctx.fillStyle = 'rgba(29, 22, 38, 0.82)';
    const r = H * 0.18; ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(W - r, 0); ctx.quadraticCurveTo(W, 0, W, r); ctx.lineTo(W, H - r); ctx.quadraticCurveTo(W, H, W - r, H); ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H - r); ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff3e6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const fs = Math.min(H * 0.42, W / Math.max(12, Math.max(...lines.map((l) => l.length)) * 0.62), big ? H / (lines.length + 1) : H * 0.42);
    ctx.font = `600 ${Math.round(fs)}px system-ui, sans-serif`;
    const step = fs * 1.3, y0 = H / 2 - step * (lines.length - 1) / 2;
    lines.forEach((l, i) => { if (i === 0 && big) ctx.font = `700 ${Math.round(fs * 1.15)}px system-ui, sans-serif`; ctx.fillText(l, W / 2, y0 + i * step, W * 0.92); if (i === 0 && big) ctx.font = `600 ${Math.round(fs)}px system-ui, sans-serif`; });
    tex.needsUpdate = true;
  };
  return { mesh, draw, tex };
}

/**
 * createRoomHook({ seed, cats, size, arc, onLog, roster, visit, names, persisted, leftHanded, memory, draw }) -> { bridge, group, sync(result, head, gaze), cats, dispose() }
 * (persisted = the visit was saved locally, visit-store.js: only then does the end card promise a new kitten tomorrow)
 *   group: add it to the scene (persistent entity). sync() is called every frame with bridge.frame()'s result (+ the head
 *   position / gaze so the hint card can float in front of the player).
 *   dispose(): removes every child, frees geometries / materials / textures and the bridge; the hook is dead after it.
 *   One hook = one XR session (W2 review MUST 1): main.js builds a fresh one on every session so the room is re-scanned
 *   in the new local-floor frame.
 */
export function createRoomHook(opts = {}) {
  const bridge = createRoomBridge({ seed: opts.seed, cats: opts.cats, size: opts.size, arc: opts.arc, onLog: opts.onLog, roster: opts.roster, visit: opts.visit, names: opts.names, persisted: opts.persisted, leftHanded: opts.leftHanded, memory: opts.memory });
  const group = new Group();
  group.name = 'kca-room';
  const cats = new Map(); // cat id -> billboard
  const cache = createSpriteCache({ draw: opts.draw }); // W3: one texture per (cat, view, pose), shared by the billboards
  let disposed = false;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // W3: toy basket (a short open cylinder) + the feather wand (a thin stick from the handle to the tip, a feather disc at the tip)
  const basket = new Mesh(new CylinderGeometry(WAND_TUNING.basketR, WAND_TUNING.basketR * 0.8, WAND_TUNING.basketH, 20, 1, true), new MeshBasicMaterial({ color: 0xd9b382, side: DoubleSide }));
  basket.visible = false; group.add(basket);
  const stick = new Mesh(new CylinderGeometry(0.004, 0.004, 1, 6), new MeshBasicMaterial({ color: 0x6b4a3a }));
  stick.visible = false; group.add(stick);
  const feather = new Mesh(new CircleGeometry(0.035, 12), new MeshBasicMaterial({ color: 0xff9ec7, side: DoubleSide, transparent: true, opacity: 0.95 }));
  feather.visible = false; group.add(feather);
  // head-locked cards: hint / caption (small, below the gaze) and the end card (bigger, centred)
  const card = makeCard(CARD_W, CARD_H, 512); group.add(card.mesh);
  const endCard = makeCard(END_W, END_H, 768); group.add(endCard.mesh);
  let cardLines = '';

  const box = new Mesh(
    new BoxGeometry(BOX_SIZE_M, BOX_SIZE_M * 1.07, BOX_SIZE_M),
    new MeshBasicMaterial({ color: 0xc8a165 }),
  );
  box.visible = false;
  group.add(box);
  const lid = new Mesh(new BoxGeometry(BOX_SIZE_M, 0.01, BOX_SIZE_M), new MeshBasicMaterial({ color: 0xb08a50 }));
  lid.position.y = BOX_SIZE_M * 1.07 / 2;
  box.add(lid);

  const laser = new Mesh(new CircleGeometry(0.02, 16), new MeshBasicMaterial({ color: 0xff2040, transparent: true, opacity: 0.9, depthWrite: false }));
  laser.rotation.x = -Math.PI / 2;
  laser.visible = false;
  group.add(laser);

  function billboardFor(id, size) {
    let b = cats.get(id);
    if (!b) { b = createCatBillboard({ cache, catId: id, size }); group.add(b.root); cats.set(id, b); }
    return b;
  }

  /** place a card in front of the head: `ahead` metres along the flat gaze, `below` metres under the eye line, facing back */
  function placeCard(mesh, head, gaze, ahead, below) {
    if (!head) return;
    let gx = gaze ? gaze.x : 0, gz = gaze ? gaze.z : -1; const l = Math.sqrt(gx * gx + gz * gz) || 1; gx /= l; gz /= l;
    mesh.position.set(head.x + gx * ahead, head.y - below, head.z + gz * ahead);
    mesh.rotation.set(0, Math.atan2(head.x - mesh.position.x, head.z - mesh.position.z), 0);
  }

  /** result = bridge.frame(...) return value; head / gaze = the viewer this frame (for the cards) */
  function sync(result, head, gaze) {
    const st = result && result.state;
    if (!st || disposed) return;
    const tNow = now();
    // box: drops, then sits on its spot; the lid goes when open; the box leaves after the climb (st.box.gone)
    box.visible = !st.box.gone;
    if (box.visible) {
      box.position.set(st.box.x, st.box.y + BOX_SIZE_M * 1.07 / 2, st.box.z);
      lid.visible = !st.box.open;
    }
    // laser dot (the sim's dot is already snapped to the nearest legal point)
    if (st.laser) { laser.visible = true; laser.position.set(st.laser.x, st.laser.y + 0.003, st.laser.z); } else laser.visible = false;
    // cats
    const seen = new Set();
    for (const c of result.cats) {
      seen.add(c.id);
      const b = billboardFor(c.id, c.size); // size = kitten / adult sprite keys (Code Review B NIT 3)
      b.root.visible = true;
      b.root.position.set(c.x, c.y, c.z);
      b.root.rotation.set(0, c.yaw, 0);
      b.setView(c);
      b.setPose(c.pose);
      b.update(tNow); // W3: per-sprite texture + crossfade
      if (c.shadow) b.setShadow(c.shadow.y, c.shadow.alpha); else b.setShadow(null, 0);
    }
    for (const [id, b] of cats) if (!seen.has(id)) b.root.visible = false; // still in the box
    // W3: wand + basket (wand.js view)
    const w = result.wand;
    if (w) {
      basket.visible = true; basket.position.set(w.basket.x, w.basket.y + WAND_TUNING.basketH / 2, w.basket.z);
      const from = w.base || w.handle; // resting = a tall wand standing in the basket (stick from the basket bottom); held = from the handle
      const dx = w.tip.x - from.x, dy = w.tip.y - from.y, dz = w.tip.z - from.z, len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      stick.visible = true; stick.scale.set(1, len, 1);
      stick.position.set((from.x + w.tip.x) / 2, (from.y + w.tip.y) / 2, (from.z + w.tip.z) / 2);
      // a unit-y cylinder turned onto the handle -> tip direction
      stick.quaternion.setFromUnitVectors(UP, tmpV.set(dx / len, dy / len, dz / len));
      feather.visible = true; feather.position.set(w.tip.x, w.tip.y, w.tip.z);
      feather.scale.setScalar(1 + 0.6 * (w.excitement || 0)); // a wiggled feather fluffs up
      if (head) feather.rotation.set(0, Math.atan2(head.x - w.tip.x, head.z - w.tip.z), 0);
    } else { basket.visible = false; stick.visible = false; feather.visible = false; }
    // W3: hint / caption card (head-locked, under the gaze); the end card replaces it
    if (result.endCard) {
      if (cardLines !== 'end') { cardLines = 'end'; endCard.draw(result.endCard.lines, true); endCard.mesh.visible = true; card.mesh.visible = false; }
      placeCard(endCard.mesh, head, gaze, CARD_AHEAD, 0.05);
    } else {
      const lines = [];
      if (result.hint) lines.push(result.hint.text);
      if (result.caption) lines.push(result.caption);
      const key = lines.join('\n');
      if (key !== cardLines) { cardLines = key; card.draw(lines, false); card.mesh.visible = lines.length > 0; }
      if (card.mesh.visible) placeCard(card.mesh, head, gaze, CARD_AHEAD, CARD_BELOW);
    }
  }

  /** free three resources of one object (geometry, material(s), their maps) */
  function freeObject(obj, keepMaps) {
    if (!obj) return;
    if (obj.geometry && typeof obj.geometry.dispose === 'function') obj.geometry.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) { if (!keepMaps && m.map && typeof m.map.dispose === 'function') m.map.dispose(); if (typeof m.dispose === 'function') m.dispose(); }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [, b] of cats) { b.root.traverse((o) => freeObject(o, true)); group.remove(b.root); } // maps belong to the cache
    cats.clear();
    cache.dispose();
    lid.parent && box.remove(lid); freeObject(lid);
    group.remove(box); freeObject(box);
    group.remove(laser); freeObject(laser);
    for (const o of [basket, stick, feather, card.mesh, endCard.mesh]) { group.remove(o); freeObject(o); }
    if (group.parent) group.parent.remove(group);
    bridge.dispose();
  }

  return { bridge, group, sync, cats, dispose, get disposed() { return disposed; } };
}

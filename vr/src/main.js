// KCA "In Your Room". W1 hello-cat scaffold (Dev 2) + W2 room-sim wiring (Gaming Engineer 2).
// Starts an immersive-ar (passthrough) session via IWSDK 1.0.1. Every tracked frame:
//   1. before the sim starts: snapshot the standard WebXR scene (detectedPlanes / detectedMeshes) into the bridge until
//      it settles (1 s unchanged) or the no-scan fallback (3 s) -> createRoom + createRoomSession (room-bridge.js);
//   2. after: hand joints -> gestures.js -> roomcat events (a `move` per tracked hand per frame, plan 2.9) -> fixed
//      60 Hz steps -> billboards (cat-views.js picks the view) -> three objects (room-hook.js).
// Session features live in ../iwsdk.config.json (read through virtual:iwsdk-project). IWSDK's SceneUnderstandingSystem
// still creates the XRPlane entities (used here only for the floor height and DEV logs).
// Session lifecycle (session-life.js, node-tested): EVERY XR session gets a fresh hook + bridge (re-scan in that session's
// local-floor frame); on 'end' or a replaced session the old one is disposed and the preview cat returns (W2 review MUST 1).
// W3 (GE2): the treat's lap line is posture-aware (floorY goes into the bridge), the feather wand + basket (wand.js), the
// first-five-minutes hints + sound captions (hints.js; on the head-locked card in room-hook and the 2D #hint / #caption
// lines), the end card (end-card.js; card in the headset + the 2D #endcard list). The visit counter is saved on the
// headset (visit-store.js, localStorage in a try/catch, one tiny { day, visit, memory } record, nothing sent; legal 10.2): day 1 = 3 kittens,
// +1 per return day from Design's roster of 8 starter kittens (art-manifest.gen.js ids + names, legal 12.4). The end card only promises "a new kitten tomorrow" when that save went through (Code Review B 07:2x).
// The W4 kitten memory (return-visit.js: bonds, first-met visit, nap-spot words; NEVER anchors) lives in the same record:
// read at visit start (startVisit -> the bridge: remembered kittens nap on their favourite kind of spot), written once with
// the end card (saveMemory), so the start card's third sentence is true (Code Review N W4 SHOULD 1).
import { createSystem, World, XRPlane } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { Vector3 } from 'three';
import { createCatBillboard } from './cat-billboard.js';
import { createRoomHook } from './room-hook.js';
import { inputKinds, readHands, readWebXRScene } from './room-bridge.js';
import { createSessionLife } from './session-life.js';
import { beginVisit } from './visit-store.js';
import { readMemory, writeMemory } from './return-visit.js';
import { rosterForVisit } from './end-card.js';
import { log } from './log.js';
// P0a slice (docs/P0A-SLICE.md GE2): synthesised WebAudio cues (sound.js; the context is made on the Enter tap, a user
// gesture) and controller haptics (haptics.js) for the fx.js cue list the bridge returns every frame. Zero files, zero network.
import { createSound } from './sound.js';
import { createHaptics, hapticPulse } from './haptics.js';
import { ART_MANIFEST } from './art-manifest.gen.js'; // Design's 8 starter kittens: ids + names (the roster)

const CAT_DISTANCE_M = 0.9; // pre-XR desktop preview spot (in reach while seated)
const DEV = import.meta.env.DEV; // Vite: true in `npm run dev*`, false in `npm run build`
const SESSION_SEED = 1;
// the roster = Design's starter kittens (vr/public/art/manifest.json order, names from Design; legal 12.4): 3 on day 1, +1 per visit
const ROSTER = Object.keys(ART_MANIFEST.cats).map((id) => ({ id, name: ART_MANIFEST.cats[id].name || id }));
const NAMES = Object.fromEntries(ROSTER.map((c) => [c.id, c.name]));
function visitStorage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; } }
/** This session's visit (saved on the headset) and its kittens. */
function startVisit() {
  const v = beginVisit(visitStorage(), Date.now(), new Date().getTimezoneOffset(), undefined, ROSTER); // roster: a carried kitten memory keeps roster ids only
  const today = rosterForVisit(ROSTER, v.visit);
  // W4 kitten memory (return-visit.js, legal 10.2): bonds, first-met visit, nap-spot words from the same record; the
  // bridge sends remembered kittens to their favourite spot and hands back the memory to save with the end card
  const memory = readMemory(visitStorage(), ROSTER);
  const remembered = Object.keys(memory.cats).length;
  log(`visit ${v.visit}${v.isNew ? ' (new kitten in the box)' : ''}, ${today.count} kittens${remembered ? `, ${remembered} remembered` : ''}${v.persisted ? '' : ' (no local save: no "tomorrow" promise)'}`);
  return { visit: v.visit, persisted: v.persisted, cats: today.ids.map((id) => ({ id, size: 'kitten' })), memory };
}
/** The end card's memory -> the visit record (whitelisted on write; the card text never changes with the outcome). */
function saveMemory(memory) {
  if (!memory) return;
  const ok = writeMemory(visitStorage(), memory, ROSTER);
  log(ok ? `kitten memory saved (${Object.keys(memory.cats).length} kittens)` : 'kitten memory not saved (no local storage)');
}

/** GE4's dev-update toast gate (window.__kcaDevUpdate, dev builds only; absent in the frozen entry): true while a round runs */
function setDevPlaying(playing) { try { if (typeof window !== 'undefined' && window.__kcaDevUpdate && typeof window.__kcaDevUpdate.setPlaying === 'function') window.__kcaDevUpdate.setPlaying(!!playing); } catch (e) { /* ignore */ } }
let sound = createSound(null); // silent until the Enter tap builds a real AudioContext
const haptics = createHaptics();
function enableSound() {
  if (sound.enabled) { sound.resume(); return; }
  try { const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null; if (AC) sound = createSound(new AC()); } catch (e) { sound = createSound(null); }
  sound.resume();
}

const tmpA = new Vector3();
const tmpB = new Vector3();
const tmpC = new Vector3();
const tmpD = new Vector3();

function setLine(id, text) {
  // 2D page lines (the headset shows the same text on the head-locked card, room-hook.js)
  const el = typeof document !== 'undefined' && document.getElementById(id);
  if (el) { el.textContent = text || ''; el.hidden = !text; }
}
function setHint(text) { setLine('hint', text); if (text) log(`hint: ${text}`); }
function setCaption(text) { setLine('caption', text); }
function setEndCard(card, memory) {
  const el = typeof document !== 'undefined' && document.getElementById('endcard');
  if (el) { el.textContent = card ? card.lines.join('\n') : ''; el.hidden = !card; }
  if (card) { log(`end card: ${card.totalHearts} hearts`); saveMemory(memory); }
}

class RoomCatSystem extends createSystem({
  planes: { required: [XRPlane] },
}) {
  init() {
    // desktop preview cat (shown before XR; hidden once the room sim runs)
    this.preview = createCatBillboard();
    this.preview.root.position.set(0, 0, -CAT_DISTANCE_M);
    this.world.createTransformEntity(this.preview.root, { persistent: true });

    // room sim glue (plain data in, three objects out), one hook per XR session. Room / hand details are DEV-only logs
    // (Legal section 10).
    this.life = createSessionLife({
      makeHook: () => { const v = startVisit(); return createRoomHook({ seed: SESSION_SEED, cats: v.cats, roster: ROSTER, names: NAMES, visit: v.visit, persisted: v.persisted, memory: v.memory, renderer: this.world && this.world.renderer ? this.world.renderer : null, onLog: DEV ? (m) => log(m) : null }); },
      attach: (hook) => {
        const entity = this.world.createTransformEntity(hook.group, { persistent: true });
        return () => { if (entity && typeof entity.destroy === 'function') entity.destroy(); };
      },
      readScene: readWebXRScene,
      readHands,
      onLog: (m) => log(m),
      onPreview: (visible) => { this.preview.root.visible = visible; },
      onHint: setHint,
      onCaption: setCaption,
      onEndCard: setEndCard,
    });

    this.floorEntity = null;
    this.floorSource = 'none';

    // DEV-only smoke hook (Gate A C2, dev/impl/SK-77-gateA.md step 3): the CI emulator smoke (vr/test/e2e/smoke.mjs)
    // reads room / cat state through it. `import.meta.env.DEV` is false in `vite build`, so the whole branch is dropped from
    // dist/ (never shipped, never logged). Plain numbers only; nothing here leaves the page.
    if (DEV && typeof window !== 'undefined') {
      const bridge = () => (this.life.hook ? this.life.hook.bridge : null);
      const floorOf = (b) => { const f = b && b.room ? b.room.surfaces.find((s) => s.kind === 'floor') : null; return f ? { id: f.id, y: f.y, virtual: !!f.virtual } : null; };
      window.__kcaSmoke = {
        source: () => { const b = bridge(); return b ? b.reason : null; },        // 'settled' | 'no_scan' | 'timeout' | null
        planes: () => { const b = bridge(); return b && b.roomInput ? b.roomInput.planes.length : 0; },
        meshes: () => { const b = bridge(); return b && b.roomInput ? b.roomInput.meshes.length : 0; },
        floorY: () => { const f = floorOf(bridge()); return f ? f.y : null; },
        floor: () => floorOf(bridge()),
        floorSource: () => this.floorSource,
        viewer: () => { const b = bridge(); return b && b.roomInput ? { x: b.roomInput.viewer.x, z: b.roomInput.viewer.z, fx: b.roomInput.forward.x, fz: b.roomInput.forward.z } : null; },
        started: () => !!this.life.started,
        sessions: () => this.life.sessions,
        mode: () => { const b = bridge(); return b && b.director ? b.director.mode : null; },          // P0a: play | celebrate | offer | countdown | playing | scorecard
        meter: () => { const b = bridge(); return b && b.director ? b.director.meter.value : null; },
        sound: () => ({ enabled: sound.enabled, played: sound.played, dropped: sound.dropped }),
        cats: () => { const b = bridge(); return b && b.state ? b.state.cats.map(({ id, x, y, z, surf, mode, pose }) => ({ id, x, y, z, surf, mode, pose })) : []; },
      };
    }

    this.cleanupFuncs.push(
      this.queries.planes.subscribe('qualify', (entity) => this.onPlane(entity), true),
      this.queries.planes.subscribe('disqualify', (entity) => this.onPlaneGone(entity)),
      () => this.life.teardown(),
    );
  }

  onPlane(entity) {
    const plane = entity.getValue(XRPlane, '_plane');
    if (!plane) return;
    if (DEV) log(`plane: ${plane.orientation} ${plane.semanticLabel || '(no label)'}`);
  }

  onPlaneGone(entity) {
    if (entity === this.floorEntity) {
      this.floorEntity = null;
      this.floorSource = 'local-floor fallback';
      log('floor plane lost -> local-floor y=0');
    }
  }

  // Floor = a horizontal plane labelled 'floor' (lowest if several), else the lowest horizontal plane. Re-run every
  // frame with current world poses (only a few planes; cheap). Used for the floorY the room is built on.
  chooseFloor() {
    let best = null, bestY = 0, bestIsFloor = false;
    for (const entity of this.queries.planes.entities) {
      const plane = entity.getValue(XRPlane, '_plane');
      if (!plane || plane.orientation !== 'horizontal') continue;
      const isFloor = plane.semanticLabel === 'floor';
      const y = entity.object3D.getWorldPosition(tmpB).y;
      if (!best || (isFloor && !bestIsFloor) || (isFloor === bestIsFloor && y < bestY)) {
        best = entity; bestY = y; bestIsFloor = isFloor;
      }
    }
    if (best !== this.floorEntity) {
      this.floorEntity = best;
      if (best) {
        this.floorSource = bestIsFloor ? 'floor plane' : 'lowest horizontal plane';
        log(DEV ? `floor = ${this.floorSource} (y=${bestY.toFixed(2)})${bestIsFloor ? '' : '; posture uses local-floor y=0'}` : `floor = ${this.floorSource}`);
      }
    }
  }

  watchSession(session) {
    const fresh = session && session !== this.life.session;
    this.life.watchSession(session);
    if (fresh) { sound.resume(); this.lastMode = null; setDevPlaying(true); } // a new XR session: audio running, in play until the first rest
    if (!session && this.lastMode !== null) { this.lastMode = null; setDevPlaying(false); }
    if (fresh && DEV && typeof session.addEventListener === 'function') {
      session.addEventListener('selectstart', (e) => log(`select start (${e.inputSource.hand ? 'hand' : 'controller'} ${e.inputSource.handedness})`));
    }
  }

  update(delta) {
    const frame = this.xrFrame;
    this.watchSession(frame ? frame.session : null);
    if (!frame || !this.life.hook) return;
    const ref = this.xrManager.getReferenceSpace();
    const head = this.camera.getWorldPosition(tmpA);
    const gaze = this.camera.getWorldDirection(tmpD);
    const fwd = tmpC.copy(gaze);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();

    this.chooseFloor();
    const floorY = this.floorEntity ? this.floorEntity.object3D.getWorldPosition(tmpB).y : 0;
    // posture (the treat's lap line) only trusts a plane LABELLED floor; otherwise the local-floor origin (y 0) is the
    // guess, never the lowest horizontal plane (a table top would make a standing player "seated"; Code Review B 1d)
    const postureFloorY = this.floorEntity && this.floorSource === 'floor plane' ? floorY : 0;

    // preview cat: keep it upright and facing the viewer until the sim takes over
    if (!this.life.started) {
      const root = this.preview.root;
      root.position.y = floorY;
      root.rotation.set(0, Math.atan2(head.x - root.position.x, head.z - root.position.z), 0);
    }

    // 1) scene snapshots until the room settles (or no scan -> virtual rug after 3 s), then
    // 2) hands -> gestures (treat only with the palm in view + above the lap) -> roomcat (a move per tracked hand per
    //    frame), fixed steps, billboards; controllers-only input for 2 s -> hint
    const result = this.life.step({
      dt: delta, frame, refSpace: ref,
      head: { x: head.x, y: head.y, z: head.z }, fwd: { x: fwd.x, z: fwd.z }, gaze: { x: gaze.x, y: gaze.y, z: gaze.z },
      floorY, postureFloorY, kinds: inputKinds(frame.session),
    });
    if (DEV && result) for (const ev of result.events) if (ev.type === 'pinch' || ev.type === 'release' || ev.type === 'treat' || ev.type === 'wand') log(`${ev.type}${ev.on === false ? ' off' : ''} ${ev.hand || ''}`);
    // P0a: this frame's cues -> sound (synth) + controller haptics (hands have none); DEV logs the beat changes only
    if (result && result.fx) {
      for (let i = 0; i < result.fx.sounds.length; i++) sound.play(result.fx.sounds[i], result.fx.pitches[i]);
      sound.flush();
      hapticPulse(haptics, frame.session.inputSources, result.fx.haptic, typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (result.director && result.director.mode !== this.lastMode) {
        this.lastMode = result.director.mode;
        if (DEV) log(`beat: ${this.lastMode}${result.director.mode === 'scorecard' && result.director.scorecard ? ' (' + result.director.scorecard[1] + ')' : ''}`);
        // GE4's dev-only "New build ready" toast (Legal item 2) only between rounds: the Laser Tag score card is the one rest (review BB S6)
        setDevPlaying(this.lastMode !== 'scorecard');
      }
    }
  }
}

const container = document.getElementById('scene-container');
log('starting IWSDK...');
World.create(container, projectOptions)
  .then((world) => {
    world.registerSystem(RoomCatSystem);
    const btn = document.getElementById('enter');
    btn.addEventListener('click', () => { enableSound(); world.launchXR(); });
    log(navigator.xr ? 'ready: press "Enter your room" (or the IWER Enter XR button)' : 'WebXR not available in this browser');
  })
  .catch((err) => {
    console.error(err);
    log(`failed to start: ${err && err.message ? err.message : err}`);
  });

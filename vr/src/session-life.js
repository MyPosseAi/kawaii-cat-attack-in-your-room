/* vr/src/session-life.js - W2 re-review (Gaming Engineer 2): the XR SESSION LIFECYCLE of the room sim, as plain
   data so node can test it with fakes (vr/test/session-life.test.mjs). main.js only feeds it the WebXR objects.
   W2 review MUST 1: every XR session gets its OWN hook + bridge (fresh scene scan in that session's local-floor frame),
   torn down (billboards, textures, box, laser, session state) when the session ends or another one starts; the preview
   cat comes back between sessions. Also owns the "put your controllers down" hint (SHOULD 3).
   W3: the bridge's onboarding hint / caption / end card ride the same step: onHint(text) gets the controller hint first
   (it wins while controllers are the only input), else the onboarding hint; onCaption(text) the sound caption; onEndCard(card, memory)
   once, when the arc ends (memory = the kitten memory to save, W4). The hook draws the head-locked card (hook.sync); these callbacks feed the 2D page lines.
   createSessionLife({ makeHook, attach, onLog, onPreview, onHint, onCaption, onEndCard, readScene, readHands, hintAfterS }) ->
     life.watchSession(xrSession | null)    call every update with the current frame's session (or null without a frame)
     life.teardown()                        dispose the current hook (also what the session 'end' event does)
     life.step({ dt, frame, refSpace, head, fwd, gaze, floorY, kinds }) -> bridge.frame() result | null (before ready)
     life.hook / life.started / life.session / life.sessionTime / life.sessions (count) */
import { createInputHint, CONTROLLER_HINT } from './room-bridge.js';

export function createSessionLife(o) {
  const onLog = typeof o.onLog === 'function' ? o.onLog : () => {};
  const onPreview = typeof o.onPreview === 'function' ? o.onPreview : () => {};
  const onHint = typeof o.onHint === 'function' ? o.onHint : () => {};
  const onCaption = typeof o.onCaption === 'function' ? o.onCaption : () => {};
  const onEndCard = typeof o.onEndCard === 'function' ? o.onEndCard : () => {};
  const hint = createInputHint(o.hintAfterS);
  const life = { hook: null, started: false, session: null, sessionTime: 0, sessions: 0, sceneIds: null, handScratch: null, hint, hintText: null, caption: null, endCard: null, _detach: null, _endHandler: null };
  const showHint = (text) => { if (text !== life.hintText) { life.hintText = text; onHint(text); } };

  life.teardown = () => {
    if (life.hook) {
      if (life._detach) { try { life._detach(); } catch (e) { /* entity already gone */ } }
      life._detach = null;
      life.hook.dispose();
      life.hook = null;
    }
    life.started = false;
    life.sceneIds = null; life.handScratch = null;
    showHint(null);
    if (life.caption) { life.caption = null; onCaption(null); }
    life.endCard = null;
    hint.reset();
    onPreview(true);
  };

  life.watchSession = (session) => {
    if (session === life.session) return;
    if (life.session) { // the old session ended (or was replaced without an 'end' we saw)
      if (life._endHandler && typeof life.session.removeEventListener === 'function') life.session.removeEventListener('end', life._endHandler);
      life._endHandler = null;
      life.teardown();
      onLog('XR session ended');
    }
    life.session = session || null;
    life.sessionTime = 0;
    if (!session) return;
    life.sessions++;
    life.teardown(); // never two hooks
    life.hook = o.makeHook();
    life._detach = typeof o.attach === 'function' ? o.attach(life.hook) : null;
    life.sceneIds = new WeakMap(); life.handScratch = {};
    onPreview(true);
    onLog(`XR session started (blend: ${session.environmentBlendMode || 'n/a'})${life.sessions > 1 ? ` #${life.sessions}, room re-scan` : ''}`);
    if (typeof session.addEventListener === 'function') {
      const s = session;
      life._endHandler = () => { if (life.session === s) { life._endHandler = null; life.session = null; life.teardown(); onLog('XR session ended'); } };
      session.addEventListener('end', life._endHandler);
    }
  };

  /** One tracked frame. in = { dt, frame, refSpace, head {x,y,z}, fwd {x,z} (flat), gaze {x,y,z} (unit), floorY, kinds,
   *  postureFloorY? }. floorY builds the room; postureFloorY (when the key is present, even undefined) is the floor the
   *  treat's lap line measures the head against (Code Review B SHOULD 1d: never a table mistaken for the floor). */
  life.step = (inp) => {
    if (!life.hook || !life.session) return null;
    life.sessionTime += inp.dt;
    const t = life.sessionTime;
    // controller hint (independent of the room state)
    const show = hint.update(inp.kinds, t) && !inp.hud; // SK-HUD: with the action menu wired, controllers are a real input (no "put them down" hint)
    const bridge = life.hook.bridge;
    const onboarding = bridge.hint ? bridge.hint.text : null;
    showHint(show ? CONTROLLER_HINT : onboarding);
    if (!life.started) {
      const scene = inp.refSpace && typeof o.readScene === 'function' ? o.readScene(inp.frame, inp.refSpace, life.sceneIds) : { planes: [], meshes: [] };
      bridge.observe(scene, { x: inp.head.x, z: inp.head.z }, { x: inp.fwd.x, z: inp.fwd.z }, inp.floorY, t);
      if (bridge.ready) {
        bridge.start();
        life.started = true;
        onPreview(false);
        onLog(`room ready (${bridge.reason})${bridge.room.rug ? ': no room scan, virtual rug (TODO hint: "Set up your room for couch naps")' : ''}`);
      }
      return null;
    }
    const hands = inp.refSpace && typeof o.readHands === 'function' ? o.readHands(inp.frame, inp.refSpace, t, life.handScratch) : [];
    const result = bridge.frame(inp.dt, hands, inp.head, inp.gaze || null, 'postureFloorY' in inp ? inp.postureFloorY : inp.floorY, inp.hud || null); // SK-HUD: inp.hud = { sources, hide, wristToggle } (main.js)
    life.hook.sync(result, inp.head, inp.gaze || null);
    if (result.hintChanged) showHint(show ? CONTROLLER_HINT : (result.hint ? result.hint.text : null));
    if (result.captionChanged) { life.caption = result.caption; onCaption(result.caption); }
    if (result.endCard && !life.endCard) { life.endCard = result.endCard; onEndCard(result.endCard, result.memory || null); } // W4: memory = what to save (return-visit.js)
    return result;
  };

  return life;
}

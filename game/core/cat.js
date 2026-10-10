/* game/core/cat.js — the cat controller (player cat; the same controller drives AI cats from AI-made actions).
   Pure: stepCat(cat, actions, world, dt, tuning) mutates `cat` only. Feel numbers come from tuning.js (provisional).
   Modes: rest | move | turn | air | pounce | swat | meow | knead | nap | wake. Gait for the renderer = gaitForSpeed(|vx|).
   The B1 rig draws from cat.mode / cat.modeMs / cat.side / cat.speedBL / cat.ph — nothing here touches the DOM.
   (docs/GAME-PHYSICS.md 6g): OPT-IN abilities { doubleJump, canFly } per cat (createCat / setAbilities). Off = the
   block is skipped entirely, so every pre-SK-55 hash is unchanged. Double jump: a FRESH jump press while airborne
   (not within coyote time, not busy, not charging) gives one extra jump per airtime (vy := up speed for ratio x the
   takeoff jump's height, >= minH), reset on any landing; event 'double_jump', cat.djMs < poseMs = the renderer's pose
   window. Flight: a canFly cat flaps INSTEAD of double jumping: the airborne press arms it, then HOLDING jump accelerates
   it upward (net lift, capped at maxClimb) while cat.flight (0..1 stamina) drains; empty = normal fall until landing,
   regenerates on the ground. Events 'flap_start' / 'flight_tired'; cat.flying while flapping. */
import { createBody, integrate, launch, jumpSpeedForHeight } from './physics.js';
import { approach, clamp, sign, smooth01 } from './vec.js';
import { TUNING, canFly } from './tuning.js';

export function createCat(id, x, y, { side = 1, ai = false, world = null, abilities = null } = {}) {
  const cat = {
    id, ai, body: createBody(x, y), side,
    mode: 'rest', modeMs: 0, speedBL: 0, ph: 0,
    stamina: 1, sprintS: 0, charging: false, chargeMs: 0,
    sinceGroundMs: 0, jumpBufMs: 1e9, lastJumpMs: 1e9,
    idleMs: 0, turnMs: -1, skid: false,
    click: null, // {x, kind}
    pounce: null, // {x0, dist, flying}
    swatHits: 0,
    prev: { jump: 0, pounce: 0, swat: 0, meow: 0, knead: 0, nap: 0 },
    events: [], // per-step: 'jump','land','pounce','swat','meow','skid','turn','arrive' (+ 'double_jump','flap_start','flight_tired')
    // (never hashed): abilities + air-jump / flight state. All inert while ab.doubleJump and ab.canFly are false.
    ab: { doubleJump: false, canFly: false },
    airJumps: 0, djMs: 1e9, lastJumpH: 0, flight: 1, flying: false, flapArmed: false,
  };
  if (abilities) setAbilities(cat, abilities);
  if (world) settle(cat, world);
  return cat;
}

/**: hosts switch abilities per cat at runtime (an outfit with wings, a mode that forbids flight). Only the given
    keys change. Turning flight off mid-air just lets the cat fall; stamina is kept. */
export function setAbilities(cat, { doubleJump, canFly } = {}) {
  if (doubleJump != null) cat.ab.doubleJump = !!doubleJump;
  if (canFly != null) { cat.ab.canFly = !!canFly; if (!cat.ab.canFly) { cat.flying = false; cat.flapArmed = false; } }
  return cat;
}

/** Put the cat on the platform whose top is at its feet (if any), so it starts grounded instead of falling one step. */
export function settle(cat, world) {
  const b = cat.body;
  for (const p of world.platforms) {
    if (b.x > p.x0 && b.x < p.x1 && Math.abs(b.y - p.y) < 1e-6) { b.onGround = true; b.groundId = p.id; b.vy = 0; return true; }
  }
  return false;
}

/**: the abilities a host's `moves` option gives cat `id` (null = none: createCat's inert default). canFly needs
    flight on AND the cat to be a flyer (tuning.abilities.flyers) unless moves.canFly[id] says otherwise (outfit data). */
export function movesFor(id, moves, tuning = TUNING) {
  if (!moves) return null;
  const A = tuning.abilities || TUNING.abilities, ov = moves.canFly && moves.canFly[id];
  return { doubleJump: !!moves.doubleJump, canFly: !!moves.flight && (ov != null ? !!ov : canFly(id, A.flyers)) };
}
/** render hints (never hashed): dj = pose window after a double jump, airJumps, flying, flight stamina 0..1. */
export function abilityView(c, tuning = TUNING) {
  const A = tuning.abilities || TUNING.abilities;
  return { dj: c.djMs < A.doubleJump.poseMs, airJumps: c.airJumps, flying: c.flying, flight: c.flight, abCanFly: c.ab.canFly, abDoubleJump: c.ab.doubleJump }; // ab* = what the cat CAN do (Review NIT 1), flying/flight = what it is doing
}

const BUSY = { pounce: 1, swat: 1, meow: 1, knead: 1, nap: 1, wake: 1, chew: 1 }; // chew = furniture gnaw (furniture.js sets it)

/** rising edge of a digital action */
function pressed(cat, a, k) { return a[k] > 0.5 && !(cat.prev[k] > 0.5); }

export function stepCat(cat, a, world, dt, T) {
  const b = cat.body, dtMs = dt * 1000;
  cat.events.length = 0;
  cat.modeMs += dtMs;

  // ---- click-to-move target (mouse) ----
  if (a.clickKind) cat.click = { x: a.clickX, kind: a.clickKind };
  let ix = clamp(a.moveX, -1, 1);
  if (cat.click) {
    const d = cat.click.x - b.x;
    if (ix !== 0) cat.click = null;                           // keys/stick override the click
    else if (Math.abs(d) < T.arriveBL) { cat.click = null; cat.events.push('arrive'); }
    else ix = sign(d) * (cat.click.kind === 2 ? 1 : 0.9);
  }
  const mag = Math.abs(ix);
  const sneak = a.sneak > 0.4;
  const sprint = (a.sprint > 0.4 || (cat.click && cat.click.kind === 2)) && !sneak;

  // ---- target speed by band (spec section 2) + hysteresis so a stick resting ON a threshold never flickers gaits ----
  const hys = T.stick.hysteresis || 0;
  let band = cat.band || 'walk';
  if (mag < 0.01) band = 'none';
  else if (sneak) band = 'sneak';
  else if (band === 'sneak') band = mag < T.stick.sneakBelow + hys ? 'sneak' : mag < T.stick.walkBelow ? 'walk' : 'run';
  else if (band === 'run') band = mag >= T.stick.walkBelow - hys ? 'run' : mag < T.stick.sneakBelow ? 'sneak' : 'walk';
  else band = mag < T.stick.sneakBelow ? 'sneak' : mag < T.stick.walkBelow + hys ? 'walk' : 'run';
  cat.band = band;
  let vT = band === 'none' ? 0 : band === 'sneak' ? T.speeds.sneak : band === 'walk' ? T.speeds.walk : T.speeds.run;
  if (sprint && mag > 0.01 && cat.stamina > 0) {
    cat.sprintS += dt;
    vT = cat.sprintS < T.stamina.trotFirstS ? T.speeds.trot : T.speeds.dash;
    cat.stamina = Math.max(0, cat.stamina - dt / T.stamina.dashS * (cat.sprintS > T.stamina.trotFirstS ? 1 : 0.3));
  } else { cat.sprintS = 0; cat.stamina = Math.min(1, cat.stamina + dt / T.stamina.refillS); }
  vT *= sign(ix);

  const anyPress = ['jump', 'pounce', 'swat', 'meow', 'knead', 'nap'].some((k) => pressed(cat, a, k));
  if (mag > 0.01 || anyPress) cat.idleMs = 0; else cat.idleMs += dtMs;

  // ---- ground actions ----
  const busy = !!BUSY[cat.mode];
  if (b.onGround) {
    if (cat.mode === 'nap' && (mag > 0.01 || anyPress)) setMode(cat, 'wake');
    if (!busy) {
      if (pressed(cat, a, 'pounce')) {
        const flying = Math.abs(b.vx) > T.speeds.walk;
        cat.pounce = { x0: b.x, dist: (flying ? T.pounce.flyingDist : T.pounce.dist) * cat.side, flying };
        setMode(cat, 'pounce'); cat.events.push('pounce');
      } else if (pressed(cat, a, 'swat')) { setMode(cat, 'swat'); cat.swatHits = 1; cat.events.push('swat'); }
      else if (pressed(cat, a, 'meow')) { setMode(cat, 'meow'); cat.events.push('meow'); }
      else if (pressed(cat, a, 'knead')) setMode(cat, 'knead');
      else if (pressed(cat, a, 'nap')) setMode(cat, 'nap');
    } else if (cat.mode === 'swat' && pressed(cat, a, 'swat') && cat.modeMs < T.swat.doubleWindowMs) { cat.swatHits = 2; cat.events.push('swat'); }
  }
  // action timers
  switch (cat.mode) {
    case 'swat': if (cat.modeMs > T.swat.ms * cat.swatHits + 20) setMode(cat, 'rest'); break;
    case 'meow': if (cat.modeMs > 600) setMode(cat, 'rest'); break;
    case 'knead': if (a.knead < 0.5 && cat.modeMs > 800) setMode(cat, 'rest'); break;
    case 'wake': if (cat.modeMs > 1500) setMode(cat, 'rest'); break;
    case 'chew': if (cat.modeMs > (cat.chewMs || 4000)) setMode(cat, 'rest'); break; // safety: furniture.js normally ends it
    case 'pounce': {
      const wig = cat.pounce.flying ? 0 : T.pounce.wiggleMs;
      const leapT = clamp((cat.modeMs - wig) / T.pounce.leapMs, 0, 1);
      b.x = cat.pounce.x0 + cat.pounce.dist * smooth01(leapT);
      b.x = clamp(b.x, b.w / 2, world.width - b.w / 2);
      b.vx = 0;
      if (cat.modeMs > wig + T.pounce.leapMs + T.pounce.pinMs) setMode(cat, 'rest');
      break;
    }
  }

  // ---- horizontal motion ----
  const nowBusy = !!BUSY[cat.mode];
  if (nowBusy && b.onGround) vT = 0;
  if (cat.turnMs >= 0) vT = 0;
  const control = b.onGround ? 1 : cat.flying ? (T.abilities || TUNING.abilities).flight.airControl : T.jump.airControl; //: flapping steers better (flying = last step's, deterministic)
  const accRate = T.speeds.run / Math.max(0.05, T.accel.run);
  const decRate = Math.abs(b.vx) > T.speeds.trot ? T.speeds.dash / T.decel.dash : T.speeds.run / T.decel.run;
  const dv = vT - b.vx;
  const rate = (sign(dv) === sign(b.vx) || b.vx === 0) ? accRate : decRate;
  if (cat.mode !== 'pounce') b.vx = approach(b.vx, vT, rate * dt * control);

  // reversal: turn round through "facing you" (skid at speed)
  if (b.onGround && vT !== 0 && sign(vT) === -cat.side && cat.turnMs < 0 && cat.mode !== 'pounce') {
    cat.turnMs = 0; cat.skid = Math.abs(b.vx) > T.speeds.trot * 0.9; cat.events.push(cat.skid ? 'skid' : 'turn');
  }
  if (cat.turnMs >= 0) {
    cat.turnMs += dtMs;
    b.vx *= cat.skid ? 0.9 : 0.75; // ease out (per 60 Hz step)
    if (Math.abs(b.vx) < 0.02) b.vx = 0;
    if (cat.turnMs >= T.turn.ms + (cat.skid ? T.turn.skidMs : 0)) { cat.side = -cat.side; cat.turnMs = -1; }
  }
  if (!b.onGround && vT !== 0) cat.side = sign(vT);

  // ---- jumping (tap hop, hold charge, coyote, buffer) ----
  const g = T.jump.gravity;
  if (pressed(cat, a, 'jump')) cat.jumpBufMs = 0; else cat.jumpBufMs += dtMs;
  const canJump = (b.onGround || cat.sinceGroundMs <= T.jump.coyoteMs) && !nowBusy && cat.turnMs < 0;
  if (canJump && cat.jumpBufMs <= T.jump.bufferMs && !cat.charging) {
    cat.charging = true; cat.chargeMs = 0; cat.jumpBufMs = 1e9;
  }
  if (cat.charging) {
    cat.chargeMs += dtMs;
    const release = a.jump < 0.5 || cat.chargeMs >= T.jump.chargeMs;
    if (release) {
      const k = smooth01(cat.chargeMs / T.jump.chargeMs);
      const h = T.jump.hopH + (T.jump.chargeMaxH - T.jump.hopH) * k;
      launch(b, jumpSpeedForHeight(h, g));
      b.vx *= 1 + T.jump.takeoffPush;
      cat.charging = false; cat.lastJumpMs = 0; cat.sinceGroundMs = 1e9; cat.lastJumpH = h;
      setMode(cat, 'air'); cat.events.push('jump');
    } else if (!b.onGround) { cat.charging = false; } // fell off while charging: no jump
  }
  cat.lastJumpMs += dtMs;

  // ---- double jump + flight (opt-in; with both flags off this block is skipped and nothing below changes) ----
  const AB = cat.ab;
  if (AB.doubleJump || AB.canFly) {
    const A = T.abilities || TUNING.abilities;
    if (cat.djMs < 1e8) cat.djMs += dtMs;
    if (b.onGround) {
      cat.airJumps = 0; cat.lastJumpH = 0; cat.flapArmed = false; cat.flying = false; // (a launch this step already set onGround false, so its lastJumpH survives)
      if (AB.canFly && cat.flight < 1) cat.flight = Math.min(1, cat.flight + dt / A.flight.regenS);
    } else {
      // airborne for real: past coyote time (canJump covers the ground/coyote jump), no charge pending, not busy
      const airborne = !canJump && !cat.charging && !nowBusy;
      if (airborne && pressed(cat, a, 'jump')) {
        // Code Review SHOULD 1+2: the press is spent ONLY when it did something here (armed a flap with stamina left,
        // or performed the double jump); otherwise jumpBufMs keeps running so a press just before landing still fires the
        // buffered ground jump, as it does with moves off.
        if (AB.canFly) { if (cat.flight > 0) { cat.flapArmed = true; cat.jumpBufMs = 1e9; } } // flyers flap instead of double jumping (6g decision)
        else if (cat.airJumps < 1) {
          cat.jumpBufMs = 1e9;
          cat.airJumps = 1; cat.djMs = 0;
          const h = Math.max(A.doubleJump.minH, A.doubleJump.ratio * cat.lastJumpH);
          b.vy = -jumpSpeedForHeight(h, g); // replaces the fall speed: the apex gain is h from here
          cat.events.push('double_jump');
        }
      }
      const fly = AB.canFly && airborne && cat.flapArmed && a.jump > 0.5 && cat.flight > 0;
      if (fly) {
        if (!cat.flying) cat.events.push('flap_start');
        b.vy -= (A.flight.lift + g) * dt; // integrate() adds g*dt right after: net = lift
        if (b.vy < -A.flight.maxClimb) b.vy = -A.flight.maxClimb;
        cat.flight = Math.max(0, cat.flight - dt / A.flight.staminaS);
        if (cat.flight === 0) cat.events.push('flight_tired');
      }
      cat.flying = fly;
    }
  }

  // ---- integrate ----
  const wasGround = b.onGround;
  const res = integrate(world, b, dt, g);
  if (b.onGround) cat.sinceGroundMs = 0; else cat.sinceGroundMs += dtMs;
  if (res.landed) { cat.events.push('land'); cat.landFall = b.y - (res.fallFrom || b.y); setMode(cat, Math.abs(b.vx) > 0.05 ? 'move' : 'rest'); }
  else if (!b.onGround && cat.mode !== 'air' && !nowBusy) setMode(cat, 'air');

  // ---- rest / move bookkeeping for the renderer ----
  cat.speedBL = Math.abs(b.vx);
  if (b.onGround && !BUSY[cat.mode] && cat.mode !== 'air') {
    if (cat.speedBL > 0.02) { if (cat.mode !== 'move') setMode(cat, 'move'); }
    else if (cat.mode === 'move') setMode(cat, 'rest');
  }
  cat.ph += cat.speedBL * dt; // leg phase in body lengths travelled; renderer maps to gait cycles via fitGait

  for (const k in cat.prev) cat.prev[k] = a[k];
  return cat;
}

function setMode(cat, m) { if (cat.mode !== m) { cat.mode = m; cat.modeMs = 0; } }
/** Hosts/systems (furniture.js chew) may switch a cat's mode through this, never by writing cat.mode directly. */
export function setCatMode(cat, m) { setMode(cat, m); return cat; }

/** Simple AI: produce an ACTIONS record that chases (tx, ty). Deterministic given prng. Used by the laser race opponent. */
export function aiActions(cat, tx, ty, prng, { reaction = 0.9, sprintDist = 2.5, jumpUpDist = 0.6 } = {}) {
  const b = cat.body, a = { moveX: 0, jump: 0, pounce: 0, swat: 0, meow: 0, emote: 0, knead: 0, nap: 0, interact: 0, sneak: 0, sprint: 0, pause: 0, clickX: NaN, clickY: NaN, clickKind: 0 };
  const dx = tx - b.x, dy = ty - b.y; // dy < 0 => target above
  if (prng.next() > reaction) return a; // a little hesitation so the AI is beatable
  if (Math.abs(dx) > 0.15) a.moveX = dx > 0 ? 1 : -1;
  a.sprint = Math.abs(dx) > sprintDist ? 1 : 0;
  if (dy < -jumpUpDist && Math.abs(dx) < 2.2 && b.onGround) a.jump = 1;
  if (Math.abs(dx) < 1.6 && Math.abs(dy) < 0.4 && b.onGround && Math.abs(dx) > 0.5 && prng.chance(0.08)) a.pounce = 1;
  return a;
}

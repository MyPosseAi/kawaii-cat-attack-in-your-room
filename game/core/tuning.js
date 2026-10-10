/* game/core/tuning.js — the ONE table of feel numbers (design/concepts/SK31-control/spec.md section 7).
   Units: BL = body length (one B1 box width, ~110 px at 1080p), seconds, BL/s, BL/s².
   STATUS: PROVISIONAL. These are Design 1's defaults; the feel call is still pending
   (2026-10-06). Change numbers here only, never inline in the sim. */
export const TUNING = Object.freeze({
  speeds: Object.freeze({ sneak: 0.3, walk: 0.8, run: 1.25, trot: 2.2, dash: 4.0 }),
  /** seconds from standstill to the named speed */
  accel: Object.freeze({ sneak: 0.25, walk: 0.3, run: 0.35, dash: 0.5 }),
  /** seconds to ease to a stop */
  decel: Object.freeze({ run: 0.25, dash: 0.45 }),
  /** degrees/s of smooth steering (2D top-down use later); 1D side-scroll uses reversal turn below */
  turnRate: Object.freeze({ walk: 300, dash: 180 }),
  /** reversal (>120°) turn-round time, ms; skid adds skidMs at dash */
  turn: Object.freeze({ ms: 420, skidMs: 200 }),
  jump: Object.freeze({
    hopH: 0.8,          // BL, tap
    chargeMaxH: 3.0,    // BL, after full charge
    chargeMs: 350,      // hold time for a full charge
    gravity: 9,         // BL/s²  (spec says ~9; note: with g=9 a 0.8 BL hop is ~0.84 s airtime, spec quotes 0.42 s — open question for Design)
    airControl: 0.4,    // share of ground steering in the air
    coyoteMs: 100,      // may still jump this long after walking off an edge
    bufferMs: 120,      // a jump pressed this long before landing fires on landing
    takeoffPush: 0.2,   // +20 % horizontal speed at takeoff
  }),
  stamina: Object.freeze({ dashS: 2.5, refillS: 4, trotFirstS: 0.5 }),
  pounce: Object.freeze({ wiggleMs: 350, dist: 1.8, flyingDist: 1.4, leapMs: 460, pinMs: 450 }),
  swat: Object.freeze({ ms: 360, doubleWindowMs: 300, reach: 0.6 }),
  idleSitMs: 1200,
  deadZone: 0.15,
  /** stick magnitude thresholds (spec section 2) */
  stick: Object.freeze({ sneakBelow: 0.35, walkBelow: 0.7, hysteresis: 0.06 }), // hysteresis: a band is left only 0.06 past its edge (no gait flicker on a resting stick)
  /** hold a direction key longer than this and a walk becomes a run */
  keyRunAfterMs: 400,
  /** click-to-move: arrived when within this many BL */
  arriveBL: 0.15,
  /** a cat chews furniture (design/FOR-DEV.md 02:43: gnaw 3-4 s, at most once per 20 min, no re-chew 10 min) */
  furniture: Object.freeze({
    chewMsMin: 3000, chewMsMax: 4000,          // gnaw length (seeded in this range)
    repairMs: 1100,                            // Design's repair pop (screwdriver twist 620 ms + pop)
    rechewMs: 600000,                          // a repaired piece is safe for 10 min
    abortRetryMsMin: 60000, abortRetryMsMax: 120000, // a chew interrupted (drag / game mode) is retried after 1-2 min
    interval: Object.freeze({ sometimes: Object.freeze([2400000, 4800000]), often: Object.freeze([1200000, 1800000]) }), // ms between chews; spec cap = at most once per 20 min, so often = 20-30 min, sometimes = 40-80 min (Code Review SHOULD 2; Design 2 to confirm)
    approachMsMax: 30000,                      // the cat gives up an approach after 30 s (blocked path, busy host AI) and retries later (Code Review SHOULD 1)
    approachMag: 0.6,                          // walk band when the cat ambles to the piece
    reachBL: 0.45,                             // chew spot = this far outside the piece's near edge
    arriveBL: 0.2,
    wobbleAmpBL: 0.03, wobbleMs: 2400,         // cosmetic wobble for a cat standing on a fractured piece (Design: idle wobble 2.4 s)
  }),
  /** slice 4: cats roam the whole desktop (createFreeRoam setLedges / roam / edges; docs/GAME-PHYSICS.md 6f) */
  roam: Object.freeze({
    rideMaxBL: 3.0,        // a ledge that moves more than this (|dx| or |dy|) in ONE update was snapped/maximised: the cat is shaken off (falls) instead of teleporting
    hopChance: 0.35,       // when an AI cat picks a new wander target and a ledge is reachable, this share of picks goes for a ledge (the rest: a floor spot)
    reachMarginBL: 0.4,    // a ledge is "reachable" when its top is at most jump.chargeMaxH - this above the cat's surface (3.0 - 0.4 = 2.6 BL: a full charge clears it with room to land)
    minHopBL: 0.3,         // ledges closer than this (above or below) to the cat's surface are "the same level": no hop plan, just walk
    launchGapBL: 0.4,      // launch spot for a hop from BESIDE a ledge: this far outside its near end (the cat drifts in during the flight)
    hopTimeoutMs: 8000,    // a hop plan that has not landed on its ledge by then (blocked, missed) is dropped; the cat picks something else
    exitChance: 0.1,       // with an OPEN edge, this share of wander target picks walks out of it (cats spread over the monitors; idle 1.5-5 s => one exit per ~1 min per cat)
    edgeOutBL: 1.0,        // the exit target sits this far beyond the edge, so the cat really leaves (centre past 0 / width = hand-off)
  }),
  /** double jump + flight (docs/GAME-PHYSICS.md 6g). OPT-IN per cat (createCat abilities / setAbilities) and per
      host (createGame / createFreeRoam `moves`); with nothing opted in cat.js never reads this table. */
  abilities: Object.freeze({
    doubleJump: Object.freeze({
      ratio: 0.7,          // the mid-air jump's apex gain = this share of the jump that started the airtime (tap 0.8 -> +0.56 -> minH 0.6, full charge 3.0 -> +2.1 BL)
      minH: 0.6,           // BL, floor for the gain (also the gain after walking off an edge: no jump to scale from)
      poseMs: 300,         // state().cats[i].dj stays true this long after the double jump (renderer pose window)
    }),
    flight: Object.freeze({
      lift: 11,            // BL/s² NET upward acceleration while flapping (gravity 9 is already compensated: the cat always gains speed upward)
      maxClimb: 2.6,       // BL/s climb speed cap while flapping (about 2.45 after the step's gravity)
      staminaS: 2.5,       // seconds of continuous flapping from full
      regenS: 3.0,         // seconds on the ground from empty to full
      airControl: 0.8,     // share of ground steering while flapping (jump.airControl 0.4 applies to a plain fall)
    }),
    /** cat ids that can fly by default (bat wings / UFO); outfits can override per cat with setAbilities */
    flyers: Object.freeze([]),
  }),
});

/**: does this cat id fly by default (TUNING.abilities.flyers)? Hosts may pass their own flyer list (outfit data). */
export function canFly(id, flyers = TUNING.abilities.flyers) { return flyers.indexOf(id) >= 0; }

/** Shallow override helper for tests / tuning sliders: tune({ speeds: { run: 1.5 } }) */
export function tune(overrides) {
  const out = {};
  for (const k of Object.keys(TUNING)) {
    const base = TUNING[k];
    out[k] = (base && typeof base === 'object') ? { ...base, ...(overrides && overrides[k]) } : (overrides && k in overrides ? overrides[k] : base);
  }
  return out;
}

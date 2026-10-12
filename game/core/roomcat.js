/* game/core/roomcat.js — week 1: the floor-plane cat sim lifted into the player's REAL room (room.js), in metres.
   Gaming Engineer, 2026-10-09. Engine-agnostic + deterministic: no IWSDK / WebXR / DOM, no Math.random / Date, no trig.
   Fixed 60 Hz step (loop.js STEP_S); every random choice comes from the session's prng, so seed + room + event log
   replays bit-for-bit (replayRoomSession). The VR host draws each cat as a billboard at (x, y, z) facing (fx, fz) with
   `pose`, and turns hands into events (it owns gesture detection: gestures.js, week 2).
   What a cat does: wander its surface, hop up / down between surfaces on arcs within its size's limits (kitten: up 0.55 m,
   gap 0.6 m; adult: up 1.0 m, gap 1.2 m), perch, nap; reacts to hand events:
     { type: 'pet', p }                 open hand stroking near a cat's back: purr, bond +1 (once per 0.5 s per cat)
     { type: 'pinch', hand, p }         thumb-index pinch near a cat's scruff: carried (limp) / near the box top: opens it
     { type: 'move', hand, p }          hand position: the host sends it EVERY tracked frame for every tracked hand
                                        (carried cats follow it, on-palm cats glide after it); handLostS (3 s) without
                                        any event from a hand = tracking lost: its cat lets go
     { type: 'release', hand, v }       pinch released with hand velocity v: gentle toss, speed capped at tossCap; over the
                                        cap the cat POOFS (kawaii float, low gravity). Always lands on a legal surface:
                                        the flight is dry-run at release; an illegal landing becomes a twisting arc to
                                        room.js roomNearestLegal (no hovering, never on a couch back / plant / outside).
     { type: 'laser', on, p }           finger laser dot (host ray-casts; roomRaycast helps): interested cats chase, TELL (crouch
                                        tellS) then pounce at the dot's position at tell end; landing d to the dot: catch
                                        (<= catchR: pin pinS, then the cat ignores the dot laserMuteS so the player moves it),
                                        near miss (catchR < d <= nearMissR) or a plain miss; pounceCdS per cat from the launch.
                                        GE1-B 2026-10-11 (owner: "too easy"): a catch is EARNED: the kitten may hesitate (stare,
                                        hesitate*) before the tell, a stale pounce (staleP) commits to where the dot was at the
                                        tell start, a landed pounce can be fumbled (fumble*: pounce { fumbled: true, escaped:
                                        true } + near_miss), a miss may bore the kitten (missBoredP: it sits out boredS)
     { type: 'wand', on, p, speed }     feather wand tip (speed m/s from the host): nearby cats bat at it; a fast tip (> bigLeapV)
                                        makes a cat tell (leapTellS) then BIG LEAP to the highest legal surface it can reach
     { type: 'treat', on, hand, p }     open palm treat: the nearest awake cat comes; palm low enough = hops ONTO the hand
     { type: 'open_box' }               the host's open-box button (session.openBox() queues it, so the log replays it)
     { type: 'head', p, f? }            the player's head (p: x, z used; f: flat forward { x, z }), sent by the host when it moved / turned
                                        (Review CH M1): a keepOutM column around it that no idle / curious / home / wander target or
                                        walk leg enters, and no such target within behindM BEHIND the player; the curiosity stop sits on
                                        the far side of the hand from the body (in view). Until the first head event the room's build
                                        viewer / forward stand in. Logged like any event: the replay is exact.
   The 10-minute arc (plan 1.3; arc: true): box drops on the floor in front of the viewer, opens on a pinch (or after
   15 s), kittens climb out 5 at a time (waves every 2.5 s), play until 7:30, zoomies, then each cat walks to a nap spot
   (couch seat, then bed, then floor / rug) and naps; phase 'end' at 10:00.
   Event OUTPUT (plain data, metres; `session.events` = this step's list, derived from state, not hashed but
   replayed bit-for-bit by replayRoomEvents): { type: 'tell', cat, kind: 'pounce' | 'leap' }, { type: 'pounce', cat, catch,
   d }, { type: 'near_miss', cat, d }, { type: 'combo', n } (comboN catches within comboS, session-wide), { type: 'big_leap',
   cat, surf }, { type: 'hand_climb', cat }, { type: 'phase', phase }. No pounce or leap without a preceding tell.
   P0a slice events (GE1 2026-10-10, juice hooks for vr/src; all derived, none hashed, replayed exactly):
     { type: 'purr', cat, hearts, bond }   a stroke landed (once per petCdS per cat): purr + hearts (0..heartsMax, leak 1 per heartsDecayS)
     { type: 'eat', cat, hearts }          the treat is eaten (happy bump: hearts + 2, bond + 1); the cat then ignores treats for treatCdS
     { type: 'treat_come', cat }           a treat was shown and this cat is the one coming
     { type: 'toss', cat, speed, poof, hard } a pinch released: the flight starts (dry-run already decided the legal landing); hard = over the
                                           cap or a fall past lim.drop (both float down at floatG: "no throw off heights")
     { type: 'wander_off', cat, s }        hardTossN hard tosses in hardWindowS: the kitten walks away and ignores pinches for s seconds
     near_miss { ..., quiet }              quiet = within nearMissCdS of this kitten's last loud one: no caption (sound / sparks still)
     { type: 'land', cat, from, surf, squash, happy?, hard? }  feet on a legal surface; from = 'toss' | 'hop' | 'pounce' | 'climb' | 'bat' |
                                           'twist' | 'poof'; squash 0..1 from the impact speed (the host plays the squash-and-stretch);
                                           a toss landing says happy (gentle: the kitten purrs) or hard (it floated down)
     { type: 'catch', cat, d }             a pounce caught the dot (alongside { type: 'pounce', catch: true })
     { type: 'box_lid' }                   the lid opens; { type: 'box_peek', cat } boxPeekS before a kitten hops; { type: 'box_hop_out',
                                           cat, n } as it goes (one by one: wave slots waveStaggerS apart)
   Grounded cats ALWAYS stand on a legal room surface (feet y = surface y exactly, footprint legal with ROOM_LIMITS.catR);
   airborne = 'hop' | 'fly'; 'carried' / 'onhand' = the hand is the support; 'inbox' = the box floor; 'tell' (crouch) and
   'pin' (holding the caught dot) are grounded.
   "Behave like cats" (GDXE / GE1 2026-10-10, after the owner's Quest test of 6c06c90: "did not behave much like cats"): idle is a CYCLE
   (sit / loaf / groom / stretch / stand-and-look, 1.5-4.5 s bouts), walks are SHORT (<= wanderMaxM) and end in a stand-and-look pause
   (no gliding across the room), hops between surfaces are rare; CURIOSITY: a hand seen within curiousM in the last curiousAgeS draws an
   idle kitten to curiousStopM short of the point under it, where it sits facing the hand; HOME: a kitten farther than homeM from the box
   spot (= in front of the player) walks back; a stroked kitten turns to the hand (lean in); the laser chase SLOWS to a stalk inside
   stalkM before the crouch tell; a played-with kitten with no hearts left and no hand seen for dozeAfterS DOZES (pose 'nap', mode 'idle')
   and any hand / laser / treat wakes it (it stretches first). All of it seeded: the replay hash still pins it.
   Build rule: only `export function` / `export const`; private names carry the `rc` prefix. */
import { createPrng, createHasher } from './prng.js';
import { STEP_S } from './loop.js';
import { ROOM_LIMITS, roomInside, roomSurface, roomLegalAt, roomLineLegal, roomHops, roomRoute, roomNearestLegal, roomNapSpots } from './room.js';

export const ROOMCAT_VERSION = 2; // 2 = fun pass (tell / catch / pin / mute / combo / big leap)
export const ROOMCAT_SIZES = Object.freeze({
  kitten: Object.freeze({ h: 0.18, walk: 0.35, run: 0.9, up: 0.55, gap: 0.6, drop: 1.4, scruff: 0.15 }),
  adult: Object.freeze({ h: 0.3, walk: 0.5, run: 1.4, up: 1.0, gap: 1.2, drop: 1.4, scruff: 0.26 }),
});
export const ROOMCAT_TUNING = Object.freeze({
  g: 9.81, floatG: 1.6, tossCap: 1.6, hopClear: 0.1, maxFlyS: 4,
  pinchR: 0.1, petR: 0.25, petCdS: 0.5, pounceR: 0.14, batR: 0.28, treatR: 0.13, handHop: 1.0, eatS: 2,
  // petR 0.2 -> 0.25 = gestures.js petNear (a stroke the gesture accepts always purrs); handHop 0.5 -> 1.0: the treat gesture only STARTS
  // above the lap line (seated head - 0.45 m ~ 0.75 m, standing >= 0.7 m above the floor), so a floor kitten could never reach a palm
  // it was allowed to see (it begged forever, no 'eat', no meter); a kitten now hops up to a palm at hip height (owner's Quest test fix)
  boxDropS: 0.35, boxDropH: 0.6, boxAutoOpenS: 15, waveSize: 5, waveS: 2.5, waveStaggerS: 0.2, boxH: 0.3, boxR: 0.14,
  playEndS: 450, zoomiesS: 20, endS: 600, interest: 1.0, maxCats: 24, // interest 0.75 -> 1.0: with 3 kittens one in four ignored the dot for the whole visit ("they don't chase it")
  // "behave like cats" (GDXE / GE1 2026-10-10; see the header): idle cycle, short walks + pauses, curiosity, home, stalk, doze
  wanderMaxM: 1.2, pauseS0: 0.4, pauseS1: 1.4, idleS0: 1.5, idleS1: 4.5, hopP: 0.12, stretchS: 1.2,
  curiousM: 2.5, curiousAgeS: 3, curiousP: 0.45, curiousStopM: 0.3, lookS0: 1.0, lookS1: 2.5, curiousDetourCdS: 2, hopOverN: 400, smoothLook: 10,
  homeM: 2.3, homeP: 0.6, // homeM 1.6 -> 2.3 (GE1-B 2026-10-11, owner: "play zone is small"): the kittens' home circle doubles in area; still a walk back, in view
  stalkM: 0.55, stalkV: 0.45,
  dozeAfterS: 20, dozeS0: 6, dozeS1: 12,
  // Review CH S3 (hand-tracking jitter): the pounce LEAD reads the dot's velocity over the last leadWinS (a ring of per-step dot
  // positions), not over the 0.25 s tell: 3 mm of joint jitter through the ray is 2-5 cm of random "travel" per tell (x1.24 lead = a
  // miss every time, catches 1-6 %) but only ~0.07 m/s over half a second; a dot whose lead travel (v x tellS) is under leadDeadM is
  // HELD: aimed exactly, no scatter. The dot itself is never smoothed (the catch / escape geometry stays raw and testable).
  leadWinS: 0.5, leadDeadM: 0.05, heldMeanN: 8,
  keepOutM: 0.4, behindM: 1.0, // Review CH M1: the player's body column (no kitten target / walk leg inside), and no target within behindM behind the head
  // review fixes: fallback hops (twist / off the hand) are not snaps: at most floatV (poof float) or hopV m/s across,
  // never longer than maxSafeS; a hand that sends nothing for handLostS lets go of its cat; a cat leaves a palm after onhandMaxS
  floatV: 1.2, hopV: 3, maxSafeS: 3.5, handLostS: 3, onhandMaxS: 12,
  // re-review SHOULD 2: a cat on a palm glides after the moving palm (this fraction of the gap per 60 Hz step)
  palmFollow: 0.25,
  // fun pass (docs/GAMES-FUN-AUDIT.md section 2 #1 + section 5): the laser beat is a game, not a pounce storm.
  // tellS: crouch before every pounce (aimed at the dot at tell END); pounceCdS: per-cat pounce cooldown counted from the
  // launch (was a 0.5 s literal); pounceReach: a pounce never flies further than this from the cat (a dot that ran away =
  // a short miss, never a snap); catchR / nearMissR: landing-point-to-dot bands AT LANDING (one rule); pinS: the kitten
  // pins a caught dot; laserMuteS: it ignores the dot for this long STARTING WHEN THE PIN ENDS (the player moves the dot);
  // missStareS: after a miss the kitten stares at the dot (the "lost it... found it!" beat) before chasing again;
  // pounceLeadS: the pounce leads a MOVING dot by its speed over the tell times the flight (0.31 s): a steady dot is
  // caught, a dot that changes direction during the tell / flight escapes (the player's skill); comboN catches within comboS = 'combo'; bigLeapV: wand tip speed that earns a big leap, leapTellS crouch first,
  // leapCoolS per cat, leapReach: landing within this of the tip (seated + in reach), leapRun: the run-up to the hop edge.
  tellS: 0.4, pounceCdS: 2.0, pounceReach: 0.3, pounceLeadS: 0.31, missStareS: 1.6, catchR: 0.035, nearMissR: 0.16, pinS: 0.8, laserMuteS: 2.5, comboN: 3, comboS: 10, comboCdS: 25,
  // P0a Build 1 (GDXE fix 1): catchR 0.05 -> 0.035, nearMissR 0.1 -> 0.16, and a dot that moved more than escapeM during the
  // flight (launch -> landing) is never caught (the player's move is the escape): catches 35-50 % of pounces on the slow sweep
  escapeM: 0.12, // (comboCdS: one 'combo' caption per 25 s, so a slow-dot catch storm reads as <= 2 combos / min)
  // aimErr: the pounce aim scatters (seeded prng, uniform disc) by up to aimErr x the dot's travel during the tell: a still
  // dot is hit exactly, a moving one lands a few cm off either way (the lead's systematic error alone made catches a knife edge)
  aimErr: 0.65, aimErrS: 0.25, // aimErrS (GE1-B): the dot-travel window the scatter (and the held-dot dead zone) scales with = the old 0.25 s tell
  // GE1-B 2026-10-11 (the owner's Quest test of the laser: "too easy for them to catch (but fun)"): a catch is EARNED, not instant.
  // hesitateP: the first time a kitten gets inside pounceR on an approach it freezes (stare) for hesitateS0..S1 with this chance
  // (reaction delay; the player sees it coming); staleP: the pounce commits to where the dot WAS when the tell started (no lead:
  // a dot that kept moving during the tell is missed); fumbleP0 / fumbleK / fumbleMax: a pounce that landed on the dot is still
  // fumbled (the paw slips: an escaped near miss) with chance fumbleP0 + dot speed (m/s, over leadWinS) x fumbleK, capped at
  // fumbleMax (a fast dot is nearly never pinned); missBoredP / boredS: after a miss the kitten sometimes loses interest and sits
  // watching the dot for boredS (the c.mute path). With them: tellS 0.25 -> 0.4, pounceCdS 1.2 -> 2.0, missStareS 1.2 -> 1.6,
  // laserMuteS 1.5 -> 2.5. Measured (game/test/roomcat-laser-rate.test.mjs, 3 kittens on the rug): a slowly swept dot = one catch
  // per 4-8 s of play (was 2 s), a still dot one per ~2 s (was 1 s), a fast dot one per 10+ s. All seeded: replays stay exact.
  hesitateP: 0.5, hesitateS0: 0.3, hesitateS1: 0.8, staleP: 0.35, fumbleP0: 0.3, fumbleK: 0.35, fumbleMax: 0.85, missBoredP: 0.2, boredS: 3,
  // P0a fix round (same-surface stall): a straight walk blocked by a plane / obstacle on the SAME surface (a couch between the
  // kitten and the dot) plans a detour over the surface's sample grid (BFS + line-of-sight smoothing, rcGrid); retried every
  // detourCdS while blocked (no stare lock)
  detourCdS: 0.5,
  bigLeapV: 1.5, leapTellS: 0.3, leapCoolS: 8, leapReach: 1.5, leapRun: 0.5,
  // P0a slice (GE1): hearts per cat (stroke + 1, treat + 2, leak 1 per heartsDecayS), a cat that just ate ignores treats for
  // treatCdS (the next nearest cat comes), box_peek leads the hop out by boxPeekS, squash = impact speed / squashV (cap 1)
  heartsMax: 5, heartsDecayS: 4, treatCdS: 6, boxPeekS: 0.3, squashV: 6, // squashV 3 -> 6 (Review BA): a 0.46 m fall no longer saturates the squash
  // toss conditions (Review BA): a HARD toss = over tossCap or a fall past lim.drop (both float down); hardTossN of them
  // within hardWindowS -> the kitten wanders off for sulkS (no pinch, no chase; walks away; 'wander_off' event, never a hurt state)
  hardTossN: 4, hardWindowS: 20, sulkS: 8, hardV: 2.6, hardDrop: 2.2, // GDXE Build 2 MUST 1: hard = over hardV (a VR wrist flick is 2-3 m/s: not hard) or an apex more than hardDrop above the landing (a throw off a height); the flight still caps at tossCap and floats past lim.drop
  nearMissCdS: 6, // GDXE Build 2 item 4: a kitten's near_miss within this of its last one carries quiet: true (the host captions only loud ones; sounds / sparks / meter unchanged)
});
/** pure helper: catch ring buffer. Pushes `tick`, drops entries older than `windowTicks`, and when `n` catches sit
 *  inside the window returns true and clears the buffer (one combo per n catches). Mutates `buf`. */
export function rcCombo(buf, tick, n = ROOMCAT_TUNING.comboN, windowTicks = Math.round(ROOMCAT_TUNING.comboS / STEP_S)) {
  buf.push(tick);
  let k = 0; while (k < buf.length && tick - buf[k] > windowTicks) k++;
  if (k) buf.splice(0, k);
  if (buf.length >= n) { buf.length = 0; return true; }
  return false;
}
const RC_T = (s) => Math.round(s / STEP_S);
const RC_SLACK = 0.03; // detour legs are planned with catR + this: the 5 cm line check never trips the per-step walk on a corner notch
const RC_GRIDS = new WeakMap(); // surface -> neighbour lists over its samples (built once, read-only)
/** the k nearest connected samples to (px, pz), nearest first, by insertion into a fixed buffer (no sort of all n; Review BA SHOULD 2) */
function rcNearest(S, G, px, pz, k, buf) {
  const idx = buf.idx, dd = buf.d; let m = 0;
  for (let i = 0; i < S.length; i++) {
    if (!G[i].length) continue;
    const dx = S[i].x - px, dz = S[i].z - pz, d = dx * dx + dz * dz;
    if (m === k && d >= dd[m - 1]) continue;
    let j = m < k ? m : k - 1; while (j > 0 && dd[j - 1] > d) { dd[j] = dd[j - 1]; idx[j] = idx[j - 1]; j--; }
    dd[j] = d; idx[j] = i; if (m < k) m++;
  }
  return Array.prototype.slice.call(idx, 0, m);
}
/** P0a: the walkable graph of a surface's samples: i -> [j...] for samples within 2.5 grid steps joined by a legal straight line */
let RC_GRID_BUILDS = 0;
/** how many detour grids have been built so far (tests: none during play) */
export function rcGridBuilds() { return RC_GRID_BUILDS; }
function rcGrid(room, surf) {
  let g = RC_GRIDS.get(surf); if (g) return g;
  RC_GRID_BUILDS++;
  const S = surf.samples, n = S.length; let step = Infinity;
  for (let i = 1; i < n; i++) { const d = rcLen(S[i].x - S[0].x, S[i].z - S[0].z); if (d < step) step = d; }
  const R = step * 2.5, R2 = R * R; g = []; // (2.5 steps: a missing grid row, e.g. a 0.3 m corridor between two tables, is still crossed)
  for (let i = 0; i < n; i++) { const nb = []; for (let j = 0; j < n; j++) { if (j === i) continue; const dx = S[j].x - S[i].x, dz = S[j].z - S[i].z; if (dx * dx + dz * dz <= R2 && roomLineLegal(room, surf.id, S[i], S[j], ROOM_LIMITS.catR + RC_SLACK)) nb.push(j); } g.push(nb); }
  RC_GRIDS.set(surf, g); return g;
}

function rcLen(x, z) { return Math.sqrt(x * x + z * z); }
/** do segments p-q and a-b (x, z) cross? */
function rcCross(px, pz, qx, qz, a, b) {
  const o = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = o(a.x, a.z, b.x, b.z, px, pz), d2 = o(a.x, a.z, b.x, b.z, qx, qz), d3 = o(px, pz, qx, qz, a.x, a.z), d4 = o(px, pz, qx, qz, b.x, b.z);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function rcFace(c, dx, dz) { const l = rcLen(dx, dz); if (l > 1e-6) { c.fx = dx / l; c.fz = dz / l; } }

/** Create a session. opts: { room (createRoom), seed, cats: number | [{ id, size, napSurf? }], size = 'kitten', arc = true }.
 *  napSurf (W4 kitten memory): the id of the surface this cat heads to first at nap time when it is free (its
 *  remembered favourite spot, matched by label in vr/src/return-visit.js spotsForRoom); other cats are unchanged. */
export function createRoomSession(opts = {}) {
  const room = opts.room, T = ROOMCAT_TUNING, prng = createPrng(opts.seed == null ? 1 : opts.seed);
  if (!room || !room.floor) throw new Error('roomcat: room with a floor (or rug) required');
  const arc = opts.arc !== false;
  let list = Array.isArray(opts.cats) ? opts.cats : Array.from({ length: opts.cats == null ? 3 : opts.cats }, (_, i) => ({ id: 'k' + (i + 1) }));
  list = list.slice(0, T.maxCats);
  const floor = roomSurface(room, room.floor);
  const boxSpot = room.box || { surf: floor.id, x: floor.samples[0].x, y: floor.y, z: floor.samples[0].z };
  const s = {
    tick: 0, phase: arc ? 'drop' : 'play', phaseT: 0, openTick: -1,
    box: { x: boxSpot.x, y: boxSpot.y + (arc ? T.boxDropH : 0), z: boxSpot.z, surf: boxSpot.surf, landed: !arc, open: !arc, gone: !arc },
    laser: null, wand: null, treat: null, hands: {}, log: [], queue: [], napTaken: [], napSpots: null,
    cats: [], out: [], combo: [], comboCd: 0, lastHandTick: -1e9,
    head: { x: room.viewer ? room.viewer.x : 0, z: room.viewer ? room.viewer.z : 0, fx: room.forward ? room.forward.x : 0, fz: room.forward ? room.forward.z : -1 },
    laserHistN: Math.round(ROOMCAT_TUNING.leadWinS / STEP_S) + 1, // the dot per step over the last leadWinS (CH S3), as a preallocated ring (CK S2: no per-step object)
    laserHX: new Float64Array(Math.round(ROOMCAT_TUNING.leadWinS / STEP_S) + 1), laserHZ: new Float64Array(Math.round(ROOMCAT_TUNING.leadWinS / STEP_S) + 1), laserHS: new Array(Math.round(ROOMCAT_TUNING.leadWinS / STEP_S) + 1).fill(null),
  };
  const emit = (ev) => { s.out.push(ev); };
  list.forEach((d, i) => {
    const size = ROOMCAT_SIZES[d.size || opts.size || 'kitten'] ? (d.size || opts.size || 'kitten') : 'kitten';
    const c = { id: String(d.id != null ? d.id : 'k' + (i + 1)), size, lim: ROOMCAT_SIZES[size], x: 0, y: 0, z: 0, surf: null, mode: 'inbox', pose: 'inbox',
      fx: 0, fz: 1, t: 0, plan: [], hop: null, fly: null, poof: false, bond: 0, purr: 0, petCd: 0, interest: prng.chance(T.interest),
      goal: 'wander', nap: null, eat: 0, hand: null, onT: 0, wave: Math.floor(i / T.waveSize), slot: i % T.waveSize, cool: 0, lastHop: 0,
      tell: 0, tellKind: null, tellX: 0, tellZ: 0, pin: 0, mute: 0, leapCool: 0, leap: null,
      hearts: 0, heartT: 0, treatCd: 0, peeked: false, detourCd: 0, detourTo: null, dotX0: 0, dotZ0: 0, hardT: [], sulk: 0, tossHard: false, nmTick: -1e9,
      played: 0, wake: false, curDetCd: 0, hes: false, // hes = hesitated on this approach already (GE1-B) // played = deeds that landed on this kitten (purr / eat / catch / gentle toss); wake = just woke from a doze (stretch first)
      napSurf: typeof d.napSurf === 'string' && d.napSurf ? d.napSurf : null };
    if (arc) { c.x = s.box.x + (prng.next() - 0.5) * 0.12; c.z = s.box.z + (prng.next() - 0.5) * 0.12; c.y = s.box.y; c.surf = 'box'; }
    else { const p = prng.pick(floor.spots); c.x = p.x; c.z = p.z; c.y = floor.y; c.surf = floor.id; c.mode = 'idle'; c.pose = 'sit'; c.t = RC_T(prng.range(0.2, 1.5)); }
    s.cats.push(c);
  });

  const legalAt = (c, x, z) => roomLegalAt(room, c.surf, x, z);
  for (const q of room.surfaces) if (q.legal) rcGrid(room, q); // detour grids built NOW (session set-up, during the box drop), never on a play frame (Review BA SHOULD 2: a 7-25 ms first-detour hitch)
  // fixed per room: horizontal surfaces (landing / bonk) and vertical ones (walls) for the toss sweep
  const flat = room.surfaces.filter((q) => q.kind !== 'vertical'), vert = room.surfaces.filter((q) => q.kind === 'vertical');
  // ballistic arc to (x, y, z); g / minDur optional (fallback hops: float gravity, a minimum duration from the distance)
  const startHop = (c, to, x, y, z, clear = T.hopClear, pose = 'hop', g = T.g, minDur = 0) => {
    const y0 = c.y, apex = Math.max(y0, y) + clear;
    let vy = Math.sqrt(2 * g * (apex - y0)), dur = vy / g + Math.sqrt(2 * (apex - y) / g);
    if (minDur > dur) { dur = minDur; vy = (y - y0 + 0.5 * g * dur * dur) / dur; }
    rcFace(c, x - c.x, z - c.z);
    c.hop = { x0: c.x, y0, z0: c.z, x1: x, y1: y, z1: z, vy, g, dur, n: Math.max(6, Math.ceil(dur / STEP_S)), k: 0, to, kind: pose };
    c.mode = 'hop'; c.pose = pose; c.surf = null; c.lastHop = s.tick;
  };
  // fallback hop to a safe landing L: within the cat's size limits it is a normal hop at <= hopV m/s; a longer drop than
  // lim.drop or a wider gap than lim.gap becomes a slow poof float (low gravity, <= floatV m/s across): never a snap
  const safeHop = (c, L, pose) => {
    const hd = rcLen(L.x - c.x, L.z - c.z), float = pose === 'poof' || c.y - L.y > c.lim.drop || hd > c.lim.gap;
    const dur = Math.min(T.maxSafeS, hd / (float ? T.floatV : T.hopV));
    c.poof = float;
    startHop(c, L.surf, L.x, L.y, L.z, 0.05, float ? 'poof' : pose, float ? T.floatG : T.g, dur);
  };
  // the hand lets go (treat closed / eaten + bored / tracking lost / landing on a hand with no treat): nearest legal spot
  const dropFromHand = (c) => {
    c.hand = null; c.eat = 0; c.plan = [];
    safeHop(c, roomNearestLegal(room, { x: c.x, y: c.y, z: c.z }), 'hop');
  };
  const land = (c, surf, x, y, z, from, vImp) => {
    const wasPoof = c.poof;
    c.x = x; c.y = y; c.z = z; c.surf = surf; c.hop = null; c.fly = null; c.poof = false; c.mode = 'idle';
    const ev = { type: 'land', cat: c.id, from, surf, squash: Math.round(Math.min(1, Math.abs(vImp || 0) / T.squashV) * 100) / 100 };
    const tossed = from === 'toss' || from === 'twist' || from === 'poof';
    if (tossed) { ev.happy = !c.tossHard && !c.sulk; ev.hard = c.tossHard; } // the kitten liked a gentle toss; a hard one (over the cap / off a height) it did not (= the toss event's `hard`, BE NIT 1)
    emit(ev);
    if (tossed) rcAfterToss(c);
  };
  //: a gentle landing = a short purr ("liked it"); hardTossN hard tosses within hardWindowS = the kitten wanders off for
  // sulkS (ignores pinches, walks to a far spot, gentle pose; never a hurt state) and says so once
  const rcAfterToss = (c) => {
    if (c.hardT.length >= T.hardTossN && !c.sulk) { c.sulk = RC_T(T.sulkS); c.hardT.length = 0; c.plan = []; c.t = RC_T(0.3); c.pose = 'loaf'; emit({ type: 'wander_off', cat: c.id, s: T.sulkS }); return; }
    if (!c.sulk && !c.tossHard) { c.purr = RC_T(1.2); c.played++; }
  };
  const hearts = (c, n) => { c.hearts = Math.min(T.heartsMax, c.hearts + n); c.heartT = RC_T(T.heartsDecayS); return c.hearts; };
  // plan a route; validated first with no allocation (failed plans, e.g. a chase that cannot reach the dot, are the
  // common case during laser play), the plan legs are only built once the whole route is legal
  const picks = [], goalXZ = { x: 0, z: 0 };
  const planTo = (c, surf, x, z) => {
    const route = roomRoute(room, c.surf, surf, c.lim); if (!route) return false;
    let cur = c, cs = c.surf; picks.length = 0;
    for (const e of route) {
      let pair = null;
      for (const p of e.pairs) if (roomLineLegal(room, cs, cur, p.a)) { pair = p; break; }
      if (!pair) return false;
      picks.push(pair); cur = pair.b; cs = e.to;
    }
    goalXZ.x = x; goalXZ.z = z;
    if (!roomLineLegal(room, cs, cur, goalXZ)) return false;
    const plan = [];
    for (let i = 0; i < route.length; i++) { const pair = picks[i]; plan.push({ k: 'walk', x: pair.a.x, z: pair.a.z }, { k: 'hop', to: route[i].to, x: pair.b.x, z: pair.b.z }); }
    plan.push({ k: 'walk', x, z }); c.plan = plan; return true;
  };
  // walk toward (x, z) on the current surface; true = arrived, false = moving, null = blocked
  const walk = (c, x, z, speed) => {
    const dx = x - c.x, dz = z - c.z, d = rcLen(dx, dz), st = speed * STEP_S;
    rcFace(c, dx, dz);
    if (d <= st) { if (!legalAt(c, x, z)) return null; c.x = x; c.z = z; return true; }
    const nx = c.x + dx / d * st, nz = c.z + dz / d * st;
    if (!legalAt(c, nx, nz)) return null;
    c.x = nx; c.z = nz; return false;
  };
  // same-surface detour (P0a fix round): a path over the surface's sample grid (neighbours = samples within 2.5 grid steps
  // joined by a legal straight line; built once per surface, cached), BFS from the sample nearest the cat to the sample nearest
  // the goal, then line-of-sight smoothing. Returns the waypoints [{ x, z }...] (the goal last) or null when no path exists.
  const pickBuf = { idx: new Int32Array(16), d: new Float64Array(16) };
  const detour = (c, x, z) => {
    const p = pathOn(c.surf, c, x, z); if (p) return p;
    return hopOver(c, x, z);
  };
  // the same-surface path from any point `from` = { x, z } on surface `surfId` to (x, z): waypoints (the goal last) or null
  const pathOn = (surfId, from, x, z) => {
    const surf = roomSurface(room, surfId), c = from; if (!surf || surf.samples.length < 2) return null;
    const G = rcGrid(room, surf), S = surf.samples, n = S.length;
    const pick = (px, pz, from) => { // the 16 nearest CONNECTED samples (a sample inside the slack margin has no edges), nearest first, the first with a legal straight line from / to (px, pz)
      const order = rcNearest(S, G, px, pz, 16, pickBuf);
      for (let k = 0; k < order.length; k++) { const i = order[k]; if (from ? roomLineLegal(room, surf.id, goalXZ2(px, pz), S[i]) : roomLineLegal(room, surf.id, S[i], goalXZ2(px, pz))) return i; } // (the legs from the cat and to the goal keep the plain margin: both may sit just inside the slack)
      return -1;
    };
    const a = pick(c.x, c.z, true), b = pick(x, z, false); if (a < 0 || b < 0) return null;
    const prev = new Int32Array(n).fill(-2); prev[a] = -1; const q = [a]; let found = a === b;
    for (let h = 0; h < q.length && !found; h++) { const u = q[h]; for (const v of G[u]) if (prev[v] === -2) { prev[v] = u; if (v === b) { found = true; break; } q.push(v); } }
    if (!found) return null;
    const path = []; for (let k = b; k >= 0; k = prev[k]) path.unshift(S[k]);
    const out = []; let cur = { x: c.x, z: c.z }, i = 0; // smoothing: from cur, skip to the farthest path point in a legal line
    while (i < path.length) { let j = Math.min(path.length - 1, i + T.smoothLook); while (j > i && !roomLineLegal(room, surf.id, cur, path[j], ROOM_LIMITS.catR + RC_SLACK)) j--; out.push({ x: path[j].x, z: path[j].z }); cur = path[j]; i = j + 1; } // (CH S1: the look-ahead is capped at smoothLook samples: the line checks per leg are bounded, a long straight stays a few short legs)
    out.push({ x, z }); return out;
  };
  // the floor is cut in two (a couch + a table leave no corridor): hop ONTO a legal surface the kitten can reach from where it
  // stands (a sample of S within lim.gap / lim.up), walk across it, and hop off onto the sample of c.surf nearest the goal that
  // a hop can reach and that has a legal line (or a pathOn() path) to the goal. Waypoints carry { hop: true, to } for the hops.
  const hopOver = (c, x, z) => {
    const here = roomSurface(room, c.surf); if (!here) return null;
    let best = null, bd = Infinity;
    for (const e1 of roomHops(room, c.surf, c.lim)) {
      const S = roomSurface(room, e1.to); if (!S || !S.legal) continue;
      let b1 = null, d1 = c.lim.gap; // take-off from where the cat stands onto the nearest sample of S within the hop gap
      for (const q of S.samples) { const d = rcLen(q.x - c.x, q.z - c.z); if (d <= d1) { d1 = d; b1 = q; } }
      if (!b1) continue;
      // CH S1 (cost bound): at most ~hopOverN landing candidates per surface (every stride-th sample of a big floor; a 0.1 m grid
      // becomes a 0.2-0.3 m one for the landing choice), was every sample x every sample of S: 12 ms spikes
      const HS = here.samples, stride = Math.max(1, Math.ceil(HS.length / T.hopOverN));
      for (let fi = 0; fi < HS.length; fi += stride) { const f = HS[fi]; // the landing back on c.surf: near the goal, within the gap of some sample of S
        const dg = rcLen(x - f.x, z - f.z); if (dg >= 2.5 || d1 + dg >= bd) continue;
        let b2 = null, d2 = c.lim.gap; for (const q of S.samples) { const d = rcLen(q.x - f.x, q.z - f.z); if (d <= d2) { d2 = d; b2 = q; } }
        if (!b2 || !roomLineLegal(room, e1.to, b1, b2)) continue;
        const leg3 = roomLineLegal(room, c.surf, f, goalXZ2(x, z)) ? [{ x, z }] : pathOn(c.surf, f, x, z); if (!leg3) continue;
        bd = d1 + dg; best = [{ x: b1.x, z: b1.z, hop: true, to: e1.to }, { x: b2.x, z: b2.z }, { x: f.x, z: f.z, hop: true, to: c.surf }].concat(leg3);
      }
    }
    return best;
  };
  const goalXZ2 = (x, z) => { goalXZ.x = x; goalXZ.z = z; return goalXZ; };
  const rcLegs = (w) => w.map((p) => (p.hop ? { k: 'hop', to: p.to, x: p.x, z: p.z } : { k: 'walk', x: p.x, z: p.z }));
  // walk straight, or when blocked plan a detour (plan legs); returns walk()'s result, or 'detour' when a detour plan was set
  const walkOrDetour = (c, x, z, speed, goal) => {
    const r = walk(c, x, z, speed); if (r !== null) return r;
    if (c.detourCd > 0) return null; c.detourCd = RC_T(T.detourCdS);
    const w = detour(c, x, z); if (!w) return null;
    c.plan = rcLegs(w); c.goal = goal; c.detourTo = { x, z }; return 'detour';
  };
  const scruff = (c) => ({ x: c.x, y: c.y + c.lim.scruff, z: c.z });
  const d3 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); };
  const busy = (c) => c.mode === 'carried' || c.mode === 'onhand' || c.mode === 'inbox' || c.mode === 'hop' || c.mode === 'fly' || c.mode === 'climb';
  // one fixed step of a toss flight F = { x, y, z, vx, vy, vz, g, h } (shared by the dry-run and the real flight, so both
  // are identical). Swept: crossing a wall stops the horizontal motion (the cat slides down it); the cat's HEAD (feet + h,
  // re-review SHOULD 4) rising into a horizontal surface from below (table top, ceiling) bonks: vertical speed 0, head
  // just under it (never pushed down). Returns the landing surface or null.
  const flyStep = (F) => {
    const px = F.x, py = F.y, pz = F.z;
    F.vy -= F.g * STEP_S; F.x += F.vx * STEP_S; F.y += F.vy * STEP_S; F.z += F.vz * STEP_S;
    for (const w of vert) {
      if (F.y < w.lo - 0.02 || F.y > w.y) continue;
      if ((w.seg && rcCross(px, pz, F.x, F.z, w.seg.a, w.seg.b)) || roomInside(room, w.id, F.x, F.z)) { F.x = px; F.z = pz; F.vx = 0; F.vz = 0; break; }
    }
    if (F.vy > 0) {
      const h = F.h || 0;
      for (const q of flat) if (py < q.y - 1e-6 && F.y + h >= q.y && roomInside(room, q.id, F.x, F.z)) { F.y = Math.max(py, Math.min(F.y, q.y - h - 0.01)); F.vy = 0; return null; }
      return null;
    }
    let hit = null;
    for (const q of flat) if (q.kind !== 'ceiling' && py >= q.y && F.y <= q.y && (!hit || q.y > hit.y) && roomInside(room, q.id, F.x, F.z)) hit = q;
    return hit;
  };
  // toss: dry-run the swept flight; illegal landing -> fallback hop (twist / poof float) to the nearest legal spot
  const toss = (c, v) => {
    let vx = v ? +v.x || 0 : 0, vy = v ? +v.y || 0 : 0, vz = v ? +v.z || 0 : 0;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    c.poof = sp > T.tossCap;
    if (c.poof) { const k = T.tossCap / sp; vx *= k; vy *= k; vz *= k; }
    let g = c.poof ? T.floatG : T.g, D = { x: c.x, y: c.y, z: c.z, vx, vy, vz, g, h: c.lim.h };
    let hit = null, n = 0;
    for (; n < RC_T(T.maxFlyS) && !hit; n++) hit = flyStep(D);
    // Review BA P0a MUST 1 ("never harm, no throw off heights"): a let-go / gentle toss whose fall would exceed the
    // kitten's own drop limit (lim.drop, the hops' rule) floats down at floatG like a hard throw, never a full-g drop
    const apex = c.y + Math.max(0, vy) * Math.max(0, vy) / (2 * g); // a lob is measured from its APEX (Review BE SHOULD 1)
    if (!c.poof && (!hit || apex - hit.y > c.lim.drop)) {
      c.poof = true; g = T.floatG; D = { x: c.x, y: c.y, z: c.z, vx, vy, vz, g, h: c.lim.h }; hit = null; n = 0;
      for (; n < RC_T(T.maxFlyS) && !hit; n++) hit = flyStep(D);
    }
    const landY = hit ? hit.y : roomNearestLegal(room, { x: D.x, y: Math.max(c.y, D.y), z: D.z }).y, hard = sp > T.hardV || apex - landY > T.hardDrop; // over hardV, or a fall past lim.drop from the apex; the landing's `hard` says the same (BE NIT 1). A 1.6-2.6 m/s toss floats (cap) but is NOT hard
    emit({ type: 'toss', cat: c.id, speed: Math.round(sp * 100) / 100, poof: c.poof, hard });
    c.tossHard = hard; if (hard) { c.hardT.push(s.tick); while (c.hardT.length && s.tick - c.hardT[0] > RC_T(T.hardWindowS)) c.hardT.shift(); } else c.hardT.length = 0; // (a gentle toss forgives)
    if (hit && roomLegalAt(room, hit.id, D.x, D.z)) {
      c.fly = { x: c.x, y: c.y, z: c.z, vx, vy, vz, g, h: c.lim.h, n, k: 0, surf: hit.id, x1: D.x, y1: hit.y, z1: D.z };
      c.mode = 'fly'; c.pose = c.poof ? 'poof' : 'fall'; c.surf = null; rcFace(c, vx, vz);
    } else {
      const L = roomNearestLegal(room, { x: D.x, y: Math.max(c.y, D.y), z: D.z });
      // the fallback starts at the release point (feet); it never passes through a wall: the target is inside the room
      safeHop(c, L, c.poof ? 'poof' : 'twist');
    }
  };
  const dotFor = (p) => {
    if (!p) return null;
    return roomNearestLegal(room, { x: p.x, y: p.y + 0.02, z: p.z });
  };
  const apply = (ev) => {
    const h = ev.hand || 'r';
    if (ev.type === 'move' || ev.type === 'pinch' || ev.type === 'treat') if (ev.p) s.hands[h] = { x: ev.p.x, y: ev.p.y, z: ev.p.z, tick: s.tick };
    if (ev.type === 'head') { if (ev.p) { s.head.x = +ev.p.x || 0; s.head.z = +ev.p.z || 0; } if (ev.f && (ev.f.x || ev.f.z)) { const l = rcLen(ev.f.x, ev.f.z); s.head.fx = ev.f.x / l; s.head.fz = ev.f.z / l; } return; }
    if (ev.type !== 'open_box' && (ev.p || ev.type === 'release' || ev.on === false)) { s.lastHandTick = s.tick; rcWake(); }
    if (ev.type === 'pinch' && ev.p) {
      if (s.box.landed && !s.box.open && d3(ev.p, { x: s.box.x, y: s.box.y + T.boxH, z: s.box.z }) <= 0.3) { rcOpen(); return; }
      let best = null, bd = T.pinchR;
      for (const c of s.cats) { if (c.mode === 'carried' || c.mode === 'inbox' || c.mode === 'onhand' || c.sulk > 0) continue; const d = d3(ev.p, scruff(c)); if (d <= bd) { bd = d; best = c; } }
      if (best) { const c = best; c.mode = 'carried'; c.pose = 'carried'; c.surf = null; c.hop = null; c.fly = null; c.plan = []; c.hand = h; c.onT = s.tick; c.x = ev.p.x; c.y = ev.p.y - c.lim.scruff; c.z = ev.p.z; }
    } else if (ev.type === 'move' && ev.p) {
      // carried cats hang from the pinch (exact); on-palm cats glide after the palm in stepCat (no teleport)
      for (const c of s.cats) if (c.mode === 'carried' && c.hand === h) { c.x = ev.p.x; c.z = ev.p.z; c.y = ev.p.y - c.lim.scruff; }
      if (s.treat && s.treat.hand === h) { s.treat.p = { x: ev.p.x, y: ev.p.y, z: ev.p.z }; s.treat.at = dotFor(ev.p); }
    } else if (ev.type === 'release') {
      for (const c of s.cats) if (c.mode === 'carried' && c.hand === h) { c.hand = null; toss(c, ev.v); }
    } else if (ev.type === 'pet' && ev.p) {
      for (const c of s.cats) {
        if (c.mode === 'carried' || c.mode === 'inbox' || c.mode === 'hop' || c.mode === 'fly') continue;
        const b = { x: c.x, y: c.y + c.lim.h * 0.8, z: c.z };
        if (d3(ev.p, b) <= T.petR) {
          c.purr = RC_T(1.2); rcFace(c, ev.p.x - c.x, ev.p.z - c.z); // leans into the hand: turns to it
          if (c.petCd <= 0) { c.bond++; c.played++; c.petCd = RC_T(T.petCdS); emit({ type: 'purr', cat: c.id, hearts: hearts(c, 1), bond: c.bond }); }
          if (c.mode !== 'nap' && c.mode !== 'onhand' && c.mode !== 'pin') { c.mode = 'idle'; c.pose = 'petted'; c.plan = []; c.t = RC_T(1.2); }
        }
      }
    } else if (ev.type === 'open_box') {
      if (s.box.landed && !s.box.open) rcOpen();
    } else if (ev.type === 'laser') {
      s.laser = ev.on === false || !ev.p ? null : dotFor(ev.p);
    } else if (ev.type === 'wand') {
      s.wand = ev.on === false || !ev.p ? null : { p: { x: ev.p.x, y: ev.p.y, z: ev.p.z }, at: dotFor(ev.p), speed: Math.max(0, +ev.speed || 0) };
    } else if (ev.type === 'treat') {
      if (ev.on === false) {
        // the palm closes: a cat on it OR still hopping onto it (review MUST 2) drops to the nearest legal spot
        for (const c of s.cats) if (c.hand === h && (c.mode === 'onhand' || (c.mode === 'hop' && c.hop.to === 'hand'))) dropFromHand(c);
        if (s.treat && s.treat.hand === h) s.treat = null;
      } else if (ev.p) {
        let best = null, bd = Infinity; const at = dotFor(ev.p);
        for (const c of s.cats) { if (busy(c) || c.mode === 'nap' || c.treatCd > 0 || c.sulk > 0) continue; const d = d3(c, at); if (d < bd) { bd = d; best = c; } }
        s.treat = { hand: h, p: { x: ev.p.x, y: ev.p.y, z: ev.p.z }, at, cat: best ? best.id : null };
        if (best) { best.plan = []; emit({ type: 'treat_come', cat: best.id }); }
      }
    }
  };
  function rcOpen() { s.box.open = true; s.openTick = s.tick; s.phase = 'climb'; emit({ type: 'box_lid' }); }
  // a hand is back (any hand event): dozing kittens stir within 0.5-1.5 s and stretch when they get up
  function rcWake() { for (const c of s.cats) if (c.mode === 'idle' && c.pose === 'nap') { if (c.t > RC_T(1.5)) c.t = RC_T(prng.range(0.5, 1.5)); c.wake = true; } }
  // Review CH M1: the player's body. rcClear = (x, z) is outside the keep-out column and not within behindM behind the player;
  // rcSegClear = the walk leg a -> b never passes inside the column (a leg that STARTS inside is allowed out); rcPlanClear = every leg
  const rcClear = (x, z) => {
    const H = s.head, dx = x - H.x, dz = z - H.z, d2 = dx * dx + dz * dz;
    if (d2 < T.keepOutM * T.keepOutM) return false;
    return !(d2 < T.behindM * T.behindM && dx * H.fx + dz * H.fz < 0);
  };
  const rcSegClear = (ax, az, bx, bz) => {
    const H = s.head, r2 = T.keepOutM * T.keepOutM, ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
    if ((ax - H.x) * (ax - H.x) + (az - H.z) * (az - H.z) < r2) return true; // already inside: any leg out is fine
    let t = l2 > 1e-12 ? ((H.x - ax) * ex + (H.z - az) * ez) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t - H.x, pz = az + ez * t - H.z; return px * px + pz * pz >= r2;
  };
  const rcPlanClear = (c, legs) => { let x = c.x, z = c.z; for (const l of legs) { if (!rcSegClear(x, z, l.x, l.z)) return false; x = l.x; z = l.z; } return true; };
  // the most recent hand within curiousM (flat) seen in the last curiousAgeS: { x, z, d } or null
  const rcNearHand = (c) => {
    let best = null;
    for (const k in s.hands) { const hd = s.hands[k]; if (s.tick - hd.tick > RC_T(T.curiousAgeS)) continue; const d = rcLen(hd.x - c.x, hd.z - c.z); if (d <= T.curiousM && (!best || d < best.d)) best = { x: hd.x, y: hd.y, z: hd.z, d }; }
    return best;
  };

  const think = (c) => {
    // nap time
    if (s.phase === 'nap' || s.phase === 'end') {
      if (!c.nap) {
        const all = s.napSpots || (s.napSpots = roomNapSpots(room));
        const spots = c.napSurf && all.some((sp) => sp.surf === c.napSurf) ? all.filter((sp) => sp.surf === c.napSurf).concat(all.filter((sp) => sp.surf !== c.napSurf)) : all; // the remembered favourite first
        for (const sp of spots) {
          if (s.napTaken.some((q) => q.surf === sp.surf && rcLen(q.x - sp.x, q.z - sp.z) < 0.25)) continue;
          if (sp.surf !== c.surf && !roomRoute(room, c.surf, sp.surf, c.lim)) continue;
          c.nap = sp; s.napTaken.push(sp); break;
        }
        if (!c.nap) { c.nap = { surf: c.surf, x: c.x, y: c.y, z: c.z }; s.napTaken.push(c.nap); }
        c.plan = [];
      }
      if (c.surf === c.nap.surf && rcLen(c.x - c.nap.x, c.z - c.nap.z) < 1e-6) { c.mode = 'nap'; c.pose = 'nap'; return; }
      if (!planTo(c, c.nap.surf, c.nap.x, c.nap.z)) { s.napTaken = s.napTaken.filter((q) => q !== c.nap); c.nap = { surf: c.surf, x: c.x, y: c.y, z: c.z }; s.napTaken.push(c.nap); }
      return;
    }
    const zoom = s.phase === 'wind';
    if (c.sulk > 0) { // wandering off: a far sample of its surface, walked, then a loaf; no play until the sulk ends
      const surf = roomSurface(room, c.surf); let far = null, fd = -1;
      for (let i = 0; i < 6; i++) { const p = prng.pick(surf.samples); const d = rcLen(p.x - c.x, p.z - c.z); if (d > fd && rcClear(p.x, p.z) && rcSegClear(c.x, c.z, p.x, p.z) && roomLineLegal(room, c.surf, c, p)) { fd = d; far = p; } }
      if (far && fd > 0.3) { c.plan = [{ k: 'walk', x: far.x, z: far.z }]; c.goal = 'wander'; return; }
      c.mode = 'idle'; c.pose = 'loaf'; c.t = RC_T(1.5); return;
    }
    // treat
    if (s.treat && s.treat.cat === c.id && s.treat.at) {
      const at = s.treat.at;
      if (c.surf === at.surf && rcLen(c.x - at.x, c.z - at.z) <= T.treatR) {
        if (s.treat.p.y - c.y <= T.handHop && s.treat.p.y >= c.y) { c.hand = s.treat.hand; const p = s.treat.p; startHop(c, 'hand', p.x, p.y, p.z, 0.06); c.eat = RC_T(T.eatS); return; }
        c.mode = 'idle'; c.pose = 'beg'; c.t = RC_T(0.3); rcFace(c, s.treat.p.x - c.x, s.treat.p.z - c.z); return;
      }
      if (c.surf === at.surf) { if (walkOrDetour(c, at.x, at.z, c.lim.walk, 'treat') === null) { c.mode = 'idle'; c.pose = 'beg'; c.t = RC_T(0.3); } else if (!c.plan.length) c.plan = [{ k: 'walk', x: at.x, z: at.z }]; return; }
      if (planTo(c, at.surf, at.x, at.z)) return;
    }
    // laser chase (a muted cat, pin just ended, sits and watches the dot until the player moves it)
    if (s.laser && c.interest && s.phase === 'play') {
      const L = s.laser;
      if (c.mute > 0) { c.mode = 'idle'; c.pose = 'sit'; c.t = RC_T(0.2); rcFace(c, L.x - c.x, L.z - c.z); return; }
      if (c.surf === L.surf) {
        const d = rcLen(L.x - c.x, L.z - c.z);
        if (d <= T.pounceR && c.cool <= 0) {
          // GE1-B: the reaction delay: once per approach the kitten may freeze (stare at the dot) before the crouch tell
          if (!c.hes) { c.hes = true; if (prng.chance(T.hesitateP)) { c.mode = 'idle'; c.pose = 'stare'; c.plan = [{ k: 'stare', n: RC_T(prng.range(T.hesitateS0, T.hesitateS1)) }]; rcFace(c, L.x - c.x, L.z - c.z); return; } }
          c.hes = false; c.mode = 'tell'; c.pose = 'crouch'; c.tell = RC_T(T.tellS); c.tellKind = 'pounce'; c.tellX = L.x; c.tellZ = L.z; c.plan = []; rcFace(c, L.x - c.x, L.z - c.z); emit({ type: 'tell', cat: c.id, kind: 'pounce' }); return;
        }
        if (d > T.pounceR) c.hes = false; // a new approach may hesitate again
        const stalk = d <= T.stalkM; // inside stalkM the chase SLOWS to a stalk (low walk, eyes on the dot) before the crouch tell
        c.goal = 'chase'; c.mode = stalk ? 'stalk' : 'run'; c.pose = stalk ? 'walk' : 'run';
        if (walkOrDetour(c, L.x, L.z, stalk ? T.stalkV : c.lim.run, 'chase') === null) { c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.25); }
        return;
      }
      if (planTo(c, L.surf, L.x, L.z)) { c.goal = 'chase'; c.t = RC_T(0.6); return; }
      c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.4); rcFace(c, L.x - c.x, L.z - c.z); return;
    }
    // wand
    if (s.wand && s.wand.at && c.interest && s.phase === 'play') {
      const W = s.wand.at;
      // big leap: a fast tip + a reachable HIGHER legal surface within leapReach of the tip -> tell (crouch) then hop
      if (s.wand.speed > T.bigLeapV && c.leapCool <= 0 && c.cool <= 0 && c.surf && rcLen(W.x - c.x, W.z - c.z) <= T.batR + T.leapRun) {
        const leap = rcLeapPick(c, s.wand.p);
        if (leap) { c.leap = leap; c.mode = 'tell'; c.pose = 'crouch'; c.tell = RC_T(T.leapTellS); c.tellKind = 'leap'; c.plan = []; rcFace(c, leap.a.x - c.x, leap.a.z - c.z); emit({ type: 'tell', cat: c.id, kind: 'leap' }); return; }
      }
      if (c.surf === W.surf && rcLen(W.x - c.x, W.z - c.z) <= T.batR) {
        if (c.cool <= 0) { const clear = Math.max(0.05, Math.min(0.3, s.wand.p.y - c.y - c.lim.h)); startHop(c, c.surf, c.x, c.y, c.z, clear, 'bat'); c.cool = RC_T(0.7); return; }
        c.mode = 'idle'; c.pose = 'crouch'; c.t = RC_T(0.1); rcFace(c, W.x - c.x, W.z - c.z); return;
      }
      if (c.surf === W.surf) { if (walkOrDetour(c, W.x, W.z, c.lim.walk, 'wander') === null) { c.mode = 'idle'; c.pose = 'stare'; c.t = RC_T(0.3); } else { c.mode = 'walk'; c.pose = 'walk'; } return; }
      if (planTo(c, W.surf, W.x, W.z)) return;
    }
    // wander = the idle CYCLE of a cat (see the header). Order: wake-up stretch, doze, curiosity toward a hand, home toward the
    // player, a short walk + pause, a rare hop, else sit / loaf / groom.
    const surf = roomSurface(room, c.surf);
    if (c.wake) { c.wake = false; c.mode = 'idle'; c.pose = 'stretch'; c.t = RC_T(T.stretchS); return; }
    if (!zoom && c.played > 0 && c.hearts === 0 && !s.laser && !s.treat && !s.wand && s.tick - s.lastHandTick > RC_T(T.dozeAfterS)) {
      c.mode = 'idle'; c.pose = 'nap'; c.t = RC_T(prng.range(T.dozeS0, T.dozeS1)); return; // played out and nobody around: a doze (any hand wakes it)
    }
    const hand = zoom ? null : rcNearHand(c);
    if (hand && prng.chance(T.curiousP)) {
      const look = { k: 'pause', n: RC_T(prng.range(T.lookS0, T.lookS1)), pose: 'sit' };
      // the stop: on the FAR side of the hand from the body (head -> hand direction, or head -> kitten when the hand is at the body),
      // at least keepOutM out, curiousStopM past the hand: the kitten sits in front of the player, in view, never on the feet (CH M1)
      const H = s.head; let ux = hand.x - H.x, uz = hand.z - H.z, dhb = rcLen(ux, uz);
      if (dhb < 0.05) { ux = H.fx; uz = H.fz; } else { ux /= dhb; uz /= dhb; }
      { ux += H.fx; uz += H.fz; const l = rcLen(ux, uz); if (l < 1e-6) { ux = H.fx; uz = H.fz; } else { ux /= l; uz /= l; } } // biased toward the player's forward: a hand at the hip puts the kitten 45 deg ahead, in view
      const reach = Math.max(dhb + T.curiousStopM, T.keepOutM + 0.05), tx = H.x + ux * reach, tz = H.z + uz * reach;
      const at = roomNearestLegal(room, { x: hand.x, y: hand.y, z: hand.z }), dt = rcLen(tx - c.x, tz - c.z);
      if (dt > 0.12 && rcClear(tx, tz)) {
        if (c.surf === at.surf || !at.surf) { // same surface as the spot under the hand: straight, or around the couch (detour), to the stop
          if (legalAt(c, tx, tz) && roomLineLegal(room, c.surf, c, { x: tx, z: tz }) && rcSegClear(c.x, c.z, tx, tz)) { c.plan = [{ k: 'walk', x: tx, z: tz }, look]; c.goal = 'curious'; return; }
          const w = legalAt(c, tx, tz) && c.curDetCd <= 0 ? detour(c, tx, tz) : null; if (c.curDetCd <= 0) c.curDetCd = RC_T(T.curiousDetourCdS); // (CH S1: one curiosity detour plan per kitten per curiousDetourCdS)
          if (w) { const legs = rcLegs(w); if (rcPlanClear(c, legs)) { c.plan = legs.concat([look]); c.goal = 'curious'; return; } }
        } else if (roomLegalAt(room, at.surf, tx, tz) && planTo(c, at.surf, tx, tz)) { if (rcPlanClear(c, c.plan)) { c.plan.push(look); c.goal = 'curious'; return; } c.plan = []; } // the hand is over another surface (the couch seat): hop over to it
      }
      if (rcClear(c.x, c.z)) { c.mode = 'idle'; c.pose = prng.chance(0.5) ? 'sit' : 'stand'; c.t = RC_T(prng.range(T.lookS0, T.lookS1)); rcFace(c, hand.x - c.x, hand.z - c.z); return; } // close enough (or no way there): sit and look at the hand
    }
    if (!zoom && rcLen(s.box.x - c.x, s.box.z - c.z) > T.homeM && prng.chance(T.homeP)) {
      let best = null, bd = Infinity; // of 6 random samples of this surface, the one nearest the box spot with a legal line (a step home, not a teleport)
      for (let i = 0; i < 6; i++) { const p = prng.pick(surf.samples); const d = rcLen(p.x - s.box.x, p.z - s.box.z); if (d < bd && d < rcLen(c.x - s.box.x, c.z - s.box.z) - 0.3 && rcLen(p.x - c.x, p.z - c.z) <= T.wanderMaxM * 1.5 && rcClear(p.x, p.z) && rcSegClear(c.x, c.z, p.x, p.z) && roomLineLegal(room, c.surf, c, p)) { bd = d; best = p; } }
      if (best) { c.plan = [{ k: 'walk', x: best.x, z: best.z }, { k: 'pause', n: RC_T(prng.range(T.pauseS0, T.pauseS1)), pose: 'stand' }]; c.goal = 'wander'; return; }
    }
    const r = prng.next();
    if (r < (zoom ? 0.75 : 0.4)) {
      for (let i = 0; i < 6; i++) {
        const p = prng.pick(surf.samples); if (!zoom && rcLen(p.x - c.x, p.z - c.z) > T.wanderMaxM) continue;
        if (rcClear(p.x, p.z) && rcSegClear(c.x, c.z, p.x, p.z) && roomLineLegal(room, c.surf, c, p)) { c.plan = [{ k: 'walk', x: p.x, z: p.z }]; if (!zoom) c.plan.push({ k: 'pause', n: RC_T(prng.range(T.pauseS0, T.pauseS1)), pose: 'stand' }); c.goal = zoom ? 'zoom' : 'wander'; return; }
      }
    } else if (r < (zoom ? 0.95 : 0.4 + T.hopP)) {
      const hops = roomHops(room, c.surf, c.lim);
      if (hops.length) {
        const e = prng.pick(hops), pair = e.pairs.find((p) => (zoom || rcLen(p.a.x - c.x, p.a.z - c.z) <= T.wanderMaxM * 1.5) && rcClear(p.a.x, p.a.z) && rcClear(p.b.x, p.b.z) && rcSegClear(c.x, c.z, p.a.x, p.a.z) && roomLineLegal(room, c.surf, c, p.a)); // (a hop whose run-up is near; a far one waits for a later think)
        if (pair) { c.plan = [{ k: 'walk', x: pair.a.x, z: pair.a.z }, { k: 'hop', to: e.to, x: pair.b.x, z: pair.b.z }]; c.goal = 'wander'; return; }
      }
    }
    const q = prng.next();
    c.mode = 'idle'; c.pose = q < 0.35 ? 'sit' : q < 0.65 ? 'loaf' : q < 0.9 ? 'groom' : 'stretch';
    c.t = RC_T(c.pose === 'stretch' ? T.stretchS : prng.range(T.idleS0, T.idleS1));
  };

  //: the highest legal surface above the cat's that it can reach in ONE hop (roomHops honours lim.up / gap), with
  // the landing within leapReach of the wand tip and the take-off point within leapRun of the cat on a legal line
  const rcLeapPick = (c, tip) => {
    let best = null, bestY = -Infinity, bestD = Infinity;
    for (const e of roomHops(room, c.surf, c.lim)) {
      if (e.up <= 0.02) continue;
      const to = roomSurface(room, e.to); if (!to || !to.legal || to.y < bestY - 1e-6) continue;
      for (const p of e.pairs) {
        if (rcLen(p.a.x - c.x, p.a.z - c.z) > T.leapRun) continue;
        const dt = d3({ x: p.b.x, y: to.y, z: p.b.z }, tip); if (dt > T.leapReach) continue;
        if (to.y <= bestY + 1e-6 && dt >= bestD) continue; // same height: the landing nearest the tip wins
        if (!roomLineLegal(room, c.surf, c, p.a)) continue;
        best = { to: e.to, a: p.a, b: p.b }; bestY = to.y; bestD = dt;
      }
    }
    return best;
  };
  //: the pounce lands; one rule: d = landing point to the dot AT LANDING (same surface), catch / near miss / miss
  const rcPounceLand = (c) => {
    const L = s.laser, d = L && L.surf === c.surf ? rcLen(L.x - c.x, L.z - c.z) : Infinity;
    const moved = L ? rcLen(L.x - c.dotX0, L.z - c.dotZ0) : Infinity; // the dot's travel during the flight (from the launch): the escape
    // GE1-B: a landed pounce can still FUMBLE (paw slips off the dot): chance fumbleP0 + dot speed x fumbleK (cap fumbleMax), seeded
    const fumbled = d <= T.catchR && moved <= T.escapeM && prng.chance(Math.min(T.fumbleMax, T.fumbleP0 + rcDotSpeed(L) * T.fumbleK));
    if (d <= T.catchR && moved <= T.escapeM && !fumbled) {
      emit({ type: 'pounce', cat: c.id, catch: true, d }); emit({ type: 'catch', cat: c.id, d }); c.played++;
      c.mode = 'pin'; c.pose = 'pin'; c.pin = RC_T(T.pinS); c.t = 0;
      if (s.comboCd <= 0 && rcCombo(s.combo, s.tick, T.comboN, RC_T(T.comboS))) { emit({ type: 'combo', n: T.comboN }); s.comboCd = RC_T(T.comboCdS); }
      return;
    }
    emit({ type: 'pounce', cat: c.id, catch: false, d: d === Infinity ? -1 : d, escaped: d <= T.catchR, fumbled });
    if (d <= T.nearMissR) { const quiet = s.tick - c.nmTick < RC_T(T.nearMissCdS); if (!quiet) c.nmTick = s.tick; emit({ type: 'near_miss', cat: c.id, d, quiet }); }
    // a miss: the kitten lands, then stares ("lost it... found it!") for missStareS before the chase resumes
    c.pose = 'land'; c.t = RC_T(0.15); c.plan = [{ k: 'stare', n: RC_T(T.missStareS) }];
    // GE1-B: ... and sometimes loses interest: sits watching the dot for boredS (the mute path) before it chases again
    if (prng.chance(T.missBoredP)) c.mute = RC_T(T.boredS);
  };
  //: the tell ends. Pounce: aim at the dot where it is NOW (tell end), never further than pounceReach, always a legal
  // point of the cat's surface; the dot gone / off this surface = no pounce. Leap: run to the take-off point and hop.
  const rcTellEnd = (c) => {
    c.mode = 'idle'; c.tellKind === 'leap' ? rcLeapGo(c) : rcPounceGo(c);
    c.tellKind = null;
  };
  /** the dot's speed (m/s) over the ring (leadWinS; falls back to tellS when the ring is short); no allocation */
  const rcDotSpeed = (L) => {
    const k = (s.tick + 1) % s.laserHistN, oldOk = s.laserHS[k] === L.surf, win = oldOk ? (s.laserHistN - 1) * STEP_S : T.tellS;
    if (!oldOk) return 0; // (a dot this surface has not seen for leadWinS: treat it as still; the escape rule covers a jump)
    return rcLen(L.x - s.laserHX[k], L.z - s.laserHZ[k]) / win;
  };
  const rcPounceGo = (c) => {
    const L = s.laser;
    if (!L || L.surf !== c.surf || !c.interest) { c.pose = 'stare'; c.t = RC_T(0.2); return; }
    // aim = the dot now + its velocity over the tell x the flight (a lead); clamped to pounceReach; legal or no lead; legal or in place
    // the dot's velocity over leadWinS (the ring; falls back to the tell when the ring has no dot on this surface that far back)
    const k = (s.tick + 1) % s.laserHistN, oldOk = s.laserHS[k] === L.surf, win = oldOk ? (s.laserHistN - 1) * STEP_S : T.tellS; // the oldest slot = leadWinS ago
    const ox = oldOk ? s.laserHX[k] : c.tellX, oz = oldOk ? s.laserHZ[k] : c.tellZ;
    const vx = (L.x - ox) / win, vz = (L.z - oz) / win, trav = rcLen(vx, vz) * T.aimErrS, held = trav < T.leadDeadM; // (GE1-B: aimErrS, not the longer tellS: the eyes track the dot through the whole crouch)
    const lead = held ? 0 : T.pounceLeadS, er = held ? 0 : trav * T.aimErr * Math.sqrt(prng.next()), ea = held ? 0 : prng.next() * 6.2831853; // (a held dot: no prng draw, aimed exactly)
    let ax = L.x, az = L.z;
    if (held) { let n = 0, sx = 0, sz = 0; for (let i = 0; i < T.heldMeanN; i++) { const q = (s.tick - i + s.laserHistN) % s.laserHistN; if (s.laserHS[q] !== L.surf) break; sx += s.laserHX[q]; sz += s.laserHZ[q]; n++; } if (n) { ax = sx / n + vx * (n - 1) / 2 * STEP_S; az = sz / n + vz * (n - 1) / 2 * STEP_S; } } // CM SHOULD: the mean lags a slow dot by (n-1)/2 steps; add that back // a held dot: aim at its recent MEAN (the jitter averages out; CK S1)
    let x = ax + vx * lead + er * Math.cos(ea), z = az + vz * lead + er * Math.sin(ea), d = rcLen(x - c.x, z - c.z);
    // GE1-B: a STALE pounce commits to where the dot was when the tell started (no lead, no scatter): a dot that kept moving is missed
    if (!held && prng.chance(T.staleP)) { x = c.tellX; z = c.tellZ; d = rcLen(x - c.x, z - c.z); }
    if (d > T.pounceReach) { const k = T.pounceReach / d; x = c.x + (x - c.x) * k; z = c.z + (z - c.z) * k; }
    if (!legalAt(c, x, z)) { x = L.x; z = L.z; d = rcLen(x - c.x, z - c.z); if (d > T.pounceReach) { const k = T.pounceReach / d; x = c.x + (x - c.x) * k; z = c.z + (z - c.z) * k; } if (!legalAt(c, x, z)) { x = c.x; z = c.z; } }
    c.dotX0 = L.x; c.dotZ0 = L.z; startHop(c, c.surf, x, c.y, z, 0.12, 'pounce'); c.cool = RC_T(T.pounceCdS);
  };
  const rcLeapGo = (c) => {
    const l = c.leap; c.leap = null;
    if (!l || !s.wand || !roomLineLegal(room, c.surf, c, l.a)) { c.pose = 'stare'; c.t = RC_T(0.2); return; }
    c.plan = [{ k: 'walk', x: l.a.x, z: l.a.z }, { k: 'hop', to: l.to, x: l.b.x, z: l.b.z, leap: true }]; c.goal = 'leap';
  };
  // nothing stays on a hand without an active pinch / treat: tracking silent for handLostS -> let go
  const handLost = (c) => { const hs = s.hands[c.hand]; return s.tick - Math.max(hs ? hs.tick : -1e9, c.onT) > RC_T(T.handLostS); };
  const stepCat = (c) => {
    if (c.cool > 0) c.cool--; if (c.petCd > 0) c.petCd--; if (c.purr > 0) c.purr--; if (c.mute > 0) c.mute--; if (c.leapCool > 0) c.leapCool--;
    if (c.treatCd > 0) c.treatCd--; if (c.detourCd > 0) c.detourCd--; if (c.curDetCd > 0) c.curDetCd--; if (c.sulk > 0) c.sulk--; if (c.hearts > 0 && --c.heartT <= 0) { c.hearts--; c.heartT = RC_T(T.heartsDecayS); }
    if (c.mode === 'inbox') {
      c.y = s.box.y;
      if (s.phase !== 'drop' && s.box.open && s.openTick >= 0) {
        const go = s.openTick + RC_T(0.5 + c.wave * T.waveS + c.slot * T.waveStaggerS);
        if (!c.peeked && s.tick >= go - RC_T(T.boxPeekS)) { c.peeked = true; emit({ type: 'box_peek', cat: c.id }); }
        if (s.tick >= go) {
          let L = null;
          for (let i = 0; i < 12 && !L; i++) {
            let ux = prng.next() * 2 - 1, uz = prng.next() * 2 - 1; const l = rcLen(ux, uz); if (l < 0.2 || l > 1) continue; ux /= l; uz /= l;
            const dd = prng.range(0.3, 0.55), x = s.box.x + ux * dd, z = s.box.z + uz * dd;
            if (roomLegalAt(room, s.box.surf, x, z)) L = { x, z };
          }
          if (!L) { const p = roomNearestLegal(room, { x: s.box.x + 0.4, y: s.box.y, z: s.box.z }); L = { x: p.x, z: p.z }; }
          startHop(c, s.box.surf, L.x, s.box.y, L.z, T.boxH, 'climb'); emit({ type: 'box_hop_out', cat: c.id, n: c.wave * T.waveSize + c.slot + 1 });
        }
      }
      return;
    }
    if (c.mode === 'carried') { if (handLost(c)) { c.hand = null; toss(c, null); } return; }
    if (c.mode === 'onhand') {
      const mine = s.treat && s.treat.hand === c.hand;
      if (!mine || handLost(c) || s.tick - c.onT > RC_T(T.onhandMaxS)) {
        if (mine && (s.treat.eaten || handLost(c))) s.treat = null;
        dropFromHand(c); return;
      }
      const p = s.treat.p, k = T.palmFollow; // glide after the palm (it moved since the hop launched, or moves now)
      c.x += (p.x - c.x) * k; c.y += (p.y - c.y) * k; c.z += (p.z - c.z) * k;
      if (Math.abs(p.x - c.x) + Math.abs(p.y - c.y) + Math.abs(p.z - c.z) < 1e-4) { c.x = p.x; c.y = p.y; c.z = p.z; }
      c.pose = c.eat > 0 ? 'eat' : 'sit';
      if (c.eat > 0 && --c.eat === 0) { c.bond++; c.played++; s.treat.eaten = true; c.treatCd = RC_T(T.treatCdS); emit({ type: 'eat', cat: c.id, hearts: hearts(c, 2) }); }
      return;
    }
    if (c.mode === 'hop') {
      const H = c.hop; H.k++;
      if (H.k >= H.n) {
        if (H.to === 'hand') {
          // the treat may be gone (closed during the hop, or replaced by the other hand): never land on an empty hand
          if (!s.treat || s.treat.hand !== c.hand) { c.x = H.x1; c.y = H.y1; c.z = H.z1; dropFromHand(c); return; }
          // re-review SHOULD 2: land where the palm was at launch (the hop's own target, no last-frame snap to the
          // current palm); from there the cat glides after the palm (onhand step)
          c.x = H.x1; c.y = H.y1; c.z = H.z1; c.hop = null; c.surf = null; c.mode = 'onhand'; c.pose = 'eat'; c.onT = s.tick; emit({ type: 'hand_climb', cat: c.id }); return;
        }
        land(c, H.to, H.x1, H.y1, H.z1, H.kind, Math.sqrt(Math.max(0, H.vy * H.vy - 2 * H.g * (H.y1 - H.y0))));
        if (H.kind === 'pounce') { rcPounceLand(c); return; }
        c.pose = 'land'; c.t = RC_T(0.15); return;
      }
      const t = H.dur * H.k / H.n, f = H.k / H.n;
      c.x = H.x0 + (H.x1 - H.x0) * f; c.z = H.z0 + (H.z1 - H.z0) * f; c.y = H.y0 + H.vy * t - 0.5 * H.g * t * t;
      return;
    }
    if (c.mode === 'fly') {
      const F = c.fly; F.k++;
      if (F.k >= F.n) { land(c, F.surf, F.x1, F.y1, F.z1, 'toss', F.vy); if (!c.sulk) { c.pose = 'land'; c.t = RC_T(0.4); } return; }
      flyStep(F); c.x = F.x; c.y = F.y; c.z = F.z;
      return;
    }
    if (c.mode === 'nap') { c.pose = 'nap'; return; }
    //: tell (crouch, facing the dot) then launch; pin the caught dot, then the mute starts when the pin ENDS
    if (c.mode === 'tell') {
      if (c.tell > 0) { c.tell--; c.pose = 'crouch'; if (c.tellKind === 'pounce' && s.laser) rcFace(c, s.laser.x - c.x, s.laser.z - c.z); return; }
      rcTellEnd(c); return;
    }
    if (c.mode === 'pin') {
      c.pose = 'pin';
      if (c.pin > 0 && --c.pin > 0) return;
      c.mode = 'idle'; c.pose = 'sit'; c.mute = RC_T(T.laserMuteS); c.t = 0; return;
    }
    // grounded: plan first
    if (c.plan.length) {
      const leg = c.plan[0];
      if (leg.k === 'stare') { c.mode = 'idle'; c.pose = 'stare'; if (s.laser) rcFace(c, s.laser.x - c.x, s.laser.z - c.z); if (--leg.n <= 0) c.plan.shift(); return; }
      if (leg.k === 'pause') { // the stand-and-look after a walk: faces the nearest recent hand (the player) when one is near
        c.mode = 'idle'; c.pose = leg.pose || 'stand'; const hd = rcNearHand(c); if (hd) rcFace(c, hd.x - c.x, hd.z - c.z);
        if (--leg.n <= 0) c.plan.shift(); return;
      }
      if (leg.k === 'walk') {
        const fast = c.goal === 'chase' || c.goal === 'zoom';
        const stalk = c.goal === 'chase' && s.laser && c.surf === s.laser.surf && rcLen(s.laser.x - c.x, s.laser.z - c.z) <= T.stalkM;
        const r = walk(c, leg.x, leg.z, stalk ? T.stalkV : fast ? c.lim.run : c.lim.walk);
        c.mode = stalk ? 'stalk' : fast ? 'run' : 'walk'; c.pose = stalk ? 'walk' : c.mode;
        if (r === true) c.plan.shift(); else if (r === null) { const rest = c.plan.slice(1); c.plan = []; const w = c.detourCd > 0 ? null : detour(c, leg.x, leg.z); if (w) { c.detourCd = RC_T(T.detourCdS); c.plan = rcLegs(w).concat(rest); } else { c.mode = 'idle'; c.pose = 'sit'; c.t = RC_T(0.3); } }
        // laser moved: re-think a chase every 0.5 s
        if (c.goal === 'chase' && (s.tick - c.lastHop) % 30 === 0 && s.laser && c.surf === s.laser.surf && !(c.detourTo && rcLen(s.laser.x - c.detourTo.x, s.laser.z - c.detourTo.z) < 0.25)) { c.plan = []; c.detourTo = null; } // (a detour plan survives while the dot stays near its goal)
      } else {
        c.plan.shift(); const to = roomSurface(room, leg.to); startHop(c, leg.to, leg.x, to.y, leg.z);
        if (leg.leap) { c.leapCool = RC_T(T.leapCoolS); c.goal = 'wander'; emit({ type: 'big_leap', cat: c.id, surf: leg.to }); }
      }
      return;
    }
    if (c.t > 0) { c.t--; c.mode = 'idle'; return; }
    think(c);
  };

  const phaseStep = () => {
    const t = s.tick;
    if (s.phase === 'drop') {
      const k = Math.min(1, t / RC_T(T.boxDropS)); s.box.y = boxSpot.y + T.boxDropH * (1 - k * k);
      if (k >= 1) { s.box.y = boxSpot.y; s.box.landed = true; s.phase = 'closed'; }
    } else if (s.phase === 'closed') {
      if (t >= RC_T(T.boxAutoOpenS)) rcOpen();
    } else if (s.phase === 'climb') {
      if (s.cats.every((c) => c.mode !== 'inbox')) { s.phase = 'play'; s.box.gone = false; }
    }
    if ((s.phase === 'play' || s.phase === 'climb') && t >= RC_T(T.playEndS)) s.phase = 'wind';
    if (s.phase === 'wind' && t >= RC_T(T.playEndS + T.zoomiesS)) { s.phase = 'nap'; s.laser = null; s.wand = null; for (const c of s.cats) if (c.mode !== 'carried' && c.mode !== 'onhand') { c.plan = []; c.t = 0; } }
    if (s.phase === 'nap' && t >= RC_T(T.endS)) s.phase = 'end';
  };

  const api = {
    room,
    get tick() { return s.tick; },
    get phase() { return s.phase; },
    get log() { return s.log; },
    /**: the events of the LAST step (a copy; plain data). Derived from state: not hashed, replayed exactly. */
    get events() { return s.out.slice(); },
    /** queue an event for the next step (recorded in the log with that step's tick) */
    push(ev) { if (ev && typeof ev.type === 'string') s.queue.push(ev); },
    /** one fixed 60 Hz step; `events` (optional array) are applied first, like push() */
    step(events) {
      if (Array.isArray(events)) for (const e of events) api.push(e);
      s.out.length = 0; const was = s.phase;
      if (s.queue.length) { for (const e of s.queue) { s.log.push({ tick: s.tick, ev: e }); apply(e); } s.queue = []; }
      phaseStep(); if (s.comboCd > 0) s.comboCd--;
      { const k = s.tick % s.laserHistN; if (s.laser) { s.laserHS[k] = s.laser.surf; s.laserHX[k] = s.laser.x; s.laserHZ[k] = s.laser.z; } else s.laserHS[k] = null; }
      if (s.phase !== was) emit({ type: 'phase', phase: s.phase }); // a pinch / openBox opens the box in apply, hence here
      for (const c of s.cats) stepCat(c);
      s.tick++;
    },
    /** open the box now (host button / tests) */
    openBox() { api.push({ type: 'open_box' }); }, // queued + logged like a hand event, so a replay opens the box on the same tick
    cat(id) { return s.cats.find((c) => c.id === id) || null; },
    /** render / test view: plain data */
    state() {
      return {
        tick: s.tick, phase: s.phase, box: { ...s.box }, laser: s.laser && { ...s.laser }, wand: s.wand && { ...s.wand.at, tip: s.wand.p }, treat: s.treat && { ...s.treat.p, cat: s.treat.cat },
        cats: s.cats.map((c) => ({ id: c.id, size: c.size, x: c.x, y: c.y, z: c.z, fx: c.fx, fz: c.fz, surf: c.surf, mode: c.mode, pose: c.pose, poof: c.poof, purr: c.purr > 0, bond: c.bond, hearts: c.hearts, full: c.treatCd > 0, sulk: c.sulk > 0, doze: c.mode === 'idle' && c.pose === 'nap', airborne: c.mode === 'hop' || c.mode === 'fly', support: c.mode === 'carried' || c.mode === 'onhand' ? 'hand' : c.surf })),
      };
    },
    hash() {
      const h = createHasher(); h.num(s.tick).str(s.phase).num(prng.getState() / 65536);
      h.num(s.box.y).num(s.box.open ? 1 : 0);
      for (const c of s.cats) h.str(c.id).str(c.mode).str(c.pose).str(c.surf || '-').num(c.x).num(c.y).num(c.z).num(c.fx).num(c.fz).num(c.bond).num(c.poof ? 1 : 0).num(c.cool).num(c.mute).num(c.leapCool).num(c.treatCd).num(c.hearts).num(c.sulk).num(c.played);
      h.num(s.head.x).num(s.head.z).num(s.head.fx).num(s.head.fz);
      return h.digest();
    },
  };
  return api;
}

/** Replay: same opts + the recorded log (from session.log) for `ticks` steps -> the final hash. */
export function replayRoomSession(opts, log, ticks) {
  const g = createRoomSession(opts); let i = 0;
  for (let t = 0; t < ticks; t++) { while (i < log.length && log[i].tick === t) g.push(log[i++].ev); g.step(); }
  return g.hash();
}
/** replay of the EVENTS: same opts + log for `ticks` steps -> [{ tick, ev }] of every emitted event, plus the hash. */
export function replayRoomEvents(opts, log, ticks) {
  const g = createRoomSession(opts); let i = 0; const out = [];
  for (let t = 0; t < ticks; t++) { while (i < log.length && log[i].tick === t) g.push(log[i++].ev); g.step(); for (const ev of g.events) out.push({ tick: t, ev }); }
  return { events: out, hash: g.hash() };
}

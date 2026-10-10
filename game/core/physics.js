/* game/core/physics.js — bodies, gravity, one-way platforms, bounds, circle overlap. Units: BL, seconds; y grows DOWN
   (screen-like) so the renderer only multiplies by px-per-BL. A body's (x, y) is the FEET point (bottom-centre),
   matching B1 `frameFor` (feet on the box floor), w/h are the collision box.
   Platforms are one-way: a body lands only when it is moving down and its feet cross the platform top during the step.
   "Drawn windows / furniture" in game mode are platforms; the floor is just the bottom bound as a platform. */
export function createBody(x, y, { w = 0.9, h = 0.6 } = {}) {
  return { x, y, vx: 0, vy: 0, w, h, onGround: false, groundId: -1, prevY: y };
}

/** World: { width, height, platforms: [{id, x0, x1, y}] } — floor must be included as a platform spanning the width. */
export function createWorld({ width, height, platforms = [] }) {
  const floor = { id: 0, x0: 0, x1: width, y: height, floor: true };
  const list = [floor, ...platforms.map((p, i) => ({ id: i + 1, x0: p.x0, x1: p.x1, y: p.y }))];
  return { width, height, platforms: list };
}

/** The platform the body would land on this step (feet crossed its top while moving down), or null. */
export function landingPlatform(world, body, prevY, newY, newX) {
  if (newY < prevY) return null; // moving up: pass through from below
  let best = null;
  for (const p of world.platforms) {
    if (newX <= p.x0 || newX >= p.x1) continue;
    if (prevY <= p.y + 1e-9 && newY >= p.y) {
      if (!best || p.y < best.y) best = p;
    }
  }
  return best;
}

/** True while the body is standing on platform p (feet on top, within its x range). */
export function supportedBy(world, body) {
  for (const p of world.platforms) {
    if (p.id === body.groundId && body.x > p.x0 && body.x < p.x1 && Math.abs(body.y - p.y) < 1e-6) return p;
  }
  return null;
}

/** Integrate one fixed step: gravity, move, land on one-way platforms, clamp to screen bounds (stop with a brace, no bounce). */
export function integrate(world, body, dt, gravity) {
  const prevX = body.x, prevY = body.y;
  body.prevY = prevY;
  if (!body.onGround) body.vy += gravity * dt;
  let nx = body.x + body.vx * dt;
  let ny = body.onGround ? body.y : body.y + body.vy * dt;

  // side bounds: stop dead at the edge (spec: "stops with a little brace, no bounce")
  //: a world view with openLeft / openRight (freeroam edge hand-off) lets the body pass that bound; the caller
  // removes it once its centre is past 0 / width. createWorld never sets the flags, so every other world is unchanged.
  const half = body.w / 2;
  if (nx < half && !world.openLeft) { nx = half; if (body.vx < 0) body.vx = 0; }
  if (nx > world.width - half && !world.openRight) { nx = world.width - half; if (body.vx > 0) body.vx = 0; }
  // OPT-IN solids (walls / ceilings): world.solids = [{x0, x1, y0, y1}] AABBs. Absent = the old behaviour exactly.
  // Axis-separated: the X move is resolved against solids the body overlaps vertically at prevY (stop at the wall, vx 0).
  if (world.solids) nx = solidSideClamp(world.solids, prevX, prevY, nx, half, body.h, body);

  if (body.onGround) {
    // walked off the edge?
    body.x = nx;
    const p = supportedBy(world, body);
    if (!p) { body.onGround = false; body.groundId = -1; body.vy = 0; }
    body.y = ny;
    return { landed: false, leftGround: !p };
  }

  const land = landingPlatform(world, body, prevY, ny, nx);
  if (land) {
    body.x = nx; body.y = land.y; body.vy = 0; body.onGround = true; body.groundId = land.id;
    return { landed: true, platform: land, fallFrom: prevY };
  }
  // ceiling = top of screen
  if (ny < 0) { ny = 0; if (body.vy < 0) body.vy = 0; }
  //: head bump on a solid's underside while rising (Y move resolved at the new x)
  if (world.solids && ny < prevY) ny = solidHeadClamp(world.solids, prevY, ny, nx, half, body.h, body);
  body.x = nx; body.y = ny;
  return { landed: false };
}

/** solids: clamp the X move so the body (feet point, w = 2 half, h) never enters a solid it overlaps vertically. */
function solidSideClamp(solids, prevX, prevY, nx, half, h, body) {
  const top = prevY - h;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (!(top < s.y1 - 1e-9 && prevY > s.y0 + 1e-9)) continue; // no vertical overlap
    if (nx > prevX) { if (prevX + half <= s.x0 + 1e-9 && nx + half > s.x0) { nx = s.x0 - half; if (body.vx > 0) body.vx = 0; } }
    else if (nx < prevX) { if (prevX - half >= s.x1 - 1e-9 && nx - half < s.x1) { nx = s.x1 + half; if (body.vx < 0) body.vx = 0; } }
  }
  return nx;
}
/** solids: a rising body whose head crosses a solid's underside stops there (vy 0, no bounce). */
function solidHeadClamp(solids, prevY, ny, nx, half, h, body) {
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (nx + half <= s.x0 + 1e-9 || nx - half >= s.x1 - 1e-9) continue;
    if (prevY - h >= s.y1 - 1e-9 && ny - h < s.y1) { ny = s.y1 + h; if (body.vy < 0) body.vy = 0; }
  }
  return ny;
}

/** Leave the ground with an upward speed (negative vy since y grows down). */
export function launch(body, upSpeed) {
  body.onGround = false; body.groundId = -1; body.vy = -upSpeed;
}

/** Up-speed needed to reach height h under gravity g: v = sqrt(2 g h). */
export function jumpSpeedForHeight(h, g) { return Math.sqrt(2 * g * h); }

export function circleOverlap(ax, ay, ar, bx, by, br) {
  const dx = ax - bx, dy = ay - by, r = ar + br;
  return dx * dx + dy * dy <= r * r;
}

export function aabbOverlap(a, b) {
  return Math.abs(a.x - b.x) * 2 < (a.w + b.w) && Math.abs((a.y - a.h / 2) - (b.y - b.h / 2)) * 2 < (a.h + b.h);
}

/* ---- AABB box stacking (box stack; also future toys/furniture-as-bodies) ----
   A box is a body like a cat (feet point = bottom-centre, w/h) that can rest on the floor, on a platform or ON ANOTHER
   BOX: it lands on the highest top whose horizontal overlap with it is at least `minSupport` of its width; a box whose
   support slides away (overlap below minSupport) falls; a sliding box that hits another box at its level stops at
   contact and nudges it (velocity * `nudge`), and boxes standing on it ride along (friction carries the stack).
   groundId of a box resting on box j is BOX_ID_BASE + j.id; hosts expose box tops as world platforms (`boxPlatforms`)
   so cats can climb stacks. Deterministic, O(n^2) with n <= ~12, no allocations per step except the sort scratch. */
export const BOX_ID_BASE = 1000;
export function createBox(id, x, y, { w = 0.8, h = 0.8 } = {}) {
  const b = createBody(x, y, { w, h }); b.id = id; b.px = x; b.py = y; return b;
}
/** horizontal overlap of two boxes in BL (<= 0 means none) */
export function boxOverlapX(a, b) { return Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2); }
/** the box that directly supports `b` (feet on its top, enough overlap), else null */
export function boxSupport(b, boxes, minSupport = 0.35) {
  for (const o of boxes) if (o !== b && Math.abs(b.y - (o.y - o.h)) < 1e-6 && boxOverlapX(b, o) >= minSupport * b.w) return o;
  return null;
}
/** boxes standing directly on `b` (collected into `out`, cleared first) */
export function boxesOn(b, boxes, out, minSupport = 0.35) {
  out.length = 0;
  for (const o of boxes) if (o !== b && o.onGround && o.groundId === BOX_ID_BASE + b.id && boxOverlapX(o, b) >= minSupport * o.w) out.push(o);
  return out;
}
/* Rider carry (review GE-shift3 MUST): the whole stack moves as ONE rigid unit by the LARGEST dx every rider allows, so a
   rider can never be pushed past a wall or into a box resting at its level (the stack stops at that contact instead and
   nudges the blocker like a floor bump). Two passes: carryLimit shrinks dx, carryApply moves the riders by it. */
function carryLimit(b, dx, boxes, depth, world, nudge, vx) {
  if (depth > 16 || dx === 0) return dx;
  for (const o of boxes) if (o !== b && o.onGround && o.groundId === BOX_ID_BASE + b.id) {
    let d = dx;
    const oh = o.w / 2;
    if (o.x + d < oh) d = oh - o.x; if (o.x + d > world.width - oh) d = world.width - oh - o.x; // wall
    for (const q of boxes) { // any box beside the rider (resting, not of the same stack, or airborne) = contact
      if (q === o || q === b || (q.onGround && q.groundId === o.groundId)) continue;
      if (!((o.y - o.h) < q.y - 1e-6 && o.y > (q.y - q.h) + 1e-6)) continue; // vertical overlap of the two bodies
      const gap = d > 0 ? (q.x - q.w / 2) - (o.x + oh) : (o.x - oh) - (q.x + q.w / 2);
      if (gap < -1e-9) continue; // already past / overlapping on that side (cannot happen for resting boxes; be safe)
      if (Math.abs(d) > gap) { d = d > 0 ? gap : -gap; if (q.onGround && q.vx === 0) q.vx = vx * nudge; }
    }
    d = carryLimit(o, d, boxes, depth + 1, world, nudge, vx);
    if (Math.abs(d) < Math.abs(dx)) dx = d;
  }
  return dx;
}
function carryApply(b, dx, boxes, depth) {
  if (depth > 16 || dx === 0) return;
  for (const o of boxes) if (o !== b && o.onGround && o.groundId === BOX_ID_BASE + b.id) { o.x += dx; carryApply(o, dx, boxes, depth + 1); }
}
const byDepth = (a, b) => b.y - a.y; // deepest (largest y) first; hoisted: no per-step closure
function platformById(world, id) { const ps = world.platforms; for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }
/** Integrate every box one fixed step. Lower boxes first so supports settle before riders. NOTE: sorts the caller's
    `boxes` array in place every step (deepest first); render by id, never by index. Returns the array.
    UNIFORM SIZE ONLY (review GE-shift3 re-review SHOULD 1): settleLevel / bridging assume every box has the same w and h
    (a mixed-size pile can overlap in rare pinches); createBoxStack enforces it, other callers must too. */
export function stepBoxes(world, boxes, dt, { gravity = 9, friction = 2.5, minSupport = 0.35, nudge = 0.6, floorOnly = false, events = null } = {}) {
  const floorW = floorOnly ? FLOOR_WORLD(world) : world; // floorOnly: boxes fall past drawn windows, only the floor and other boxes stop them
  boxes.sort(byDepth);
  for (const b of boxes) {
    b.px = b.x; b.py = b.y;
    const half = b.w / 2;
    if (b.onGround) {
      // still supported?
      let ok = false;
      if (b.groundId >= BOX_ID_BASE) { for (const o of boxes) if (o !== b && BOX_ID_BASE + o.id === b.groundId) { ok = o.onGround && Math.abs(b.y - (o.y - o.h)) < 1e-6 && (boxOverlapX(b, o) >= minSupport * b.w || bridged(b, o, boxes, minSupport)); break; } }
      else { const p = platformById(floorW, b.groundId); ok = !!(p && Math.abs(b.y - p.y) < 1e-6 && b.x + half > p.x0 + minSupport * b.w && b.x - half < p.x1 - minSupport * b.w); }
      if (!ok) { b.onGround = false; b.groundId = -1; b.vy = 0; if (events) events.push({ type: 'box_fall', id: b.id }); }
    }
    if (b.onGround) {
      if (b.vx !== 0) {
        b.vx = b.vx > 0 ? Math.max(0, b.vx - friction * dt) : Math.min(0, b.vx + friction * dt);
        let nx = b.x + b.vx * dt;
        if (nx < half) { nx = half; b.vx = 0; } if (nx > world.width - half) { nx = world.width - half; b.vx = 0; }
        // contact with a box at the same level: stop at its side and nudge it
        for (const o of boxes) {
          if (o === b) continue;
          const vert = (b.y - b.h) < o.y - 1e-6 && b.y > (o.y - o.h) + 1e-6;
          if (!vert) continue;
          const gap = b.vx > 0 ? (o.x - o.w / 2) - (nx + half) : (nx - half) - (o.x + o.w / 2);
          const wasApart = b.vx > 0 ? (b.x + half) <= (o.x - o.w / 2) + 1e-6 : (b.x - half) >= (o.x + o.w / 2) - 1e-6;
          if (wasApart && gap < 0) { nx = b.vx > 0 ? (o.x - o.w / 2) - half : (o.x + o.w / 2) + half; if (o.onGround && o.vx === 0) o.vx = b.vx * nudge; b.vx = 0; if (events) events.push({ type: 'box_bump', id: b.id, other: o.id }); }
        }
        let dx = nx - b.x;
        if (dx !== 0) { const lim = carryLimit(b, dx, boxes, 0, world, nudge, b.vx); if (lim !== dx) { dx = lim; b.vx = 0; } b.x += dx; carryApply(b, dx, boxes, 0); }
      }
      continue;
    }
    // airborne
    b.vy += gravity * dt;
    let nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
    if (nx < half) { nx = half; b.vx = 0; } if (nx > world.width - half) { nx = world.width - half; b.vx = 0; }
    // side contact in the air: a hopping box never enters a resting box's body; it keeps its sideways speed so it slides
    // up the neighbour's side and goes OVER it once it clears the top (that is how a swat stacks a box)
    if (b.vx !== 0) for (const o of boxes) {
      if (o === b || !o.onGround) continue;
      const vert = (b.y - b.h) < o.y - 1e-6 && b.y > (o.y - o.h) + 1e-6;
      if (!vert) continue;
      const wasApart = b.vx > 0 ? (b.x + half) <= (o.x - o.w / 2) + 1e-6 : (b.x - half) >= (o.x + o.w / 2) - 1e-6;
      const gap = b.vx > 0 ? (o.x - o.w / 2) - (nx + half) : (nx - half) - (o.x + o.w / 2);
      if (wasApart && gap < 0) nx = b.vx > 0 ? (o.x - o.w / 2) - half : (o.x + o.w / 2) + half;
    }
    if (b.vy > 0) {
      // land on the highest box top crossed this step (enough overlap), else a platform / the floor
      let top = null, topY = Infinity;
      for (const o of boxes) {
        if (o === b || !o.onGround) continue; // a box still falling is not a landing target (review: rode a falling support marked onGround)
        const ty = o.y - o.h;
        if (ty >= topY || b.y > ty + 1e-9 || ny < ty) continue; // must cross that top this step, highest wins
        if (Math.min(nx + half, o.x + o.w / 2) - Math.max(nx - half, o.x - o.w / 2) < minSupport * b.w) continue;
        top = o; topY = ty;
      }
      const p = landingPlatform(floorW, b, b.y, ny, nx);
      if (top && (!p || topY <= p.y)) {
        // no two boxes share a level: slide to touch a neighbour already resting there, and keep enough support
        const lx = settleLevel(b, nx, topY, boxes, world);
        if (lx === lx && Math.min(lx + half, top.x + top.w / 2) - Math.max(lx - half, top.x - top.w / 2) >= minSupport * b.w) {
          b.x = lx; b.y = topY; b.vy = 0; b.vx = 0; b.onGround = true; b.groundId = BOX_ID_BASE + top.id; if (events) events.push({ type: 'box_land', id: b.id, on: top.id }); continue;
        } // else: no room or too little support after the slide -> keep falling past it
      }
      if (p) {
        const lx = settleLevel(b, nx, p.y, boxes, world);
        if (lx === lx) { b.x = lx; b.y = p.y; b.vy = 0; b.vx = 0; b.onGround = true; b.groundId = p.id; if (events) events.push({ type: 'box_land', id: b.id, on: p.floor ? 'floor' : 'platform' }); continue; }
        // boxed in at floor level: come to rest on the box it overlaps most
        let o2 = null, best = 0;
        for (const o of boxes) { if (o === b || !o.onGround || Math.abs(o.y - p.y) > 1e-6) continue; const ov = Math.min(nx + half, o.x + o.w / 2) - Math.max(nx - half, o.x - o.w / 2); if (ov > best) { best = ov; o2 = o; } }
        if (o2) { climbRest(b, o2, boxes, world, minSupport, events); continue; }
        b.x = nx; b.y = p.y; b.vy = 0; b.vx = 0; b.onGround = true; b.groundId = p.id; continue;
      }
    }
    if (ny < -b.h) ny = -b.h;
    // corner pass-through guard (review GE-shift3 SHOULD): a drop with too little overlap to land must not enter a resting
    // box's body; push it out sideways to the nearer side (then back inside the walls)
    for (const o of boxes) {
      if (o === b || !o.onGround) continue;
      if (!((ny - b.h) < o.y - 1e-6 && ny > (o.y - o.h) + 1e-6)) continue;
      const ov = Math.min(nx + half, o.x + o.w / 2) - Math.max(nx - half, o.x - o.w / 2);
      if (ov <= 1e-9) continue;
      nx = nx >= o.x ? o.x + o.w / 2 + half : o.x - o.w / 2 - half;
      if (nx < half) nx = half; if (nx > world.width - half) nx = world.width - half;
    }
    // pinched (a slot narrower than the box, or a wall): it cannot sink, so it rests bridging the tops it overlaps
    { let o2 = null, best = 0, ty = Infinity;
      for (const o of boxes) {
        if (o === b || !o.onGround) continue;
        if (!((ny - b.h) < o.y - 1e-6 && ny > (o.y - o.h) + 1e-6)) continue;
        const ov = Math.min(nx + half, o.x + o.w / 2) - Math.max(nx - half, o.x - o.w / 2);
        if (ov <= 1e-9) continue;
        const t = o.y - o.h;
        if (t < ty - 1e-6 || (Math.abs(t - ty) <= 1e-6 && ov > best)) { if (t < ty - 1e-6) best = 0; ty = t; if (ov > best) { best = ov; o2 = o; } }
      }
      if (o2 && b.vy > 0) { // falling onto the slot: rest bridging the tops (a box already in a corner pops up onto it)
        const lx = settleLevel(b, nx, ty, boxes, world);
        if (lx === lx) { b.x = lx; b.y = ty; b.vy = 0; b.vx = 0; b.onGround = true; b.groundId = BOX_ID_BASE + o2.id; if (events) events.push({ type: 'box_land', id: b.id, on: o2.id, bridge: true }); }
        else climbRest(b, o2, boxes, world, minSupport, events);
        continue;
      }
      if (o2) { nx = b.x; ny = b.y; b.vx = 0; if (b.vy < 0) b.vy = 0; } // rising (or already level) into a pinch: blocked, hold and drop back
    }
    b.x = nx; b.y = ny;
  }
  return boxes;
}
/** a box whose own support overlap is small still rests if the boxes at that level together hold >= minSupport of it (bridging a narrow slot) */
function bridged(b, sup, boxes, minSupport) {
  let sum = 0;
  for (const q of boxes) { if (q === b || !q.onGround || Math.abs(q.y - sup.y) > 1e-6) continue; const ov = boxOverlapX(b, q); if (ov > 0) sum += ov; }
  return sum >= minSupport * b.w;
}
/** rest b on o2's top, climbing to the lowest level with room: if o2's top is taken by a box we would overlap, land on THAT box instead */
function climbRest(b, o2, boxes, world, minSupport, events) {
  const half = b.w / 2;
  let lx2 = NaN;
  for (let k = 0; k < 16; k++) {
    lx2 = settleLevel(b, o2.x, o2.y - o2.h, boxes, world);
    if (lx2 === lx2 && Math.min(lx2 + half, o2.x + o2.w / 2) - Math.max(lx2 - half, o2.x - o2.w / 2) >= minSupport * b.w) break;
    let blocker = null, bov = 0;
    for (const o of boxes) { if (o === b || !o.onGround || Math.abs(o.y - (o2.y - o2.h)) > 1e-6) continue; const ov = Math.min(o2.x + half, o.x + o.w / 2) - Math.max(o2.x - half, o.x - o.w / 2); if (ov > bov) { bov = ov; blocker = o; } }
    if (!blocker) { lx2 = o2.x; break; }
    o2 = blocker; lx2 = NaN;
  }
  if (!(lx2 === lx2)) lx2 = o2.x;
  b.x = lx2; b.y = o2.y - o2.h; b.vy = 0; b.vx = 0; b.onGround = true; b.groundId = BOX_ID_BASE + o2.id; if (events) events.push({ type: 'box_land', id: b.id, on: o2.id });
}
/** x for a box landing at level y so it touches (never overlaps) boxes already resting at that level; NaN if boxed in */
function settleLevel(b, nx, y, boxes, world) {
  const half = b.w / 2;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const o of boxes) {
      if (o === b || !o.onGround || Math.abs(o.y - y) > 1e-6) continue;
      const ov = Math.min(nx + half, o.x + o.w / 2) - Math.max(nx - half, o.x - o.w / 2);
      if (ov <= 1e-9) continue;
      nx = nx >= o.x ? o.x + o.w / 2 + half : o.x - o.w / 2 - half; moved = true;
    }
    if (nx < half || nx > world.width - half) return NaN;
    if (!moved) return nx;
  }
  return NaN;
}
const floorScratch = { width: 0, height: 0, platforms: [] };
function FLOOR_WORLD(world) { floorScratch.width = world.width; floorScratch.height = world.height; floorScratch.platforms.length = 0; floorScratch.platforms.push(world.platforms[0]); return floorScratch; }
/** world platform records for the tops of resting boxes (ids BOX_ID_BASE + box.id), written into `out` */
export function boxPlatforms(boxes, out) {
  out.length = 0;
  for (const b of boxes) if (b.onGround) out.push({ id: BOX_ID_BASE + b.id, x0: b.x - b.w / 2, x1: b.x + b.w / 2, y: b.y - b.h, box: b.id });
  return out;
}
/** height (count) of the tallest column of boxes standing on the floor within [x0, x1] */
export function stackHeight(boxes, x0, x1, floorY, minSupport = 0.35) {
  let best = 0;
  const up = (b, depth) => { let h = depth; for (const o of boxes) if (o !== b && o.onGround && o.groundId === BOX_ID_BASE + b.id && boxOverlapX(o, b) >= minSupport * o.w) h = Math.max(h, up(o, depth + 1)); return h; };
  for (const b of boxes) if (b.onGround && b.groundId === 0 && Math.abs(b.y - floorY) < 1e-6 && b.x >= x0 && b.x <= x1) best = Math.max(best, up(b, 1));
  return best;
}

/* vr/src/art-glue.js - P0a: the PURE bits of wiring Design's VR1 sprites (vr/src/art/atlas.js) into the billboards and the
   box, kept out of the three.js files so node tests cover them (vr/test/art-manifest.test.mjs). Gaming Engineer 2, 2026-10-10. */
/** Design's atlas frames are metres at their ppm. Design fixed the ppm (2026-10-10 10:2x: a side 'idle' is 0.28 m, cat-billboard
 *  KITTEN_HEIGHT_M), so the frames are used 1:1; the knob stays for a quick headset re-tune. */
export const ART_SCALE = 1;
/** billboard id -> the art id (Laser Tag cats are drawn as 'lt:<coat>' so they never collide with a Play kitten of the same coat) */
export function artIdOf(id) { return String(id).replace(/^lt:/, ''); }
/** roomcat pose -> the atlas anim key (atlas.js ANIM_ALIAS covers the rest); 'pin' holds the caught dot: a sit; inbox draws nothing */
export function artPose(pose) { return pose === 'pin' ? 'sit' : pose === 'inbox' ? null : pose; }
/** BoxGeometry face UVs -> an atlas rect. face = 0..5 (+x, -x, +y, -y, +z, -z); uv = { u0, v0, u1, v1 } (flipY true). The four
 *  vertices of a face sit at 4 * face in the order top-left, top-right, bottom-left, bottom-right. */
export function boxFaceUV(geom, face, uv) {
  const a = geom.attributes.uv, i = face * 4;
  a.setXY(i, uv.u0, uv.v1); a.setXY(i + 1, uv.u1, uv.v1); a.setXY(i + 2, uv.u0, uv.v0); a.setXY(i + 3, uv.u1, uv.v0); a.needsUpdate = true;
}

/** GPU residency (review BC MUST 2, Design's 7-sheet layout): a kitten draws ONE sheet at a time (hi 1 MB within 2.5 m, lo 0.25 MB
 *  beyond), so the GPU holds the sheets drawn in the last staleS plus the box, never more than `budget` bytes. Images are decoded
 *  UPFRONT (the host's image cache: no network / decode mid-play); only the GPU upload of a cached sheet happens on first draw.
 *  Pure bookkeeping: touch(file, bytes, t) marks a sheet drawn now (evicting the least-recently-drawn ones first when the budget
 *  would overflow; returns the evicted files, or null when even that cannot make room: the caller draws the other lod); 
 *  stale(t) returns the sheets not drawn for staleS. */
export function createResidency(budget = 8 * 1024 * 1024, staleS = 1.0, loReserve = 262144) {
  const res = new Map(); // file -> { bytes, last }
  let used = 0;
  // (review BF S3) a big (hi) sheet must leave loReserve free, so a kitten whose hi is refused can always draw its lo sheet
  const api = {
    get bytes() { return used; }, get files() { return [...res.keys()]; }, budget, staleS,
    has(file) { return res.has(file); },
    touch(file, bytes, t) {
      const cur = res.get(file);
      if (cur) { cur.last = t; return []; }
      const out = [], cap = bytes > loReserve ? budget - loReserve : budget;
      while (used + bytes > cap) {
        let oldest = null; for (const [f, r] of res) if (r.last < t - 1e-9 && (!oldest || r.last < oldest.r.last)) oldest = { f, r };
        if (!oldest) return null; // everything resident was drawn THIS frame: no room
        res.delete(oldest.f); used -= oldest.r.bytes; out.push(oldest.f);
      }
      res.set(file, { bytes, last: t }); used += bytes;
      return out;
    },
    stale(t) { const out = []; for (const [f, r] of res) if (t - r.last >= staleS) out.push(f); return out; },
    drop(file) { const r = res.get(file); if (r) { res.delete(file); used -= r.bytes; return true; } return false; },
  };
  return api;
}

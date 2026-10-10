/* vr/src/cat-art.js - P0a slice: the SPRITE SWAP SEAM between the VR glue (GE2) and Design's art (vr/src/art/**, the
   sprite atlas loader they deliver). Gaming Engineer 2, 2026-10-10.
   The billboards draw every (sprite x pose) texture once through createSpriteCache({ draw }) (cat-billboard.js); the draw
   function is the whole contract: draw(ctx2d, px, { sprite: 'side'|'front'|'back'|'above'|'below', pose, catId, size }).
   Design calls registerCatArt(draw) once (from main.js or their own module); until then the placeholder drawing in
   cat-billboard.js is used. The seam is a plain registry so neither lane imports the other's files. */
export const CAT_ART_VERSION = 1;
const art = { draw: null, name: 'placeholder' };
/** Register Design's drawer (or null to go back to the placeholder). Returns the active name. */
export function registerCatArt(draw, name) { art.draw = typeof draw === 'function' ? draw : null; art.name = art.draw ? (name || 'design') : 'placeholder'; return art.name; }
/** The active drawer (null = placeholder). room-hook passes it to createSpriteCache. */
export function catArtDraw() { return art.draw; }
export function catArtName() { return art.name; }

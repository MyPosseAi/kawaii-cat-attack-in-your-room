/* game/core/world.js — the one standard 2D platform world (BL units) shared by the desktop game (game.js) and Laser Tag
   (lasertag.js, LASER_TAG_STD_WORLD). Split out of game.js (Review BA SHOULD 3, GE1 2026-10-10) so lasertag.js no longer
   imports game.js (desktop-only code that is not part of this build).
   Build rule: only `export const` / `export function`. */
export const DEFAULT_WORLD = Object.freeze({
  width: 16, height: 8,
  platforms: [ // "drawn windows" in BL; y = top edge (y grows down, floor at y = height)
    { x0: 1.5, x1: 5.5, y: 6.2 }, { x0: 7.0, x1: 10.5, y: 5.0 }, { x0: 12.0, x1: 15.2, y: 6.4 }, { x0: 4.0, x1: 7.0, y: 3.4 },
  ],
});

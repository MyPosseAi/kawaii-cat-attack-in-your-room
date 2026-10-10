// vr/src/iwer-guard.js - keeps IWER (the Immersive Web Emulation Runtime, dev-only) out of the built page.
// @iwsdk/vite-plugin-dev injects the emulator bundle during `vite dev`; vr/iwsdk.config.json keeps
// dev.emulator.injectOnBuild = false so it never reaches dist/. This guard PROVES that on the final dist/:
//   1) iwerGuardPlugin(): after `vite build`, scans dist/ (licenses.txt excluded) and FAILS the build on a marker.
//   2) CLI (`node src/iwer-guard.js dist`): the same scan in CI ("Check dist") and the public Pages workflow.
// Why not `grep -i iwer dist/`? A 4-letter substring is not a usable marker: it shows up in base64 blobs, hashed
// identifiers and in @iwsdk option names ("iwer", "injectOnBuild", "IWERPluginOptions") even in a clean build
// (CI run #4 failed on a clean dist/). The markers below exist ONLY when the emulator runtime itself is bundled.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IWER_PACKAGE = 'iwer';
/**
 * Strings that only the IWER 2.5.0 runtime (iwer/lib, the bundle @iwsdk/vite-plugin-dev 1.0.1 injects) produces.
 * Read from the published package, 2026-10-09:
 *  - lib/private.js: Symbol descriptions for the runtime's private slots (survive minification verbatim),
 *  - lib/device/XRDevice.js: installRuntime() warning / error texts,
 *  - dist/injection-bundle.js (the dev UI): its postMessage channel name.
 * NOT the bare word "iwer", not option names, not generic WebXR class names (XRSession, XRDevice...).
 */
export const FORBIDDEN_MARKERS = Object.freeze([
  '@iwer/xr-device',
  '@iwer/xr-system',
  '@iwer/xr-frame',
  '@iwer/xr-input-source',
  '@iwer/gamepad',
  'IWER: a native WebXR runtime is already available on navigator.xr',
  'Cannot install the emulated runtime while a native override is installed',
  'skipping installRuntime. Pass { forceInstall: true } to override',
  'iwer-prefs',
]);
/** Strings a clean build may legitimately contain: must NEVER be treated as markers (regression check in tests). */
export const ALLOWED_MENTIONS = Object.freeze(['iwer', 'IWER', 'injectOnBuild', 'IWERPluginOptions', 'ProcessedIWEROptions',
  'Immersive Web Emulation Runtime', 'emulator', 'metaQuest3', 'XRDevice', 'XRSystem', 'XRSession', 'navigator.xr']);
export const EXCLUDED_FILES = Object.freeze(['licenses.txt']);
/** Binary assets are skipped (they cannot contain JS); everything else is scanned as text. */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|glb|gltf|bin|wasm|ktx2?|basis|mp3|ogg|wav|woff2?|ttf|otf|zip)$/i;

/** Find every forbidden marker in `text`. */
export function findMarkers(text, markers = FORBIDDEN_MARKERS) {
  return markers.filter((m) => text.includes(m));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Scan a built dist/ folder. Returns { hits: [{ file, marker }], scanned }. `file` is relative to `dir`.
 * Files named in `exclude` (basename) are skipped.
 */
export function scanDist(dir, { exclude = EXCLUDED_FILES, markers = FORBIDDEN_MARKERS } = {}) {
  const hits = [];
  let scanned = 0;
  for (const p of walk(dir)) {
    if (exclude.includes(basename(p)) || BINARY_EXT.test(p)) continue;
    const text = readFileSync(p, 'latin1');
    scanned++;
    const rel = relative(dir, p).split('\\').join('/');
    for (const marker of findMarkers(text, markers)) hits.push({ file: rel, marker });
  }
  return { hits, scanned };
}

/** Human-readable verdict; `ok` false = the build must fail. */
export function checkDist(dir, opts) {
  const r = scanDist(dir, opts);
  const problems = r.hits.map((h) => `${h.file}: contains "${h.marker}" (IWER emulator runtime in the build; injectOnBuild must stay false)`);
  if (r.scanned === 0) problems.push(`no text files scanned in ${dir} (empty or missing dist/)`);
  return { ok: problems.length === 0, problems, ...r };
}

/** Vite plugin: run the dist check after the bundle is written (build only). */
export function iwerGuardPlugin({ log = console.log } = {}) {
  let outDir = 'dist';
  return {
    name: 'kca-iwer-guard',
    apply: 'build',
    configResolved(config) { outDir = join(config.root, config.build.outDir); },
    closeBundle(error) {
      // Vite calls closeBundle from a `finally` even when the build failed; Rollup passes that error. Never replace it with ours.
      if (error) { log('kca-iwer-guard: skipped, the build failed earlier (see the error above).'); return; }
      const r = checkDist(outDir);
      if (!r.ok) throw new Error(`kca-iwer-guard: ${r.problems.join('; ')}`);
      log(`kca-iwer-guard: ${r.scanned} files scanned, no IWER emulator runtime code.`);
    },
  };
}

// CLI: `node src/iwer-guard.js dist` -> exit 1 with the problems on stderr.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || 'dist';
  const r = checkDist(dir);
  if (!r.ok) { for (const p of r.problems) console.error(`::error::${p}`); process.exit(1); }
  console.log(`kca-iwer-guard: ${r.scanned} files scanned in ${dir}; no IWER emulator runtime code.`);
}

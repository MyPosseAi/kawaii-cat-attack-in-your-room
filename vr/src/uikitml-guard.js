// vr/src/uikitml-guard.js - keeps the unlicensed npm package "@drawcall/uikitml" out of the built page (Legal,
// legal/TRY-IT-OUT-SCOPE.md section 12.3 option 2). Two halves, both build-time only (no runtime code, no network):
//   1) uikitmlAlias(): Vite resolve.alias entries that send '@drawcall/uikitml' (and any subpath) to src/stubs/uikitml-stub.js.
//   2) uikitmlGuardPlugin(): after `vite build`, scans dist/ (licenses.txt excluded) and FAILS the build if a marker that
//      only the real package produces is found, or if the stub's own marker is missing (= the alias did not apply).
// The same scan runs in CI ("Check dist" step) via `node src/uikitml-guard.js dist`. Note: the bare word "uikitml" is NOT
// a usable marker - @iwsdk/core (MIT) itself contains it (AssetType "uikitml", ".uikitml" asset kind, UIKitML error texts).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UIKITML_PACKAGE = '@drawcall/uikitml';
/** Matches the bare package and every subpath import ('@drawcall/uikitml/dist/parse.js'), nothing else. */
export const UIKITML_ALIAS_RE = /^@drawcall\/uikitml(?:\/.*)?$/;
export const STUB_PATH = fileURLToPath(new URL('./stubs/uikitml-stub.js', import.meta.url));
/** Same value as STUB_MARKER in the stub (kept literal here so the guard never has to import the stub). */
export const STUB_MARKER = 'kca-ui-panel-stub';
/**
 * Strings that exist only in @drawcall/uikitml 0.1.8's IMPLEMENTATION (dist/parse.js error texts, parser-internal helper
 * names, the package path itself). NOT export/import identifier names: @iwsdk/core (MIT) legitimately imports
 * { instantiate, resolveKitComponentSets, parse } and our stub exports them, so those names are in every clean bundle.
 */
export const FORBIDDEN_MARKERS = Object.freeze([
  '@drawcall/uikitml',
  'UIKitML requires exactly one root component',
  'must be a top-level UIKitML metadata element',
  'Invalid preferred color scheme. Expected "dark", "light", or "system"',
  'withDeclaredFontFamilyEnum',
  'collectExpectedAlternatives',
  'flattenValidationIssues',
  'appendProvenance',
]);
/** Names IWSDK and our stub share with the real package: must NEVER be treated as markers (regression check in tests). */
export const SHARED_IDENTIFIERS = Object.freeze(['parse', 'instantiate', 'resolveKitComponentSets', 'generate', 'convertToReact',
  'convertToThree', 'htmlComponentSet', 'horizonComponentSet', 'lucideComponentSet', 'fontFamilyNames']);
export const EXCLUDED_FILES = Object.freeze(['licenses.txt']);
/** Binary assets are skipped (they cannot contain JS); everything else is scanned as text. */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|glb|gltf|bin|wasm|ktx2?|basis|mp3|ogg|wav|woff2?|ttf|otf|zip)$/i;

/** Vite `resolve.alias` entries for vite.config.js. */
export function uikitmlAlias(stubPath = STUB_PATH) {
  return [{ find: UIKITML_ALIAS_RE, replacement: stubPath }];
}

/** What the alias would resolve `id` to: the stub path, or null when the id is not the package. */
export function resolveAlias(id, stubPath = STUB_PATH) {
  return UIKITML_ALIAS_RE.test(id) ? stubPath : null;
}

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
 * Scan a built dist/ folder. Returns { hits: [{ file, marker }], stubFound, scanned }.
 * `file` is relative to `dir`. Files named in `exclude` (basename) are skipped.
 */
export function scanDist(dir, { exclude = EXCLUDED_FILES, markers = FORBIDDEN_MARKERS, stubMarker = STUB_MARKER } = {}) {
  const hits = [];
  let stubFound = false;
  let scanned = 0;
  for (const p of walk(dir)) {
    if (exclude.includes(basename(p)) || BINARY_EXT.test(p)) continue;
    const text = readFileSync(p, 'latin1');
    scanned++;
    const rel = relative(dir, p).split('\\').join('/');
    for (const marker of findMarkers(text, markers)) hits.push({ file: rel, marker });
    if (text.includes(stubMarker)) stubFound = true;
  }
  return { hits, stubFound, scanned };
}

/** Human-readable verdict; `ok` false = the build must fail. */
export function checkDist(dir, opts) {
  const r = scanDist(dir, opts);
  const problems = r.hits.map((h) => `${h.file}: contains "${h.marker}" (unlicensed package code in the build)`);
  if (!r.stubFound) problems.push(`stub marker "${STUB_MARKER}" not found in ${dir} (the alias did not apply or the UI module vanished)`);
  return { ok: problems.length === 0, problems, ...r };
}

/** Vite plugin: run the dist check after the bundle is written (build only). */
export function uikitmlGuardPlugin({ log = console.log } = {}) {
  let outDir = 'dist';
  return {
    name: 'kca-uikitml-guard',
    apply: 'build',
    configResolved(config) { outDir = join(config.root, config.build.outDir); },
    closeBundle() {
      const r = checkDist(outDir);
      if (!r.ok) throw new Error(`kca-uikitml-guard: ${r.problems.join('; ')}`);
      log(`kca-uikitml-guard: ${r.scanned} files scanned, no unlicensed UI-markup package code; stub present.`);
    },
  };
}

// CLI: `node src/uikitml-guard.js dist` -> exit 1 with the problems on stderr.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || 'dist';
  const r = checkDist(dir);
  if (!r.ok) { for (const p of r.problems) console.error(`::error::${p}`); process.exit(1); }
  console.log(`kca-uikitml-guard: ${r.scanned} files scanned in ${dir}; no unlicensed UI-markup package code; stub present.`);
}

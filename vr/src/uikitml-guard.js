// vr/src/uikitml-guard.js - keeps the unlicensed npm package "@drawcall/uikitml" out of the built page (Legal,
// legal/TRY-IT-OUT-SCOPE.md section 12.3 option 2). Two halves, both build-time only (no runtime code, no network):
//   1) uikitmlAlias(): Vite resolve.alias entries that send '@drawcall/uikitml' (and any subpath) to src/stubs/uikitml-stub.js.
//   2) uikitmlGuardPlugin(): after `vite build`, scans dist/ (licenses.txt excluded) and FAILS the build if a marker that
//      only the real package produces is found, or if the stub's own marker is missing (= the alias did not apply).
// The same scan runs in CI ("Check dist" step) via `node src/uikitml-guard.js dist`. Note: the bare word "uikitml" is NOT
// a usable marker - @iwsdk/core (MIT) itself contains it (AssetType "uikitml", ".uikitml" asset kind, UIKitML error texts).
// Ops fix 2026-10-10 (CI 'VR build' #8, `npm run build:freeze`): (a) the guard no longer MASKS an earlier build error - Vite
// runs closeBundle from a `finally` even when generateBundle threw, and an empty dist-freeze/ then read as "stub marker not
// found"; closeBundle(error) now steps aside and an unwritten / empty output folder is reported as exactly that. (b) FROZEN
// build only (Legal): the stub marker proves the alias applied, so it is required whenever a uikitml / ui-panel
// consumer module (UI_MODULE_SIGNATURES) is in the bundle; a frozen bundle that carries NO such consumer, NO stub and NO
// real-package code passes (nothing is left for the alias to prove). The ban on the real package is unchanged in every mode.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isContestFreeze } from './freeze-guard.js';

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
/**
 * String literals (they survive minification; identifiers do not) that only @iwsdk/core's UIKitML / spatial-UI consumer
 * modules (dist/ui/**, the importer of the three package names) produce. When any of them is in a bundle, that consumer
 * shipped and its imports must have resolved to our stub (marker required). Frozen build only; see checkDist.
 */
export const UI_MODULE_SIGNATURES = Object.freeze([
  'UIKitML asset requires the spatialUI feature',
]);
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
export function scanDist(dir, { exclude = EXCLUDED_FILES, markers = FORBIDDEN_MARKERS, stubMarker = STUB_MARKER, uiSignatures = UI_MODULE_SIGNATURES } = {}) {
  const hits = [];
  let stubFound = false;
  let uiModuleFound = false;
  let scanned = 0;
  if (!existsSync(dir)) return { hits, stubFound, uiModuleFound, scanned, missing: true };
  for (const p of walk(dir)) {
    if (exclude.includes(basename(p)) || BINARY_EXT.test(p)) continue;
    const text = readFileSync(p, 'latin1');
    scanned++;
    const rel = relative(dir, p).split('\\').join('/');
    for (const marker of findMarkers(text, markers)) hits.push({ file: rel, marker });
    if (text.includes(stubMarker)) stubFound = true;
    if (findMarkers(text, uiSignatures).length) uiModuleFound = true;
  }
  return { hits, stubFound, uiModuleFound, scanned, missing: false };
}

/**
 * Human-readable verdict; `ok` false = the build must fail. `freeze` (default: the folder is named dist-freeze or env
 * KCA_CONTEST_FREEZE=1, same rule as src/freeze-guard.js isContestFreeze) relaxes ONLY the stub-marker requirement, and only
 * when no uikitml / ui-panel consumer module is in the bundle and no real-package code is found (Legal: the alias has
 * nothing left to prove). The real-package markers fail the build in every mode. An unwritten or empty folder is reported as
 * such (never as a missing stub): that is an earlier build failure, see Vite's error above it.
 */
export function checkDist(dir, { freeze, ...opts } = {}) {
  const frozen = freeze ?? isContestFreeze({ outDir: dir });
  const r = scanDist(dir, opts);
  if (r.missing) return { ok: false, problems: [`output folder ${dir} does not exist (the build failed before writing; see the error above)`], ...r };
  if (r.scanned === 0) return { ok: false, problems: [`no text files in ${dir} (empty output folder: the build failed before writing; see the error above)`], ...r };
  const problems = r.hits.map((h) => `${h.file}: contains "${h.marker}" (unlicensed package code in the build)`);
  let note = null;
  if (!r.stubFound) {
    if (frozen && !r.uiModuleFound && r.hits.length === 0) note = 'frozen build: no UI-markup consumer module, no stub, no unlicensed code (nothing to alias)';
    else problems.push(`stub marker "${STUB_MARKER}" not found in ${dir} (the alias did not apply or the UI module vanished)${r.uiModuleFound ? '; a UI-markup consumer module IS in the bundle' : ''}`);
  }
  return { ok: problems.length === 0, problems, note, frozen, ...r };
}

const okLine = (r) => (r.note ? `; ${r.note}` : '; stub present');

/** Vite plugin: run the dist check after the bundle is written (build only). */
export function uikitmlGuardPlugin({ log = console.log, env = process.env } = {}) {
  let outDir = 'dist';
  let frozen = false;
  return {
    name: 'kca-uikitml-guard',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
      frozen = isContestFreeze({ mode: config.mode, env, outDir: config.build.outDir });
    },
    // Rollup passes the build error (if any) to closeBundle; Vite calls it from a `finally`. Never replace that error with ours.
    closeBundle(error) {
      if (error) { log('kca-uikitml-guard: skipped, the build failed earlier (see the error above).'); return; }
      const r = checkDist(outDir, { freeze: frozen });
      if (!r.ok) throw new Error(`kca-uikitml-guard: ${r.problems.join('; ')}`);
      log(`kca-uikitml-guard: ${r.scanned} files scanned, no unlicensed UI-markup package code${okLine(r)}.`);
    },
  };
}

// CLI: `node src/uikitml-guard.js dist` -> exit 1 with the problems on stderr.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `--freeze` or a folder named dist-freeze or env KCA_CONTEST_FREEZE=1 = the frozen rule (checkDist).
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--')) || 'dist';
  const r = checkDist(dir, args.includes('--freeze') ? { freeze: true } : {});
  if (!r.ok) { for (const p of r.problems) console.error(`::error::${p}`); process.exit(1); }
  console.log(`kca-uikitml-guard: ${r.scanned} files scanned in ${dir}; no unlicensed UI-markup package code${okLine(r)}.`);
}

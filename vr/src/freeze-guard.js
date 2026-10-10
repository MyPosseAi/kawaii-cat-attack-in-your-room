/* vr/src/freeze-guard.js - contest-freeze build (Legal TRY-IT-OUT-SCOPE.md section 13.6, product owner 2026-10-09):
   the "Send feedback" link + QR (src/feedback.js) are for development and Try-it-out testing ONLY. The frozen entry
   (GATE-A section 7 strict, fully zero-network) ships WITHOUT the link, the QR, the Issues URL, the "Work in progress:
   updated until November 14" line and the privacy sentence about the link, and WITH Legal's frozen start card (13.6 item 5:
   privacy paragraph minus the feedback clause, the "Contest build v1.0, frozen ..." line, the hosting line). Build time only
   (nothing here is imported by the runtime):
     1) freezeIndexHtml(): src/feedback.js calls it instead of injecting the link when the build is frozen; it CUTS the marker,
        the #wip line, the privacy feedback sentence and the feedback CSS from index.html, ADDS the frozen + hosting lines, and
        fails closed if any cut is missing.
     2) freezeGuardPlugin() / CLI `node src/freeze-guard.js dist-freeze`: after the build, drops the QR paragraph from
        licenses.txt, then scans the whole output folder and FAILS on any string of 13.6 item 6 (feedback / QR / Issues URL /
        WIP line / contest bans; github.com and absolute URLs on the page itself; the repo's own Issues slug anywhere) and if
        the frozen start-card paragraphs are not present word for word. Like src/iwer-guard.js and src/uikitml-guard.js.
   Frozen = `vite build --mode contest-freeze` (= `npm run build:freeze`, writes dist-freeze/), env KCA_CONTEST_FREEZE=1, or an
   outDir named dist-freeze (a hand-run `vite build --outDir dist-freeze` can never produce an unfrozen "frozen" folder).
   The regular `npm run build` is unchanged: it keeps the link + QR and still fails on a placeholder issuesUrl.
   Gaming Engineer 2, 2026-10-09.
   ALL HANDS P0a (Gaming Engineer 4, 2026-10-10; Legal item 2 / 13.11 row 2): the dev-only auto-update (src/dev-update.js
   polling version.json, the "New build ready" toast, the #build-stamp corner line from src/build-stamp.js, and the dev
   start-card sentence "This test build checks once a minute ...") is removed from the frozen entry the same way: four more
   FREEZE_CUTS (sentence, stamp element, dev-update script tag, dev CSS), five more FORBIDDEN_MARKERS, and checkFreezeDist also
   fails on a version.json file or an unfilled {{PLACEHOLDER}} in the output. The frozen entry stays zero-network. */
import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDist } from './iwer-guard.js';

export const FREEZE_MODE = 'contest-freeze';
export const FREEZE_ENV = 'KCA_CONTEST_FREEZE';
export const FREEZE_OUT_DIR = 'dist-freeze';
/* ---------- hashed bans (Review Z2 MUST, Legal FOR-DEV): no banned plaintext anywhere in vr/ ----------
   Two salted-hash lists, same scheme as legal/secret-name.hashes.json: text = NFKC, lowercase, letters-only tokens; every
   1-token window, 2-token window joined by one space and 2-token window joined with no space is hashed as
   hex(sha256(utf8(salt + text))) and compared. A hit is reported as "<list> #<n>", never as the text.
     1) vr/freeze-bans.hashes.json (PUBLIC, hashes only): the contest bans of TRY-IT-OUT-SCOPE.md 13.7 /.
     2) legal/secret-name.hashes.json (PRIVATE, read in place from the main repo, never copied): the Games Master's name.
        Override the path with KCA_SECRET_NAME_HASHES. When the file is absent (public repo, a shell without legal/) the check is
        SKIPPED with a loud ::warning:: (Review AC S2); the main-repo CI has legal/ and runs it. */
export const BANS_HASHES_URL = new URL('../freeze-bans.hashes.json', import.meta.url);
export const SECRET_HASHES_URL = new URL('../../legal/secret-name.hashes.json', import.meta.url);
export const SECRET_HASHES_ENV = 'KCA_SECRET_NAME_HASHES';

/** True when this build is the frozen contest entry: Vite mode 'contest-freeze', env KCA_CONTEST_FREEZE=1, or outDir dist-freeze. */
export function isContestFreeze({ mode, env = process.env, outDir } = {}) {
  return mode === FREEZE_MODE || (env != null && env[FREEZE_ENV] === '1') || (outDir != null && basename(outDir) === FREEZE_OUT_DIR);
}

/* ---------- Legal 13.6 item 5: the frozen start card, word for word (vr/test/fixtures/legal-text.json mirrors it) ---------- */
/** Paragraph 2 (frozen line). A contest-v1.0.1 re-freeze edits the build / day here (test pins the shape). */
export const FROZEN_LINE = 'Contest build v1.0, frozen November 14, 2026. No changes until the contest results are announced.';
export const FROZEN_LINE_RE = /^Contest build v1\.0(?:\.\d+)?, frozen November \d{1,2}, 2026\. No changes until the contest results are announced\.$/;
/** Paragraph 3 (hosting line): plain text, no link. */
export const HOSTING_LINE = "This page is hosted on GitHub Pages. GitHub sees normal web request data (like your IP address) when your browser loads it, under GitHub's Privacy Statement. We don't run analytics or cookies here.";
/** Sentences 1 and 2 of paragraph 1, which must stay as written. */
export const PRIVACY_S1_S2 = 'Your room and hand data stay on your headset. The game records nothing and sends nothing.';
/** Must be PRESENT in the frozen index.html (13.6 item 6, last bullet). */
export const REQUIRED_PAGE_STRINGS = Object.freeze([PRIVACY_S1_S2, FROZEN_LINE, HOSTING_LINE]);

/* ---------- Legal 13.6 item 6: strings that must be ABSENT (case-sensitive, exact; never case-insensitive) ---------- */
/** Scanned in EVERY output file (licenses.txt included once its QR paragraph is dropped). The feedback link and QR, the config
 *  key and URL shape, the feedback sentence, the WIP line (never the bare date: the frozen line needs it), the repo's own
 *  Issues slug (precise enough for vendor chunks) and the contest bans (13.7). */
export const FORBIDDEN_MARKERS = Object.freeze([
  'Send feedback',
  'send feedback',
  'feedback-qr',
  'id="feedback"',
  '<!-- feedback -->',
  'issuesUrl',
  'issues/new/choose',
  'Feedback only goes out',
  'anything you post there is public',
  'GitHub page',
  'Work in progress',
  'updated until November 14',
  'kawaii-cat-attack-in-your-room/issues',
  // Dev-only auto-update (item 2): the polled file, the poller, the stamp element id, the toast and the dev card sentence.
  'version.json',
  'dev-update',
  'build-stamp',
  'New build',
  'This test build checks',
  // The contest bans (13.7) are NOT listed here: they are matched by salted hash (vr/freeze-bans.hashes.json, see above).
]);
/** Legal item 2: the dev start-card sentence (after sentence 2) while the auto-update check ships; cut when frozen. */
export const DEV_CHECK_SENTENCE = 'This test build checks once a minute for a newer version. That check sends no game data.';
/** A dev-build file that must NOT exist in the frozen output (src/build-stamp.js writes it for dev builds only). */
export const VERSION_FILE = 'version.json';
/** Any {{NAME}} left on a page = a build placeholder nobody filled (src/build-stamp.js fills {{PLAY_URL}}). */
export const PLACEHOLDER_LEFT_RE = /\{\{[A-Za-z_]+\}\}/;
/** Scanned in the page files (*.html) only: the frozen page carries no absolute URL at all. Vendor chunks may legitimately
 *  carry github.com / https:// inside warning strings and XML namespaces, so these never run on assets/*.js (Review X2 S3);
 *  licenses.txt names upstream repos on github.com on purpose. */
export const PAGE_ONLY_MARKERS = Object.freeze(['github.com', 'http' + '://', 'https' + '://']); // split so test/network-allowlist sees no URL literal here
/** Kept for the CLI / tests: nothing is excluded wholesale any more (Review X2 S1). */
export const EXCLUDED_FILES = Object.freeze([]);
export const LICENSES_FILE = 'licenses.txt';
/** The licenses.txt paragraph that credits the QR encoder: dropped from the frozen build (the QR is not there). */
export const LICENSES_QR_CUT = /The "Scan to send feedback" QR code on the start card[^\n]*\n(?:[^\n]*\n)*?[^\n]*DENSO WAVE INCORPORATED\.\n\n/;

/** Every forbidden marker found in `text`. */
export function findFreezeMarkers(text, markers = FORBIDDEN_MARKERS) {
  return markers.filter((m) => text.includes(m));
}

/** The cuts applied to vr/index.html for the frozen build. Each regex must match exactly `count` times (fail closed). */
export const FREEZE_CUTS = Object.freeze([
  { name: 'the <!-- feedback --> marker line (no link, no QR)', re: /[ \t]*<!-- feedback -->\r?\n/g, count: 1, to: '' },
  { name: 'the #wip "Work in progress" line (Try-it-out only) -> the frozen line + the hosting line', re: /<p id="wip">[^<]*<\/p>/g, count: 1,
    to: `<p id="frozen">${FROZEN_LINE}</p>\n      <p id="hosting">${HOSTING_LINE}</p>` },
  { name: 'the privacy sentence about the feedback link', re: / Feedback only goes out if you tap Send feedback[^<]*?there is public\./g, count: 1, to: '' },
  { name: 'the #feedback-qr CSS rules', re: /[ \t]*#feedback-qr[^\n]*\n/g, count: 2, to: '' },
  { name: 'the #wip CSS rule -> #frozen, #hosting', re: /#wip \{/g, count: 1, to: '#frozen, #hosting {' },
  // ALL HANDS P0a dev-only auto-update (item 2): the sentence, the stamp element, the poller script, the dev CSS.
  { name: 'the D-111 dev start-card sentence "This test build checks ..."', re: / This test build checks once a minute for a newer version\. That check sends no game data\./g, count: 1, to: '' },
  { name: 'the <p id="build-stamp"> element (src/build-stamp.js fills it in dev builds)', re: /[ \t]*<p id="build-stamp"[^\n]*\n/g, count: 1, to: '' },
  { name: 'the src/dev-update.js <script> tag (version.json poll + toast)', re: /[ \t]*<script type="module" src="\/src\/dev-update\.js"><\/script>\r?\n/g, count: 1, to: '' },
  { name: 'the #build-stamp / #dev-update-toast CSS rules', re: /[ \t]*#(?:build-stamp|dev-update-toast)[^\n]*\n/g, count: 3, to: '' },
]);

/**
 * index.html -> the frozen start card (Legal 13.6 item 5). Throws if any cut does not match exactly its expected count (the
 * page changed under us), if a forbidden marker is still left afterwards, or if a required paragraph is missing.
 * Never reads feedback.config.json, never calls the QR encoder.
 */
export function freezeIndexHtml(html) {
  let out = html;
  for (const cut of FREEZE_CUTS) {
    const n = (out.match(cut.re) || []).length;
    if (n !== cut.count) throw new Error(`freeze: expected ${cut.count} match(es) for ${cut.name} in index.html, found ${n}; update FREEZE_CUTS in src/freeze-guard.js`);
    out = out.replace(cut.re, cut.to);
  }
  const problems = pageProblems(out);
  if (problems.length) throw new Error(`freeze: index.html after the cuts: ${problems.join('; ')}`);
  return out;
}

/** Problems with a frozen PAGE: forbidden strings (common + page-only) and missing required paragraphs. */
export function pageProblems(html) {
  const left = findFreezeMarkers(html, [...FORBIDDEN_MARKERS, ...PAGE_ONLY_MARKERS]);
  const problems = left.map((m) => `still contains ${JSON.stringify(m)}`);
  for (const s of REQUIRED_PAGE_STRINGS) if (!html.includes(s)) problems.push(`missing the required frozen start-card text ${JSON.stringify(s.slice(0, 40) + '...')}`);
  return problems;
}
/** The {{PLACEHOLDER}} check is separate from pageProblems: freezeIndexHtml runs BEFORE src/build-stamp.js fills {{PLAY_URL}}. */
export function placeholderProblems(html) {
  const m = html.match(PLACEHOLDER_LEFT_RE);
  return m ? [`unfilled build placeholder ${m[0]} (src/build-stamp.js did not run or the name is unknown)`] : [];
}

/** Drop the QR-encoder paragraph from a licenses.txt text (exactly one match, else throw). */
export function freezeLicensesText(text) {
  const n = (text.match(new RegExp(LICENSES_QR_CUT.source, 'g')) || []).length;
  if (n !== 1) throw new Error(`freeze: expected exactly one "Scan to send feedback" QR paragraph in ${LICENSES_FILE}, found ${n}; update LICENSES_QR_CUT in src/freeze-guard.js`);
  return text.replace(LICENSES_QR_CUT, '');
}

/** Rewrite <dir>/licenses.txt without the QR paragraph (tmp + rename). Returns true when it was rewritten. */
export function freezeLicensesFile(dir) {
  const p = join(dir, LICENSES_FILE);
  if (!existsSync(p)) return false;
  const text = readFileSync(p, 'utf8');
  if (!LICENSES_QR_CUT.test(text)) return false; // already frozen (idempotent)
  writeFileSync(p + '.tmp', freezeLicensesText(text));
  renameSync(p + '.tmp', p);
  return true;
}

/* ---------- salted-hash matching ---------- */
/** Letters-only tokens of a text (NFKC, lowercase). */
export function hashTokens(text) {
  return text.normalize('NFKC').toLowerCase().match(/[a-z]+/g) || [];
}
export const saltedHash = (salt, text) => createHash('sha256').update(salt + text, 'utf8').digest('hex');
/** Every distinct 1-token, spaced-pair and joined-pair window of the tokens. */
export function hashWindows(tokens) {
  const out = new Set();
  for (let i = 0; i < tokens.length; i++) {
    out.add(tokens[i]);
    if (i + 1 < tokens.length) { out.add(tokens[i] + ' ' + tokens[i + 1]); out.add(tokens[i] + tokens[i + 1]); }
  }
  return out;
}
/** Validate a hash list { algo, salt, hashes[] } (entries optional, never plaintext). Throws on a malformed list. */
export function parseHashList(json, name) {
  const l = typeof json === 'string' ? JSON.parse(json) : json;
  if (l.algo !== 'sha256' || typeof l.salt !== 'string' || !/^[0-9a-f]{16,}$/.test(l.salt)) throw new Error(`${name}: algo must be sha256 with a hex salt`);
  if (!Array.isArray(l.hashes) || l.hashes.length === 0 || !l.hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) throw new Error(`${name}: hashes must be non-empty 64-hex sha256 strings`);
  return { name, salt: l.salt, hashes: l.hashes };
}
/** Indices (1-based) of the list entries whose hash matches any window of `text`. Never returns the text. */
export function matchHashList(text, list) {
  const hits = new Set();
  const index = new Map(list.hashes.map((h, i) => [h, i + 1]));
  for (const w of hashWindows(hashTokens(text))) { const n = index.get(saltedHash(list.salt, w)); if (n) hits.add(n); }
  return [...hits].sort((a, b) => a - b);
}
/** The hash lists to enforce: the public contest bans (required) + the private secret-name list (loud warning when absent). */
export function loadHashLists({ env = process.env, warn = console.warn, bansUrl = BANS_HASHES_URL, secretUrl } = {}) {
  const lists = [parseHashList(readFileSync(bansUrl, 'utf8'), 'contest ban')];
  const secretPath = secretUrl ?? (env[SECRET_HASHES_ENV] ? env[SECRET_HASHES_ENV] : SECRET_HASHES_URL);
  if (existsSync(secretPath)) lists.push(parseHashList(readFileSync(secretPath, 'utf8'), 'secret name'));
  else warn(`::warning::kca-freeze-guard: secret-name hash list not found (${env[SECRET_HASHES_ENV] || 'legal/secret-name.hashes.json'}); the Games Master name check was SKIPPED (Legal 13.6 item 6). Run this in the main repo or set ${SECRET_HASHES_ENV}.`);
  return lists;
}

const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|glb|gltf|bin|wasm|ktx2?|basis|mp3|ogg|wav|woff2?|ttf|otf|zip)$/i;
/** Hashed-list hits over every text file in `dir`: { file, marker: '<list> #<n>' }. */
export function hashListHits(dir, lists) {
  const out = [];
  if (!lists.length) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { stack.push(p); continue; }
      if (BINARY_EXT.test(p)) continue;
      const text = readFileSync(p, 'utf8');
      const rel = p.slice(dir.length + 1).split('\\').join('/');
      for (const list of lists) for (const n of matchHashList(text, list)) out.push({ file: rel, marker: `${list.name} #${n}` });
    }
  }
  return out;
}

/**
 * Scan a built folder (same walker as iwer-guard.js: binary assets skipped). Common markers on every text file, page-only
 * markers on *.html, hashed bans + secret name on every text file (reported by list + index, never by value).
 */
export function scanFreezeDist(dir, { markers = FORBIDDEN_MARKERS, pageMarkers = PAGE_ONLY_MARKERS, hashLists, warn = console.warn } = {}) {
  const common = scanDist(dir, { exclude: [], markers });
  const page = scanDist(dir, { exclude: [], markers: pageMarkers });
  const hits = [...common.hits, ...page.hits.filter((h) => /\.html?$/i.test(h.file))];
  hits.push(...hashListHits(dir, hashLists ?? loadHashLists({ warn })));
  return { hits, scanned: common.scanned };
}

/** Human-readable verdict; `ok` false = the frozen build must fail. Also checks the required start-card text in index.html. */
export function checkFreezeDist(dir, opts) {
  if (!existsSync(dir)) return { ok: false, problems: [`output folder ${dir} does not exist (did the build fail before writing?)`], hits: [], scanned: 0 };
  const r = scanFreezeDist(dir, opts);
  const problems = r.hits.map((h) => `${h.file}: contains "${h.marker}" (must be absent from the frozen entry, Legal 13.6 item 6; see src/freeze-guard.js)`);
  if (r.scanned === 0) problems.push(`no text files scanned in ${dir} (empty output folder)`);
  const index = join(dir, 'index.html');
  if (existsSync(index)) {
    const html = readFileSync(index, 'utf8');
    for (const s of REQUIRED_PAGE_STRINGS) if (!html.includes(s)) problems.push(`index.html: missing the required frozen start-card text "${s.slice(0, 40)}..." (Legal 13.6 item 5)`);
    for (const p of placeholderProblems(html)) problems.push(`index.html: ${p}`);
  } else problems.push('index.html missing');
  if (existsSync(join(dir, VERSION_FILE))) problems.push(`${VERSION_FILE}: present (the dev-only auto-update file; the frozen entry polls nothing, Legal D-111 item 2 / D-104)`);
  const lic = join(dir, LICENSES_FILE);
  if (existsSync(lic) && LICENSES_QR_CUT.test(readFileSync(lic, 'utf8'))) problems.push(`${LICENSES_FILE}: still carries the QR-encoder paragraph`);
  return { ok: problems.length === 0, problems, ...r };
}

/** Vite plugin: only active for a frozen `vite build`; drops the licenses.txt QR paragraph, then scans the output folder. */
export function freezeGuardPlugin({ log = console.log } = {}) {
  let outDir = FREEZE_OUT_DIR;
  return {
    name: 'kca-freeze-guard',
    apply: (config, { command, mode }) => command === 'build' && isContestFreeze({ mode, outDir: config?.build?.outDir }),
    configResolved(config) { outDir = join(config.root, config.build.outDir); },
    closeBundle(error) {
      // Vite calls closeBundle from a `finally` even when the build failed; Rollup passes that error. Never replace it with ours.
      if (error) { log('kca-freeze-guard: skipped, the build failed earlier (see the error above).'); return; }
      if (!existsSync(outDir)) throw new Error(`kca-freeze-guard: output folder ${outDir} was not written (the build failed earlier; see the error above)`);
      freezeLicensesFile(outDir);
      const r = checkFreezeDist(outDir);
      if (!r.ok) throw new Error(`kca-freeze-guard: ${r.problems.join('; ')}`);
      log(`kca-freeze-guard: ${r.scanned} files scanned, frozen start card present, no feedback link / QR / Issues URL / WIP text / auto-update (frozen entry).`);
    },
  };
}

// CLI: `node src/freeze-guard.js dist-freeze` -> exit 1 with the problems on stderr. Read-only: it does not rewrite licenses.txt.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2] || FREEZE_OUT_DIR;
  const r = checkFreezeDist(dir);
  if (!r.ok) { for (const p of r.problems) console.error(`::error::${p}`); process.exit(1); }
  console.log(`kca-freeze-guard: ${r.scanned} files scanned in ${dir}; frozen start card present; no feedback link / QR / Issues URL / WIP text.`);
}

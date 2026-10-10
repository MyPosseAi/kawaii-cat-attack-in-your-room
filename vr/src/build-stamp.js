/* vr/src/build-stamp.js - BUILD TIME ONLY (vite.config.js -> buildStampPlugin). Nothing here is imported by the runtime
   (vr/test/network-allowlist.test.mjs enforces it). ALL HANDS P0a section C.2 (team/ORCH-PROMPT-ALL-HANDS-PLAYABLE.md),
   Legal item 2 / TRY-IT-OUT-SCOPE.md 13.11 row 2. Three jobs, all on vr/index.html and the output folder:
     1) The build stamp. `<p id="build-stamp" hidden></p>` in index.html becomes a visible corner line
        "build 0.0.1 · a1b2c3d · 2026-10-10 08:12 UTC" with data-version / data-built-at / data-commit attributes that
        src/dev-update.js reads. Stamp = version + short commit hash + UTC time ONLY (never a commit message, author
        or branch). The commit comes from env GITHUB_SHA (CI / the Pages workflow) or KCA_COMMIT; 'local' otherwise, 'dev' on
        the dev server. No git command runs here.
     2) version.json = { version, builtAt, commit } written next to index.html (emitFile; never hashed, never cached:
        dev-update.js polls it with cache 'no-store'). The dev server serves the same JSON from memory.
     3) The flat preview card's address: `{{PLAY_URL}}` in index.html is filled from env PLAY_URL (must be an https URL;
        default = the Pages build's custom domain play.kawaiicatattack.com, item 1) and shown WITHOUT the scheme as plain text, never a link:
        the frozen page may carry no absolute URL at all (Legal 13.6 item 6) and it is an address to type into the headset.
   FROZEN build (`npm run build:freeze`, src/freeze-guard.js isContestFreeze): jobs 1 and 2 are OFF. The stamp element, the
   dev-update script tag, the dev CSS and the dev start-card sentence are CUT by freezeIndexHtml (FREEZE_CUTS) before this
   plugin runs (order 'post'); no version.json is written; the post-build scan fails on 'version.json' / 'build-stamp' /
   'New build' / 'dev-update' / 'This test build checks' anywhere in dist-freeze/ and on a version.json file. Job 3 runs in
   every build. Any `{{...}}` left on the page fails the build.
   Gaming Engineer 4, 2026-10-10. */
import { readFileSync } from 'node:fs';
import { isContestFreeze } from './freeze-guard.js';

export const PLAY_URL_ENV = 'PLAY_URL';
export const PLAY_URL_PLACEHOLDER = '{{PLAY_URL}}';
/** The public Pages build (the ONE playable link, Legal 13.1 (a)) at its custom domain (item 1, live 2026-10-10; the old
    myposseai.github.io address redirects here). Override with env PLAY_URL. */
export const DEFAULT_PLAY_URL = 'https://play.kawaiicatattack.com/';
export const COMMIT_ENVS = Object.freeze(['KCA_COMMIT', 'GITHUB_SHA']);
export const VERSION_FILE = 'version.json';
export const STAMP_ID = 'build-stamp';
/** The element as it sits in vr/index.html (one line; the frozen cut matches the whole line). */
export const STAMP_PLACEHOLDER_RE = /<p id="build-stamp" hidden><\/p>/g;
export const PLACEHOLDER_LEFT_RE = /\{\{[A-Za-z_]+\}\}/;
export const PKG_URL = new URL('../package.json', import.meta.url);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** env PLAY_URL (trimmed) or the default; must be a plain https URL with a host, no query / hash (nothing to track). */
export function resolvePlayUrl(env = process.env) {
  const raw = (env && env[PLAY_URL_ENV] ? env[PLAY_URL_ENV] : '').trim() || DEFAULT_PLAY_URL;
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error(`build-stamp: ${PLAY_URL_ENV} is not a URL: ${JSON.stringify(raw)}`); }
  if (u.protocol !== 'https:' || !u.hostname || u.search || u.hash || u.username || u.password) {
    throw new Error(`build-stamp: ${PLAY_URL_ENV} must be a plain https://host/path URL (no query, hash or credentials), got ${JSON.stringify(raw)}`);
  }
  return u.href;
}

/** "https://host/path/" -> "host/path" (what a player types into the headset browser; no scheme, no trailing slash). */
export function displayPlayUrl(url) {
  return String(url).replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Fill every {{PLAY_URL}} (at least one must exist) with the display form, HTML-escaped. */
export function fillPlayUrl(html, url) {
  const n = html.split(PLAY_URL_PLACEHOLDER).length - 1;
  if (n < 1) throw new Error(`build-stamp: ${PLAY_URL_PLACEHOLDER} not found in index.html (the flat preview card needs it)`);
  return html.split(PLAY_URL_PLACEHOLDER).join(esc(displayPlayUrl(url)));
}

/** Short commit hash from the env (7 chars; a 40-hex sha is trimmed), else the fallback. Never a message / author / branch. */
export function shortCommit(env = process.env, fallback = 'local') {
  for (const k of COMMIT_ENVS) {
    const v = env && typeof env[k] === 'string' ? env[k].trim() : '';
    if (/^[0-9a-f]{7,40}$/i.test(v)) return v.slice(0, 7).toLowerCase();
  }
  return fallback;
}

/** { version, builtAt (ISO, whole seconds, UTC), commit }. */
export function makeStamp({ version, now = Date.now(), env = process.env, commit } = {}) {
  const v = version ?? JSON.parse(readFileSync(PKG_URL, 'utf8')).version;
  if (typeof v !== 'string' || !v) throw new Error('build-stamp: package.json version missing');
  const builtAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { version: v, builtAt, commit: commit ?? shortCommit(env) };
}

/** "build 0.0.1 · a1b2c3d · 2026-10-10 08:12 UTC" */
export function stampLabel(stamp) {
  const t = stamp.builtAt.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC');
  return `build ${stamp.version} · ${stamp.commit} · ${t}`;
}

/** The visible stamp line (data attributes for dev-update.js, text for testers). Exactly one placeholder element must exist. */
export function injectStamp(html, stamp) {
  const n = (html.match(STAMP_PLACEHOLDER_RE) || []).length;
  if (n !== 1) throw new Error(`build-stamp: expected exactly one <p id="build-stamp" hidden></p> in index.html, found ${n}`);
  const el = `<p id="${STAMP_ID}" data-version="${esc(stamp.version)}" data-built-at="${esc(stamp.builtAt)}" data-commit="${esc(stamp.commit)}">${esc(stampLabel(stamp))}</p>`;
  return html.replace(STAMP_PLACEHOLDER_RE, el);
}

/** Throws if any {{NAME}} is left on the page (a placeholder nobody filled). */
export function assertNoPlaceholders(html) {
  const m = html.match(PLACEHOLDER_LEFT_RE);
  if (m) throw new Error(`build-stamp: unfilled placeholder ${m[0]} left in index.html`);
  return html;
}

export const versionJson = (stamp) => JSON.stringify({ version: stamp.version, builtAt: stamp.builtAt, commit: stamp.commit }, null, 2) + '\n';

/**
 * Vite plugin. Build: stamp + version.json (dev build) or neither (frozen); {{PLAY_URL}} always. Dev server: stamp with
 * commit 'dev' and /version.json from memory (so the toast code path and the CI smoke see a 200, never a 404).
 */
export function buildStampPlugin({ env = process.env, now, freeze, log = console.log } = {}) {
  let frozen = freeze === true;
  let command = 'build';
  let stamp = null;
  return {
    name: 'kca-build-stamp',
    configResolved(config) {
      command = config.command;
      frozen = freeze ?? isContestFreeze({ mode: config.mode, env, outDir: config.build?.outDir });
      stamp = frozen ? null : makeStamp({ now, env, commit: command === 'serve' ? 'dev' : undefined });
    },
    transformIndexHtml: {
      order: 'post', // after kca-feedback-qr (which, frozen, cuts the stamp element + the dev-update script first)
      handler(html) {
        let out = fillPlayUrl(html, resolvePlayUrl(env));
        if (!frozen) out = injectStamp(out, stamp);
        return assertNoPlaceholders(out);
      },
    },
    generateBundle() {
      if (frozen || command !== 'build') return;
      this.emitFile({ type: 'asset', fileName: VERSION_FILE, source: versionJson(stamp) });
      log(`kca-build-stamp: ${stampLabel(stamp)} -> ${VERSION_FILE}`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!stamp || (req.url || '').split('?')[0] !== '/' + VERSION_FILE) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(versionJson(stamp));
      });
    },
  };
}

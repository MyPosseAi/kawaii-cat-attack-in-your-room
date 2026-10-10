/* vr/src/dev-update.js - DEV / TRY-IT-OUT BUILDS ONLY. The headset auto-update check (ALL HANDS P0a section C.2; Legal
   item 2 / TRY-IT-OUT-SCOPE.md 13.11 row 2): once a minute GET ./version.json (same origin, cache 'no-store', no query,
   no headers, no body, no cookies, nothing written to storage) and compare it with the build stamp this page was built with
   (#build-stamp data attributes, written by src/build-stamp.js). A newer build shows ONE toast, "New build ready, tap to
   reload", only BETWEEN ROUNDS: never while `setPlaying(true)` is on (GE2 flips it from main.js when a round / countdown /
   safety moment starts and off when it ends; a build found mid-play waits for the next setPlaying(false)). Tap = reload.
   Toast and stamp fade (300 ms opacity, no flash, no motion).
   This file is its own <script type="module"> entry in vr/index.html, NOT imported by main.js, so the frozen contest entry
   (`npm run build:freeze`) drops it by cutting that script tag (src/freeze-guard.js FREEZE_CUTS); the frozen scan then fails
   on 'dev-update' / 'version.json' / 'New build' / 'build-stamp' anywhere in dist-freeze/ (zero-network entry, / 13.6).
   The ONLY network call in vr/src: vr/test/network-allowlist.test.mjs allows exactly this fetch of exactly this path
   (vr/test/network-allowlist.json entry kind 'dev'), and nothing else.
   For GE2: window.__kcaDevUpdate.setPlaying(bool) (optional chaining: it is absent in the frozen build), or
   window.dispatchEvent(new CustomEvent('kca:playing', { detail: { playing: true } })); 'kca:new-build' fires (once) when a
   newer build is found, in case the head-locked card wants its own between-rounds line.
   Gaming Engineer 4, 2026-10-10. */

export const VERSION_PATH = './version.json';
export const POLL_MS = 60_000;
export const TOAST_TEXT = 'New build ready, tap to reload';
export const TOAST_ID = 'dev-update-toast';
export const STAMP_ID = 'build-stamp';
export const PLAYING_EVENT = 'kca:playing';
export const NEW_BUILD_EVENT = 'kca:new-build';

/** { version, builtAt, commit } from the #build-stamp element's data attributes (null when the page has no stamp). */
export function readStamp(el) {
  if (!el || !el.dataset) return null;
  const { version, builtAt, commit } = el.dataset;
  if (!version || !builtAt) return null;
  return { version, builtAt, commit: commit || '' };
}

/** A well-formed version.json body: version + builtAt strings (commit optional). */
export function isStamp(x) {
  return !!x && typeof x === 'object' && typeof x.version === 'string' && typeof x.builtAt === 'string' && (x.commit === undefined || typeof x.commit === 'string');
}

/** True when `remote` was built after `current` (ISO UTC strings compare as text), or same time but another commit. */
export function isNewerBuild(current, remote) {
  if (!isStamp(current) || !isStamp(remote)) return false;
  if (remote.builtAt > current.builtAt) return true;
  return remote.builtAt === current.builtAt && !!remote.commit && !!current.commit && remote.commit !== current.commit;
}

/**
 * The poller as plain data (node-tested with fakes). `fetchFn(url, init)` is the only outside call; it is given exactly
 * VERSION_PATH and { cache: 'no-store', credentials: 'omit' }. Errors and non-200s are swallowed (next poll in a minute).
 */
export function createDevUpdate({ stamp, fetchFn, intervalMs = POLL_MS, onNewBuild = () => {}, onToast = () => {}, timers = globalThis } = {}) {
  const state = { playing: false, pending: null, shown: false, polls: 0, timer: null, disposed: false };
  const maybeShow = () => {
    if (state.pending && !state.playing && !state.shown) { state.shown = true; onToast(state.pending); }
  };
  async function poll() {
    if (state.disposed || !stamp || state.pending) return state.pending;
    state.polls++;
    try {
      const res = await fetchFn(VERSION_PATH, { cache: 'no-store', credentials: 'omit' });
      if (!res || !res.ok) return null;
      const body = await res.json();
      if (isNewerBuild(stamp, body)) {
        state.pending = { version: body.version, builtAt: body.builtAt, commit: body.commit || '' };
        onNewBuild(state.pending);
        maybeShow();
      }
    } catch (e) { /* offline, 404, bad JSON: try again next minute */ }
    return state.pending;
  }
  function setPlaying(on) { state.playing = !!on; if (!state.playing) maybeShow(); }
  function start() {
    if (state.timer || state.disposed || !stamp) return;
    state.timer = timers.setInterval(() => { poll(); }, intervalMs);
  }
  function dispose() { state.disposed = true; if (state.timer) { timers.clearInterval(state.timer); state.timer = null; } }
  return { poll, setPlaying, start, dispose, get playing() { return state.playing; }, get pending() { return state.pending; }, get shown() { return state.shown; }, get polls() { return state.polls; } };
}

/* ---------- page glue (skipped under node and on a page without the stamp, i.e. the frozen build) ---------- */
function mount() {
  if (typeof document === 'undefined' || typeof fetch !== 'function') return null;
  const stamp = readStamp(document.getElementById(STAMP_ID));
  if (!stamp) return null;
  const toast = document.createElement('button');
  toast.id = TOAST_ID; toast.type = 'button'; toast.hidden = true; toast.textContent = TOAST_TEXT;
  toast.addEventListener('click', () => location.reload());
  document.body.appendChild(toast);
  const dev = createDevUpdate({
    stamp,
    fetchFn: (url, init) => fetch(url, init),
    onNewBuild: (b) => window.dispatchEvent(new CustomEvent(NEW_BUILD_EVENT, { detail: b })),
    onToast: () => { toast.hidden = false; requestAnimationFrame(() => toast.classList.add('show')); },
  });
  window.addEventListener(PLAYING_EVENT, (e) => dev.setPlaying(!!(e.detail && e.detail.playing)));
  window.__kcaDevUpdate = { setPlaying: dev.setPlaying, stamp, get pending() { return dev.pending; } };
  dev.start();
  return dev;
}
mount();

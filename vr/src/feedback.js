/* vr/src/feedback.js - "Send feedback" link + QR on the 2D start card (vr/index.html) ONLY. Legal,
   legal/TRY-IT-OUT-SCOPE.md sections 4 and 8 (Safe if: plain text link on the 2D start/end page, never in the immersive
   scene, no logo / badge / image, QR generated at build time from the plain Issues URL, no QR web service, no tracking
   parameters, caption word for word). The game sends NOTHING: this module runs at BUILD time (vite.config.js ->
   feedbackPlugin -> transformIndexHtml); the page makes no request until the player taps the link (target=_blank).
   Nothing here is imported by the runtime (vr/src/main.js and friends); vr/test/network-allowlist.test.mjs enforces it.
   DEV / TRY-IT-OUT ONLY (product owner, 2026-10-09): the frozen contest entry (`npm run build:freeze` = vite mode contest-freeze, or env
   KCA_CONTEST_FREEZE=1) ships NO link, NO QR, no Issues URL: see src/freeze-guard.js (cuts + post-build dist scan).
   Gaming Engineer 2, 2026-10-09. */
import { readFileSync } from 'node:fs';
import { qrSvg } from './qr.js';
// freeze: the link + QR are dev / Try-it-out only; the frozen entry build (mode contest-freeze) strips them instead.
import { isContestFreeze, freezeIndexHtml } from './freeze-guard.js';

/** The ONE place the Issues URL lives: vr/feedback.config.json { "issuesUrl": "" }. Ops fills it in for the public copy
 *  (ops/PUBLIC-REPO.md): the public GitHub Issues "new issue" chooser of the public repo, plain, no ?query, no #hash, no
 *  tracking parameters. Empty or a [BRACKET] value is a placeholder: the dev server warns, `vite build` FAILS. */
export const FEEDBACK_CONFIG_URL = new URL('../feedback.config.json', import.meta.url);
export const FEEDBACK_PLACEHOLDER = '[ISSUES_URL]';
export const FEEDBACK_LABEL = 'Send feedback';
export const QR_CAPTION = 'Scan to send feedback (opens a public GitHub page)';
export const FEEDBACK_MARKER = '<!-- feedback -->';
/** Plain https GitHub "new issue" chooser page: https://github.com/<owner>/<repo>/issues/new/choose; nothing else is accepted at build. */
export const ISSUES_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/new\/choose$/;

/** Read feedback.config.json (the one config value). Returns the raw string ('' when unset). */
export function loadFeedbackUrl(configUrl = FEEDBACK_CONFIG_URL) {
  const cfg = JSON.parse(readFileSync(configUrl, 'utf8'));
  if (typeof cfg.issuesUrl !== 'string') throw new Error('feedback: feedback.config.json must have a string "issuesUrl"');
  return cfg.issuesUrl.trim();
}

export const isPlaceholder = (url) => url === '' || url == null || /^\[.*\]$/.test(url);

/** 'placeholder' for an unset / [BRACKET] value; 'ok' for the one accepted URL shape; throws for anything else. */
export function checkFeedbackUrl(url) {
  if (isPlaceholder(url)) return 'placeholder';
  if (!ISSUES_URL_RE.test(url)) throw new Error(`feedback: issuesUrl must be the plain public GitHub Issues page https://github.com/<owner>/<repo>/issues/new/choose (no query / hash / tracking), got ${JSON.stringify(url)}`);
  return 'ok';
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The start-card block: one plain <a> (opens in a new tab only when tapped; no prefetch, no widget, no image) + the
 *  build-time QR of the same URL with Legal's caption. strict (the default, = `vite build`): a placeholder FAILS.
 *  strict: false (dev server only): a placeholder warns and the literal [ISSUES_URL] text is drawn instead. */
export function feedbackHtml(url, { strict = true, warn = console.warn } = {}) {
  if (checkFeedbackUrl(url) === 'placeholder') {
    if (strict) throw new Error('feedback: issuesUrl in vr/feedback.config.json is not set (placeholder). The production build refuses to ship a placeholder link / QR; fill in the public GitHub Issues URL.');
    warn('[kca-feedback-qr] issuesUrl in vr/feedback.config.json is not set; dev server only, NOT for the public copy.');
    url = FEEDBACK_PLACEHOLDER;
  }
  const link = `<a id="feedback" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${FEEDBACK_LABEL}</a>`;
  const qr = qrSvg(url, { label: QR_CAPTION, className: 'qr' });
  return `${link}\n      <figure id="feedback-qr">${qr}<figcaption>${esc(QR_CAPTION)}</figcaption></figure>`;
}

/** Replace the single marker in index.html with the block. Throws if the marker is missing or appears twice. */
export function injectFeedback(html, url, opts) {
  const n = html.split(FEEDBACK_MARKER).length - 1;
  if (n !== 1) throw new Error(`feedback: expected exactly one ${FEEDBACK_MARKER} marker in index.html, found ${n}`);
  return html.replace(FEEDBACK_MARKER, feedbackHtml(url, opts));
}

/** Vite plugin (build + dev server): draws the link and QR into index.html. `vite build` fails on a placeholder or any
 *  URL that is not https://github.com/<owner>/<repo>/issues/new/choose; the dev server (command 'serve') only warns.
 *  Frozen build (`freeze` option, else Vite mode 'contest-freeze' / env KCA_CONTEST_FREEZE=1 / outDir dist-freeze): the marker,
 *  the WIP line and the privacy feedback sentence are CUT and Legal's frozen + hosting lines added instead (src/freeze-guard.js);
 *  feedback.config.json is not even read. */
export function feedbackPlugin({ configUrl = FEEDBACK_CONFIG_URL, warn = console.warn, freeze } = {}) {
  let command = 'build'; // fail closed until Vite tells us otherwise
  let frozen = freeze === true;
  return {
    name: 'kca-feedback-qr',
    configResolved(config) {
      command = config.command;
      frozen = freeze ?? isContestFreeze({ mode: config.mode, outDir: config.build?.outDir });
    },
    transformIndexHtml(html) {
      if (frozen) return freezeIndexHtml(html);
      return injectFeedback(html, loadFeedbackUrl(configUrl), { strict: command !== 'serve', warn });
    },
  };
}

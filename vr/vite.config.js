// KCA VR - Vite config. Mirrors the IWSDK 1.0.1 example layout
// (examples/scene-understanding/vite.config.ts): iwsdkDev() takes NO options when
// iwsdk.config.json exists (the plugin rejects a competing emulator config).
// iwsdkDev() also serves HTTPS (basic-ssl) because WebXR needs a secure origin.
import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// Build-time 'Send feedback' link + QR on the start card (Legal); no runtime code, no network.
import { feedbackPlugin } from './src/feedback.js';
// Legal (TRY-IT-OUT-SCOPE.md section 12): @drawcall/uikitml (pulled in by @iwsdk/core's spatial-UI system) has no licence.
// We use no UIKitML panels, so the package is aliased to our own stub and the build fails if its code reaches dist/.
import { uikitmlAlias, uikitmlGuardPlugin } from './src/uikitml-guard.js';
// IWER (the dev-only WebXR emulator) is injected by iwsdkDev() in dev only (iwsdk.config.json: injectOnBuild=false).
// The guard fails the build if the emulator runtime still reaches dist/; CI re-runs it with `node src/iwer-guard.js dist`.
import { iwerGuardPlugin } from './src/iwer-guard.js';
// Contest freeze (Legal 13.6, product owner 2026-10-09): the feedback link + QR are dev / Try-it-out only. `npm run build:freeze`
// (vite mode contest-freeze -> dist-freeze/; env KCA_CONTEST_FREEZE=1 or --outDir dist-freeze also count) swaps in Legal's frozen
// start card in feedbackPlugin, drops the QR paragraph from licenses.txt and fails that build if any feedback / QR / Issues URL /
// WIP string is left in the output (github.com / absolute URLs on the page); CI re-runs `node src/freeze-guard.js dist-freeze`.
// The plugin is inactive (apply=false) for the regular build and the dev server.
import { freezeGuardPlugin } from './src/freeze-guard.js';
// ALL HANDS P0a section C.2 (Legal item 2): the build stamp (#build-stamp corner line: version + short commit + UTC
// time), version.json next to index.html for the dev-only once-a-minute check in src/dev-update.js (its own <script> entry
// in index.html, never imported by main.js), and the flat preview card's address ({{PLAY_URL}} <- env PLAY_URL, default
// the Pages URL, shown without a scheme). Frozen build: no stamp, no version.json (freezeIndexHtml cuts the element, the
// script tag, the dev CSS and the dev start-card sentence; the dev-only text + file fail the frozen scan). Runs 'post'.
// Cache-busting: Vite's default output names are assets/[name]-[hash].js / [ext], so every build changes every asset URL
// and only index.html itself can be stale; GitHub Pages cannot set headers (index.html carries no-cache metas, best effort).
import { buildStampPlugin } from './src/build-stamp.js';

const VR_DIR = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [iwsdkDev(), feedbackPlugin(), uikitmlGuardPlugin(), iwerGuardPlugin(), freezeGuardPlugin(), buildStampPlugin()],
  resolve: { alias: uikitmlAlias() },
  // Relative base: the build works from any sub-path (e.g. a GitHub Pages project site).
  base: './',
  publicDir: 'public',
  server: {
    // Default `npm run dev` = this machine only (localhost). LAN mode for the Quest on YOUR OWN
    // Wi-Fi is opt-in: `npm run dev:lan` (= vite --host 0.0.0.0; the CLI flag overrides this).
    host: 'localhost',
    fs: {
      strict: true,
      // Only the vr/ folder (this config's folder, incl. vr/node_modules) and game/core (the room sim imported by
      // src/room-bridge.js) are served. NEVER '..' as a whole.
      allow: [VR_DIR, fileURLToPath(new URL('../game/core', import.meta.url))],
      // Belt and braces (replaces Vite's default list, so the defaults are repeated here).
      deny: [
        '.env', '.env.*', '**/.env*',
        '*.{crt,pem}', '**/*.pem', '**/*.key',
        '**/*token*', '**/*webhook*',
        '**/ops/**', '**/.git/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // entry build: no source maps, even for a local `npm run build`
    target: 'esnext',
    // index.html carries two module entries (src/main.js and the dev-only src/dev-update.js); Vite hashes both (default
    // assets/[name]-[hash].js). version.json (emitted by buildStampPlugin) and public/ files keep their plain names.
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    esbuildOptions: { target: 'esnext' },
  },
});

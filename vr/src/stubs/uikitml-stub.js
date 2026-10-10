// vr/src/stubs/uikitml-stub.js - stand-in for the npm package "@drawcall/uikitml" (Legal, legal/TRY-IT-OUT-SCOPE.md
// section 12). That package ships with NO licence, so it may not be redistributed in our public build. @iwsdk/core's UI
// system (dist/ui/uikitml.js) imports { instantiate, resolveKitComponentSets, parse } from it, and @iwsdk/core marks
// dist/ui/** as side-effectful, so the import survives tree-shaking even though this app creates no PanelUI entity and
// loads no UIKitML asset (vr/src imports only createSystem / World / XRPlane). vite.config.js aliases the package to this
// file (src/uikitml-guard.js), so the real package never enters dist/. Every export throws, but only when CALLED: nothing
// runs at import time, so the scene starts exactly as before. Original work for Kawaii Cat Attack!!.
export const STUB_MARKER = 'kca-ui-panel-stub';

function notShipped(name) {
  return function uikitmlNotShipped() {
    throw new Error(
      `${STUB_MARKER}: ${name}() was called, but the spatial-UI markup engine is not part of this build ` +
      '(unlicensed dependency kept out on purpose). Remove the PanelUI entity / UI asset that needs it.',
    );
  };
}

// The three names @iwsdk/core 1.0.1 imports:
export const parse = notShipped('parse');
export const instantiate = notShipped('instantiate');
export const resolveKitComponentSets = notShipped('resolveKitComponentSets');
// The rest of the real package's public surface (dist/index.js), so any other consumer fails loudly instead of at link time:
export const generate = notShipped('generate');
export const convertToReact = notShipped('convertToReact');
export const convertToThree = notShipped('convertToThree');
export const htmlComponentSet = notShipped('htmlComponentSet');
export const horizonComponentSet = notShipped('horizonComponentSet');
export const lucideComponentSet = notShipped('lucideComponentSet');
export const fontFamilyNames = Object.freeze([]);

# Kawaii Cat Attack!! In Your Room

**Work in progress: updated until November 14, 2026.**

**Contest freeze:** the last update is on November 14, 2026, tagged `contest-v1.0`. From November 18, 2026, 12:00 PT until the contest winners are announced, nothing in this repository or on the game page changes.

Kawaii Cat Attack!! In Your Room, a mixed-reality cat game for Meta Quest 3, contest entry.

A box of kittens arrives in your real room. They explore your floor, hop onto your couch and bed, play,
and finally curl up for a nap. Everything runs in the Quest Browser (WebXR passthrough), so there is nothing to install.

## Try it out
https://myposseai.github.io/kawaii-cat-attack-in-your-room/

## How to play
1. Put on your Meta Quest 3 and open the link above in the **Quest Browser**.
2. Press **Enter your room** and allow the passthrough / room permissions the browser asks for.
3. Play with your hands (controllers work too):
   - **Pinch the box flaps** to open the box.
   - **Pet a kitten:** stroke her back slowly with an open hand.
   - **Pick one up:** pinch the scruff of her neck.
   - **Laser dot:** point your finger and the kittens chase the red dot.
   - **Feather wand:** pinch the wand from the basket, then wiggle it.
   - **Treat:** hold your palm up, flat and still.
4. When the kittens get sleepy, let them nap. Come back tomorrow: they remember you.

## Privacy
Your room and hand data stay on your headset. The game records nothing and sends nothing. Only the day of your last visit, how many visits you've made, and each kitten's hearts, the visit you met it on and its favourite kind of nap spot (like bed, couch or floor) are saved, in this headset's browser, so the kittens can remember you tomorrow. Feedback only goes out if you tap Send feedback, which opens a public GitHub page; anything you post there is public.

This page is hosted on GitHub Pages. GitHub sees normal web request data (like your IP address) when your browser loads it, under GitHub's Privacy Statement. We don't run analytics or cookies here.

## Feedback
Found a bug, have an idea, or want to tell us how it went? Open an issue: https://github.com/MyPosseAi/kawaii-cat-attack-in-your-room/issues/new/choose
Anything you post there is public. 13+ only, and please don't post personal info (yours or anyone else's).

## Licence
Copyright (c) 2026 HeatSeeker LLC. All rights reserved.
The code and art in this repository are shared for viewing only, as part of a contest entry. See [LICENSE](LICENSE).

This repository is a published copy of the contest build. Development history is kept privately and can be shown to the contest organisers on request.

## Credits and third-party licences
The cat art, code and text are original work for Kawaii Cat Attack!!
This game uses the open-source software below, each under the MIT License (full text in
[vr/public/licenses.txt](vr/public/licenses.txt), which also lists every package bundled into the build; also linked from the game page as "Credits & licences").

```
This page uses the open-source software below. Each is under the MIT License (full text at the end).

1. Immersive Web SDK (IWSDK): @iwsdk/core 1.0.1 (shipped in this build)
   Copyright (c) Meta Platforms, Inc. and affiliates.
   https://github.com/facebook/immersive-web-sdk

2. IWER - Immersive Web Emulation Runtime (DEV ONLY: used on the developer's computer through
   @iwsdk/vite-plugin-dev 1.0.1; NOT included in this build)
   Copyright (c) Meta Platforms, Inc. and affiliates.
   https://github.com/meta-quest/immersive-web-emulator

3. three.js, as the "super-three" 0.181.0 package (shipped in this build)
   Copyright (c) 2010-2025 three.js authors
   https://github.com/mrdoob/three.js

4. Vite 7.3.7 (build tool; a small Vite helper (module preload) may be included in the built page)
   Copyright (c) 2019-present, VoidZero Inc. and Vite contributors
   https://github.com/vitejs/vite
```

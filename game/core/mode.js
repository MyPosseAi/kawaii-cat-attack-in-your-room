/* game/core/mode.js — game-mode state machine + safety rails (the part that is pure logic).
   States: off -> countdown -> playing <-> paused(exit overlay) ; finished ; exited.
   RULES: Esc (or the second hotkey, or Start on a pad, or the always-visible Exit button) must get the
   player OUT from ANY state: first press opens the exit overlay (paused), a second press or "Exit game" confirms.
   forceExit(reason) (watchdog timeout, lock/sleep, blur to a system dialog, crash) exits immediately from any state.
   Real click capture / global shortcuts live in Dev 1's Electron main process (game/HANDOFF-DEV1.md); this machine
   only decides WHEN the capture layer may be on: captureAllowed() is true only in countdown/playing/paused/finished.
   Focus rule (2026-10-08): a focus loss PAUSES the round, it never quits it. 'blur' (the page lost
   focus) and 'blur-system' (the host saw another app / a system dialog take focus) both pause a countdown/playing round;
   'blur-system' also marks the pause as a SOFT RELEASE (softReleased() true): the host gives the mouse back (click-through)
   but keeps the view, the page shows a 'Click to resume' card, and resume() re-begins with a fresh countdown so nobody
   loses a race to a toast. Lock / suspend / shutdown / display-change still exit at once (the rails). Before 2026-10-08
   'blur-system' exited; no host sent it to the page (desktop capture.js releases on its own), so this is inert until
   Dev 1's host half (capture.js 'soft release' + forwarding) lands. */
export const MODE_STATES = Object.freeze(['off', 'countdown', 'playing', 'paused', 'finished', 'exited']);
export const SECOND_HOTKEY = Object.freeze({ ctrl: true, shift: true, code: 'KeyP' }); // Ctrl+Shift+P (spec section 5)

export function createModeMachine({ watchdogMs = 3000, countdownMs = 1500 } = {}) {
  const m = {
    state: 'off', stateMs: 0, exitReason: null, lastHeartbeatMs: 0, watchdogMs, countdownMs, log: [],
    /** why the round is paused: 'user' (Esc / Exit button / host escape) | 'blur' (page focus lost) | 'blur-system'
        (another app has focus: soft release) | null when not paused */
    pauseReason: null, pausedFrom: null,
    captureAllowed() { return m.state === 'countdown' || m.state === 'playing' || m.state === 'paused' || m.state === 'finished'; },
    indicator() { return m.captureAllowed() ? 'Game mode on · Esc to leave' : ''; },
    start() { if (m.state === 'off' || m.state === 'exited' || m.state === 'finished') go(m, 'countdown'); return m.state; },
    /** Esc / second hotkey / Start / Exit button. */
    escape() {
      switch (m.state) {
        case 'off': return m.state;
        case 'paused': return exit(m, 'user');
        case 'exited': return m.state;
        default: return pause(m, 'user');
      }
    },
    /** Resume button / 'Click to resume' card / tray 'Resume game'. After a soft release ('blur-system': the player was
        in another app) the round restarts its countdown, so the player gets 1.5 s to find the cat again; an Esc or page
        'blur' pause resumes at once, exactly as before (unchanged 0.1.3 behaviour). */
    resume() {
      if (m.state !== 'paused') return m.state;
      return go(m, m.pauseReason === 'blur-system' ? 'countdown' : 'playing');
    },
    /** True while the host should keep the mouse released (click-through) but the game view up: paused by 'blur-system'. */
    softReleased() { return m.state === 'paused' && m.pauseReason === 'blur-system'; },
    /** "Exit game" button on the overlay, or any guard rail. Works from every state. */
    forceExit(reason = 'user') { return exit(m, reason); },
    finish() { if (m.state === 'playing') go(m, 'finished'); return m.state; },
    /** Renderer heartbeat (call every frame). The host's watchdog (Electron main) calls heartbeat() when it hears one. */
    heartbeat() { m.lastHeartbeatMs = 0; },
    /** Advance timers; returns the state. The watchdog fires if no heartbeat for watchdogMs while capturing. */
    tick(dtMs) {
      m.stateMs += dtMs;
      if (m.captureAllowed()) {
        m.lastHeartbeatMs += dtMs;
        if (m.lastHeartbeatMs > m.watchdogMs) return exit(m, 'watchdog');
      }
      if (m.state === 'countdown' && m.stateMs >= m.countdownMs) go(m, 'playing');
      return m.state;
    },
    /** OS-level events the host forwards: 'lock' | 'suspend' | 'shutdown' | 'display-change' -> release immediately
        (display-change = a monitor was removed / metrics changed: the capture layer may no longer cover the right area, so leave; Code Review NIT 2).
        'blur' | 'blur-system' -> PAUSE, never exit (SK-BUG-20). A 'blur-system' on a round that is already paused
        (Esc card open) upgrades it to a soft release; on 'off' / 'finished' / 'exited' a blur changes nothing. */
    systemEvent(kind) {
      if (kind === 'lock' || kind === 'suspend' || kind === 'shutdown' || kind === 'display-change') return exit(m, kind);
      if (kind === 'blur' || kind === 'blur-system') {
        if (m.state === 'playing' || m.state === 'countdown') return pause(m, kind);
        if (m.state === 'paused' && kind === 'blur-system') { m.pauseReason = 'blur-system'; m.log.push('paused:soft'); }
      }
      return m.state;
    },
  };
  return m;
}
function go(m, s) { m.log.push(m.state + '>' + s); if (s !== 'paused') { m.pauseReason = null; m.pausedFrom = null; } m.state = s; m.stateMs = 0; if (s !== 'exited') m.exitReason = null; return s; }
function pause(m, reason) { const from = m.state; go(m, 'paused'); m.pauseReason = reason; m.pausedFrom = from; return 'paused'; }
function exit(m, reason) { if (m.state === 'exited') return m.state; m.exitReason = reason; m.lastHeartbeatMs = 0; return go(m, 'exited'); }

/** True when a KeyboardEvent-like {code, ctrlKey, shiftKey} is Esc or the second hotkey. Host calls this on keydown. */
export function isExitChord(e) {
  if (!e) return false;
  if (e.code === 'Escape') return true;
  return !!(e.ctrlKey && e.shiftKey && e.code === SECOND_HOTKEY.code);
}

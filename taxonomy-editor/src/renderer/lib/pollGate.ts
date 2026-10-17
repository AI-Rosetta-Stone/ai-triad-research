// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251 (PI cost request): the ONE gate every renderer poller goes through. A poller runs only
// while the tab is visible and the user has been active within the idle window. Background tabs
// and idle sessions then make no requests, so the hosted Container App can scale to zero.
//
//   shouldPoll           the pure predicate (visible && recently active)
//   isPollAllowed        the predicate against the live page
//   onPollAllowedChange  notifies when the answer flips (visibility, first input after idle, idle deadline)
//   gatedInterval        a setInterval that exists only while allowed, and fires once when allowed again
//
// Pollers with their own scheduling (healthProbe's backoff chain) use isPollAllowed and
// onPollAllowedChange directly; fixed-interval pollers use gatedInterval. No poller re-implements
// the visibility or idle logic.

/** Polling stops after this long with no user input (t/4251: about 10 minutes). */
export const POLL_IDLE_MS = 10 * 60_000;

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
/** Input events closer together than this don't re-notify subscribers (pointermove is chatty). */
const INPUT_NOTIFY_MIN_GAP_MS = 1_000;

/** The pure predicate: poll only while visible and while the last input is within the idle window. */
export function shouldPoll(visible: boolean, msSinceInput: number, idleMs: number = POLL_IDLE_MS): boolean {
  return visible && msSinceInput < idleMs;
}

let lastInputAt = Date.now(); // a fresh page load counts as activity
let installed = false;
const subscribers = new Set<() => void>();

function notifyAll(): void { for (const evaluate of [...subscribers]) evaluate(); }

function onInput(): void {
  const now = Date.now();
  const gap = now - lastInputAt;
  lastInputAt = now;
  if (gap >= INPUT_NOTIFY_MIN_GAP_MS) notifyAll();
}

function install(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return;
  installed = true;
  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { passive: true, capture: true });
  document.addEventListener('visibilitychange', notifyAll);
}

/** Only an explicitly hidden page stops polling; any other state (incl. legacy 'prerender') polls as before. */
function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** The predicate against the live page. */
export function isPollAllowed(idleMs: number = POLL_IDLE_MS): boolean {
  install();
  return shouldPoll(pageVisible(), Date.now() - lastInputAt, idleMs);
}

/**
 * Calls `listener(allowed)` whenever the answer changes: on a visibility change, on the first input
 * after idling, and when the idle deadline passes. Returns an unsubscribe function.
 */
export function onPollAllowedChange(listener: (allowed: boolean) => void, idleMs: number = POLL_IDLE_MS): () => void {
  install();
  let allowed = isPollAllowed(idleMs);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Re-check the answer, notify on a flip, and (while allowed) re-arm a timer for the idle deadline.
  const evaluate = () => {
    const next = isPollAllowed(idleMs);
    if (next !== allowed) { allowed = next; listener(next); }
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = allowed ? setTimeout(evaluate, Math.max(idleMs - (Date.now() - lastInputAt), 0) + 1) : undefined;
  };

  subscribers.add(evaluate);
  evaluate(); // arms the first idle deadline; `allowed` already holds the current answer, so nothing fires
  return () => {
    subscribers.delete(evaluate);
    if (idleTimer !== undefined) clearTimeout(idleTimer);
  };
}

/**
 * A `setInterval(fn, ms)` that exists only while polling is allowed. The timer is cleared, not
 * skipped, while hidden or idle; becoming allowed again calls `fn` once at once and restarts the
 * interval. Returns a stop function.
 */
export function gatedInterval(fn: () => void, ms: number, idleMs: number = POLL_IDLE_MS): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined; } };
  const startTimer = () => { stopTimer(); timer = setInterval(fn, ms); };

  const unsubscribe = onPollAllowedChange((allowed) => {
    if (allowed) { fn(); startTimer(); } else stopTimer();
  }, idleMs);
  if (isPollAllowed(idleMs)) startTimer();

  return () => { unsubscribe(); stopTimer(); };
}

/** Test seam: reset the module's activity clock and listeners. */
export function __resetPollGateForTests(now: number = Date.now()): void {
  lastInputAt = now;
  subscribers.clear();
}

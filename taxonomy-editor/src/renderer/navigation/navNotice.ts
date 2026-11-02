// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC3: a restored URL whose item no longer exists falls back to the tool's library "with
// a notice". Routes post the notice here; RunToastHost shows it in the shared toast stack. Kept
// as a plain pub/sub (like runningSignal) so routes don't depend on React.

type NavNoticeListener = (text: string) => void;

const listeners = new Set<NavNoticeListener>();

/**
 * Notices posted while nobody is listening. A pasted URL restores at boot, while MainApp is still
 * showing its loading screen — RunToastHost hasn't mounted, so a not-found notice posted then
 * would be lost (found on staging, t/4640 web sweep). Held here and delivered on first subscribe.
 */
let pending: string[] = [];

export function postNavNotice(text: string): void {
  if (listeners.size === 0) {
    pending.push(text);
    return;
  }
  listeners.forEach(listener => listener(text));
}

export function subscribeNavNotice(listener: NavNoticeListener): () => void {
  listeners.add(listener);
  const held = pending;
  pending = [];
  held.forEach(text => listener(text));
  return () => { listeners.delete(listener); };
}

/** Test-only: drop any held notices. */
export function __resetNavNoticeForTest(): void {
  pending = [];
  listeners.clear();
}

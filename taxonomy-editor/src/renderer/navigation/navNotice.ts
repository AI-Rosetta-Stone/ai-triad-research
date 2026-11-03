// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC3: a restored URL whose item no longer exists falls back to the tool's library "with
// a notice". Routes post the notice here; RunToastHost shows it in the shared toast stack. Kept
// as a plain pub/sub (like runningSignal) so routes don't depend on React.

/** How long a notice stays on screen (RunToastHost's auto-dismiss). */
export const NAV_NOTICE_TTL_MS = 8000;

export interface NavNotice {
  id: number;
  text: string;
  postedAt: number;
}

type NavNoticeListener = (notice: NavNotice) => void;

const listeners = new Set<NavNoticeListener>();

/**
 * Notices still inside their display window. Held here, not only in the toast host's state, because
 * the host doesn't live through boot: MainApp first renders the full UI (host mounted), then swaps
 * to its loading screen while loadAll runs (host unmounted), then back. A pasted dead /debate/:id
 * fails fast, so its notice reached the first host and died with it (staging, t/4640#64). Every
 * subscriber — including a remounted host — gets the notices still active.
 */
let active: NavNotice[] = [];
let nextId = 1;

function prune(now: number): void {
  active = active.filter(n => now - n.postedAt < NAV_NOTICE_TTL_MS);
}

export function postNavNotice(text: string): void {
  const notice: NavNotice = { id: nextId++, text, postedAt: Date.now() };
  prune(notice.postedAt);
  active.push(notice);
  listeners.forEach(listener => listener(notice));
}

export function subscribeNavNotice(listener: NavNoticeListener): () => void {
  listeners.add(listener);
  prune(Date.now());
  active.forEach(notice => listener(notice));
  return () => { listeners.delete(listener); };
}

/** The user dismissed it, or it timed out — never replay it to a later subscriber. */
export function dismissNavNotice(id: number): void {
  active = active.filter(n => n.id !== id);
}

/** Test-only: forget every notice and listener. */
export function __resetNavNoticeForTest(): void {
  active = [];
  listeners.clear();
}

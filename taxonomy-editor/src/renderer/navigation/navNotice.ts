// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC3: a restored URL whose item no longer exists falls back to the tool's library "with
// a notice". Routes post the notice here; RunToastHost shows it in the shared toast stack. Kept
// as a plain pub/sub (like runningSignal) so routes don't depend on React.

type NavNoticeListener = (text: string) => void;

const listeners = new Set<NavNoticeListener>();

export function postNavNotice(text: string): void {
  listeners.forEach(listener => listener(text));
}

export function subscribeNavNotice(listener: NavNoticeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

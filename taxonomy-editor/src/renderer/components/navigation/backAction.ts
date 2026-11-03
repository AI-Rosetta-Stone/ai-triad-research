// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { Crumb, HistoryEntry } from '../../navigation/types';

const LABEL_MAX = 60;

const truncate = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/** "Back to {label}" / "Forward to {label}", or plain "Back" / "Forward" with no destination. */
export function historyButtonName(verb: 'Back' | 'Forward', dest: HistoryEntry | undefined): string {
  return dest?.label ? `${verb} to ${truncate(dest.label)}` : verb;
}

/** What the ← button does right now. */
export type BackAction =
  | { kind: 'back'; name: string; enabled: boolean }
  | { kind: 'up'; name: string; href: string };

/**
 * § Phone "up" (docs/ux/navigation-location-bar.md): at phone width only the current crumb shows,
 * so ← does double duty. With nothing to go back to (a deep link, or the first entry) and a linked
 * ancestor on the current place, ← goes UP to that ancestor — enabled, named "Up to {ancestor}".
 * Otherwise it's plain Back.
 */
export function backAction(opts: {
  isPhone: boolean;
  canGoBack: boolean;
  backDest: HistoryEntry | undefined;
  crumbs: Crumb[];
}): BackAction {
  const { isPhone, canGoBack, backDest, crumbs } = opts;
  if (isPhone && !canGoBack) {
    // The nearest linked ancestor: the one closest to the current crumb.
    const up = [...crumbs].reverse().find(c => c.href);
    if (up?.href) return { kind: 'up', name: `Up to ${up.text}`, href: up.href };
  }
  return { kind: 'back', name: historyButtonName('Back', canGoBack ? backDest : undefined), enabled: canGoBack };
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

/**
 * Navigation trace for the flight recorder (t/4769): boot restore, each history write and each
 * history move, so a dump can say which route a pasted URL matched and what the subscriber wrote.
 * Payloads carry ids and paths only — never labels, which can be user-authored titles.
 */
export type NavEvent = 'nav.boot' | 'nav.restore' | 'nav.install' | 'nav.push' | 'nav.replace' | 'nav.move' | 'nav.fallback';

export function recordNav(event: NavEvent, data: Record<string, unknown>, level: 'info' | 'warn' = 'info'): void {
  getGlobalRecorder()?.record({ type: 'state.change', component: 'navigation', level, message: event, data });
}

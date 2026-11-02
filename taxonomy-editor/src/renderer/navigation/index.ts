// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { WebHistory } from './navHistory';
import { MemoryHistory } from './navHistory';
import type { NavHistory } from './types';
import { expectReplace, replaceView } from './subscriber';

// Singleton history instance — Web or Electron
export const navHistory: NavHistory = import.meta.env.VITE_TARGET === 'web'
  ? new WebHistory()
  : new MemoryHistory();

/** Record a view change (camp tab, filter) on the current entry — no Back step. See replaceView. */
export function replaceCurrentView(path: string, placeKey?: string): void {
  replaceView(navHistory, path, placeKey);
}

/** Mark the next arrival at `placeKey` as automatic (auto-open, auto-select): it replaces, no Back step. */
export { expectReplace };

export type { NavHistory, HistoryEntry, PlaceInfo } from './types';

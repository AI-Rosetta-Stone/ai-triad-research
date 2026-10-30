// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { WebHistory } from './navHistory';
import { MemoryHistory } from './navHistory';
import type { NavHistory } from './types';

// Singleton history instance — Web or Electron
export const navHistory: NavHistory = import.meta.env.VITE_TARGET === 'web'
  ? new WebHistory()
  : new MemoryHistory();

export type { NavHistory, HistoryEntry, PlaceInfo } from './types';

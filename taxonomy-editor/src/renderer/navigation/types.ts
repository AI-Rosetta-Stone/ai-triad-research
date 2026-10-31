// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

export interface HistoryEntry {
  path: string;
  placeKey: string;
  label: string;
  scrollTop?: number;
  timestamp: number;
}

export interface NavHistory {
  push(entry: Omit<HistoryEntry, 'timestamp'>): void;
  replace(entry: Omit<HistoryEntry, 'timestamp'>): void;
  back(): void;
  forward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  current(): HistoryEntry | null;
  peekBack(): HistoryEntry | null;
  peekForward(): HistoryEntry | null;
  subscribe(listener: (entry: HistoryEntry) => void): () => void;
}

export interface Crumb {
  label: string;
  placeKey: string;
}

export interface PlaceInfo {
  path: string;
  placeKey: string;
  label: string;
  crumbs: Crumb[];
}

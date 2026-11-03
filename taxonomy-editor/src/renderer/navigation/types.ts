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
  go(delta: number): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  current(): HistoryEntry | null;
  peekBack(): HistoryEntry | null;
  peekForward(): HistoryEntry | null;
  entries(): HistoryEntry[];
  index(): number;
  subscribe(listener: (entry: HistoryEntry) => void): () => void;
}

/** One breadcrumb (docs/ux/navigation-location-bar.md § Breadcrumb). Always a human title, never an id. */
export interface Crumb {
  text: string;
  /** Camp dot before the text. */
  camp?: 'acc' | 'saf' | 'skp';
  /** Set only on an ancestor that leads UP to a different place (§ Clickable breadcrumb). */
  href?: string;
}

/** The tool a place belongs to — picks the bar's leading icon. */
export type PlaceTool =
  | 'rosetta-stone' | 'chat' | 'opeds' | 'inquiry' | 'debate' | 'taxonomy'
  | 'conflicts' | 'cruxes' | 'summaries' | 'validation' | 'organizations';

export interface PlaceInfo {
  path: string;
  placeKey: string;
  /** Short form for tooltips and the Recent menu: the last crumb's text. */
  label: string;
  tool: PlaceTool;
  crumbs: Crumb[];
}

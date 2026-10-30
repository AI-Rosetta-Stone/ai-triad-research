// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { NavHistory, HistoryEntry } from './types';

type NavHistoryListener = (entry: HistoryEntry) => void;

/**
 * WebHistory — backed by window.history + popstate.
 * Stores state in window.history.state with { v, idx, placeKey, label }.
 * Tooltips use a sessionStorage shadow array for labels.
 */
export class WebHistory implements NavHistory {
  private listeners = new Set<NavHistoryListener>();

  constructor() {
    // Listen for browser back/forward (popstate)
    window.addEventListener('popstate', (e) => {
      const state = e.state as { v?: number; idx?: number; placeKey?: string; label?: string } | null;
      if (state?.v === 1 && state.placeKey) {
        const current = this.current();
        if (current) {
          this.listeners.forEach(l => l(current));
        }
      }
    });
  }

  push(entry: Omit<HistoryEntry, 'timestamp'>): void {
    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    const state = { v: 1, idx: (this.current()?.timestamp ?? -1) + 1, placeKey: entry.placeKey, label: entry.label };

    window.history.pushState(state, '', entry.path);
    this.updateLabelShadow(entry.label);
    this.listeners.forEach(l => l(withTimestamp));
  }

  replace(entry: Omit<HistoryEntry, 'timestamp'>): void {
    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    const state = { v: 1, idx: (this.current()?.timestamp ?? -1), placeKey: entry.placeKey, label: entry.label };

    window.history.replaceState(state, '', entry.path);
    this.updateLabelShadow(entry.label);
    this.listeners.forEach(l => l(withTimestamp));
  }

  back(): void {
    if (this.canGoBack()) {
      window.history.back();
    }
  }

  forward(): void {
    if (this.canGoForward()) {
      window.history.forward();
    }
  }

  canGoBack(): boolean {
    const state = window.history.state as { v?: number; idx?: number } | null;
    return state?.v === 1 && (state.idx ?? 0) > 0;
  }

  canGoForward(): boolean {
    // On the web, the browser manages the forward stack internally.
    // We can't detect forward without traversing the history API (which we can't do).
    // For now, assume forward is always available if canGoBack is true.
    // A more robust solution would require the TL's guidance on the web forward detection.
    return false;
  }

  current(): HistoryEntry | null {
    const state = window.history.state as { v?: number; placeKey?: string; label?: string } | null;
    if (state?.v === 1 && state.placeKey) {
      return {
        path: window.location.pathname + window.location.search,
        placeKey: state.placeKey,
        label: state.label ?? 'Unknown',
        timestamp: Date.now(),
      };
    }
    return null;
  }

  peekBack(): HistoryEntry | null {
    // On the web, we can't peek into the history stack safely.
    // Return null to indicate we can't determine the destination.
    return null;
  }

  peekForward(): HistoryEntry | null {
    return null;
  }

  subscribe(listener: NavHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private updateLabelShadow(label: string): void {
    try {
      const idx = (this.current()?.timestamp ?? -1);
      const labels = JSON.parse(sessionStorage.getItem('nav_labels') ?? '[]') as string[];
      labels[idx] = label;
      sessionStorage.setItem('nav_labels', JSON.stringify(labels));
    } catch {
      // Silently fail if sessionStorage is unavailable (e.g., private mode)
    }
  }
}

/**
 * MemoryHistory — in-memory stack for Electron.
 * Stores history in renderer memory; no main-process involvement.
 */
export class MemoryHistory implements NavHistory {
  private entries: HistoryEntry[] = [];
  private currentIndex = -1;
  private listeners = new Set<NavHistoryListener>();

  push(entry: Omit<HistoryEntry, 'timestamp'>): void {
    // Discard forward history when pushing from a non-head position
    this.entries = this.entries.slice(0, this.currentIndex + 1);

    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    this.entries.push(withTimestamp);
    this.currentIndex = this.entries.length - 1;

    this.listeners.forEach(l => l(withTimestamp));
  }

  replace(entry: Omit<HistoryEntry, 'timestamp'>): void {
    if (this.currentIndex < 0) {
      // If we're at the start, push instead
      this.push(entry);
      return;
    }

    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    this.entries[this.currentIndex] = withTimestamp;

    this.listeners.forEach(l => l(withTimestamp));
  }

  back(): void {
    if (this.canGoBack()) {
      this.currentIndex--;
      const entry = this.entries[this.currentIndex];
      if (entry) {
        this.listeners.forEach(l => l(entry));
      }
    }
  }

  forward(): void {
    if (this.canGoForward()) {
      this.currentIndex++;
      const entry = this.entries[this.currentIndex];
      if (entry) {
        this.listeners.forEach(l => l(entry));
      }
    }
  }

  canGoBack(): boolean {
    return this.currentIndex > 0;
  }

  canGoForward(): boolean {
    return this.currentIndex < this.entries.length - 1;
  }

  current(): HistoryEntry | null {
    return this.currentIndex >= 0 ? this.entries[this.currentIndex] ?? null : null;
  }

  peekBack(): HistoryEntry | null {
    if (this.currentIndex > 0) {
      return this.entries[this.currentIndex - 1] ?? null;
    }
    return null;
  }

  peekForward(): HistoryEntry | null {
    if (this.currentIndex < this.entries.length - 1) {
      return this.entries[this.currentIndex + 1] ?? null;
    }
    return null;
  }

  subscribe(listener: NavHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

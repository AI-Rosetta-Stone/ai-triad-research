// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { NavHistory, HistoryEntry } from './types';

type NavHistoryListener = (entry: HistoryEntry) => void;

/**
 * WebHistory — backed by window.history + popstate.
 * Stores state in window.history.state with { v, idx, placeKey, label }.
 * Full stack stored in sessionStorage['nav_stack'] for entries() and index().
 */
export class WebHistory implements NavHistory {
  private listeners = new Set<NavHistoryListener>();
  private static readonly STACK_KEY = 'nav_stack';
  private static readonly INDEX_KEY = 'nav_index';

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
    const stack = this.getStack();
    const currentIdx = this.getIndex();

    // Discard forward history when pushing from a non-head position
    stack.splice(currentIdx + 1);
    stack.push(withTimestamp);

    const newIdx = stack.length - 1;
    const state = { v: 1, idx: newIdx, placeKey: entry.placeKey, label: entry.label };

    window.history.pushState(state, '', entry.path);
    this.saveStack(stack);
    this.saveIndex(newIdx);
    this.listeners.forEach(l => l(withTimestamp));
  }

  replace(entry: Omit<HistoryEntry, 'timestamp'>): void {
    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    const stack = this.getStack();
    const currentIdx = this.getIndex();

    if (currentIdx >= 0) {
      stack[currentIdx] = withTimestamp;
    } else {
      stack.push(withTimestamp);
    }

    const state = { v: 1, idx: currentIdx >= 0 ? currentIdx : 0, placeKey: entry.placeKey, label: entry.label };

    window.history.replaceState(state, '', entry.path);
    this.saveStack(stack);
    this.listeners.forEach(l => l(withTimestamp));
  }

  back(): void {
    if (this.canGoBack()) {
      this.saveIndex(this.getIndex() - 1);
      window.history.back();
    }
  }

  forward(): void {
    if (this.canGoForward()) {
      this.saveIndex(this.getIndex() + 1);
      window.history.forward();
    }
  }

  go(delta: number): void {
    if (delta !== 0) {
      const newIdx = this.getIndex() + delta;
      const stack = this.getStack();
      if (newIdx >= 0 && newIdx < stack.length) {
        this.saveIndex(newIdx);
        window.history.go(delta);
      }
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

  entries(): HistoryEntry[] {
    return this.getStack();
  }

  index(): number {
    return this.getIndex();
  }

  subscribe(listener: NavHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private getStack(): HistoryEntry[] {
    try {
      return JSON.parse(sessionStorage.getItem(WebHistory.STACK_KEY) ?? '[]') as HistoryEntry[];
    } catch {
      return [];
    }
  }

  private saveStack(stack: HistoryEntry[]): void {
    try {
      sessionStorage.setItem(WebHistory.STACK_KEY, JSON.stringify(stack));
    } catch {
      /* telemetry — silent by design */
    }
  }

  private getIndex(): number {
    try {
      return parseInt(sessionStorage.getItem(WebHistory.INDEX_KEY) ?? '0', 10) || 0;
    } catch {
      return 0;
    }
  }

  private saveIndex(idx: number): void {
    try {
      sessionStorage.setItem(WebHistory.INDEX_KEY, String(idx));
    } catch {
      /* telemetry — silent by design */
    }
  }
}

/**
 * MemoryHistory — in-memory stack for Electron.
 * Stores history in renderer memory; no main-process involvement.
 */
export class MemoryHistory implements NavHistory {
  private stack: HistoryEntry[] = [];
  private currentIndex = -1;
  private listeners = new Set<NavHistoryListener>();

  push(entry: Omit<HistoryEntry, 'timestamp'>): void {
    // Discard forward history when pushing from a non-head position
    this.stack = this.stack.slice(0, this.currentIndex + 1);

    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    this.stack.push(withTimestamp);
    this.currentIndex = this.stack.length - 1;

    this.listeners.forEach(l => l(withTimestamp));
  }

  replace(entry: Omit<HistoryEntry, 'timestamp'>): void {
    if (this.currentIndex < 0) {
      // If we're at the start, push instead
      this.push(entry);
      return;
    }

    const withTimestamp: HistoryEntry = { ...entry, timestamp: Date.now() };
    this.stack[this.currentIndex] = withTimestamp;

    this.listeners.forEach(l => l(withTimestamp));
  }

  back(): void {
    if (this.canGoBack()) {
      this.currentIndex--;
      const entry = this.stack[this.currentIndex];
      if (entry) {
        this.listeners.forEach(l => l(entry));
      }
    }
  }

  forward(): void {
    if (this.canGoForward()) {
      this.currentIndex++;
      const entry = this.stack[this.currentIndex];
      if (entry) {
        this.listeners.forEach(l => l(entry));
      }
    }
  }

  go(delta: number): void {
    const newIndex = this.currentIndex + delta;
    if (newIndex >= 0 && newIndex < this.stack.length) {
      this.currentIndex = newIndex;
      const entry = this.stack[this.currentIndex];
      if (entry) {
        this.listeners.forEach(l => l(entry));
      }
    }
  }

  canGoBack(): boolean {
    return this.currentIndex > 0;
  }

  canGoForward(): boolean {
    return this.currentIndex < this.stack.length - 1;
  }

  current(): HistoryEntry | null {
    return this.currentIndex >= 0 ? this.stack[this.currentIndex] ?? null : null;
  }

  peekBack(): HistoryEntry | null {
    if (this.currentIndex > 0) {
      return this.stack[this.currentIndex - 1] ?? null;
    }
    return null;
  }

  peekForward(): HistoryEntry | null {
    if (this.currentIndex < this.stack.length - 1) {
      return this.stack[this.currentIndex + 1] ?? null;
    }
    return null;
  }

  entries(): HistoryEntry[] {
    return [...this.stack];
  }

  index(): number {
    return this.currentIndex;
  }

  subscribe(listener: NavHistoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { MemoryHistory } from './navHistory';
import type { HistoryEntry } from './types';

describe('MemoryHistory', () => {
  describe('push and back', () => {
    it('pushes a new entry and allows back navigation', () => {
      const history = new MemoryHistory();
      const listener = { calls: [] as HistoryEntry[] };
      history.subscribe((entry) => listener.calls.push(entry));

      // Push entry 1
      history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
      expect(history.canGoBack()).toBe(false);
      expect(history.canGoForward()).toBe(false);
      expect(listener.calls).toHaveLength(1);

      // Push entry 2
      history.push({ path: '/opeds', placeKey: 'opeds:none', label: 'Op-Eds' });
      expect(history.canGoBack()).toBe(true);
      expect(history.canGoForward()).toBe(false);
      expect(listener.calls).toHaveLength(2);

      // Back to entry 1
      history.back();
      expect(history.current()?.placeKey).toBe('chat:none');
      expect(history.canGoBack()).toBe(false);
      expect(history.canGoForward()).toBe(true);
    });
  });

  describe('replace', () => {
    it('replaces the current entry without growing the stack', () => {
      const history = new MemoryHistory();
      const listener = { calls: [] as HistoryEntry[] };
      history.subscribe((entry) => listener.calls.push(entry));

      // Push entry 1
      history.push({ path: '/taxonomy/acc', placeKey: 'taxonomy:none', label: 'Taxonomy (Acc)' });
      expect(listener.calls).toHaveLength(1);

      // Replace with POV switch (same placeKey, different path)
      history.replace({ path: '/taxonomy/saf', placeKey: 'taxonomy:none', label: 'Taxonomy (Saf)' });
      expect(listener.calls).toHaveLength(2);
      expect(history.current()?.path).toBe('/taxonomy/saf');

      // Back should go before the first entry (can't go back)
      expect(history.canGoBack()).toBe(false);
    });
  });

  describe('forward after back', () => {
    it('allows forward after navigating back', () => {
      const history = new MemoryHistory();

      history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
      history.push({ path: '/opeds', placeKey: 'opeds:none', label: 'Op-Eds' });
      history.back();

      expect(history.canGoForward()).toBe(true);
      expect(history.current()?.placeKey).toBe('chat:none');

      history.forward();
      expect(history.current()?.placeKey).toBe('opeds:none');
    });
  });

  describe('discard forward after new push', () => {
    it('discards forward history when pushing from a non-head position', () => {
      const history = new MemoryHistory();

      history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
      history.push({ path: '/opeds', placeKey: 'opeds:none', label: 'Op-Eds' });
      history.back();

      expect(history.canGoForward()).toBe(true);

      // Push a new entry from the back position — discards forward
      history.push({ path: '/inquiry', placeKey: 'inquiry:none', label: 'Inquiry' });
      expect(history.canGoForward()).toBe(false);
      expect(history.current()?.placeKey).toBe('inquiry:none');
    });
  });

  describe('peek', () => {
    it('returns the next entry without changing position', () => {
      const history = new MemoryHistory();

      history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
      history.push({ path: '/opeds', placeKey: 'opeds:none', label: 'Op-Eds' });
      history.back();

      expect(history.peekBack()?.placeKey).toBe(undefined); // Can't go back
      expect(history.peekForward()?.placeKey).toBe('opeds:none');
      expect(history.current()?.placeKey).toBe('chat:none'); // Position unchanged
    });
  });

  describe('subscribe and unsubscribe', () => {
    it('notifies subscribers on push/replace/back/forward', () => {
      const history = new MemoryHistory();
      const calls: string[] = [];
      const unsubscribe = history.subscribe((entry) => {
        calls.push(entry.placeKey);
      });

      history.push({ path: '/chat', placeKey: 'chat:none', label: 'Chat' });
      expect(calls).toEqual(['chat:none']);

      unsubscribe();
      history.push({ path: '/opeds', placeKey: 'opeds:none', label: 'Op-Eds' });
      expect(calls).toEqual(['chat:none']); // No new call after unsubscribe
    });
  });
});

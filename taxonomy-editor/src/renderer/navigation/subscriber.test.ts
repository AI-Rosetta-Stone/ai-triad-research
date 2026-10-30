// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installNavSubscriber, setRestoringFlag } from './subscriber';
import { MemoryHistory } from './navHistory';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

// The mock mirrors Zustand's plain subscribe(listener) — the only form useTaxonomyStore supports
// (it is not created with subscribeWithSelector). A mock with a (selector, listener) signature
// let a dead subscriber pass these tests before (t/4640, #4196).
type Listener = (state: TaxonomyStore, prevState: TaxonomyStore) => void;

describe('installNavSubscriber blockers', () => {
  let history: MemoryHistory;
  let mockStore: {
    subscribe: (listener: Listener) => () => void;
    getState: () => TaxonomyStore;
    state: TaxonomyStore;
    listeners: Set<Listener>;
  };
  const notify = () => mockStore.listeners.forEach(l => l(mockStore.state, mockStore.state));

  beforeEach(() => {
    history = new MemoryHistory();
    mockStore = {
      state: { activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore,
      listeners: new Set(),
      getState: () => mockStore.state,
      subscribe: (listener: Listener) => {
        mockStore.listeners.add(listener);
        return () => { mockStore.listeners.delete(listener); };
      },
    };
  });

  it('blocker 3: boot creates exactly one entry via replace (no-trap rule)', () => {
    installNavSubscriber(mockStore, history);
    expect(history.current()?.placeKey).toBe('rosetta-stone');
    expect(history.canGoBack()).toBe(false);
    expect(history.canGoForward()).toBe(false);
  });

  it('blocker 2: handles async restore without re-growing stack', () => {
    installNavSubscriber(mockStore, history);

    // User navigates to Chat, then Op-Eds
    mockStore.state.activeTab = 'chat';
    notify();
    mockStore.state.activeTab = 'opeds';
    notify();

    // User clicks back (popstate) — history.current() is now chat
    history.back();

    // Async restore: isRestoring is set, store changes fire, then clears
    setRestoringFlag(true);
    mockStore.state.activeTab = 'chat';
    notify();
    setRestoringFlag(false);

    // After restore, an async item open fires (different placeKey).
    // Compares against navHistory.current() = chat, not a stale previousPlace.
    mockStore.state.selectedNodeId = 'conv-1';
    notify();

    // Pushed once for the async open, not for the restore
    expect(history.current()?.placeKey).toBe('chat:conv-1');
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(false);
  });
});

describe('installNavSubscriber real store integration (t/4640 AC7)', () => {
  let unsubscribe: (() => void) | undefined;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = undefined;
  });

  it('setActiveTab pushes history entries through the real store', () => {
    useTaxonomyStore.getState().setActiveTab('rosetta-stone');
    const history = new MemoryHistory();
    unsubscribe = installNavSubscriber(useTaxonomyStore, history);

    // Boot replaces, never pushes
    expect(history.canGoBack()).toBe(false);
    expect(history.canGoForward()).toBe(false);

    useTaxonomyStore.getState().setActiveTab('chat');
    expect(history.current()?.placeKey).toBe('chat:none');
    expect(history.canGoBack()).toBe(true);

    useTaxonomyStore.getState().setActiveTab('opeds');
    expect(history.current()?.placeKey).toBe('opeds:none');

    history.back();
    expect(history.current()?.placeKey).toBe('chat:none');
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(true);
  });
});

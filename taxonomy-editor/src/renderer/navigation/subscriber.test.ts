// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach } from 'vitest';
import { installNavSubscriber, setRestoringFlag } from './subscriber';
import { MemoryHistory } from './navHistory';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import type { PlaceInfo } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

describe('installNavSubscriber blockers', () => {
  let history: MemoryHistory;
  let mockStore: {
    subscribe: (selector: (state: TaxonomyStore) => PlaceInfo, listener: (place: PlaceInfo) => void) => () => void;
    getState: () => TaxonomyStore;
    state: TaxonomyStore;
    listeners: Set<(place: PlaceInfo) => void>;
  };

  beforeEach(() => {
    history = new MemoryHistory();
    mockStore = {
      state: { activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore,
      listeners: new Set(),
      getState: () => mockStore.state,
      subscribe: (selector: (state: TaxonomyStore) => PlaceInfo, listener: (place: PlaceInfo) => void) => {
        mockStore.listeners.add(listener);
        return () => mockStore.listeners.delete(listener);
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

    // User navigates to Chat
    mockStore.state.activeTab = 'chat';
    mockStore.listeners.forEach(l => l({
      path: '/chat',
      placeKey: 'chat:none',
      label: 'Chat',
    }));

    // User navigates to Op-Eds
    mockStore.state.activeTab = 'opeds';
    mockStore.listeners.forEach(l => l({
      path: '/opeds',
      placeKey: 'opeds:none',
      label: 'Op-Eds',
    }));

    // User clicks back (popstate)
    history.back();
    // history.current() now = chat

    // Async restore: isRestoring is set, store changes fire, then clears
    setRestoringFlag(true);
    mockStore.state.activeTab = 'chat';
    mockStore.listeners.forEach(l => l({
      path: '/chat',
      placeKey: 'chat:none',
      label: 'Chat',
    }));
    setRestoringFlag(false);

    // After restore, async item open fires (different placeKey)
    // Blocker 1 fix: compares against navHistory.current() = chat, not stale previousPlace
    mockStore.state.selectedNodeId = 'conv-1';
    mockStore.listeners.forEach(l => l({
      path: '/chat/conv-1',
      placeKey: 'chat:conv-1',
      label: 'Chat: conv-1',
    }));

    // Should have pushed only once for the async open, not for the restore
    expect(history.current()?.placeKey).toBe('chat:conv-1');
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(false);
  });
});

describe('installNavSubscriber real store integration (t/4640 AC7)', () => {
  it('setActiveTab pushes history entry with real store', () => {
    const history = new MemoryHistory();

    // Install subscriber with real store
    installNavSubscriber(useTaxonomyStore, history);

    // Initial state should create one entry with no back/forward
    expect(history.canGoBack()).toBe(false);
    expect(history.canGoForward()).toBe(false);

    // Change activeTab (simulating user navigation)
    useTaxonomyStore.getState().setActiveTab('chat');

    // Should have pushed a new entry
    expect(history.canGoBack()).toBe(true);
    expect(history.current()?.placeKey).toContain('chat');

    // Change to another tab
    useTaxonomyStore.getState().setActiveTab('opeds');

    // Should have pushed again
    expect(history.canGoBack()).toBe(true);
    expect(history.current()?.placeKey).toContain('opeds');

    // Go back
    history.back();

    // Should be at chat
    expect(history.current()?.placeKey).toContain('chat');
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(true);
  });
});

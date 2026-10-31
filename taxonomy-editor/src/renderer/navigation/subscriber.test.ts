// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installNavSubscriber, setRestoringFlag, type NavStores, type SubscribableStore } from './subscriber';
import { MemoryHistory } from './navHistory';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';

// Mocks mirror Zustand's plain subscribe(listener) — the only form these stores support
// (none is created with subscribeWithSelector). A mock with a (selector, listener) signature
// let a dead subscriber pass these tests before (t/4640, #4196).
type MockStore<S> = SubscribableStore<S> & { state: S; notify: () => void };

function mockStore<S>(initial: S): MockStore<S> {
  const listeners = new Set<(state: S, prev: S) => void>();
  const store: MockStore<S> = {
    state: initial,
    getState: () => store.state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify: () => listeners.forEach(l => l(store.state, store.state)),
  };
  return store;
}

type ChatState = NonNullable<NavStores['chat']> extends SubscribableStore<infer S> ? S : never;

describe('installNavSubscriber blockers', () => {
  let history: MemoryHistory;
  let taxonomy: MockStore<TaxonomyStore>;
  let chat: MockStore<ChatState>;

  beforeEach(() => {
    history = new MemoryHistory();
    taxonomy = mockStore({ activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore);
    chat = mockStore({ activeChat: null } as unknown as ChatState);
  });

  it('blocker 3: boot creates exactly one entry via replace (no-trap rule)', () => {
    installNavSubscriber({ taxonomy, chat }, history);
    expect(history.current()?.placeKey).toBe('rosetta-stone');
    expect(history.canGoBack()).toBe(false);
    expect(history.canGoForward()).toBe(false);
  });

  it('blocker 2: handles async restore without re-growing stack', () => {
    installNavSubscriber({ taxonomy, chat }, history);

    // User navigates to Chat, then Op-Eds
    taxonomy.state.activeTab = 'chat' as TaxonomyStore['activeTab'];
    taxonomy.notify();
    taxonomy.state.activeTab = 'opeds' as TaxonomyStore['activeTab'];
    taxonomy.notify();

    // User clicks back (popstate) — history.current() is now chat
    history.back();

    // Async restore: isRestoring is set, store changes fire, then clears
    setRestoringFlag(true);
    taxonomy.state.activeTab = 'chat' as TaxonomyStore['activeTab'];
    taxonomy.notify();
    setRestoringFlag(false);

    // After restore, an async chat open fires in the CHAT store (different placeKey).
    // Compares against navHistory.current() = chat, not a stale previousPlace.
    chat.state = { ...chat.state, activeChat: { id: 'conv-1', topic: 'A chat' } } as unknown as ChatState;
    chat.notify();

    // Pushed once for the async open, not for the restore
    expect(history.current()?.placeKey).toBe('chat:conv-1');
    expect(history.canGoBack()).toBe(true);
    expect(history.canGoForward()).toBe(false);
  });

  it('a change in a tool store (not the taxonomy store) pushes a new place', () => {
    taxonomy.state.activeTab = 'chat' as TaxonomyStore['activeTab'];
    installNavSubscriber({ taxonomy, chat }, history);
    expect(history.current()?.placeKey).toBe('chat:none');

    chat.state = { ...chat.state, activeChat: { id: 'conv-9', topic: 'Opened' } } as unknown as ChatState;
    chat.notify();

    expect(history.current()?.placeKey).toBe('chat:conv-9');
    expect(history.current()?.label).toBe('Opened');
    expect(history.canGoBack()).toBe(true);
  });

  it('the returned function unsubscribes from every store', () => {
    const unsubscribe = installNavSubscriber({ taxonomy, chat }, history);
    unsubscribe();
    taxonomy.state.activeTab = 'opeds' as TaxonomyStore['activeTab'];
    taxonomy.notify();
    chat.notify();
    expect(history.current()?.placeKey).toBe('rosetta-stone');
    expect(history.canGoBack()).toBe(false);
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
    unsubscribe = installNavSubscriber({ taxonomy: useTaxonomyStore }, history);

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

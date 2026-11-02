// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installNavSubscriber, setRestoringFlag, expectReplace, replaceView, type NavStores, type SubscribableStore } from './subscriber';
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

  it('AC2: a POV tab switch on the same selected node replaces, adding no new history entry', () => {
    taxonomy.state = { ...taxonomy.state, activeTab: 'accelerationist', selectedNodeId: 'node-1' } as unknown as TaxonomyStore;
    installNavSubscriber({ taxonomy, chat }, history);
    expect(history.entries()).toHaveLength(1);
    expect(history.current()?.placeKey).toBe('taxonomy:node-1');

    // Same node, different POV tab — placeOf() keys taxonomy places off the node id, not the
    // POV tab, so this must replace (same entry count), not push (t/4640 AC2).
    taxonomy.state = { ...taxonomy.state, activeTab: 'safetyist' } as unknown as TaxonomyStore;
    taxonomy.notify();

    expect(history.entries()).toHaveLength(1);
    expect(history.current()?.path).toBe('/taxonomy/saf?node=node-1');
    expect(history.canGoBack()).toBe(false);
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

describe('history → state and automatic places (t/4640#40 items 5 and 6)', () => {
  let history: MemoryHistory;
  let taxonomy: MockStore<TaxonomyStore>;
  let chat: MockStore<ChatState>;
  let restored: string[];
  /** A fake restorePath: records the path and applies the tab the way a route's restore() would. */
  let restorePath: (path: string) => void;

  const setTab = (tab: string) => {
    taxonomy.state = { ...taxonomy.state, activeTab: tab } as unknown as TaxonomyStore;
    taxonomy.notify();
  };
  const openChat = (id: string, topic = 'A chat') => {
    chat.state = { ...chat.state, activeChat: { id, topic } } as unknown as ChatState;
    chat.notify();
  };

  beforeEach(() => {
    expectReplace(null);
    history = new MemoryHistory();
    taxonomy = mockStore({ activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore);
    chat = mockStore({ activeChat: null } as unknown as ChatState);
    restored = [];
    restorePath = (path) => {
      restored.push(path);
      setRestoringFlag(true);
      const tab = path === '/' ? 'rosetta-stone' : path.split('/')[1];
      taxonomy.state = { ...taxonomy.state, activeTab: tab } as unknown as TaxonomyStore;
      chat.state = { ...chat.state, activeChat: null } as unknown as ChatState;
      taxonomy.notify();
      setRestoringFlag(false);
    };
  });

  it('Back restores the previous place; the subscriber\'s own pushes restore nothing', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    setTab('debate');
    expect(restored).toEqual([]);

    history.back();
    expect(restored).toEqual(['/chat']);
    expect(taxonomy.state.activeTab).toBe('chat');
    // The restore itself added no entry: Forward still leads to Debate.
    expect(history.entries()).toHaveLength(3);
    expect(history.peekForward()?.placeKey).toBe('debate:none');
  });

  it('AC1: Back ×3 walks every place in order — the view follows the URL each step', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    setTab('debate');
    setTab('accelerationist');

    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      history.back();
      seen.push(taxonomy.state.activeTab);
    }
    expect(seen).toEqual(['debate', 'chat', 'rosetta-stone']);
    expect(history.canGoBack()).toBe(false);
  });

  it('AC2: the Chat tab\'s auto-open replaces — one Back step for "open Chat", not two', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    expectReplace('chat:c-newest');
    openChat('c-newest');

    expect(history.entries().map(e => e.placeKey)).toEqual(['rosetta-stone', 'chat:c-newest']);
  });

  it('AC2: Taxonomy\'s auto-select replaces; a user\'s own node click still pushes', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('accelerationist');
    expectReplace('taxonomy:n-1');
    taxonomy.state = { ...taxonomy.state, selectedNodeId: 'n-1' } as unknown as TaxonomyStore;
    taxonomy.notify();
    expect(history.entries()).toHaveLength(2);

    taxonomy.state = { ...taxonomy.state, selectedNodeId: 'n-2' } as unknown as TaxonomyStore;
    taxonomy.notify();
    expect(history.entries().map(e => e.placeKey)).toEqual(['rosetta-stone', 'taxonomy:n-1', 'taxonomy:n-2']);
  });

  it('an expectation the user overtakes is dropped — it can\'t turn a later real open into a replace', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    expectReplace('chat:c-1');
    setTab('debate'); // user moves on before c-1 arrives
    setTab('chat');
    openChat('c-1'); // now a real user open
    expect(history.entries().map(e => e.placeKey)).toEqual(['rosetta-stone', 'chat:none', 'debate:none', 'chat:none', 'chat:c-1']);
  });

  it('a restored item\'s async arrival replaces the restored entry, and its title updates the label', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    openChat('c-1', 'First');
    setTab('debate');

    history.back(); // to chat:c-1 — the fake restore leaves the chat unloaded (chat:none)
    expect(history.current()?.placeKey).toBe('chat:c-1');
    openChat('c-1', 'First (renamed)'); // the load lands

    expect(history.entries()).toHaveLength(4);
    expect(history.current()?.placeKey).toBe('chat:c-1');
    expect(history.current()?.label).toBe('First (renamed)');
    expect(history.canGoForward()).toBe(true);
  });

  it('a view query written by replaceView survives later changes in the same place', () => {
    installNavSubscriber({ taxonomy, chat }, history, restorePath);
    setTab('chat');
    openChat('c-1');
    replaceView(history, '/chat/c-1?view=x', 'chat:c-1');
    chat.notify();
    expect(history.current()?.path).toBe('/chat/c-1?view=x');

    replaceView(history, '/chat/other', 'chat:c-9'); // not the current place → ignored
    expect(history.current()?.path).toBe('/chat/c-1?view=x');
  });
});

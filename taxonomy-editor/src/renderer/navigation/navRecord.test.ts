// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4769: a dump from a pasted deep link must show the route matched, the placeKey expected and
// reached, and every history write with its reason. Real MemoryHistory + subscriber; the recorder
// is a spy.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));

const routeRestore = vi.fn();
vi.mock('../routing/appRoutes', () => {
  const route = (id: string, placeKey: string) => ({ id, match: () => null, placeKey: () => placeKey, restore: routeRestore });
  return {
    ROOT_ROUTE: route('rosetta-stone', 'rosetta-stone'),
    findRoute: (pathname: string) => (pathname === '/chat/c-1' ? { route: route('chat-item', 'chat:c-1'), params: { chatId: 'c-1' } } : null),
  };
});

const { installNavSubscriber, expectReplace } = await import('./subscriber');
const { restorePath } = await import('./restore');
const { MemoryHistory } = await import('./navHistory');
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';
import type { SubscribableStore } from './subscriber';

type Mock<S> = SubscribableStore<S> & { state: S; notify: () => void };
function mockStore<S>(initial: S): Mock<S> {
  const listeners = new Set<(s: S, p: S) => void>();
  const store: Mock<S> = {
    state: initial,
    getState: () => store.state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    notify: () => listeners.forEach(l => l(store.state, store.state)),
  };
  return store;
}

const navEvents = () => record.mock.calls.map(([e]) => e).filter(e => e.component === 'navigation');
const named = (message: string) => navEvents().filter(e => e.message === message).map(e => e.data);

beforeEach(() => { record.mockClear(); routeRestore.mockClear(); expectReplace(null); });

describe('navigation flight-recorder trace (t/4769)', () => {
  it('records the boot install and every push/replace with its reason', () => {
    const history = new MemoryHistory();
    const taxonomy = mockStore({ activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore);
    const stop = installNavSubscriber({ taxonomy }, history);

    expect(named('nav.install')).toEqual([expect.objectContaining({ placeKey: 'rosetta-stone', path: '/' })]);
    expect(named('nav.replace')).toEqual([{ from: null, to: 'rosetta-stone', path: '/', reason: 'boot' }]);

    taxonomy.state = { ...taxonomy.state, activeTab: 'chat' } as unknown as TaxonomyStore;
    taxonomy.notify();
    expect(named('nav.push')).toEqual([{ from: 'rosetta-stone', to: 'chat:none', path: '/chat', reason: 'user' }]);

    expectReplace('opeds:none');
    taxonomy.state = { ...taxonomy.state, activeTab: 'opeds' } as unknown as TaxonomyStore;
    taxonomy.notify();
    expect(named('nav.replace').at(-1)).toEqual({ from: 'chat:none', to: 'opeds:none', path: '/opeds', reason: 'expected' });
    stop();
  });

  it('records a history move and whether it restored', () => {
    const history = new MemoryHistory();
    const taxonomy = mockStore({ activeTab: 'rosetta-stone', selectedNodeId: null } as unknown as TaxonomyStore);
    const restore = vi.fn();
    const stop = installNavSubscriber({ taxonomy }, history, restore);
    taxonomy.state = { ...taxonomy.state, activeTab: 'chat' } as unknown as TaxonomyStore;
    taxonomy.notify();

    history.back();
    expect(named('nav.move')).toEqual([{ from: 'chat:none', to: 'rosetta-stone', path: '/', restored: true }]);
    expect(restore).toHaveBeenCalledWith('/');
    stop();
  });

  it('restorePath records the matched route, params and expected placeKey; ids only, no labels', () => {
    restorePath('/chat/c-1?x=1');
    expect(named('nav.restore')).toEqual([{ path: '/chat/c-1?x=1', routeId: 'chat-item', params: { chatId: 'c-1' }, expectedPlaceKey: 'chat:c-1', fellBack: false }]);
    expect(navEvents().every(e => !('label' in (e.data ?? {})))).toBe(true);
  });

  it('restorePath records a fallback to the landing page', () => {
    restorePath('/nowhere');
    expect(named('nav.restore')).toEqual([expect.objectContaining({ routeId: 'rosetta-stone', expectedPlaceKey: 'rosetta-stone', fellBack: true })]);
  });
});

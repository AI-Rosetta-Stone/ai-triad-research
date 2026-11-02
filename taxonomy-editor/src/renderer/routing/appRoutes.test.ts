// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the in-app deep-link route registry (t/3486, t/4640). The load-bearing
// assertions: every place placeOf() produces has a route whose placeKey matches it (the
// round trip below — a place without one can't be restored by Back, Reload or a pasted URL),
// and each route's restore() calls the tool's real open action.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { placeOf, type AppState } from '../navigation/placeOf';

const taxonomyState = {
  setActiveTab: vi.fn(),
  navigateToNode: vi.fn(),
  navigateToConflict: vi.fn(),
};
vi.mock('../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { getState: () => taxonomyState },
}));

const opEdState = { requestOpen: vi.fn(), selectSet: vi.fn() };
vi.mock('../hooks/useOpEdStore', () => ({
  useOpEdStore: { getState: () => opEdState },
}));

const debateState = { activeDebate: null as unknown, closeDebate: vi.fn(), loadDebate: vi.fn() };
vi.mock('../hooks/useDebateStore', () => ({
  useDebateStore: { getState: () => debateState },
}));

const chatState = { loadChat: vi.fn() };
const chatSetState = vi.fn();
vi.mock('../hooks/useChatStore', () => ({
  useChatStore: { getState: () => chatState, setState: (s: unknown) => chatSetState(s) },
}));

const inquiryState = { openList: vi.fn(), openFromHistory: vi.fn() };
vi.mock('../hooks/useInquiryStore', () => ({
  useInquiryStore: { getState: () => inquiryState },
}));

const { DEBATE_ROUTE, OPED_ROUTE, findRoute, opedRoutePath } = await import('./appRoutes');

/** Match a full path and run its route's restore(). */
function restore(path: string): void {
  const [pathname, qs] = path.split('?');
  const match = findRoute(pathname);
  if (!match) throw new Error(`no route for ${path}`);
  match.route.restore(match.params, new URLSearchParams(qs ?? ''));
}

beforeEach(() => {
  vi.clearAllMocks();
  debateState.activeDebate = null;
});

describe('DEBATE_ROUTE.match', () => {
  it('matches /debate with or without trailing slash', () => {
    expect(DEBATE_ROUTE.match('/debate')).toEqual({});
    expect(DEBATE_ROUTE.match('/debate/')).toEqual({});
  });
  it('returns null for non-matching paths', () => {
    expect(DEBATE_ROUTE.match('/')).toBeNull();
    expect(DEBATE_ROUTE.match('/debates')).toBeNull();
    expect(DEBATE_ROUTE.match('/debate/123')).toBeNull();
  });
});

describe('OPED_ROUTE.match', () => {
  it('matches /opeds/:setId, with or without a trailing slash', () => {
    expect(OPED_ROUTE.match('/opeds/set-1')).toEqual({ setId: 'set-1' });
    expect(OPED_ROUTE.match('/opeds/set-1/')).toEqual({ setId: 'set-1' });
  });
  it('decodes a URL-encoded setId', () => {
    expect(OPED_ROUTE.match('/opeds/a%20b')).toEqual({ setId: 'a b' });
  });
  it('returns null for non-matching paths', () => {
    expect(OPED_ROUTE.match('/')).toBeNull();
    expect(OPED_ROUTE.match('/opeds')).toBeNull();
    expect(OPED_ROUTE.match('/opeds/')).toBeNull();
    expect(OPED_ROUTE.match('/share/oped/set-1')).toBeNull();
  });
});

describe('restore() per route calls the tool\'s real open action (t/4640#40 AC3)', () => {
  it('/ → the landing tab', () => {
    restore('/');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('rosetta-stone');
  });

  it('/chat → the Chat tab with no chat open', () => {
    restore('/chat');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('chat');
    expect(chatSetState).toHaveBeenCalledWith({ activeChatId: null, activeChat: null });
    expect(chatState.loadChat).not.toHaveBeenCalled();
  });

  it('/chat/:id → clears the previous chat, then loads this one', () => {
    restore('/chat/c-1');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('chat');
    expect(chatSetState).toHaveBeenCalledWith({ activeChatId: null, activeChat: null });
    expect(chatState.loadChat).toHaveBeenCalledWith('c-1');
  });

  it('/debate → the Debate library, closing an open debate', () => {
    debateState.activeDebate = { id: 'd-0' };
    restore('/debate');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('debate');
    expect(debateState.closeDebate).toHaveBeenCalled();
  });

  it('/debate/:id → loads the debate', () => {
    restore('/debate/d-1');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('debate');
    expect(debateState.loadDebate).toHaveBeenCalledWith('d-1');
  });

  it('/opeds → the library, with no set selected', () => {
    restore('/opeds');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('opeds');
    expect(opEdState.selectSet).toHaveBeenCalledWith(null);
  });

  it('/opeds/:setId?pov= → requests opening the set on that camp', () => {
    restore('/opeds/set-1?pov=acc');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('opeds');
    expect(opEdState.requestOpen).toHaveBeenCalledWith('set-1', 'acc');
  });

  it('/inquiry → the question list', () => {
    restore('/inquiry');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('inquiry');
    expect(inquiryState.openList).toHaveBeenCalled();
  });

  it('/inquiry/:id → opens the answer', () => {
    restore('/inquiry/j-1');
    expect(inquiryState.openFromHistory).toHaveBeenCalledWith('j-1');
  });

  it('/taxonomy/:pov → the camp tab; with ?node= → navigates to the node', () => {
    restore('/taxonomy/saf');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('safetyist');
    restore('/taxonomy/skp?node=skp-beliefs-001');
    expect(taxonomyState.navigateToNode).toHaveBeenCalledWith('skeptic', 'skp-beliefs-001');
  });

  it('/conflicts → the tab; with ?claim= → navigates to the conflict', () => {
    restore('/conflicts');
    expect(taxonomyState.setActiveTab).toHaveBeenCalledWith('conflicts');
    restore('/conflicts?claim=cl-1');
    expect(taxonomyState.navigateToConflict).toHaveBeenCalledWith('cl-1');
  });

  it('single-place tabs restore their tab', () => {
    for (const tab of ['cruxes', 'summaries', 'validation', 'organizations']) {
      restore(`/${tab}`);
      expect(taxonomyState.setActiveTab).toHaveBeenCalledWith(tab);
    }
  });
});

describe('placeOf() ↔ route round trip (t/4640#40 AC3)', () => {
  const base = { taxonomyStore: { selectedNodeId: null } } as unknown as AppState;
  const states: Array<[string, AppState]> = [
    ['landing', { ...base, activeTab: 'rosetta-stone' }],
    ['chat library', { ...base, activeTab: 'chat', chatStore: { activeChat: null } } as unknown as AppState],
    ['chat item', { ...base, activeTab: 'chat', chatStore: { activeChat: { id: 'c-1', topic: 'T' } } } as unknown as AppState],
    ['debate library', { ...base, activeTab: 'debate', debateStore: { activeDebate: null } } as unknown as AppState],
    ['debate item', { ...base, activeTab: 'debate', debateStore: { activeDebate: { id: 'd-1', topic: { original: 'T', final: null } } } } as unknown as AppState],
    ['op-eds library', { ...base, activeTab: 'opeds', opEdStore: { selectedSetId: null, sets: [] } } as unknown as AppState],
    ['op-ed set', { ...base, activeTab: 'opeds', opEdStore: { selectedSetId: 's 1', sets: [{ set_id: 's 1', topic: 'T' }] } } as unknown as AppState],
    ['inquiry list', { ...base, activeTab: 'inquiry', inquiryStore: { result: null, jobId: null } } as unknown as AppState],
    ['inquiry answer', { ...base, activeTab: 'inquiry', inquiryStore: { result: { request: { question: 'Q' } }, jobId: 'j-1' } } as unknown as AppState],
    ...(['accelerationist', 'safetyist', 'skeptic', 'situations'] as const).flatMap((tab): Array<[string, AppState]> => [
      [`${tab} camp`, { ...base, activeTab: tab }],
      [`${tab} node`, { ...base, activeTab: tab, taxonomyStore: { selectedNodeId: 'n-1' } } as unknown as AppState],
    ]),
    ['conflicts', { ...base, activeTab: 'conflicts' }],
    ['conflict claim', { ...base, activeTab: 'conflicts', taxonomyStore: { selectedNodeId: 'cl-1' } } as unknown as AppState],
    ...(['cruxes', 'summaries', 'validation', 'organizations'].map((tab): [string, AppState] => [tab, { ...base, activeTab: tab }])),
  ];

  it.each(states)('%s: placeOf().path has a route whose placeKey is placeOf().placeKey', (_name, state) => {
    const place = placeOf(state);
    const [pathname, qs] = place.path.split('?');
    const match = findRoute(pathname);
    expect(match, `no route for ${place.path}`).not.toBeNull();
    expect(match!.route.placeKey(match!.params, new URLSearchParams(qs ?? ''))).toBe(place.placeKey);
  });
});

describe('findRoute', () => {
  it('strips query strings before matching', () => {
    const match = findRoute('/opeds/set-1?pov=acc&tab=overview');
    expect(match?.route.id).toBe('opeds');
    expect(match?.params).toEqual({ setId: 'set-1' });
  });
  it('returns null for an unregistered path', () => {
    expect(findRoute('/debates/anything')).toBeNull();
    expect(findRoute('/taxonomy/xyz')).toBeNull();
    expect(findRoute('/share/pov/1')).toBeNull();
  });
});

describe('opedRoutePath', () => {
  it('builds a path with no query when pov is omitted', () => {
    expect(opedRoutePath('set-1')).toBe('/opeds/set-1');
  });
  it('builds a path with a pov query param', () => {
    expect(opedRoutePath('set-1', 'acc')).toBe('/opeds/set-1?pov=acc');
  });
  it('encodes special characters in the setId', () => {
    expect(opedRoutePath('a b')).toBe('/opeds/a%20b');
  });
});

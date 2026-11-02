// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the in-app deep-link route registry (t/3486, t/4640). The load-bearing
// assertions: every place placeOf() produces has a route whose placeKey matches it (the
// round trip below — a place without one can't be restored by Back, Reload or a pasted URL),
// and each route's restore() calls the tool's real open action.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { placeOf, type AppState } from '../navigation/placeOf';

type CampFile = { nodes: Array<{ id: string; label: string; superseded_by?: string }> } | null;

// Stateful enough for the routes to read back what they set (activeTab, the open item id), and
// subscribable so a route can wait for a camp's file to load.
const taxonomyState = {
  activeTab: 'rosetta-stone' as string,
  selectedNodeId: null as string | null,
  accelerationist: null as CampFile,
  safetyist: null as CampFile,
  skeptic: null as CampFile,
  situations: null as CampFile,
  supersededNodes: { accelerationist: [], safetyist: [], skeptic: [] } as Record<string, Array<{ node: { id: string }; index: number }>>,
  setActiveTab: vi.fn((tab: string) => { taxonomyState.activeTab = tab; taxonomyState.selectedNodeId = null; }),
  setSelectedNodeId: vi.fn((id: string | null) => { taxonomyState.selectedNodeId = id; }),
  navigateToNode: vi.fn((tab: string, id: string) => { taxonomyState.activeTab = tab; taxonomyState.selectedNodeId = id; }),
  navigateToConflict: vi.fn(),
};
const taxonomyListeners = new Set<() => void>();
/** Simulate loadAll landing a camp's file. */
function loadCamp(tab: 'accelerationist' | 'safetyist' | 'skeptic' | 'situations', nodes: Array<{ id: string; label: string }>): void {
  taxonomyState[tab] = { nodes };
  taxonomyListeners.forEach(l => l());
}
vi.mock('../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: {
    getState: () => taxonomyState,
    subscribe: (l: () => void) => { taxonomyListeners.add(l); return () => taxonomyListeners.delete(l); },
  },
}));

const opEdState = { requestOpen: vi.fn(), selectSet: vi.fn() };
vi.mock('../hooks/useOpEdStore', () => ({
  useOpEdStore: { getState: () => opEdState },
}));

/** Whether the next mocked load finds its item. */
let loadSucceeds = true;

const debateState = {
  activeDebate: null as unknown,
  activeDebateId: null as string | null,
  closeDebate: vi.fn(),
  loadDebate: vi.fn(async (id: string) => { if (loadSucceeds) debateState.activeDebateId = id; }),
};
const debateSetState = vi.fn((s: Partial<typeof debateState>) => { Object.assign(debateState, s); });
vi.mock('../hooks/useDebateStore', () => ({
  useDebateStore: { getState: () => debateState, setState: (s: never) => debateSetState(s) },
}));

const chatState = {
  activeChatId: null as string | null,
  loadChat: vi.fn(async (id: string) => { if (loadSucceeds) chatState.activeChatId = id; }),
};
const chatSetState = vi.fn((s: Partial<typeof chatState>) => { Object.assign(chatState, s); });
vi.mock('../hooks/useChatStore', () => ({
  useChatStore: { getState: () => chatState, setState: (s: never) => chatSetState(s) },
}));

const inquiryState = { openList: vi.fn(), openFromHistory: vi.fn() };
vi.mock('../hooks/useInquiryStore', () => ({
  useInquiryStore: { getState: () => inquiryState },
}));

const notices: string[] = [];
vi.mock('../navigation/navNotice', () => ({ postNavNotice: (text: string) => notices.push(text) }));
const resyncToState = vi.fn();
vi.mock('../navigation/subscriber', () => ({ resyncToState: () => resyncToState() }));

const { DEBATE_ROUTE, OPED_ROUTE, findRoute, opedRoutePath } = await import('./appRoutes');

/** Let a restore's async load (and its .then) settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Match a full path and run its route's restore(). */
function restore(path: string): void {
  const [pathname, qs] = path.split('?');
  const match = findRoute(pathname);
  if (!match) throw new Error(`no route for ${path}`);
  match.route.restore(match.params, new URLSearchParams(qs ?? ''));
}

beforeEach(() => {
  vi.clearAllMocks();
  loadSucceeds = true;
  notices.length = 0;
  taxonomyState.activeTab = 'rosetta-stone';
  taxonomyState.selectedNodeId = null;
  taxonomyState.accelerationist = taxonomyState.safetyist = taxonomyState.skeptic = taxonomyState.situations = null;
  taxonomyState.supersededNodes = { accelerationist: [], safetyist: [], skeptic: [] };
  taxonomyListeners.clear();
  debateState.activeDebate = null;
  debateState.activeDebateId = null;
  chatState.activeChatId = null;
});

describe('a stale /taxonomy/:pov?node= falls back to the camp with a notice (t/4640 AC3, staging sweep)', () => {
  const NODE_NOTICE = 'That node couldn’t be found. It may have been removed or renamed.';

  it('a node missing from the loaded camp is cleared, the entry resyncs, and the notice posts', async () => {
    loadCamp('safetyist', [{ id: 'saf-desires-011', label: 'Real' }]);
    restore('/taxonomy/saf?node=saf-desires-034');
    await settle();
    expect(taxonomyState.setSelectedNodeId).toHaveBeenCalledWith(null);
    expect(resyncToState).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([NODE_NOTICE]);
  });

  it('waits for the camp to load when restored at boot, then checks', async () => {
    restore('/taxonomy/saf?node=saf-desires-034');
    await settle();
    expect(notices).toEqual([]); // not loaded yet — can't know
    loadCamp('safetyist', [{ id: 'saf-desires-011', label: 'Real' }]);
    expect(notices).toEqual([NODE_NOTICE]);
  });

  it('an existing node stays selected, with no notice', async () => {
    loadCamp('safetyist', [{ id: 'saf-desires-011', label: 'Real' }]);
    restore('/taxonomy/saf?node=saf-desires-011');
    await settle();
    expect(taxonomyState.selectedNodeId).toBe('saf-desires-011');
    expect(notices).toEqual([]);
    expect(resyncToState).not.toHaveBeenCalled();
  });

  it('a superseded node still counts as found — it opens with its banner', async () => {
    loadCamp('safetyist', [{ id: 'saf-desires-011', label: 'Real' }]);
    taxonomyState.supersededNodes = { accelerationist: [], safetyist: [{ node: { id: 'saf-desires-old' }, index: 0 }], skeptic: [] };
    restore('/taxonomy/saf?node=saf-desires-old');
    await settle();
    expect(notices).toEqual([]);
  });

  it('no fallback once the user has selected another node before the check ran', async () => {
    restore('/taxonomy/saf?node=saf-desires-034');
    await settle();
    taxonomyState.selectedNodeId = 'saf-desires-011'; // the user clicked a node while loading
    loadCamp('safetyist', [{ id: 'saf-desires-011', label: 'Real' }]);
    expect(notices).toEqual([]);
    expect(taxonomyState.setSelectedNodeId).not.toHaveBeenCalled();
  });
});

describe('a deleted or unknown item falls back to its library with a notice (t/4640 AC3)', () => {
  it('/chat/:id that fails to load posts the not-found notice and resyncs the entry to the library', async () => {
    loadSucceeds = false;
    restore('/chat/gone');
    await settle();
    expect(notices).toEqual(['That chat couldn’t be found. It may have been deleted.']);
    expect(resyncToState).toHaveBeenCalledTimes(1);
  });

  it('/debate/:id that fails to load posts the not-found notice', async () => {
    loadSucceeds = false;
    restore('/debate/gone');
    await settle();
    expect(notices).toEqual(['That debate couldn’t be found. It may have been deleted.']);
  });

  it('a successful load posts nothing and resyncs nothing', async () => {
    restore('/chat/c-1');
    restore('/debate/d-1');
    await settle();
    expect(notices).toEqual([]);
    expect(resyncToState).not.toHaveBeenCalled();
  });

  it('no notice and no resync once the user has moved to another tool before the load failed', async () => {
    loadSucceeds = false;
    restore('/debate/gone');
    taxonomyState.activeTab = 'chat';
    await settle();
    expect(notices).toEqual([]);
    expect(resyncToState).not.toHaveBeenCalled();
  });

  it('/debate/:id clears the previously open debate first, without closeDebate()', () => {
    debateState.activeDebate = { id: 'd-old' };
    debateState.activeDebateId = 'd-old';
    restore('/debate/d-1');
    expect(debateSetState).toHaveBeenCalledWith({ activeDebateId: null, activeDebate: null });
    expect(debateState.closeDebate).not.toHaveBeenCalled();
  });
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

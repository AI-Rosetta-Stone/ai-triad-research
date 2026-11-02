// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// In-app deep-linkable URL registry (t/3486, TL-approved shape at t/3486#2). ONE
// registry module — each entry pairs a path pattern with a restore() that seeds
// store state from a matched URL. Every place placeOf() can produce has a route here
// (t/4640 spec table), so Back/Forward/Recent, Reload and a pasted URL all restore
// through the same entry. Components never call pushState themselves: the nav
// subscriber records places, and replaceView() records view changes.
//
// Deliberately NOT a router library: the hard problem is URL<->Zustand-state sync
// at boot, which a library doesn't solve for us.

import type { TabId } from '../types/taxonomy';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import { useOpEdStore } from '../hooks/useOpEdStore';
import { useDebateStore } from '../hooks/useDebateStore';
import { useChatStore } from '../hooks/useChatStore';
import { useInquiryStore } from '../hooks/useInquiryStore';

export interface AppRoute {
  /** Unique id for logging/debugging — not part of the URL. */
  id: string;
  /** Parse a pathname into named params, or null if this route doesn't match. */
  match(pathname: string): Record<string, string> | null;
  /**
   * The placeKey placeOf() yields once restore() has fully applied (t/4640). An async
   * open (loading a chat, a debate) lands after restore() returns; the subscriber uses
   * this to record that arrival as a replace of the restored entry, not a new Back step.
   */
  placeKey(params: Record<string, string>, query: URLSearchParams): string;
  /** Seed store state from matched params + query string. Called at boot and on every history move. */
  restore(params: Record<string, string>, query: URLSearchParams): void;
}

const taxonomy = () => useTaxonomyStore.getState();

/** A route for an exact path with no params. */
function exactRoute(id: string, path: string, placeKey: string, restore: () => void): AppRoute {
  const re = new RegExp(`^${path.replace(/\//g, '\\/')}\\/?$`);
  return {
    id,
    match: (pathname) => (re.test(pathname) ? {} : null),
    placeKey: () => placeKey,
    restore,
  };
}

/** A route for `/<prefix>/:id`. */
function itemRoute(id: string, prefix: string, param: string, placeKeyPrefix: string, restore: (itemId: string, query: URLSearchParams) => void): AppRoute {
  const re = new RegExp(`^\\/${prefix}\\/([^/]+)\\/?$`);
  return {
    id,
    match(pathname) {
      const m = pathname.match(re);
      return m ? { [param]: decodeURIComponent(m[1]) } : null;
    },
    placeKey: (params) => `${placeKeyPrefix}:${params[param]}`,
    restore: (params, query) => restore(params[param], query),
  };
}

export const ROOT_ROUTE = exactRoute('rosetta-stone', '', 'rosetta-stone', () => taxonomy().setActiveTab('rosetta-stone'));

// ── Chat ──
export const CHAT_ROUTE = exactRoute('chat', '/chat', 'chat:none', () => {
  taxonomy().setActiveTab('chat');
  useChatStore.setState({ activeChatId: null, activeChat: null });
});
export const CHAT_ITEM_ROUTE = itemRoute('chat-item', 'chat', 'chatId', 'chat', (chatId) => {
  taxonomy().setActiveTab('chat');
  // Clear first: a failed load must fall back to the library, not leave the previous chat
  // showing under this chat's URL. loadChat sets chatError, which the tab shows as the notice.
  useChatStore.setState({ activeChatId: null, activeChat: null });
  void useChatStore.getState().loadChat(chatId);
});

// ── Debate ──
/** `/debate` — the Debate library. */
export const DEBATE_ROUTE = exactRoute('debate', '/debate', 'debate:none', () => {
  taxonomy().setActiveTab('debate');
  if (useDebateStore.getState().activeDebate) useDebateStore.getState().closeDebate();
});
export const DEBATE_ITEM_ROUTE = itemRoute('debate-item', 'debate', 'debateId', 'debate', (debateId) => {
  taxonomy().setActiveTab('debate');
  void useDebateStore.getState().loadDebate(debateId);
});

// ── Op-Ed Studies ──
export const OPEDS_ROUTE = exactRoute('opeds-library', '/opeds', 'opeds:none', () => {
  taxonomy().setActiveTab('opeds');
  useOpEdStore.getState().selectSet(null);
});
/**
 * `/opeds/:setId?pov=acc|saf|skp` — the op-eds route. Restoring only opens
 * "my" sets for now (t/3486#4): the URL shape doesn't distinguish source yet, and
 * community op-ed addressing has its own id-mismatch history (t/3426). A community
 * deep link 404s into "not found" today — a deliberate MVP scope cut, not silent.
 */
export const OPED_ROUTE = itemRoute('opeds', 'opeds', 'setId', 'opeds', (setId, query) => {
  taxonomy().setActiveTab('opeds');
  useOpEdStore.getState().requestOpen(setId, query.get('pov') ?? undefined);
});

// ── Ask a Question ──
export const INQUIRY_ROUTE = exactRoute('inquiry', '/inquiry', 'inquiry:none', () => {
  taxonomy().setActiveTab('inquiry');
  useInquiryStore.getState().openList();
});
export const INQUIRY_ITEM_ROUTE = itemRoute('inquiry-item', 'inquiry', 'jobId', 'inquiry', (jobId) => {
  taxonomy().setActiveTab('inquiry');
  void useInquiryStore.getState().openFromHistory(jobId);
});

// ── Taxonomy ──
const POV_TABS: Record<string, TabId> = {
  acc: 'accelerationist',
  saf: 'safetyist',
  skp: 'skeptic',
  sit: 'situations',
};
const TAXONOMY_PATH_RE = /^\/taxonomy\/(acc|saf|skp|sit)\/?$/;

/** `/taxonomy/:pov?node=<id>` — a camp, optionally with a node selected. */
export const TAXONOMY_ROUTE: AppRoute = {
  id: 'taxonomy',
  match(pathname) {
    const m = pathname.match(TAXONOMY_PATH_RE);
    return m ? { pov: m[1] } : null;
  },
  placeKey: (_params, query) => `taxonomy:${query.get('node') ?? 'none'}`,
  restore(params, query) {
    const tab = POV_TABS[params.pov];
    const node = query.get('node');
    if (node) taxonomy().navigateToNode(tab, node);
    else taxonomy().setActiveTab(tab);
  },
};

/** `/conflicts?claim=<id>`. */
export const CONFLICTS_ROUTE: AppRoute = {
  id: 'conflicts',
  match: (pathname) => (/^\/conflicts\/?$/.test(pathname) ? {} : null),
  placeKey: (_params, query) => `conflicts:${query.get('claim') ?? 'none'}`,
  restore(_params, query) {
    const claim = query.get('claim');
    if (claim) taxonomy().navigateToConflict(claim);
    else taxonomy().setActiveTab('conflicts');
  },
};

// ── Single-place tabs ──
const tabRoute = (tab: TabId) => exactRoute(tab, `/${tab}`, `${tab}:none`, () => taxonomy().setActiveTab(tab));

export const APP_ROUTES: AppRoute[] = [
  ROOT_ROUTE,
  CHAT_ROUTE, CHAT_ITEM_ROUTE,
  DEBATE_ROUTE, DEBATE_ITEM_ROUTE,
  OPEDS_ROUTE, OPED_ROUTE,
  INQUIRY_ROUTE, INQUIRY_ITEM_ROUTE,
  TAXONOMY_ROUTE, CONFLICTS_ROUTE,
  tabRoute('cruxes'), tabRoute('summaries'), tabRoute('validation'), tabRoute('organizations'),
];

export function findRoute(url: string): { route: AppRoute; params: Record<string, string> } | null {
  // Strip query string before matching (e.g., /opeds/set-1?pov=acc → /opeds/set-1)
  const pathname = url.split('?')[0];
  for (const route of APP_ROUTES) {
    const params = route.match(pathname);
    if (params) return { route, params };
  }
  return null;
}

/** Build the canonical URL for an open op-ed set + active camp tab. */
export function opedRoutePath(setId: string, pov?: string): string {
  const path = `/opeds/${encodeURIComponent(setId)}`;
  return pov ? `${path}?pov=${encodeURIComponent(pov)}` : path;
}

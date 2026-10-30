// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// In-app deep-linkable URL registry (t/3486, TL-approved shape at t/3486#2). ONE
// registry module — each entry pairs a path pattern with a restore() that seeds
// store state from a matched URL, so future views (debates/taxonomy/chats) add an
// entry here rather than inventing their own pushState/popstate handling.
//
// Deliberately NOT a router library: the hard problem is URL<->Zustand-state sync
// at boot, which a library doesn't solve for us, and this app has exactly one
// registered route today. Extended in t/4640 to cover all places.

import { isElectronMode } from '@bridge';
import { useTaxonomyStore } from '../hooks/useTaxonomyStore';
import { useOpEdStore } from '../hooks/useOpEdStore';

export interface AppRoute {
  /** Unique id for logging/debugging — not part of the URL. */
  id: string;
  /** Parse a pathname into named params, or null if this route doesn't match. */
  match(pathname: string): Record<string, string> | null;
  /** Seed store state from matched params + query string. Called at boot and on popstate. */
  restore(params: Record<string, string>, query: URLSearchParams): void;
}

// ── Route Patterns ──

const ROOT_RE = /^\/?\s*$/;
const CHAT_LIBRARY_RE = /^\/chat\/?$/;
const CHAT_OPEN_RE = /^\/chat\/([^/]+)\/?$/;
const OPEDS_LIBRARY_RE = /^\/opeds\/?$/;
const OPEDS_OPEN_RE = /^\/opeds\/([^/]+)\/?$/;
const INQUIRY_LIBRARY_RE = /^\/inquiry\/?$/;
const INQUIRY_OPEN_RE = /^\/inquiry\/([^/]+)\/?$/;
const DEBATE_LIBRARY_RE = /^\/debate\/?$/;
const DEBATE_OPEN_RE = /^\/debate\/([^/]+)\/?$/;
const TAXONOMY_RE = /^\/taxonomy\/([a-z]+)\/?$/;
const CONFLICTS_RE = /^\/conflicts\/?$/;
const CRUXES_RE = /^\/cruxes\/?$/;
const SUMMARIES_RE = /^\/summaries\/?$/;
const VALIDATION_RE = /^\/validation\/?$/;
const ORGANIZATIONS_RE = /^\/organizations\/?$/;

// ── Root Route ──

export const ROOT_ROUTE: AppRoute = {
  id: 'root',
  match: (pathname) => ROOT_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('rosetta-stone');
  },
};

// ── Chat Routes ──

export const CHAT_LIBRARY_ROUTE: AppRoute = {
  id: 'chat-library',
  match: (pathname) => CHAT_LIBRARY_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('chat');
  },
};

export const CHAT_OPEN_ROUTE: AppRoute = {
  id: 'chat-open',
  match: (pathname) => {
    const m = pathname.match(CHAT_OPEN_RE);
    return m ? { id: decodeURIComponent(m[1]) } : null;
  },
  restore: (params) => {
    useTaxonomyStore.getState().setActiveTab('chat');
    useTaxonomyStore.getState().setSelectedNodeId(params.id);
    // TODO: Add chat open action via useChatStore.requestOpen(params.id) when chat store is integrated
  },
};

// ── Op-Ed Routes ──

export const OPEDS_LIBRARY_ROUTE: AppRoute = {
  id: 'opeds-library',
  match: (pathname) => OPEDS_LIBRARY_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('opeds');
  },
};

export const OPEDS_OPEN_ROUTE: AppRoute = {
  id: 'opeds',
  match: (pathname) => {
    const m = pathname.match(OPEDS_OPEN_RE);
    return m ? { setId: decodeURIComponent(m[1]) } : null;
  },
  restore: (params, query) => {
    useTaxonomyStore.getState().setActiveTab('opeds');
    useOpEdStore.getState().requestOpen(params.setId, query.get('pov') ?? undefined);
  },
};

// ── Inquiry Routes ──

export const INQUIRY_LIBRARY_ROUTE: AppRoute = {
  id: 'inquiry-library',
  match: (pathname) => INQUIRY_LIBRARY_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('inquiry');
  },
};

export const INQUIRY_OPEN_ROUTE: AppRoute = {
  id: 'inquiry-open',
  match: (pathname) => {
    const m = pathname.match(INQUIRY_OPEN_RE);
    return m ? { id: decodeURIComponent(m[1]) } : null;
  },
  restore: (params) => {
    useTaxonomyStore.getState().setActiveTab('inquiry');
    useTaxonomyStore.getState().setSelectedNodeId(params.id);
    // TODO: Add inquiry open action via store when inquiry store is integrated
  },
};

// ── Debate Routes ──

export const DEBATE_LIBRARY_ROUTE: AppRoute = {
  id: 'debate-library',
  match: (pathname) => DEBATE_LIBRARY_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('debate');
  },
};

export const DEBATE_OPEN_ROUTE: AppRoute = {
  id: 'debate-open',
  match: (pathname) => {
    const m = pathname.match(DEBATE_OPEN_RE);
    return m ? { id: decodeURIComponent(m[1]) } : null;
  },
  restore: (params) => {
    useTaxonomyStore.getState().setActiveTab('debate');
    useTaxonomyStore.getState().setSelectedNodeId(params.id);
    // TODO: Add debate open action via store when debate store is integrated
  },
};

// ── Taxonomy Routes ──

/**
 * Taxonomy routes cover all four POV tabs (accelerationist, safetyist, skeptic, situations)
 * as a single place, with optional node selection.
 * POV is a view change (replaceView), not a place change (goToPlace).
 */
export const TAXONOMY_ROUTE: AppRoute = {
  id: 'taxonomy',
  match: (pathname) => {
    const m = pathname.match(TAXONOMY_RE);
    if (!m) return null;

    const pov = m[1];
    const query = new URLSearchParams(pathname.split('?')[1] ?? '');
    return { pov, nodeId: query.get('node') ?? undefined };
  },
  restore: (params, query) => {
    const pov = params.pov;
    const nodeId = query.get('node');

    // Map POV abbreviation to TabId
    const povTabMap: Record<string, 'accelerationist' | 'safetyist' | 'skeptic' | 'situations'> = {
      'acc': 'accelerationist',
      'saf': 'safetyist',
      'skp': 'skeptic',
      'sit': 'situations',
    };

    const tab = povTabMap[pov];
    if (tab) {
      useTaxonomyStore.getState().setActiveTab(tab);
      if (nodeId) {
        useTaxonomyStore.getState().setSelectedNodeId(nodeId);
      } else {
        useTaxonomyStore.getState().setSelectedNodeId(null);
      }
    }
  },
};

// ── Conflicts Route ──

export const CONFLICTS_ROUTE: AppRoute = {
  id: 'conflicts',
  match: (pathname) => CONFLICTS_RE.test(pathname) ? {} : null,
  restore: (params, query) => {
    useTaxonomyStore.getState().setActiveTab('conflicts');
    const claimId = query.get('claim');
    if (claimId) {
      useTaxonomyStore.getState().setSelectedNodeId(claimId);
    } else {
      useTaxonomyStore.getState().setSelectedNodeId(null);
    }
  },
};

// ── Library Routes (Cruxes, Summaries, Validation, Organizations) ──

export const CRUXES_ROUTE: AppRoute = {
  id: 'cruxes',
  match: (pathname) => CRUXES_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('cruxes');
  },
};

export const SUMMARIES_ROUTE: AppRoute = {
  id: 'summaries',
  match: (pathname) => SUMMARIES_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('summaries');
  },
};

export const VALIDATION_ROUTE: AppRoute = {
  id: 'validation',
  match: (pathname) => VALIDATION_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('validation');
  },
};

export const ORGANIZATIONS_ROUTE: AppRoute = {
  id: 'organizations',
  match: (pathname) => ORGANIZATIONS_RE.test(pathname) ? {} : null,
  restore: () => {
    useTaxonomyStore.getState().setActiveTab('organizations');
  },
};

// ── Registry ──

export const APP_ROUTES: AppRoute[] = [
  ROOT_ROUTE,
  CHAT_LIBRARY_ROUTE,
  CHAT_OPEN_ROUTE,
  OPEDS_LIBRARY_ROUTE,
  OPEDS_OPEN_ROUTE,
  INQUIRY_LIBRARY_ROUTE,
  INQUIRY_OPEN_ROUTE,
  DEBATE_LIBRARY_ROUTE,
  DEBATE_OPEN_ROUTE,
  TAXONOMY_ROUTE,
  CONFLICTS_ROUTE,
  CRUXES_ROUTE,
  SUMMARIES_ROUTE,
  VALIDATION_ROUTE,
  ORGANIZATIONS_ROUTE,
];

export function findRoute(pathname: string): { route: AppRoute; params: Record<string, string> } | null {
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

/**
 * Navigate to a new place (push history).
 * Web: pushes via window.history. Electron: no-op (use navHistory.push instead).
 * @deprecated Use navHistory.push() via placeOf + subscriber instead. Keep for OpEdTab migration.
 */
export function navigateTo(path: string): void {
  if (isElectronMode()) return;
  window.history.pushState({}, '', path);
}

/**
 * Update the URL to reflect a view change within a place (replace history).
 * Web: replaceState. Electron: no-op (use navHistory.replace instead).
 * @deprecated Use navHistory.replace() via placeOf + subscriber instead.
 */
export function replaceRoute(path: string): void {
  if (isElectronMode()) return;
  window.history.replaceState({}, '', path);
}

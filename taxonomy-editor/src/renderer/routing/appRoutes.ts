// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// In-app deep-linkable URL registry (t/3486, TL-approved shape at t/3486#2). ONE
// registry module — each entry pairs a path pattern with a restore() that seeds
// store state from a matched URL, so future views (debates/taxonomy/chats) add an
// entry here rather than inventing their own pushState/popstate handling.
//
// Deliberately NOT a router library: the hard problem is URL<->Zustand-state sync
// at boot, which a library doesn't solve for us, and this app has exactly one
// registered route today.

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

const OPED_PATH_RE = /^\/opeds\/([^/]+)\/?$/;

/**
 * `/opeds/:setId?pov=acc|saf|skp` — the first registered route. Restoring only opens
 * "my" sets for now (t/3486#4): the URL shape doesn't distinguish source yet, and
 * community op-ed addressing has its own id-mismatch history (t/3426). A community
 * deep link 404s into "not found" today — a deliberate MVP scope cut, not silent.
 */
export const OPED_ROUTE: AppRoute = {
  id: 'opeds',
  match(pathname) {
    const m = pathname.match(OPED_PATH_RE);
    return m ? { setId: decodeURIComponent(m[1]) } : null;
  },
  restore(params, query) {
    useTaxonomyStore.getState().setActiveTab('opeds');
    useOpEdStore.getState().requestOpen(params.setId, query.get('pov') ?? undefined);
  },
};

export const APP_ROUTES: AppRoute[] = [OPED_ROUTE];

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

/**
 * Push a new URL reflecting in-app state — web only. Electron's renderer doesn't run
 * behind a normal http origin, so pushState there is a no-op with no observer to react
 * to it (no address bar, no back/forward chrome); guard rather than let it silently do
 * nothing useful on every call.
 */
export function navigateTo(path: string): void {
  if (isElectronMode()) return;
  window.history.pushState({}, '', path);
}

/**
 * Update the URL to reflect a within-set change (e.g. camp-tab switch) WITHOUT adding a
 * back-button history entry — every tab click pushing a new entry would make "back" from
 * a shared link a tab-by-tab replay instead of leaving the set.
 */
export function replaceRoute(path: string): void {
  if (isElectronMode()) return;
  window.history.replaceState({}, '', path);
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { findRoute, ROOT_ROUTE } from '../routing/appRoutes';
import { expectReplace, setRestoringFlag } from './subscriber';

/**
 * Restore app state from a history path (t/4640): boot, Reload, a pasted URL, and every
 * Back / Forward / Recent move all come through here.
 *
 * The route's restore() runs with the restoring flag set, so its synchronous store changes
 * don't record history. Its async half (a chat or debate loading) lands later; the route's
 * placeKey is registered with expectReplace() so that arrival replaces the entry rather than
 * adding a Back step.
 *
 * An unknown path restores the landing page, with a WARN — never a blank page.
 */
export function restorePath(path: string): void {
  const [pathname, queryString] = path.split('?');
  const query = new URLSearchParams(queryString ?? '');
  let match = findRoute(pathname);
  if (!match) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'navigation', level: 'warn',
      message: `restorePath: no route for "${path}" — falling back to the landing page`,
    });
    match = { route: ROOT_ROUTE, params: {} };
  }
  setRestoringFlag(true);
  try {
    match.route.restore(match.params, query);
  } finally {
    setRestoringFlag(false);
  }
  expectReplace(match.route.placeKey(match.params, query));
}

/**
 * Go to a path as a user action — the breadcrumb's "up" link (t/4640 § Clickable breadcrumb).
 * Unlike restorePath, the route's store changes are NOT suppressed, so the nav subscriber
 * records the arrival as a push and Back returns to where the user was. Up targets are
 * collections and camps, which open synchronously, so there's no async arrival to expect.
 */
export function goToPath(path: string): void {
  const [pathname, queryString] = path.split('?');
  const match = findRoute(pathname);
  if (!match) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'navigation', level: 'warn',
      message: `goToPath: no route for "${path}" — ignoring the click`,
    });
    return;
  }
  match.route.restore(match.params, new URLSearchParams(queryString ?? ''));
}

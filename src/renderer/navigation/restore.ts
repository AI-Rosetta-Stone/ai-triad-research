// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { AppRoute } from '../routing/appRoutes';
import { findRoute } from '../routing/appRoutes';
import { setRestoringFlag } from './subscriber';

/**
 * Restore app state from a history path.
 * Matches the path against registered routes, then calls each route's restore() function
 * while the restoring flag is set, preventing the subscriber from pushing new entries.
 */
export function restore(path: string): void {
  setRestoringFlag(true);
  try {
    const route = findRoute(path);
    if (route) {
      // Parse query string for route params
      const [pathname, queryString] = path.split('?');
      const params = route.params;
      const query = new URLSearchParams(queryString ?? '');

      // Call the route's restore function to apply state
      route.route.restore(params, query);
    } else {
      // Unknown path — replace to landing with WARN
      console.warn(`Navigation: unknown route "${path}", falling back to /`);
      setRestoringFlag(false);
      // The caller should handle this by navigating to '/'
    }
  } finally {
    setRestoringFlag(false);
  }
}

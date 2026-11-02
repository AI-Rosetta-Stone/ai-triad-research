// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Boots deep-linkable in-app URLs (t/3486): restores the place the URL names once at
// mount, so Reload and a pasted URL reopen it. Web only — Electron's renderer has no
// address bar. Back/Forward are NOT handled here: the nav subscriber restores every
// history move in both builds (t/4640#40), and a second popstate listener here would
// restore twice.

import { useEffect } from 'react';
import { isElectronMode } from '@bridge';
import { restorePath } from '../navigation/restore';
import { findRoute } from './appRoutes';

export function useAppRoute(): void {
  useEffect(() => {
    if (isElectronMode()) return;
    // `/` is the landing page the app boots to anyway; restoring it would override the
    // session's own boot defaults for no gain. A path no route owns (served by another
    // page) is left alone, as before.
    const { pathname, search } = window.location;
    if (pathname === '/' || !findRoute(pathname)) return;
    restorePath(pathname + search);
  }, []);
}

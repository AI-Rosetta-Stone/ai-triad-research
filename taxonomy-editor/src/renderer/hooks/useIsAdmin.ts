// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4167 (PI p/548#290): the desktop app is single-user, so its user is the admin. On the web
// the server's profile decides; while it is loading, or if it failed, not admin (fail closed).
// This gates UI only: the server enforces authorization separately (t/4167 part B).
// Extracted from useCanEditPovTags (t/4559) so every admin-only UI surface shares one check.

import { isElectronMode } from '@bridge';
import { useUserProfile } from './useAuthStatus';

export function useIsAdmin(): boolean {
  const profile = useUserProfile();
  if (isElectronMode()) return true;
  return profile?.isAdmin === true;
}

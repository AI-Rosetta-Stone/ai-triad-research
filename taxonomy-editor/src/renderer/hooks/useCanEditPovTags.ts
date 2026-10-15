// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4167 (PI p/548#290): only admins may add or remove a node's POV tags. The desktop app is single-user, so its
// user is the admin. On the web the server's profile decides; while it is loading, or if it failed, tags are
// read-only (fail closed). This hides the controls only: the server enforces the rule separately (t/4167 part B).

import { isElectronMode } from '@bridge';
import { useUserProfile } from './useAuthStatus';

export function useCanEditPovTags(): boolean {
  const profile = useUserProfile();
  if (isElectronMode()) return true;
  return profile?.isAdmin === true;
}

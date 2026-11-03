// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4167 (PI p/548#290): only admins may add or remove a node's POV tags. This hides the
// controls only: the server enforces the rule separately (t/4167 part B). The admin check
// itself moved to useIsAdmin (t/4559) so every admin-only UI surface shares one definition.

import { useIsAdmin } from './useIsAdmin';

export function useCanEditPovTags(): boolean {
  return useIsAdmin();
}

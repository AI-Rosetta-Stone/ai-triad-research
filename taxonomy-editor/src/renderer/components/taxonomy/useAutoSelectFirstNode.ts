// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect } from 'react';
import { expectReplace } from '../../navigation';

/**
 * When a camp's tab opens with nothing selected, select its first node. The selection is
 * automatic, not the user's, so it replaces the current history entry instead of adding a Back
 * step (t/4640#40 item 6). Runs on a camp change only — the user clearing the selection within a
 * camp doesn't re-select. Extracted from PovTab so the camp-switch history behaviour can be
 * tested with the real effect (t/4640 AC8 round 2).
 */
export function useAutoSelectFirstNode(
  pov: string,
  orderedIds: readonly string[],
  selectedNodeId: string | null,
  setSelectedNodeId: (id: string) => void,
): void {
  useEffect(() => {
    if (!selectedNodeId && orderedIds.length > 0) {
      expectReplace(`taxonomy:${orderedIds[0]}`);
      setSelectedNodeId(orderedIds[0]);
    }
  }, [pov]); // camp change only, as before
}

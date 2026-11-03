// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from the now-deleted DebateTable.tsx (t/3705 cleanup, t/3702#10) — DebateTable was
// superseded by the shared LibraryListPage adoption but this row-shape type is still the
// production contract for a My-tab debate row, consumed by DebateTab.tsx / debateLibraryConfig.tsx.

/** Shape of a My-debate row — matches DebateSessionSummary from main/debateIO.ts. */
export interface SessionRowData {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  phase: string;
  topic_text?: string;
  model?: string;
  turn_count?: number;
  /** True when this row represents a community debate — drives onConfirm to call loadCommunityDebateSession (t/2400). */
  community?: boolean;
  /** t/4678/t/4679: set when this debate came from Ask a Question — mirrors debateIndex.ts's
   *  DebateSessionSummary. Deliberately narrower than the full origin union: the list only needs
   *  to flag inquiry debates for the "Question" badge, not distinguish cli/gui. */
  origin_mode?: 'inquiry';
  inquiry_id?: string;
}

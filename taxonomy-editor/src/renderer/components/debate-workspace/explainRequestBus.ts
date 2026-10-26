// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4514: lets the global right-click "Explain…" (scoped to a text selection) open the SAME
// inline per-statement panel the card's own "Explain" button uses, without threading a callback
// prop through StatementCard/DebateWorkspace or adding a floating overlay (the ticket's explicit
// "no new overlay" constraint — contrast with the Comment popover, which IS an overlay and is not
// the pattern to follow here). Keyed by entry id; each TaxonomyRefsSection instance registers a
// handler while mounted, matching the one TaxonomyRefsSection the entry's right-click menu targets.

export type ExplainSelectionRequest = { text: string };
type Handler = (req: ExplainSelectionRequest) => void;

const handlers = new Map<string, Handler>();

/** Register the inline panel's handler for one entry id. Returns the unregister function — call
 *  it on unmount so a stale handler never fires into an unmounted panel. */
export function registerExplainTarget(entryId: string, handler: Handler): () => void {
  handlers.set(entryId, handler);
  return () => {
    if (handlers.get(entryId) === handler) handlers.delete(entryId);
  };
}

/** Ask the entry's inline panel to open with a selection-scoped prompt. Returns false when no
 *  panel is registered for that entry id (e.g. unmounted mid-interaction) — the caller falls back
 *  to the Gemini escape hatch rather than silently dropping the request. */
export function requestExplainForSelection(entryId: string, text: string): boolean {
  const handler = handlers.get(entryId);
  if (!handler) return false;
  handler({ text });
  return true;
}

/** Test seam. */
export function __clearExplainTargetsForTests(): void {
  handlers.clear();
}

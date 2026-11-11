// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Chat entry normalizer: backfills missing ref labels for old chats at load time (t/282).
 * Only real labels are written; a node that doesn't resolve keeps its ref unchanged, and the
 * render path shows "No longer in the taxonomy" for it. Nothing is backfilled while the taxonomy
 * is still loading, so a chat opened early is not marked as missing.
 */

import type { ChatEntry, ChatSession } from '../types/chat';
import type { TaxonomyRef } from '../types/debate';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export interface NormalizerContext {
  /** False while the taxonomy is still loading: nothing is backfilled and nothing is warned about. */
  taxonomyLoaded: boolean;
  /** The label for a node id, or null when it doesn't resolve (superseded nodes included). */
  lookupLabel: (nodeId: string) => string | null;
}

/** Node ids that must resolve in a loaded taxonomy. pol-* (policy actions) and conflict ids live
 *  elsewhere, so a miss on them is expected and is not warned about. */
const TAXONOMY_NODE_ID = /^(acc|saf|skp|cc|sit)-/;

function normalizeRef(ref: TaxonomyRef, context: NormalizerContext): TaxonomyRef {
  if (ref.label || !context.taxonomyLoaded) return ref;

  const label = context.lookupLabel(ref.node_id);
  if (label) return { ...ref, label };

  if (TAXONOMY_NODE_ID.test(ref.node_id)) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-store',
      level: 'warn',
      message: 'WARN: chat ref node is not in the loaded taxonomy; the row will show "No longer in the taxonomy"',
      data: { node_id: ref.node_id },
    });
  }
  return ref;
}

/** Normalize a single chat entry in place: backfill ref labels that resolve. */
export function normalizeEntry(entry: ChatEntry, context: NormalizerContext): void {
  if (entry.taxonomy_refs && Array.isArray(entry.taxonomy_refs)) {
    entry.taxonomy_refs = entry.taxonomy_refs.map(ref => normalizeRef(ref, context));
  }
  // raw_prompt and raw_response are not backfilled; the How panel shows "not recorded" when absent.
}

/** Normalize a full chat session in place, then log one state.change for the load. */
export function normalizeSession(session: ChatSession, context: NormalizerContext): void {
  for (const entry of session.transcript) {
    normalizeEntry(entry, context);
  }

  getGlobalRecorder()?.record({
    type: 'state.change',
    component: 'chat-store',
    level: 'info',
    message: `Normalized ${session.transcript.length} entries for chat ${session.id}`,
    data: {
      chat_id: session.id,
      entry_count: session.transcript.length,
      taxonomy_loaded: context.taxonomyLoaded,
      has_raw_fields: session.transcript.some(e => e.raw_prompt || e.raw_response),
    },
  });
}

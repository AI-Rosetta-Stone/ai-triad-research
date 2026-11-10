// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Chat entry normalizer: backfills missing data fields for old chats.
 * Runs at load time; does not modify stored data.
 */

import type { ChatEntry, ChatSession } from '../types/chat';
import type { TaxonomyRef } from '../types/debate';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export interface NormalizerContext {
  taxonomyNodes: Map<string, { label: string }>;
}

/**
 * Backfill a single taxonomy ref: add node label if missing, set to "(no longer in taxonomy)"
 * if node not found.
 */
function normalizeRef(ref: TaxonomyRef, context: NormalizerContext): TaxonomyRef {
  if (ref.label) {
    return ref;
  }
  
  const node = context.taxonomyNodes.get(ref.node_id);
  if (node) {
    return {
      ...ref,
      label: node.label,
    };
  }
  
  return {
    ...ref,
    label: `${ref.node_id} (no longer in taxonomy)`,
  };
}

/**
 * Normalize a single chat entry: backfill missing fields (raw_prompt/raw_response, ref labels).
 * Mutates the entry in place.
 */
export function normalizeEntry(entry: ChatEntry, context: NormalizerContext): void {
  // Backfill ref labels
  entry.taxonomy_refs = entry.taxonomy_refs.map(ref => normalizeRef(ref, context));
  
  // raw_prompt and raw_response are optional; if missing, they render as "not recorded"
  // No need to backfill them — the render path checks if they exist.
}

/**
 * Normalize a full chat session: backfill all entries.
 * Mutates the session in place.
 */
export function normalizeSession(session: ChatSession, context: NormalizerContext): void {
  for (const entry of session.transcript) {
    normalizeEntry(entry, context);
  }
  
  // t/282: Log normalization via flight recorder
  getGlobalRecorder()?.record({
    type: 'state.change',
    component: 'chat-store',
    level: 'info',
    message: `Normalized ${session.transcript.length} entries for chat ${session.id}`,
    data: {
      chat_id: session.id,
      entry_count: session.transcript.length,
      has_raw_fields: session.transcript.some(e => e.raw_prompt || e.raw_response),
    },
  });
}

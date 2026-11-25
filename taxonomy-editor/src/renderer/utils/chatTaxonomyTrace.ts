// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat turn's skip WARNs and trace record. Pure: the caller records the WARNs and writes the
// trace onto the transcript entry. Trace fields are additive; nothing branches on them.

import type { ChatStatement } from './chatTaxonomyCap';

/** One WARN message per skipped entry (t/348#8, CL #5168 review): a node with no usable statement. */
export function chatSkipWarnings(pov: string, skipped: string[]): string[] {
  return skipped.map(nodeId => `chat-taxonomy: reason=no-usable-statement node=${nodeId} pov=${pov} (skipped, slot backfilled)`);
}

/** The per-turn trace: the node and situation ids injected, and the statement chosen per node. */
export interface ChatTurnTrace {
  /** The BDI node ids injected this turn, in injection order. */
  context_node_ids: string[];
  /** The statement index and text chosen for each injected BDI node (t/348#4 rule 4). */
  context_statements: { node_id: string; index: number; text: string }[];
  /** The situation ids injected this turn. */
  context_situation_ids: string[];
  /** The injected nodes whose line uses their label, not a statement (statement route unavailable). Empty when none. */
  label_only_node_ids: string[];
}

/** Builds the trace from the kept BDI nodes (with their statements) and the selected situations. */
export function buildChatTurnTrace(
  kept: { nodeId: string; statement: ChatStatement }[],
  situationIds: string[],
  labelOnlyNodeIds: string[] = [],
): ChatTurnTrace {
  return {
    context_node_ids: kept.map(k => k.nodeId),
    context_statements: kept.map(k => ({ node_id: k.nodeId, index: k.statement.index, text: k.statement.text })),
    context_situation_ids: [...situationIds],
    label_only_node_ids: [...labelOnlyNodeIds],
  };
}

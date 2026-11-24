// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat's situation cap, applied after relevance scoring. Pure: no store, no bridge.
// Rule (t/348#4 item 4): 4 situations by score; the top 2 are injected in full (sitPrimary 2),
// the other 2 abbreviated. Situations take no statement, so they need no fallback.

// The cap is defined once, in chatTaxonomyCap.ts (#5168), and re-exported here for the selector and its tests.
import { CHAT_SITUATION_CAP } from './chatTaxonomyCap';
export { CHAT_SITUATION_CAP };
export const CHAT_SITUATION_PRIMARY = 2;

export interface ScoredChatSituation {
  nodeId: string;
  score: number;
}

/** One selected situation: its id, and whether it is injected in full (the top CHAT_SITUATION_PRIMARY). */
export interface ChatSituationSlot {
  nodeId: string;
  full: boolean;
}

/**
 * Orders the pool like the BDI selection does: boosted (tagged) situations first, then by score
 * descending, then by id so ties are deterministic.
 */
function situationOrder(pool: ScoredChatSituation[], boostIds: ReadonlySet<string>): ScoredChatSituation[] {
  return [...pool].sort((a, b) => {
    const boostA = boostIds.has(a.nodeId) ? 1 : 0;
    const boostB = boostIds.has(b.nodeId) ? 1 : 0;
    if (boostA !== boostB) return boostB - boostA;
    if (a.score !== b.score) return b.score - a.score;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

/**
 * The chat turn's situations: the top `cap` of the pool, in order, with the first
 * CHAT_SITUATION_PRIMARY marked full. A negative or zero cap selects nothing.
 */
export function selectChatSituations(
  pool: ScoredChatSituation[],
  boostIds: ReadonlySet<string> = new Set(),
  cap: number = CHAT_SITUATION_CAP,
): ChatSituationSlot[] {
  const limit = Math.max(0, cap);
  return situationOrder(pool, boostIds)
    .slice(0, limit)
    .map((situation, index) => ({ nodeId: situation.nodeId, full: index < CHAT_SITUATION_PRIMARY }));
}

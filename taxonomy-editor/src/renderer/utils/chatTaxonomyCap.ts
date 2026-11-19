// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat's node cap, applied after relevance scoring. Pure: no store, no bridge.
// Rules (t/348#3, #4, #8, #9; CL confirmation t/348#17): 12 POV nodes, reserving the top 2 by score
// in each of Beliefs, Desires and Intentions, then filling 6 more by score from any BDI category.
// Nodes outside the three BDI categories never take a reserved slot. A node with no usable statement
// is skipped and its slot backfilled from the next-scored node in the same BDI category, so the block
// stays at 12 when the pool allows. Description and plain_description never reach the prompt.

export const CHAT_BDI_CATEGORIES = ['Beliefs', 'Desires', 'Intentions'] as const;
export const CHAT_NODE_CAP = 12;
export const CHAT_RESERVED_PER_CATEGORY = 2;
export const CHAT_SITUATION_CAP = 4;

export interface ScoredChatNode {
  nodeId: string;
  category: string;
  score: number;
}

/** Orders the pool: tagged nodes first when Prioritize boosts them (t/3996), then by score, then by id
 *  so ties are deterministic. */
function poolOrder(pool: ScoredChatNode[], boostIds: ReadonlySet<string>): ScoredChatNode[] {
  return [...pool].sort((a, b) => {
    const boostA = boostIds.has(a.nodeId) ? 1 : 0;
    const boostB = boostIds.has(b.nodeId) ? 1 : 0;
    if (boostA !== boostB) return boostB - boostA;
    if (a.score !== b.score) return b.score - a.score;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });
}

/** The ordered candidate list for a chat turn, before statement availability is checked. The first
 *  2 BDI nodes per category are reserved, then 6 more by pool order from any BDI category. */
export function selectChatCandidates(
  pool: ScoredChatNode[],
  boostIds: ReadonlySet<string> = new Set(),
  cap: number = CHAT_NODE_CAP,
): string[] {
  const bdi = poolOrder(pool.filter(n => (CHAT_BDI_CATEGORIES as readonly string[]).includes(n.category)), boostIds);
  const picked = new Set<string>();
  const out: ScoredChatNode[] = [];
  // A cap below 3 × CHAT_RESERVED_PER_CATEGORY can't reserve the full floor: reserve what fits.
  const perCategory = Math.min(CHAT_RESERVED_PER_CATEGORY, Math.floor(Math.max(0, cap) / CHAT_BDI_CATEGORIES.length));
  for (const category of CHAT_BDI_CATEGORIES) {
    for (const node of bdi.filter(n => n.category === category).slice(0, perCategory)) {
      picked.add(node.nodeId);
      out.push(node);
    }
  }
  for (const node of bdi) {
    if (out.length >= cap) break;
    if (picked.has(node.nodeId)) continue;
    picked.add(node.nodeId);
    out.push(node);
  }
  return poolOrder(out, boostIds).map(n => n.nodeId);
}

/** A chosen statement as the host returns it: its text, and its index in the node's statement list
 *  (the transcript trace records the index, t/348#4 rule 4). */
export interface ChatStatement { text: string; index: number }

/** Applies the statement rule to the candidates: a candidate with no statement is replaced by the next
 *  unpicked node in its own BDI category, in pool order. Returns the kept node ids with their statement
 *  text and index, and the ids that were skipped (for the WARN). */
export function resolveChatNodes(
  pool: ScoredChatNode[],
  candidates: string[],
  statements: Record<string, ChatStatement | null>,
  boostIds: ReadonlySet<string> = new Set(),
): { kept: { nodeId: string; statement: string; index: number }[]; skipped: string[] } {
  const byId = new Map(pool.map(n => [n.nodeId, n]));
  const ordered = poolOrder(pool.filter(n => (CHAT_BDI_CATEGORIES as readonly string[]).includes(n.category)), boostIds);
  const used = new Set(candidates);
  const kept: { nodeId: string; statement: string; index: number }[] = [];
  const skipped: string[] = [];
  for (const id of candidates) {
    const chosen = statements[id];
    if (chosen?.text) {
      kept.push({ nodeId: id, statement: chosen.text, index: chosen.index });
      continue;
    }
    skipped.push(id);
    const category = byId.get(id)?.category;
    if (!category) continue;
    const next = ordered.find(n => n.category === category && !used.has(n.nodeId) && statements[n.nodeId]?.text);
    if (next) {
      used.add(next.nodeId);
      const backfill = statements[next.nodeId]!;
      kept.push({ nodeId: next.nodeId, statement: backfill.text, index: backfill.index });
    }
  }
  return { kept, skipped };
}

/** One chat-block line for a selected node: `[id] "label" — statement`. */
export function formatChatNodeLine(node: { id: string; label: string }, statement: string): string {
  return `[${node.id}] "${node.label}" — ${statement}`;
}

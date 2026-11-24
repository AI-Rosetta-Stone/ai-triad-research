// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/348: the chat turn's taxonomy block. Relevance-selects per turn through the shared
// fetchRelevantNodes (one AN claim vector = the chat query, sourceType 'chat', no score floor, full
// pool), applies the 12-node BDI cap and the 4-situation cap, takes each node's statement from
// chatSyntheticStatements (skip-and-backfill), and formats through formatTaxonomyContext with
// statementFor. Never falls back to the whole taxonomy. Pure: bridge calls are injected.

import type { PovNode, SituationNode } from '../../../../lib/debate/taxonomyTypes';
import type { TagSelection } from '@lib/debate/types/session';
import { applyTagSelection } from '@lib/debate/relevanceSelection';
import { formatTaxonomyContext } from './taxonomyContext';
import type { TaxonomyContext } from './taxonomyContext';
import {
  selectChatCandidates, resolveChatNodes, CHAT_NODE_CAP, CHAT_SITUATION_CAP,
  CHAT_BDI_CATEGORIES, type ChatStatement, type ScoredChatNode,
} from './chatTaxonomyCap';
import { selectChatSituations, CHAT_SITUATION_PRIMARY, type ScoredChatSituation } from './chatTaxonomySituations';
import { chatSkipWarnings, buildChatTurnTrace, type ChatTurnTrace } from './chatTaxonomyTrace';

const QUERY_TRIM = 1000;

export interface ChatTurnQuery {
  topic: string;
  /** The POVer's previous turn text (selection query only). */
  previousPoverText: string;
  /** The chat's last user message (selection query, and the statement match per t/348#4 rule 1). */
  lastUserMessage: string;
}

/** The subset of the relevance result this module reads. */
export interface ChatRelevantResult {
  povNodes: { nodeId: string; score: number }[];
  situationNodes: { nodeId: string; score: number }[];
}

export interface ChatTurnDeps {
  computeQueryVector: (text: string) => Promise<{ vector: number[] }>;
  fetchRelevantNodes: (payload: {
    pov: string;
    topic: string;
    recentTranscript: string;
    threshold: number;
    minPerCategory: number;
    maxTotal: number;
    session: { anClaimEmbeddings: { id: string; vector: number[] }[]; sourceType: string };
  }) => Promise<ChatRelevantResult>;
  chatSyntheticStatements: (payload: {
    pov: 'accelerationist' | 'safetyist' | 'skeptic';
    queryText: string;
    nodeIds: string[];
  }) => Promise<Record<string, ChatStatement | null>>;
  /** Records a WARN (the caller routes it to the flight recorder). */
  warn: (message: string) => void;
}

export interface ChatTurnInput {
  pov: 'accelerationist' | 'safetyist' | 'skeptic';
  /** The POV's nodes after Scope narrowing (getTaxonomyContext). The pool never leaves this set. */
  ctx: TaxonomyContext;
  tagSelection?: TagSelection;
  query: ChatTurnQuery;
}

export interface ChatTurnResult {
  block: string;
  trace: ChatTurnTrace;
  /** True when relevance selection was unavailable and the deterministic fallback was used. */
  usedFallback: boolean;
}

function trimQuery(text: string): string {
  return text.trim().slice(0, QUERY_TRIM);
}

/** Deterministic fallback pool (t/348#7): file order, so the first 4 per BDI category are picked. */
function filePoolScores(nodes: PovNode[]): ScoredChatNode[] {
  return nodes
    .filter(n => (CHAT_BDI_CATEGORIES as readonly string[]).includes(n.category))
    .map((n, i) => ({ nodeId: n.id, category: n.category, score: -i }));
}

export async function buildChatTaxonomyTurn(input: ChatTurnInput, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const { pov, ctx, tagSelection, query } = input;
  const povById = new Map(ctx.povNodes.map(n => [n.id, n]));
  const situationById = new Map(ctx.situationNodes.map(n => [n.id, n]));
  const boostIds = new Set<string>(
    tagSelection?.mode === 'prioritize' ? applyTagSelection(ctx.povNodes, tagSelection).boostIds : [],
  );

  // 1. Relevance pool and situation pool. Scope is already applied: only ids in ctx.povNodes survive.
  let usedFallback = false;
  let pool: ScoredChatNode[];
  let situationScores: ScoredChatSituation[];
  const selectionQuery = [query.topic, query.lastUserMessage, query.previousPoverText]
    .map(trimQuery).filter(Boolean).join('\n');
  try {
    const { vector } = await deps.computeQueryVector(selectionQuery);
    const result = await deps.fetchRelevantNodes({
      pov,
      topic: query.topic,
      recentTranscript: trimQuery(query.previousPoverText),
      threshold: 0,
      minPerCategory: 0,
      maxTotal: ctx.povNodes.length,
      session: { anClaimEmbeddings: [{ id: 'chat-query', vector }], sourceType: 'chat' },
    });
    pool = result.povNodes
      .filter(s => povById.has(s.nodeId))
      .map(s => ({ nodeId: s.nodeId, category: povById.get(s.nodeId)!.category, score: s.score }))
      .filter(n => (CHAT_BDI_CATEGORIES as readonly string[]).includes(n.category));
    situationScores = result.situationNodes
      .filter(s => situationById.has(s.nodeId))
      .map(s => ({ nodeId: s.nodeId, score: s.score }));
  } catch (err) {
    usedFallback = true;
    deps.warn(`chat-taxonomy: reason=relevance-unavailable pov=${pov} (${err instanceof Error ? err.message : String(err)}); using deterministic fallback`);
    pool = filePoolScores(ctx.povNodes);
    situationScores = ctx.situationNodes.map((n, i) => ({ nodeId: n.id, score: -i }));
  }

  // 2. BDI cap: 12 nodes, top 2 per category reserved, Prioritize boosts first.
  const candidates = selectChatCandidates(pool, boostIds, CHAT_NODE_CAP);

  // 3. Statements for the whole pool, so a backfill has a statement to take (t/348#8).
  let statements: Record<string, ChatStatement | null> = {};
  try {
    statements = await deps.chatSyntheticStatements({
      pov,
      queryText: trimQuery(query.lastUserMessage || query.topic),
      nodeIds: pool.map(n => n.nodeId),
    });
  } catch (err) {
    deps.warn(`chat-taxonomy: reason=statements-unavailable pov=${pov} (${err instanceof Error ? err.message : String(err)}); nodes skipped`);
  }
  const { kept, skipped } = resolveChatNodes(pool, candidates, statements, boostIds);
  for (const warning of chatSkipWarnings(pov, skipped)) deps.warn(warning);

  // 4. Situation cap: 4 by score, the top 2 injected in full.
  const situationSlots = selectChatSituations(situationScores, new Set(), CHAT_SITUATION_CAP);
  const situationNodes: SituationNode[] = situationSlots
    .map(slot => situationById.get(slot.nodeId))
    .filter((n): n is SituationNode => n !== undefined);

  // 5. Format. statementFor supplies each kept node's statement; a node not kept is not in povNodes.
  const statementText = new Map(kept.map(k => [k.nodeId, k.statement]));
  const keptNodes = kept.map(k => povById.get(k.nodeId)).filter((n): n is PovNode => n !== undefined);
  const block = formatTaxonomyContext(
    { povNodes: keptNodes, situationNodes },
    pov,
    undefined,
    {
      maxNodes: CHAT_NODE_CAP,
      maxDesires: 9999,
      sitPrimary: CHAT_SITUATION_PRIMARY,
      statementFor: (id: string) => statementText.get(id),
      ...(tagSelection?.mode === 'prioritize' ? { tagSelection: { taggedIds: boostIds, mode: 'prioritize' as const } } : {}),
    },
  );

  return {
    block,
    trace: buildChatTurnTrace(
      kept.map(k => ({ nodeId: k.nodeId, statement: { text: k.statement, index: k.index } })),
      situationNodes.map(n => n.id),
    ),
    usedFallback,
  };
}

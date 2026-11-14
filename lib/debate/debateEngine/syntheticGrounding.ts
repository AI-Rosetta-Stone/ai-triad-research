// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Synthetic-statement debate grounding (t/412, feature flag useSyntheticStatementGrounding) ──
//
// Arm B of the t/412 experiment. Each selected POV node's prompt text is its best-matching
// synthetic statement against the debate query. Nodes with no usable statement are skipped and
// backfilled from the next-scored node in the same BDI category that has one. `description` and
// `plain_description` never enter the prompt (TL ruling, p/140#24), so a skipped node is removed
// from the prompt rather than falling back to its description.

import { bestMatchingSyntheticStatement } from '../syntheticStatementLookup.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';
import type { PovNode } from '../taxonomyTypes.js';
import type { ScoredPovNode } from '../taxonomyRelevance.js';

export interface SyntheticGroundingInput {
  /** Nodes chosen for the prompt, in score order. */
  selected: ScoredPovNode[];
  /** Eligible candidates, including `selected`, used as the backfill pool. */
  pool: ScoredPovNode[];
  queryVector: number[];
  nodeVectors: Record<string, { vectors?: number[][] }>;
  nodeStatements: Record<string, string[]>;
  debateId?: string;
}

export interface SyntheticGroundingResult {
  /** Nodes that enter the prompt, in order, with overrides applied. */
  nodes: PovNode[];
  /** Prompt text per node ID: the synthetic statement. */
  overrides: Map<string, string>;
  /** Node IDs skipped for having no usable statement. */
  skipped: string[];
  /** Node IDs that replaced a skipped node. */
  backfilled: string[];
}

function usableStatement(
  nodeId: string,
  input: SyntheticGroundingInput,
): string | undefined {
  const text = bestMatchingSyntheticStatement(nodeId, input.queryVector, input.nodeVectors, input.nodeStatements);
  return text && text.trim().length > 0 ? text : undefined;
}

function warn(debateId: string | undefined, message: string): void {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'debate-engine', level: 'warn', debate_id: debateId, message });
}

export function selectSyntheticGroundedPovNodes(input: SyntheticGroundingInput): SyntheticGroundingResult {
  const overrides = new Map<string, string>();
  const nodes: PovNode[] = [];
  const skipped: PovNode[] = [];
  const chosen = new Set<string>();

  for (const s of input.selected) {
    const text = usableStatement(s.node.id, input);
    if (text === undefined) {
      skipped.push(s.node);
      warn(input.debateId, `useSyntheticStatementGrounding: skipping ${s.node.id} — no usable synthetic statement`);
      continue;
    }
    nodes.push(s.node);
    overrides.set(s.node.id, text);
    chosen.add(s.node.id);
  }

  // Backfill each skip from the best-scored unused eligible node in the same category.
  const backfillPool = [...input.pool].sort((a, b) => b.score - a.score);
  const backfilled: string[] = [];
  for (const dropped of skipped) {
    const candidate = backfillPool.find(c => {
      if (chosen.has(c.node.id) || c.node.category !== dropped.category) return false;
      return usableStatement(c.node.id, input) !== undefined;
    });
    if (!candidate) {
      warn(input.debateId, `useSyntheticStatementGrounding: no backfill for ${dropped.id} in category ${dropped.category}`);
      continue;
    }
    chosen.add(candidate.node.id);
    nodes.push(candidate.node);
    overrides.set(candidate.node.id, usableStatement(candidate.node.id, input)!);
    backfilled.push(candidate.node.id);
  }

  return { nodes, overrides, skipped: skipped.map(n => n.id), backfilled };
}

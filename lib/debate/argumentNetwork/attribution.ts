// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Per-claim taxonomy attribution (t/110) ──────────────

import type { ArgumentNetworkNode, ClaimTaxonomyAttribution } from '../types.js';
import { cosineSimilarity, scoreNodeRelevanceMeanTopN } from '../taxonomyRelevance.js';
import { EXCLUSION_RATIO_THRESHOLD } from '../exclusionGuard.js';
import { bestMatchingSyntheticStatement } from '../syntheticStatementLookup.js';

/** Thresholds per spec: primary ≥ 0.35, secondary ≥ 0.40. */
const ATTRIBUTION_PRIMARY_THRESHOLD = 0.35;
const ATTRIBUTION_SECONDARY_THRESHOLD = 0.40;

export interface ClaimAttributionResult {
  attributed: number;
  unattributed: number;
  missing_embedding: number;
  novel_argument: number;
  decisions: ClaimAttributionDecision[];
}

export interface ClaimAttributionDecision {
  claim_id: string;
  primary_ref: string | null;
  attribution_confidence: number;
  secondary_refs_count: number;
  unattributed_reason?: 'novel_argument' | 'no_embedding' | 'direction_mismatch';
}

/**
 * Compute per-claim taxonomy attribution for AN nodes.
 * Compares each claim's attribution_embedding (or embedding fallback) against
 * same-POV taxonomy node embeddings using cosine similarity.
 * Mutates nodes in place (sets claim_taxonomy_attribution).
 *
 * @param nodes - AN nodes to attribute (typically newly extracted nodes)
 * @param speakerPov - The POV key for the speaker (e.g. 'accelerationist')
 * @param nodeEmbeddings - Taxonomy node embeddings keyed by node ID
 * @param candidateNodeIds - Set of taxonomy node IDs eligible for attribution (all BDI categories)
 * @param topN - Number of top vectors for mean-of-top-N multi-vector scoring
 * @param nodeStatements - Taxonomy synthetic-statement texts keyed by node ID (t/4644/t/4692),
 *   row-aligned with nodeEmbeddings[id].vectors. On a successful attribution, the claim's
 *   best-matching statement for the attributed node is stored on grounding_statement — computed
 *   once here rather than on every prompt render. Does NOT affect attribution/ranking.
 * @returns Attribution summary for diagnostics
 */
export function computeClaimTaxonomyAttribution(
  nodes: ArgumentNetworkNode[],
  speakerPov: string,
  nodeEmbeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][]; exclusion_vector?: number[] }>,
  candidateNodeIds: Set<string>,
  topN: number = 3,
  nodeStatements: Record<string, string[]> = {},
): ClaimAttributionResult {
  const decisions: ClaimAttributionDecision[] = [];
  let attributed = 0;
  let unattributed = 0;
  let missingEmbedding = 0;
  let novelArgument = 0;

  // Build per-POV candidate maps. Steelman nodes use steelman_of as effective POV instead of speakerPov.
  type CandidateEntry = [string, { vector: number[]; vectors?: number[][]; exclusion_vector?: number[] }];
  const candidatesByPov = new Map<string, CandidateEntry[]>();
  for (const [nodeId, entry] of Object.entries(nodeEmbeddings)) {
    if (!candidateNodeIds.has(nodeId) || !entry.vector?.length) continue;
    if (!candidatesByPov.has(entry.pov)) candidatesByPov.set(entry.pov, []);
    candidatesByPov.get(entry.pov)!.push([nodeId, { vector: entry.vector, vectors: entry.vectors, exclusion_vector: entry.exclusion_vector }]);
  }
  const hasMultiVector = [...candidatesByPov.values()].flat().some(([, e]) => e.vectors && e.vectors.length > 0);

  for (const node of nodes) {
    // Steelman nodes are attributed to the steelmanned camp's taxonomy, not the speaker's.
    const effectivePov = node.steelman_of ?? speakerPov;
    const candidateEntries = candidatesByPov.get(effectivePov) ?? [];
    const candidateMap = new Map(candidateEntries);

    const queryVector = node.attribution_embedding ?? node.embedding;
    if (!queryVector || queryVector.length === 0) {
      const attribution: ClaimTaxonomyAttribution = {
        primary_ref: '',
        attribution_confidence: 0,
        unattributed_reason: 'no_embedding',
      };
      node.claim_taxonomy_attribution = attribution;
      missingEmbedding++;
      unattributed++;
      decisions.push({
        claim_id: node.id,
        primary_ref: null,
        attribution_confidence: 0,
        secondary_refs_count: 0,
        unattributed_reason: 'no_embedding',
      });
      continue;
    }

    if (candidateEntries.length === 0) {
      const attribution: ClaimTaxonomyAttribution = {
        primary_ref: '',
        attribution_confidence: 0,
        unattributed_reason: 'no_embedding',
      };
      node.claim_taxonomy_attribution = attribution;
      missingEmbedding++;
      unattributed++;
      decisions.push({
        claim_id: node.id,
        primary_ref: null,
        attribution_confidence: 0,
        secondary_refs_count: 0,
        unattributed_reason: 'no_embedding',
      });
      continue;
    }

    // Compute similarity against all candidate nodes
    const similarities: { node_id: string; similarity: number }[] = [];
    if (hasMultiVector) {
      // Mean-of-top-3: build a single-node embeddings map per candidate and score
      const candidateMapRecord: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {};
      for (const [nodeId, entry] of candidateEntries) {
        candidateMapRecord[nodeId] = { pov: effectivePov, vector: entry.vector, vectors: entry.vectors };
      }
      const meanScores = scoreNodeRelevanceMeanTopN(queryVector, candidateMapRecord, topN);
      for (const [nodeId, sim] of meanScores) {
        similarities.push({ node_id: nodeId, similarity: sim });
      }
    } else {
      for (const [nodeId, entry] of candidateEntries) {
        const sim = cosineSimilarity(queryVector, entry.vector);
        similarities.push({ node_id: nodeId, similarity: sim });
      }
    }

    // Sort descending by similarity
    similarities.sort((a, b) => b.similarity - a.similarity);

    const best = similarities[0];

    if (best.similarity < ATTRIBUTION_PRIMARY_THRESHOLD) {
      // Unattributed — novel argument
      const attribution: ClaimTaxonomyAttribution = {
        primary_ref: '',
        attribution_confidence: best.similarity,
        unattributed_reason: 'novel_argument',
      };
      node.claim_taxonomy_attribution = attribution;
      novelArgument++;
      unattributed++;
      decisions.push({
        claim_id: node.id,
        primary_ref: null,
        attribution_confidence: best.similarity,
        secondary_refs_count: 0,
        unattributed_reason: 'novel_argument',
      });
      continue;
    }

    // V3 directional gate: if the best candidate has an exclusion_vector and the claim
    // is similarly close to the exclusion direction, demote to direction_mismatch (t/2746 V3).
    const bestEntry = candidateMap.get(best.node_id);
    if (bestEntry?.exclusion_vector && bestEntry.exclusion_vector.length > 0) {
      const excSim = cosineSimilarity(queryVector, bestEntry.exclusion_vector);
      if (excSim >= best.similarity * EXCLUSION_RATIO_THRESHOLD) {
        const attribution: ClaimTaxonomyAttribution = {
          primary_ref: '',
          attribution_confidence: best.similarity,
          unattributed_reason: 'direction_mismatch',
        };
        node.claim_taxonomy_attribution = attribution;
        novelArgument++;
        unattributed++;
        decisions.push({
          claim_id: node.id,
          primary_ref: null,
          attribution_confidence: best.similarity,
          secondary_refs_count: 0,
          unattributed_reason: 'direction_mismatch',
        });
        continue;
      }
    }

    // Attributed — primary ref is the best match
    const secondaryRefs = similarities
      .slice(1)
      .filter(s => s.similarity >= ATTRIBUTION_SECONDARY_THRESHOLD);

    const attribution: ClaimTaxonomyAttribution = {
      primary_ref: best.node_id,
      attribution_confidence: best.similarity,
    };
    if (secondaryRefs.length > 0) {
      attribution.secondary_refs = secondaryRefs;
    }
    const groundingStatement = bestMatchingSyntheticStatement(best.node_id, queryVector, nodeEmbeddings, nodeStatements);
    if (groundingStatement) {
      attribution.grounding_statement = groundingStatement;
    }
    node.claim_taxonomy_attribution = attribution;
    attributed++;
    decisions.push({
      claim_id: node.id,
      primary_ref: best.node_id,
      attribution_confidence: best.similarity,
      secondary_refs_count: secondaryRefs.length,
    });
  }

  return { attributed, unattributed, missing_embedding: missingEmbedding, novel_argument: novelArgument, decisions };
}

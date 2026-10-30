// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Synthetic-statement grounding (t/4644/t/4692, AC4 of t/4434) ───────
//
// Given a claim already attributed to a taxonomy node, finds that node's synthetic statement
// with the highest cosine similarity to the claim's own embedding — a better reference than
// the node's DOLCE description (t/4434#7/#8 paired-preference result). Attribution/ranking
// itself stays on the description vector; this only picks reference TEXT for an already-
// selected node. Called once per successful attribution (argumentNetwork/attribution.ts),
// stored on claim_taxonomy_attribution.grounding_statement — not recomputed per prompt render
// or per UI hover (t/4676's TL decision: the engine computes it once, everything else reads it).
//
// Zero extra I/O at call time: `nodeVectors`/`nodeStatements` are the taxonomy's already-loaded
// embeddings.vectors (taxonomyLoader.ts, from Export-SyntheticEmbeddings' .npy) and the corpus
// statement texts loaded once at taxonomy-load time (same row alignment as generate_corpus.py's
// export: non-pruned entries, grouped by node, original file order preserved).

import { cosineSimilarity } from '../embeddings/similarity.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

const warnedMismatch = new Set<string>();

/**
 * Best-matching synthetic statement for a (node, claim) pair.
 * Fail-safe: any missing or misaligned data returns undefined so callers omit the grounding
 * line rather than risk rendering a statement that doesn't correspond to its claimed vector.
 */
export function bestMatchingSyntheticStatement(
  nodeId: string,
  claimEmbedding: number[] | undefined,
  nodeVectors: Record<string, { vectors?: number[][] }>,
  nodeStatements: Record<string, string[]>,
): string | undefined {
  if (!claimEmbedding || claimEmbedding.length === 0) return undefined;

  const vectors = nodeVectors[nodeId]?.vectors;
  const statements = nodeStatements[nodeId];
  if (!vectors || !statements || vectors.length === 0 || statements.length === 0) return undefined;

  if (vectors.length !== statements.length) {
    if (!warnedMismatch.has(nodeId)) {
      warnedMismatch.add(nodeId);
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'debate-engine', level: 'warn',
        message: `Synthetic statement/vector count mismatch for ${nodeId} (${statements.length} statements vs ${vectors.length} vectors) — skipping synthetic grounding for this node`,
      });
    }
    return undefined;
  }

  let bestIdx = 0;
  let bestSim = -Infinity;
  for (let i = 0; i < vectors.length; i++) {
    const sim = cosineSimilarity(claimEmbedding, vectors[i]);
    if (sim > bestSim) { bestSim = sim; bestIdx = i; }
  }
  return statements[bestIdx];
}

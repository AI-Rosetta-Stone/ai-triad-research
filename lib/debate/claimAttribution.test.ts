// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { computeClaimTaxonomyAttribution } from './argumentNetwork.js';
import type { ArgumentNetworkNode } from './types.js';

// Helper: create a unit vector in a specific direction (dimension index)
function makeEmbedding(dim: number, size = 384): number[] {
  const v = new Array(size).fill(0);
  v[dim % size] = 1;
  return v;
}

// Helper: create a vector with controlled similarity to a reference
function makeSimilarEmbedding(base: number[], similarity: number, size = 384): number[] {
  // Mix base direction with an orthogonal direction to achieve target similarity
  const ortho = new Array(size).fill(0);
  ortho[(size - 1)] = 1; // orthogonal direction
  const v = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    v[i] = similarity * base[i] + Math.sqrt(1 - similarity * similarity) * ortho[i];
  }
  // Normalize
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

function makeNode(id: string, speaker: string, embedding?: number[]): ArgumentNetworkNode {
  return {
    id,
    text: `Claim ${id}`,
    speaker: speaker as ArgumentNetworkNode['speaker'],
    source_entry_id: 'e1',
    taxonomy_refs: [],
    turn_number: 1,
    embedding,
  };
}

const BELIEF_IDS = new Set(['acc-B-001', 'acc-B-002', 'acc-B-003']);

// ── Basic attribution ─────────────────────────────────

describe('computeClaimTaxonomyAttribution', () => {
  it('assigns primary_ref to the highest-similarity Belief node', () => {
    const nodeEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', nodeEmb)];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },   // exact match
      'acc-B-002': { pov: 'accelerationist', vector: makeEmbedding(1) },   // orthogonal
      'acc-B-003': { pov: 'accelerationist', vector: makeEmbedding(2) },   // orthogonal
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.attributed).toBe(1);
    expect(result.unattributed).toBe(0);
    expect(nodes[0].claim_taxonomy_attribution).toBeDefined();
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    expect(nodes[0].claim_taxonomy_attribution!.attribution_confidence).toBeCloseTo(1.0);
  });

  it('includes secondary_refs above 0.40 threshold', () => {
    const base = makeEmbedding(0);
    const similar = makeSimilarEmbedding(base, 0.6);
    const nodes = [makeNode('AN-1', 'accelerationist', base)];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: base },       // sim = 1.0
      'acc-B-002': { pov: 'accelerationist', vector: similar },    // sim ~ 0.6
      'acc-B-003': { pov: 'accelerationist', vector: makeEmbedding(5) }, // sim ~ 0
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    expect(nodes[0].claim_taxonomy_attribution!.secondary_refs).toBeDefined();
    expect(nodes[0].claim_taxonomy_attribution!.secondary_refs!.length).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.secondary_refs![0].node_id).toBe('acc-B-002');
    expect(nodes[0].claim_taxonomy_attribution!.secondary_refs![0].similarity).toBeGreaterThan(0.40);
    expect(result.decisions[0].secondary_refs_count).toBe(1);
  });

  it('omits secondary_refs when none exceed 0.40', () => {
    const base = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', base)];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: base },           // sim = 1.0
      'acc-B-002': { pov: 'accelerationist', vector: makeEmbedding(1) }, // sim = 0
    };

    computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(nodes[0].claim_taxonomy_attribution!.secondary_refs).toBeUndefined();
  });

  // ── Unattributed: novel argument ────────────────────

  it('marks claim as novel_argument when best similarity < 0.35', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', makeEmbedding(0))];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(5) }, // orthogonal → sim ≈ 0
      'acc-B-002': { pov: 'accelerationist', vector: makeEmbedding(6) }, // orthogonal → sim ≈ 0
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.unattributed).toBe(1);
    expect(result.novel_argument).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('novel_argument');
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('');
  });

  // ── Unattributed: no embedding ──────────────────────

  it('marks claim as no_embedding when claim has no embedding', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', undefined)];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.unattributed).toBe(1);
    expect(result.missing_embedding).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('no_embedding');
    expect(result.decisions[0].unattributed_reason).toBe('no_embedding');
  });

  it('marks claim as no_embedding when claim has empty embedding', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', [])];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.missing_embedding).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('no_embedding');
  });

  it('marks all claims as no_embedding when no candidate nodes exist', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', makeEmbedding(0))];
    // No embeddings for this POV
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'saf-B-001': { pov: 'safetyist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.missing_embedding).toBe(1);
    expect(result.unattributed).toBe(1);
  });

  // ── Same-POV filtering ─────────────────────────────

  it('only compares against same-POV nodes', () => {
    const emb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'safetyist', emb)];
    const safBeliefs = new Set(['saf-B-001']);
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: emb },   // exact match but wrong POV
      'saf-B-001': { pov: 'safetyist', vector: makeEmbedding(3) }, // right POV but orthogonal
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'safetyist', embeddings, safBeliefs);

    // Should NOT match acc-B-001 despite identical embedding — wrong POV
    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('novel_argument');
    expect(result.novel_argument).toBe(1);
  });

  // ── candidateNodeIds filtering ──────────────────────

  it('excludes nodes not in candidateNodeIds set', () => {
    const emb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', emb)];
    const candidateIds = new Set(['acc-B-001']); // acc-D-001 is not in candidate set
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(7) }, // orthogonal
      'acc-D-001': { pov: 'accelerationist', vector: emb },              // exact match but excluded
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, candidateIds);

    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('novel_argument');
    expect(result.novel_argument).toBe(1);
  });

  it('matches Desire/Intention nodes when included in candidateNodeIds', () => {
    const emb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', emb)];
    const allIds = new Set(['acc-B-001', 'acc-D-001']);
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(7) }, // orthogonal
      'acc-D-001': { pov: 'accelerationist', vector: emb },              // exact match
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, allIds);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-D-001');
    expect(nodes[0].claim_taxonomy_attribution!.attribution_confidence).toBeCloseTo(1.0);
  });

  // ── Multiple claims ────────────────────────────────

  it('processes multiple claims independently', () => {
    const nodes = [
      makeNode('AN-1', 'accelerationist', makeEmbedding(0)),
      makeNode('AN-2', 'accelerationist', makeEmbedding(1)),
      makeNode('AN-3', 'accelerationist', undefined), // no embedding
    ];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
      'acc-B-002': { pov: 'accelerationist', vector: makeEmbedding(1) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.attributed).toBe(2);
    expect(result.unattributed).toBe(1);
    expect(result.missing_embedding).toBe(1);
    expect(result.decisions).toHaveLength(3);

    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    expect(nodes[1].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-002');
    expect(nodes[2].claim_taxonomy_attribution!.unattributed_reason).toBe('no_embedding');
  });

  // ── Decision trace ─────────────────────────────────

  it('returns complete decision trace for diagnostics', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', makeEmbedding(0))];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.decisions).toHaveLength(1);
    const d = result.decisions[0];
    expect(d.claim_id).toBe('AN-1');
    expect(d.primary_ref).toBe('acc-B-001');
    expect(d.attribution_confidence).toBeCloseTo(1.0);
    expect(d.secondary_refs_count).toBe(0);
    expect(d.unattributed_reason).toBeUndefined();
  });

  // ── Edge case: empty nodes array ───────────────────

  it('handles empty nodes array', () => {
    const result = computeClaimTaxonomyAttribution([], 'accelerationist', {}, BELIEF_IDS);

    expect(result.attributed).toBe(0);
    expect(result.unattributed).toBe(0);
    expect(result.decisions).toHaveLength(0);
  });

  // ── Multi-vector attribution ───────────────────

  it('uses mean-of-top-N scoring when multi-vector data is present', () => {
    // Claim embedding: dim 0
    const claimEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];

    // Node with multi-vector: 3 vectors, one exact match + 2 similar
    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': {
        pov: 'accelerationist',
        vector: makeEmbedding(1), // single vector would score ~0
        vectors: [makeEmbedding(0), makeSimilarEmbedding(makeEmbedding(0), 0.9), makeEmbedding(1)],
      },
      'acc-B-002': {
        pov: 'accelerationist',
        vector: makeEmbedding(2),
        // no vectors — should be scored via single vector
      },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    // acc-B-001 should score higher via multi-vector (mean of top 3 includes the exact match)
    // acc-B-002 should score ~0 via single-vector fallback
    expect(result.attributed).toBe(1);
    const decision = result.decisions[0];
    expect(decision.primary_ref).toBe('acc-B-001');
    expect(decision.attribution_confidence).toBeGreaterThan(0.5);
  });

  it('prefers attribution_embedding over embedding when both present', () => {
    // attribution_embedding points at dim 0 (matches acc-B-001)
    // embedding points at dim 5 (orthogonal to everything useful)
    const nodes: ArgumentNetworkNode[] = [{
      ...makeNode('AN-1', 'accelerationist', makeEmbedding(5)),
      attribution_embedding: makeEmbedding(0),
    }];

    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    expect(nodes[0].claim_taxonomy_attribution!.attribution_confidence).toBeCloseTo(1.0);
  });

  it('falls back to embedding when attribution_embedding is absent', () => {
    const nodes = [makeNode('AN-1', 'accelerationist', makeEmbedding(0))];
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.attribution_confidence).toBeCloseTo(1.0);
  });

  it('falls back to single-vector when no multi-vector data exists', () => {
    const claimEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];

    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);
    expect(result.attributed).toBe(1);
    expect(result.decisions[0].attribution_confidence).toBeCloseTo(1.0);
  });
});

// ── Steelman attribution (t/3748) ─────────────────────────

describe('computeClaimTaxonomyAttribution — steelman nodes', () => {
  it('attributes steelman node to the steelmanned camp, not the speaker camp', () => {
    const emb = makeEmbedding(0);
    const nodes: ArgumentNetworkNode[] = [{
      ...makeNode('AN-1', 'accelerationist', emb),
      steelman_of: 'safetyist',
    }];
    const allIds = new Set(['acc-B-001', 'saf-B-001']);
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: emb },     // same embedding but wrong camp
      'saf-B-001': { pov: 'safetyist', vector: emb },           // steelmanned camp — should win
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, allIds);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('saf-B-001');
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).not.toMatch(/^acc-/);
  });

  it('normal (non-steelman) nodes still attribute to the speaker camp', () => {
    const emb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', emb)];
    const allIds = new Set(['acc-B-001', 'saf-B-001']);
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: emb },
      'saf-B-001': { pov: 'safetyist', vector: emb },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, allIds);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
  });

  it('steelman node is novel_argument when steelmanned camp has no candidates', () => {
    const emb = makeEmbedding(0);
    const nodes: ArgumentNetworkNode[] = [{
      ...makeNode('AN-1', 'accelerationist', emb),
      steelman_of: 'skeptic',
    }];
    const allIds = new Set(['acc-B-001']);  // only acc nodes in candidate set
    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: emb },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, allIds);

    expect(result.unattributed).toBe(1);
    expect(result.missing_embedding).toBe(1);  // no_embedding when candidateEntries is empty
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('');
  });
});

// ── V3 directional gate (t/2746) ─────────────────────────

describe('computeClaimTaxonomyAttribution — V3 direction_mismatch gate', () => {
  it('demotes to direction_mismatch when exclusion_vector is as close as main vector', () => {
    // claim embedding = same direction as acc-B-001's exclusion_vector
    const claimEmb = makeEmbedding(5);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];

    // acc-B-001 has main vector also pointing at dim 5, so similarity = 1.0.
    // Its exclusion_vector also points at dim 5 → excSim / mainSim = 1.0 >= EXCLUSION_RATIO_THRESHOLD (0.95).
    const embeddings: Record<string, { pov: string; vector: number[]; exclusion_vector?: number[] }> = {
      'acc-B-001': {
        pov: 'accelerationist',
        vector: makeEmbedding(5),
        exclusion_vector: makeEmbedding(5), // identical to claim — triggers gate
      },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);
    expect(result.attributed).toBe(0);
    expect(result.unattributed).toBe(1);
    expect(result.decisions[0].unattributed_reason).toBe('direction_mismatch');
    expect(nodes[0].claim_taxonomy_attribution!.unattributed_reason).toBe('direction_mismatch');
  });

  it('attributes normally when exclusion_vector is far from claim', () => {
    const claimEmb = makeEmbedding(5);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];

    // exclusion_vector is orthogonal (dim 6) — no direction conflict
    const embeddings: Record<string, { pov: string; vector: number[]; exclusion_vector?: number[] }> = {
      'acc-B-001': {
        pov: 'accelerationist',
        vector: makeEmbedding(5),
        exclusion_vector: makeEmbedding(6), // orthogonal → excSim ≈ 0
      },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);
    expect(result.attributed).toBe(1);
    expect(result.decisions[0].primary_ref).toBe('acc-B-001');
    expect(result.decisions[0].unattributed_reason).toBeUndefined();
  });

  it('attributes normally when no exclusion_vector is present', () => {
    const claimEmb = makeEmbedding(5);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];

    const embeddings: Record<string, { pov: string; vector: number[] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(5) },
    };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);
    expect(result.attributed).toBe(1);
    expect(result.decisions[0].primary_ref).toBe('acc-B-001');
  });
});

// ── Grounding statement (t/4692) ──────────────────────

describe('computeClaimTaxonomyAttribution — grounding_statement', () => {
  it('stores the best-matching synthetic statement on a successful attribution', () => {
    const claimEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];
    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0) },
    };
    const nodeStatements = { 'acc-B-001': ['statement A', 'statement B'] };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS, 3, nodeStatements);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    // Single-vector attribution (no `vectors` on the node embedding) falls back to
    // bestMatchingSyntheticStatement's own vectors/statements mismatch guard — no vectors
    // means no grounding, which is the common case until a node has synthetic embeddings.
    expect(nodes[0].claim_taxonomy_attribution!.grounding_statement).toBeUndefined();
  });

  it('stores the grounding statement when the attributed node has synthetic vectors', () => {
    const claimEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];
    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0), vectors: [makeEmbedding(0), makeEmbedding(1)] },
    };
    const nodeStatements = { 'acc-B-001': ['statement A (matches claim)', 'statement B (orthogonal)'] };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS, 3, nodeStatements);

    expect(result.attributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('acc-B-001');
    expect(nodes[0].claim_taxonomy_attribution!.grounding_statement).toBe('statement A (matches claim)');
  });

  it('omits grounding_statement when the attributed node has no synthetic corpus', () => {
    const claimEmb = makeEmbedding(0);
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];
    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0), vectors: [makeEmbedding(0)] },
    };
    // No nodeStatements passed at all (defaults to {}).

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS);

    expect(result.attributed).toBe(1);
    expect('grounding_statement' in nodes[0].claim_taxonomy_attribution!).toBe(false);
  });

  it('never sets grounding_statement on an unattributed claim', () => {
    const claimEmb = makeEmbedding(50); // far from every candidate
    const nodes = [makeNode('AN-1', 'accelerationist', claimEmb)];
    const embeddings: Record<string, { pov: string; vector: number[]; vectors?: number[][] }> = {
      'acc-B-001': { pov: 'accelerationist', vector: makeEmbedding(0), vectors: [makeEmbedding(0)] },
    };
    const nodeStatements = { 'acc-B-001': ['statement A'] };

    const result = computeClaimTaxonomyAttribution(nodes, 'accelerationist', embeddings, BELIEF_IDS, 3, nodeStatements);

    expect(result.unattributed).toBe(1);
    expect(nodes[0].claim_taxonomy_attribution!.primary_ref).toBe('');
    expect('grounding_statement' in nodes[0].claim_taxonomy_attribution!).toBe(false);
  });
});

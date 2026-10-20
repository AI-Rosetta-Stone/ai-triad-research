// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { buildGroundingEnvelope, type GroundingTaxonomy } from './inquiryGrounding.js';
import type { NodeEmbeddingMap } from './relevanceSelection.js';
import type { PovNode } from './taxonomyTypes.js';
import { TAG_SCOPE_MINIMUM_NODES } from './debateConfig.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function unitVec(dim: number, hotIndex: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hotIndex] = 1;
  return v;
}

/** Embed that returns identical vectors for all inputs (worst-case similarity = all equal). */
const flatEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map(() => unitVec(4, 0));

/** Embed that returns distinct orthogonal unit vectors per position. */
const distinctEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((_, i) => unitVec(Math.max(texts.length, 8), i));

function makeNode(id: string, label = id, pov_tags?: string[]): PovNode {
  return {
    id,
    category: 'beliefs',
    label,
    description: `description of ${label}`,
    parent_id: null,
    children: [],
    ...(pov_tags !== undefined ? { pov_tags } : {}),
  } as unknown as PovNode;
}

function makeTaxonomy(overrides: Partial<GroundingTaxonomy> = {}): GroundingTaxonomy {
  const povNodes: PovNode[] = [
    makeNode('acc-beliefs-001', 'A1'),
    makeNode('acc-beliefs-002', 'A2'),
    makeNode('saf-beliefs-001', 'S1'),
    makeNode('saf-beliefs-002', 'S2'),
    makeNode('skp-beliefs-001', 'K1'),
    makeNode('cc-beliefs-001',  'C1'),
  ];

  const nodeEmbeddings: NodeEmbeddingMap = {
    'acc-beliefs-001': { pov: 'acc', vector: unitVec(8, 0) },
    'acc-beliefs-002': { pov: 'acc', vector: unitVec(8, 1) },
    'saf-beliefs-001': { pov: 'saf', vector: unitVec(8, 2) },
    'saf-beliefs-002': { pov: 'saf', vector: unitVec(8, 3) },
    'skp-beliefs-001': { pov: 'skp', vector: unitVec(8, 4) },
    'cc-beliefs-001':  { pov: 'cc',  vector: unitVec(8, 5) },
  };

  return {
    povNodes,
    situationNodes: [
      { id: 'sit-001', label: 'AI Safety Situation', description: 'Overview of AI safety concerns' } as any,
      { id: 'sit-002', label: 'Autonomy Situation', description: 'Autonomous systems overview' } as any,
    ],
    nodeEmbeddings,
    ...overrides,
  };
}

// ── Basic behavior ───────────────────────────────────────────────────────────

describe('buildGroundingEnvelope — basic', () => {
  it('returns an envelope with nodesByCamp when corpus is populated', async () => {
    const { envelope } = await buildGroundingEnvelope('test question', makeTaxonomy(), flatEmbed);
    expect(envelope.nodesByCamp).toBeDefined();
  });

  it('groups nodes by camp', async () => {
    const { envelope } = await buildGroundingEnvelope('test question', makeTaxonomy(), flatEmbed);
    const camps = Object.keys(envelope.nodesByCamp);
    expect(camps).toContain('acc');
    expect(camps).toContain('saf');
    expect(camps).toContain('skp');
    expect(camps).toContain('cc');
  });

  it('respects topNodesPerCamp limit', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed, { topNodesPerCamp: 1 });
    for (const refs of Object.values(envelope.nodesByCamp)) {
      expect((refs ?? []).length).toBeLessThanOrEqual(1);
    }
  });

  it('NodeRef carries nodeId, label, and camp', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed);
    const accRefs = envelope.nodesByCamp['acc'] ?? [];
    expect(accRefs.length).toBeGreaterThan(0);
    const ref = accRefs[0]!;
    expect(ref.nodeId).toMatch(/^acc-/);
    expect(typeof ref.label).toBe('string');
    expect(ref.camp).toBe('acc');
  });

  it('appliedTag is undefined when no tagSelection provided', async () => {
    const { appliedTag } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed);
    expect(appliedTag).toBeUndefined();
  });
});

// ── Anchor selection ─────────────────────────────────────────────────────────

describe('buildGroundingEnvelope — anchor situation', () => {
  it('sets anchorSituationId when situations are available', async () => {
    const { envelope } = await buildGroundingEnvelope('ai safety question', makeTaxonomy(), flatEmbed);
    expect(envelope.anchorSituationId).toBeDefined();
  });

  it('uses pinned situationId when provided', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed, { situationId: 'sit-002' });
    expect(envelope.anchorSituationId).toBe('sit-002');
  });

  it('derives anchor from similarity when no situationId pinned', async () => {
    // With distinct embed: question gets vec[0], sit-001 gets vec[0] → highest similarity
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), distinctEmbed);
    expect(envelope.anchorSituationId).toBe('sit-001');
  });

  it('falls back gracefully when pinned id is not found', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed, { situationId: 'nonexistent' });
    // Should still return an envelope, possibly with a derived anchor
    expect(envelope.nodesByCamp).toBeDefined();
  });
});

// ── ADR-001 graceful-empty cases ─────────────────────────────────────────────

describe('buildGroundingEnvelope — ADR-001 graceful empty', () => {
  it('returns empty envelope when no povNodes', async () => {
    const taxonomy = makeTaxonomy({ povNodes: [], nodeEmbeddings: {} });
    const { envelope } = await buildGroundingEnvelope('q', taxonomy, flatEmbed);
    expect(envelope.nodesByCamp).toEqual({});
    expect(envelope.anchorSituationId).toBeUndefined();
  });

  it('returns empty envelope when embed throws', async () => {
    const failEmbed = async () => { throw new Error('embed failure'); };
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), failEmbed);
    expect(envelope.nodesByCamp).toEqual({});
  });

  it('returns empty envelope when embed returns empty vector', async () => {
    const emptyVecEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => []);
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), emptyVecEmbed);
    expect(envelope.nodesByCamp).toEqual({});
  });

  it('omits anchor when no situationNodes', async () => {
    const taxonomy = makeTaxonomy({ situationNodes: [] });
    const { envelope } = await buildGroundingEnvelope('q', taxonomy, flatEmbed);
    expect(envelope.anchorSituationId).toBeUndefined();
  });
});

// ── Similarity selection ─────────────────────────────────────────────────────

describe('buildGroundingEnvelope — similarity ordering', () => {
  it('places the node most similar to the question first', async () => {
    // acc-beliefs-001 has vec[0], question has vec[0] → similarity 1.0
    // acc-beliefs-002 has vec[1], question has vec[0] → similarity 0.0
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), distinctEmbed);
    const accRefs = envelope.nodesByCamp['acc'] ?? [];
    expect(accRefs[0]?.nodeId).toBe('acc-beliefs-001');
  });
});

// ── Tag selection — C5 equality and filtering (t/3965) ───────────────────────

// Taxonomy with ≥ TAG_SCOPE_MINIMUM_NODES (5) tagged nodes on skp — passes the Scope floor.
function makeTaggedTaxonomy(): GroundingTaxonomy {
    const povNodes: PovNode[] = [
      makeNode('acc-beliefs-001', 'A1'),
      makeNode('acc-beliefs-002', 'A2'),
      makeNode('saf-beliefs-001', 'S1'),
      makeNode('saf-beliefs-002', 'S2'),
      makeNode('skp-beliefs-001', 'K1', ['safety']),
      makeNode('skp-beliefs-002', 'K2', ['safety']),
      makeNode('skp-beliefs-003', 'K3', ['safety']),
      makeNode('skp-beliefs-004', 'K4', ['safety']),
      makeNode('skp-beliefs-005', 'K5', ['safety']),
      makeNode('skp-beliefs-006', 'K6'),              // untagged
      makeNode('cc-beliefs-001',  'C1'),
    ];

    const nodeEmbeddings: NodeEmbeddingMap = {
      'acc-beliefs-001': { pov: 'acc', vector: unitVec(12, 0) },
      'acc-beliefs-002': { pov: 'acc', vector: unitVec(12, 1) },
      'saf-beliefs-001': { pov: 'saf', vector: unitVec(12, 2) },
      'saf-beliefs-002': { pov: 'saf', vector: unitVec(12, 3) },
      'skp-beliefs-001': { pov: 'skp', vector: unitVec(12, 4) },
      'skp-beliefs-002': { pov: 'skp', vector: unitVec(12, 5) },
      'skp-beliefs-003': { pov: 'skp', vector: unitVec(12, 6) },
      'skp-beliefs-004': { pov: 'skp', vector: unitVec(12, 7) },
      'skp-beliefs-005': { pov: 'skp', vector: unitVec(12, 8) },
      'skp-beliefs-006': { pov: 'skp', vector: unitVec(12, 9) },
      'cc-beliefs-001':  { pov: 'cc',  vector: unitVec(12, 10) },
    };

    return {
      povNodes,
      situationNodes: [],
      nodeEmbeddings,
    };
  }

  // Taxonomy with < TAG_SCOPE_MINIMUM_NODES tagged nodes — triggers the thin-Scope refusal (t/3965#13).
  function makeThinTaggedTaxonomy(): GroundingTaxonomy {
    const povNodes: PovNode[] = [
      makeNode('skp-beliefs-001', 'K1', ['safety']),  // tagged (only 1 — below floor)
      makeNode('skp-beliefs-002', 'K2'),              // untagged
      makeNode('skp-beliefs-003', 'K3'),
    ];
    const nodeEmbeddings: NodeEmbeddingMap = {
      'skp-beliefs-001': { pov: 'skp', vector: unitVec(4, 0) },
      'skp-beliefs-002': { pov: 'skp', vector: unitVec(4, 1) },
      'skp-beliefs-003': { pov: 'skp', vector: unitVec(4, 2) },
    };
    return { povNodes, situationNodes: [], nodeEmbeddings };
  }

describe('buildGroundingEnvelope — tag selection', () => {
  // C5: tag on 'skeptic' — Acc and Saf envelopes toEqual the untagged run (t/3965)
  it('C5: acc and saf nodesByCamp are identical to untagged run when tag scopes skeptic', async () => {
    const taxonomy = makeTaggedTaxonomy();
    const { envelope: untagged } = await buildGroundingEnvelope('q', taxonomy, flatEmbed);
    const { envelope: tagged } = await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
    });

    // Other camps are byte-for-byte identical to the untagged run (POV-scoped correctness)
    expect(tagged.nodesByCamp['acc']).toEqual(untagged.nodesByCamp['acc']);
    expect(tagged.nodesByCamp['saf']).toEqual(untagged.nodesByCamp['saf']);
    expect(tagged.nodesByCamp['cc']).toEqual(untagged.nodesByCamp['cc']);
  });

  it('C5: acc and saf nodesByCamp are identical to untagged run when tag prioritizes skeptic', async () => {
    const taxonomy = makeTaggedTaxonomy();
    const { envelope: untagged } = await buildGroundingEnvelope('q', taxonomy, flatEmbed);
    const { envelope: tagged } = await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'prioritize' },
    });

    expect(tagged.nodesByCamp['acc']).toEqual(untagged.nodesByCamp['acc']);
    expect(tagged.nodesByCamp['saf']).toEqual(untagged.nodesByCamp['saf']);
    expect(tagged.nodesByCamp['cc']).toEqual(untagged.nodesByCamp['cc']);
  });

  it('scope mode: skp camp contains only tagged nodes', async () => {
    const taxonomy = makeTaggedTaxonomy();
    const { envelope } = await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
    });
    const skpRefs = envelope.nodesByCamp['skp'] ?? [];
    expect(skpRefs.length).toBeGreaterThan(0);
    // Every returned node must be tagged (skp-beliefs-006 is the only untagged one)
    for (const ref of skpRefs) {
      expect(ref.nodeId).not.toBe('skp-beliefs-006');
    }
  });

  it('scope mode: appliedTag carries correct pov/tag/mode/included/excludedUntagged', async () => {
    const taxonomy = makeTaggedTaxonomy();
    const { appliedTag } = await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
    });
    expect(appliedTag).toBeDefined();
    expect(appliedTag!.pov).toBe('skeptic');
    expect(appliedTag!.tag).toBe('safety');
    expect(appliedTag!.mode).toBe('scope');
    expect(appliedTag!.included).toBe(5);   // 5 tagged nodes in makeTaggedTaxonomy
    expect(appliedTag!.excludedUntagged).toBe(1);
  });

  it('prioritize mode: appliedTag has excludedUntagged=0', async () => {
    const taxonomy = makeTaggedTaxonomy();
    const { appliedTag } = await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'prioritize' },
    });
    expect(appliedTag).toBeDefined();
    expect(appliedTag!.mode).toBe('prioritize');
    expect(appliedTag!.excludedUntagged).toBe(0);
    expect(appliedTag!.included).toBe(5);   // 5 tagged nodes in makeTaggedTaxonomy
  });
});

// ── Thin-Scope and zero-tag refusal (t/3965#13) ──────────────────────────────

describe('buildGroundingEnvelope — thin-scope / no-tag refusal', () => {
  it('scope mode: throws ActionableError when tagged nodes below floor', async () => {
    const taxonomy = makeThinTaggedTaxonomy(); // 1 tagged < TAG_SCOPE_MINIMUM_NODES
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
      }),
    ).rejects.toThrow(/Scope is too thin/);
  });

  it('scope mode: error message includes in-scope count, total camp count, and minimum', async () => {
    const taxonomy = makeThinTaggedTaxonomy();
    let msg = '';
    try {
      await buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
      });
    } catch (e) { msg = String(e); }
    expect(msg).toContain('1');   // in-scope count
    expect(msg).toContain('3');   // total camp node count (makeThinTaggedTaxonomy has 3 skp nodes)
    expect(msg).toContain(String(TAG_SCOPE_MINIMUM_NODES));  // minimum
  });

  it('scope mode: throws with none-tagged error when included === 0 (degenerate)', async () => {
    const taxonomy = makeThinTaggedTaxonomy();
    // Use a tag that no node carries — reason is none-tagged, not below-floor
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'nonexistent', mode: 'scope' },
      }),
    ).rejects.toThrow(/No nodes carry tag/);
  });

  it('prioritize mode: throws when no node carries the tag (included === 0)', async () => {
    const taxonomy = makeThinTaggedTaxonomy();
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'nonexistent', mode: 'prioritize' },
      }),
    ).rejects.toThrow(/No nodes carry tag/);
  });

  it('prioritize mode: succeeds when at least one node carries the tag (no floor)', async () => {
    const taxonomy = makeThinTaggedTaxonomy(); // 1 tagged — enough for Prioritize
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'prioritize' },
      }),
    ).resolves.toBeDefined();
  });

  it('scope mode: refuses with none-tagged when tagged camp has no embeddings (pre-loop guard, t/4009)', async () => {
    // skp node is tagged but has no embedding — groundable count is 0 → none-tagged reason.
    // (Before t/4009 this would have been reason='below-floor' counting unembedded nodes.)
    const taxonomy: GroundingTaxonomy = {
      povNodes: [makeNode('skp-beliefs-001', 'K1', ['safety'])], // 1 tagged, no embedding
      situationNodes: [],
      nodeEmbeddings: {
        'acc-beliefs-001': { pov: 'acc', vector: unitVec(4, 0) }, // only acc embedded
      },
    };
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
      }),
    ).rejects.toThrow(/No groundable nodes/);
  });

  it('scope mode: unembedded tagged nodes do NOT count toward the floor (t/4009)', async () => {
    // 5 tagged skp nodes, only 2 have embeddings → 2 groundable < floor (5) → refuses.
    // (Before t/4009 this resolved because the floor counted all 5 tagged nodes.)
    const povNodes = Array.from({ length: 5 }, (_, i) =>
      makeNode(`skp-beliefs-00${i + 1}`, `K${i + 1}`, ['safety']),
    );
    const nodeEmbeddings: NodeEmbeddingMap = {
      'skp-beliefs-001': { pov: 'skp', vector: unitVec(4, 0) },
      'skp-beliefs-002': { pov: 'skp', vector: unitVec(4, 1) },
    };
    const taxonomy: GroundingTaxonomy = { povNodes, situationNodes: [], nodeEmbeddings };
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
      }),
    ).rejects.toThrow(/Scope is too thin/);
  });

  it('scope mode: resolves when enough groundable nodes even if some tagged nodes lack embeddings (t/4009)', async () => {
    // 7 tagged skp nodes, 5 have embeddings, 2 do not → 5 groundable ≥ floor → passes.
    // The 2 unembedded ones trigger a WARN but do not block.
    const povNodes = Array.from({ length: 7 }, (_, i) =>
      makeNode(`skp-beliefs-0${String(i + 1).padStart(2, '0')}`, `K${i + 1}`, ['safety']),
    );
    const nodeEmbeddings: NodeEmbeddingMap = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `skp-beliefs-0${String(i + 1).padStart(2, '0')}`,
        { pov: 'skp', vector: unitVec(8, i) },
      ]),
    );
    const taxonomy: GroundingTaxonomy = { povNodes, situationNodes: [], nodeEmbeddings };
    await expect(
      buildGroundingEnvelope('q', taxonomy, flatEmbed, {
        tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
      }),
    ).resolves.toBeDefined();
  });
});

// ── POV file-name normalization (t/4255 regression) ──────────────────────────
// Embedding producers stamp pov with the file name ("skeptic", "accelerationist",
// "safetyist", "cross-cutting") rather than the camp code ("skp", "acc", "saf",
// "cc"). The old isCamp() guard silently dropped every such entry, leaving all
// camps empty and every inquiry returning no grounding nodes.

describe('buildGroundingEnvelope — pov file-name normalization (t/4255)', () => {
  function makeFileNameTaxonomy(): GroundingTaxonomy {
    const povNodes: PovNode[] = [
      makeNode('acc-beliefs-001', 'A1'),
      makeNode('acc-beliefs-002', 'A2'),
      makeNode('saf-beliefs-001', 'S1'),
      makeNode('saf-beliefs-002', 'S2'),
      makeNode('skp-beliefs-001', 'K1', ['safety']),
      makeNode('skp-beliefs-002', 'K2', ['safety']),
      makeNode('skp-beliefs-003', 'K3', ['safety']),
      makeNode('skp-beliefs-004', 'K4', ['safety']),
      makeNode('skp-beliefs-005', 'K5', ['safety']),
      makeNode('cc-beliefs-001',  'C1'),
    ];
    // Stamped with file names as assembleNodeEmbeddings produces, NOT camp codes.
    const nodeEmbeddings: NodeEmbeddingMap = {
      'acc-beliefs-001': { pov: 'accelerationist', vector: unitVec(12, 0) },
      'acc-beliefs-002': { pov: 'accelerationist', vector: unitVec(12, 1) },
      'saf-beliefs-001': { pov: 'safetyist',       vector: unitVec(12, 2) },
      'saf-beliefs-002': { pov: 'safetyist',       vector: unitVec(12, 3) },
      'skp-beliefs-001': { pov: 'skeptic',          vector: unitVec(12, 4) },
      'skp-beliefs-002': { pov: 'skeptic',          vector: unitVec(12, 5) },
      'skp-beliefs-003': { pov: 'skeptic',          vector: unitVec(12, 6) },
      'skp-beliefs-004': { pov: 'skeptic',          vector: unitVec(12, 7) },
      'skp-beliefs-005': { pov: 'skeptic',          vector: unitVec(12, 8) },
      'cc-beliefs-001':  { pov: 'cross-cutting',    vector: unitVec(12, 9) },
    };
    return { povNodes, situationNodes: [], nodeEmbeddings };
  }

  it('populates all four camps from file-name-stamped embeddings', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeFileNameTaxonomy(), flatEmbed);
    expect((envelope.nodesByCamp['acc'] ?? []).length).toBeGreaterThan(0);
    expect((envelope.nodesByCamp['saf'] ?? []).length).toBeGreaterThan(0);
    expect((envelope.nodesByCamp['skp'] ?? []).length).toBeGreaterThan(0);
    expect((envelope.nodesByCamp['cc'] ?? []).length).toBeGreaterThan(0);
  });

  it('accepts cross-cutting → cc normalization', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeFileNameTaxonomy(), flatEmbed);
    const ccRefs = envelope.nodesByCamp['cc'] ?? [];
    expect(ccRefs.length).toBeGreaterThan(0);
    expect(ccRefs[0]?.nodeId).toBe('cc-beliefs-001');
  });

  it('tag selection works against file-name-stamped embeddings and returns appliedTag', async () => {
    const { appliedTag } = await buildGroundingEnvelope('q', makeFileNameTaxonomy(), flatEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'scope' },
    });
    expect(appliedTag).toBeDefined();
    expect(appliedTag!.pov).toBe('skeptic');
    expect(appliedTag!.included).toBe(5);
  });
});

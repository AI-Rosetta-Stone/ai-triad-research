// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { buildGroundingEnvelope, type GroundingTaxonomy } from './inquiryGrounding.js';
import { formatGroundingContext } from './prompts/inquiry.js';
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
    // Situation nodes must be precomputed — production code reads nodeEmbeddings[s.id]
    // instead of re-embedding. sit-001 gets vec[0] so it wins when question is vec[0].
    'sit-001': { pov: 'acc', vector: unitVec(8, 0) },
    'sit-002': { pov: 'acc', vector: unitVec(8, 1) },
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

// ── Label deduplication in buildGroundingEnvelope (t/4352) ───────────────────

describe('buildGroundingEnvelope — label deduplication', () => {
  function makeDedupTaxonomy(): GroundingTaxonomy {
    // acc camp: 001 and 002 share the same label; 003 has a unique label.
    // With distinctEmbed, questionVec = unitVec(8, 0).
    // Scores: 001 → 1.0, 002 → 0.0, 003 → 0.0 (tie broken by insertion order: 002 < 003).
    // Sort order: [001, 002, 003]. Dedup skips 002 (dup of 001) and backfills with 003.
    const povNodes: PovNode[] = [
      makeNode('acc-beliefs-001', 'Dup'),
      makeNode('acc-beliefs-002', 'Dup'),
      makeNode('acc-beliefs-003', 'U3'),
    ];
    const nodeEmbeddings: NodeEmbeddingMap = {
      'acc-beliefs-001': { pov: 'acc', vector: unitVec(8, 0) },
      'acc-beliefs-002': { pov: 'acc', vector: unitVec(8, 1) },
      'acc-beliefs-003': { pov: 'acc', vector: unitVec(8, 2) },
    };
    return { povNodes, situationNodes: [], nodeEmbeddings };
  }

  it('skips the duplicate-label node and backfills with the next unique one', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeDedupTaxonomy(), distinctEmbed);
    const refs = envelope.nodesByCamp['acc'] ?? [];
    const ids = refs.map(r => r.nodeId);
    expect(ids).toContain('acc-beliefs-001');
    expect(ids).not.toContain('acc-beliefs-002');
    expect(ids).toContain('acc-beliefs-003');
  });

  it('leaves selection unchanged when no label duplicates exist', async () => {
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), flatEmbed);
    const allLabels = Object.values(envelope.nodesByCamp).flat().map(r => r.label);
    const uniqueLabels = new Set(allLabels.map(l => l.trim().toLowerCase()));
    expect(uniqueLabels.size).toBe(allLabels.length);
  });
});

// ── Low coverage flag (t/4374) ───────────────────────────────────────────────

describe('buildGroundingEnvelope — low coverage (t/4374)', () => {
  it('sets lowCoverage on a camp whose best raw score is below 0.45', async () => {
    // distinctEmbed: question gets vec[0], acc-beliefs-001 gets vec[0] → similarity 1.0 (above threshold)
    // All other camp nodes are orthogonal to question → similarity 0.0 (below threshold)
    const { envelope } = await buildGroundingEnvelope('q', makeTaxonomy(), distinctEmbed);
    expect(envelope.campCoverage?.['acc']?.lowCoverage).toBe(false);
    expect(envelope.campCoverage?.['saf']?.lowCoverage).toBe(true);
    expect(envelope.campCoverage?.['skp']?.lowCoverage).toBe(true);
  });

  it('flags a camp as lowCoverage when boosted score would exceed 0.45 but raw score does not', async () => {
    // TAG_BOOST_INCREMENT = 0.08; raw = 0.44 < 0.45, boosted = 0.52 ≥ 0.45 → raw wins → lowCoverage=true
    const rawTarget = 0.44;
    const rawVec = [rawTarget, Math.sqrt(1 - rawTarget * rawTarget)];
    const questionVec = [1, 0];
    const customEmbed = async (texts: string[]): Promise<number[][]> =>
      texts.map((_, i) => (i === 0 ? questionVec : rawVec));
    const taxonomy: GroundingTaxonomy = {
      povNodes: [makeNode('skp-beliefs-001', 'K1', ['safety'])],
      situationNodes: [],
      nodeEmbeddings: { 'skp-beliefs-001': { pov: 'skp', vector: rawVec } },
    };
    const { envelope } = await buildGroundingEnvelope('q', taxonomy, customEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'safety', mode: 'prioritize' },
    });
    expect(envelope.campCoverage?.['skp']?.lowCoverage).toBe(true);
    expect(envelope.campCoverage?.['skp']?.bestRawScore).toBeCloseTo(rawTarget, 2);
  });

  it('leaves nodes unchanged and records no lowCoverage when all camps are above threshold', async () => {
    // All node vectors match the question vector → cosine 1.0 → all camps above 0.45
    const highVec = unitVec(4, 0);
    const allHighTaxonomy: GroundingTaxonomy = {
      povNodes: [
        makeNode('acc-beliefs-001', 'A1'),
        makeNode('saf-beliefs-001', 'S1'),
        makeNode('skp-beliefs-001', 'K1'),
        makeNode('cc-beliefs-001',  'C1'),
      ],
      situationNodes: [],
      nodeEmbeddings: {
        'acc-beliefs-001': { pov: 'acc', vector: highVec },
        'saf-beliefs-001': { pov: 'saf', vector: highVec },
        'skp-beliefs-001': { pov: 'skp', vector: highVec },
        'cc-beliefs-001':  { pov: 'cc',  vector: highVec },
      },
    };
    const { envelope } = await buildGroundingEnvelope('q', allHighTaxonomy, flatEmbed);
    expect(envelope.campCoverage?.['acc']?.lowCoverage).toBe(false);
    expect(envelope.campCoverage?.['saf']?.lowCoverage).toBe(false);
    expect(envelope.campCoverage?.['skp']?.lowCoverage).toBe(false);
    expect(envelope.campCoverage?.['cc']?.lowCoverage).toBe(false);
    expect((envelope.nodesByCamp['acc'] ?? []).length).toBeGreaterThan(0);
  });
});

// ── Low coverage: SCOPE excludes the only high-scoring node (t/4374 item 1) ──

describe('buildGroundingEnvelope — low coverage under SCOPE (t/4374)', () => {
  it('SCOPE: lowCoverage=true when only node above threshold is untagged and excluded', async () => {
    // skp has 5 tagged nodes (meets floor) all with score 0.0, and 1 untagged node with score 1.0.
    // Under SCOPE, the untagged node is excluded — eligible set has only the 5 tagged nodes → rawBestScore=0 < 0.45.
    const povNodes: PovNode[] = [
      makeNode('skp-beliefs-001', 'K1', ['critical']),
      makeNode('skp-beliefs-002', 'K2', ['critical']),
      makeNode('skp-beliefs-003', 'K3', ['critical']),
      makeNode('skp-beliefs-004', 'K4', ['critical']),
      makeNode('skp-beliefs-005', 'K5', ['critical']),
      makeNode('skp-beliefs-006', 'K6'),   // untagged — only match above threshold
    ];
    // question = unitVec(8,0); skp-beliefs-006 = unitVec(8,0) → score 1.0; all tagged = unitVec(8,1..5) → score 0.0
    const nodeEmbeddings: NodeEmbeddingMap = {
      'skp-beliefs-001': { pov: 'skp', vector: unitVec(8, 1) },
      'skp-beliefs-002': { pov: 'skp', vector: unitVec(8, 2) },
      'skp-beliefs-003': { pov: 'skp', vector: unitVec(8, 3) },
      'skp-beliefs-004': { pov: 'skp', vector: unitVec(8, 4) },
      'skp-beliefs-005': { pov: 'skp', vector: unitVec(8, 5) },
      'skp-beliefs-006': { pov: 'skp', vector: unitVec(8, 0) }, // high-scoring but untagged
    };
    const taxonomy: GroundingTaxonomy = { povNodes, situationNodes: [], nodeEmbeddings };
    const { envelope } = await buildGroundingEnvelope('q', taxonomy, distinctEmbed, {
      tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' },
    });
    expect(envelope.campCoverage?.['skp']?.lowCoverage).toBe(true);
    // The untagged high-scoring node must NOT appear in the grounded set
    const skpIds = (envelope.nodesByCamp['skp'] ?? []).map(r => r.nodeId);
    expect(skpIds).not.toContain('skp-beliefs-006');
  });
});

// ── formatGroundingContext NOTE line (t/4374 item 3) ────────────────────────

describe('formatGroundingContext — NOTE line for low-coverage camps (t/4374)', () => {
  it('emits a NOTE line for a low-coverage camp', () => {
    const nodesByCamp = { acc: [{ nodeId: 'acc-beliefs-001', label: 'A1' }] };
    const campCoverage = { acc: { lowCoverage: true } };
    const result = formatGroundingContext(nodesByCamp, campCoverage);
    expect(result).toContain('NOTE (acc): the taxonomy has no position that closely matches this question.');
  });

  it('does not emit a NOTE line for a covered camp', () => {
    const nodesByCamp = { acc: [{ nodeId: 'acc-beliefs-001', label: 'A1' }] };
    const campCoverage = { acc: { lowCoverage: false } };
    const result = formatGroundingContext(nodesByCamp, campCoverage);
    expect(result).not.toContain('NOTE (acc)');
  });

  it('does not emit a NOTE line when campCoverage is omitted', () => {
    const nodesByCamp = { acc: [{ nodeId: 'acc-beliefs-001', label: 'A1' }] };
    const result = formatGroundingContext(nodesByCamp);
    expect(result).not.toContain('NOTE');
  });
});

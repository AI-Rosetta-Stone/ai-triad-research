// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for selectRelevantTaxonomy label deduplication (t/4352, t/4369).

import { describe, it, expect } from 'vitest';
import { selectRelevantTaxonomy, type SelectRelevantTaxonomyInput, type NodeEmbeddingMap } from './relevanceSelection.js';
import type { PovNode } from './taxonomyTypes.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function unitVec(dim: number, hotIndex: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[hotIndex] = 1;
  return v;
}

function makeNode(id: string, label: string): PovNode {
  return { id, label, description: '', category: 'Beliefs' } as unknown as PovNode;
}

// embed returns a unit vector per text by position; the topic-query gets index 0.
const mockEmbed: SelectRelevantTaxonomyInput['embed'] = async texts =>
  texts.map((_, i) => unitVec(4, i));

function makeInput(
  povNodes: PovNode[],
  overrides: Partial<SelectRelevantTaxonomyInput> = {},
): SelectRelevantTaxonomyInput {
  const nodeEmbeddings: NodeEmbeddingMap = {};
  for (let i = 0; i < povNodes.length; i++) {
    // Each node gets a distinct unit vector so scores are deterministic.
    // queryVec = unitVec(4, 0) (from embed([topic-query])), so node 0 scores 1.0, rest score 0.0.
    nodeEmbeddings[povNodes[i].id] = { pov: 'acc', vector: unitVec(4, i) };
  }
  return {
    povNodes,
    situationNodes: [],
    policyRegistry: [],
    nodeEmbeddings,
    session: { anClaimEmbeddings: [] },
    params: {
      pov: 'acc',
      topic: 'test',
      recentTranscript: '',
      threshold: 0.0,
      minPerCategory: 1,
      maxTotal: 50,
    },
    embed: mockEmbed,
    ...overrides,
  };
}

// ── Label deduplication in selectRelevantTaxonomy (t/4352) ───────────────────

describe('selectRelevantTaxonomy — label deduplication', () => {
  it('skips a node whose label duplicates an already-selected node', async () => {
    // 001 (score 1.0) and 002 (score 0.0) share label "Dup".
    // 001 is selected first; 002 is skipped; 003 ("Other") is selected.
    const nodes = [
      makeNode('acc-beliefs-001', 'Dup'),
      makeNode('acc-beliefs-002', 'Dup'),
      makeNode('acc-beliefs-003', 'Other'),
    ];
    const result = await selectRelevantTaxonomy(makeInput(nodes));
    const ids = result.povNodes.map(n => n.nodeId);
    expect(ids).toContain('acc-beliefs-001');
    expect(ids).not.toContain('acc-beliefs-002');
    expect(ids).toContain('acc-beliefs-003');
    expect(result.injectionManifest.label_dedup).toBeDefined();
    const dedup = result.injectionManifest.label_dedup as string[];
    expect(dedup.some(s => s.includes('acc-beliefs-002') && s.includes('acc-beliefs-001'))).toBe(true);
  });

  it('does not change selection when no label duplicates exist', async () => {
    const nodes = [
      makeNode('acc-beliefs-001', 'Accelerating Growth'),
      makeNode('acc-beliefs-002', 'Compute Scaling'),
      makeNode('acc-beliefs-003', 'Open Research'),
    ];
    const result = await selectRelevantTaxonomy(makeInput(nodes));
    const ids = result.povNodes.map(n => n.nodeId);
    expect(ids).toContain('acc-beliefs-001');
    expect(ids).toContain('acc-beliefs-002');
    expect(ids).toContain('acc-beliefs-003');
    expect(result.injectionManifest.label_dedup).toBeUndefined();
  });

  it('backfills to meet minPerCategory floor after twin is removed (t/4369 gap 1)', async () => {
    // Category "Beliefs", minPerCategory: 3.
    // 001 (score 1.0) and 002 (score 0.0) share label "Dup Twin".
    // Pre-dedup removes 002, leaving pool {001, 003, 004} → floor=3 selects all 3.
    // Post-dedup (old) would: select {001,002,003} to meet floor=3, then remove 002 → count=2 (violated).
    const nodes = [
      makeNode('acc-beliefs-001', 'Dup Twin'),
      makeNode('acc-beliefs-002', 'Dup Twin'),
      makeNode('acc-beliefs-003', 'Unique Alpha'),
      makeNode('acc-beliefs-004', 'Unique Beta'),
    ];
    const result = await selectRelevantTaxonomy(makeInput(nodes, {
      params: { pov: 'acc', topic: 'test', recentTranscript: '', threshold: 0.0, minPerCategory: 3, maxTotal: 50 },
    }));
    const ids = result.povNodes.map(n => n.nodeId);
    expect(ids).toContain('acc-beliefs-001');
    expect(ids).not.toContain('acc-beliefs-002');
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps same-label nodes from different camps (t/4369 gap 2)', async () => {
    // "Open Research" appears in both acc and saf — per-camp keying must keep both.
    const nodes = [
      makeNode('acc-beliefs-001', 'Open Research'),
      makeNode('saf-beliefs-001', 'Open Research'),
      makeNode('acc-beliefs-002', 'Safety Limits'),
    ];
    const result = await selectRelevantTaxonomy(makeInput(nodes));
    const ids = result.povNodes.map(n => n.nodeId);
    expect(ids).toContain('acc-beliefs-001');
    expect(ids).toContain('saf-beliefs-001');
  });
});

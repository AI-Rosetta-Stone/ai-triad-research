// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4433 — the shared debate corpus (relevant-nodes, attribution, inquiry grounding) holds only the
// selectable POV set. Superseded nodes stay in the file but never reach scoring.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const POV_NODES = [
  { id: 'acc-beliefs-001', label: 'Survivor', description: 'kept' },
  { id: 'acc-beliefs-002', label: 'Retired', description: 'merged', superseded_by: 'acc-beliefs-001' },
  { id: 'acc-beliefs-003', label: 'Chain start', description: 'merged twice', superseded_by: 'acc-beliefs-002' },
  { id: 'acc-beliefs-004', label: 'Plain', description: 'kept' },
];
const SIT_NODES = [{ id: 'cc-001', label: 'Situation', description: 'kept' }];

vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: vi.fn(async (pov: string) => (pov === 'situations' ? { nodes: SIT_NODES } : { nodes: POV_NODES })),
  loadSyntheticEmbeddings: vi.fn(async () => ({
    'acc-beliefs-001': { pov: 'accelerationist', vectors: [[1, 0, 0]] },
    'acc-beliefs-002': { pov: 'accelerationist', vectors: [[0, 1, 0]] },
  })),
}));
vi.mock('../ai/aiBackends.js', () => ({
  computeEmbeddings: vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]) })),
}));

import { getAssembledCorpus, __resetCorpusCacheForTest } from '../routes/corpusAssemblyCache.js';

describe('getAssembledCorpus — selectable POV set only (t/4433)', () => {
  beforeEach(() => __resetCorpusCacheForTest());

  it('drops superseded nodes, including chain members, from povNodes', async () => {
    const corpus = await getAssembledCorpus('accelerationist');
    expect(corpus.povNodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-004']);
  });

  it('gives superseded nodes no embedding, even when a synthetic vector exists for them', async () => {
    const corpus = await getAssembledCorpus('accelerationist');
    expect(Object.keys(corpus.nodeEmbeddings).sort()).toEqual(['acc-beliefs-001', 'acc-beliefs-004', 'cc-001']);
    expect(corpus.allNodeIds).not.toContain('acc-beliefs-002');
    expect(corpus.allNodeIds).not.toContain('acc-beliefs-003');
  });

  it('leaves situation nodes untouched', async () => {
    const corpus = await getAssembledCorpus('accelerationist');
    expect(corpus.situationNodes.map(n => n.id)).toEqual(['cc-001']);
  });
});

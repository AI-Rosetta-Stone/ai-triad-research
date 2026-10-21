// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355: superseded POV nodes through the real store: load split, save round-trip, read-only edits,
// id uniqueness, rename cascade, integrity. Mock setup mirrors useTaxonomyStore.saveConflict.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApi } = vi.hoisted(() => {
  const mockApi = {
    loadTaxonomyFile: vi.fn().mockResolvedValue({ nodes: [] }),
    loadTaxonomyFileForEdit: vi.fn().mockResolvedValue({ nodes: [] }),
    saveTaxonomyFile: vi.fn().mockResolvedValue(undefined),
    loadPolicyRegistry: vi.fn().mockResolvedValue({ policies: [] }),
    loadConflictFiles: vi.fn().mockResolvedValue([]),
    loadConflictClusters: vi.fn().mockResolvedValue({ clusters: [] }),
    loadAggregatedCruxes: vi.fn().mockResolvedValue({ cruxes: [] }),
    saveConflictFile: vi.fn().mockResolvedValue(undefined),
    syncCommit: vi.fn().mockResolvedValue({ commitSha: 'abc', filesCommitted: 1 }),
    updateNodeEmbeddings: vi.fn().mockResolvedValue(undefined),
    loadEdges: vi.fn().mockResolvedValue({ edges: [] }),
    loadAIModels: vi.fn().mockResolvedValue(null),
    computeEmbeddings: vi.fn().mockResolvedValue({ vectors: [] }),
    computeQueryEmbedding: vi.fn().mockResolvedValue({ vector: [] }),
    generateText: vi.fn().mockResolvedValue({ text: '{}' }),
    nliClassify: vi.fn().mockResolvedValue({ results: [] }),
    hasApiKey: vi.fn().mockResolvedValue(false),
    onGenerateTextProgress: vi.fn().mockReturnValue(() => {}),
    trackEvent: vi.fn(),
    saveEdges: vi.fn().mockResolvedValue(undefined),
  };
  return { mockApi };
});

vi.mock('@bridge', () => ({ api: mockApi }));

vi.mock('@lib/debate', () => ({
  normalizeNodeProperties: vi.fn(),
}));

vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodeTypeFromId: vi.fn((id: string) => {
    if (id.startsWith('sit-')) return 'situation';
    if (id.startsWith('cc-')) return 'situation';
    return 'pov';
  }),
}));

vi.mock('@lib/debate/types', () => ({
  POV_KEYS: ['accelerationist', 'safetyist', 'skeptic'],
}));

vi.mock('@lib/debate/validators', () => ({
  validateTaxonomy: vi.fn().mockReturnValue({ issues: [] }),
}));

vi.mock('@lib/debate/validateNodeId', () => ({
  validatePovNodeId: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
}));

vi.mock('../utils/validation', () => ({
  povTaxonomyFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  crossCuttingFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  conflictFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  extractPovErrors: vi.fn().mockReturnValue({}),
  extractConflictErrors: vi.fn().mockReturnValue({}),
  stripInvalidLogicalForm: vi.fn().mockReturnValue({ removed: false }),
}));

vi.mock('../utils/similarity', () => ({
  rankBySimilarity: vi.fn().mockReturnValue([]),
}));

vi.mock('../utils/errorMessages', () => ({
  mapErrorToUserMessage: vi.fn((err: unknown) => String(err)),
}));


import { useTaxonomyStore } from './useTaxonomyStore';
import { __resetSupersededCacheForTests } from './useTaxonomyStore/superseded';
import type { PovTaxonomyFile, PovNode } from '../types/taxonomy';

const node = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: `label ${id}`, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);
const povFile = (pov: string, nodes: PovNode[]): PovTaxonomyFile => ({ pov, last_modified: '2026-01-01', nodes } as PovTaxonomyFile);

// acc-beliefs-002 is a twin retired in favour of acc-beliefs-001; it sits between two live nodes on disk.
const A1 = node('acc-beliefs-001');
const A2 = node('acc-beliefs-002', { superseded_by: 'acc-beliefs-001', parent_id: 'acc-beliefs-003' });
const A3 = node('acc-beliefs-003');

async function load() {
  mockApi.loadTaxonomyFileForEdit.mockImplementation((pov: string) => {
    if (pov === 'accelerationist') return Promise.resolve(povFile('accelerationist', [A1, A2, A3]));
    if (pov === 'safetyist') return Promise.resolve(povFile('safetyist', [node('saf-beliefs-001')]));
    if (pov === 'skeptic') return Promise.resolve(povFile('skeptic', [node('skp-beliefs-001')]));
    if (pov === 'situations') return Promise.resolve({ last_modified: '2026-01-01', nodes: [] });
    return Promise.resolve(null);
  });
  await useTaxonomyStore.getState().loadAll(true);
}
const savedAcc = () => {
  const call = mockApi.saveTaxonomyFile.mock.calls.find(c => c[0] === 'accelerationist');
  return call?.[1] as PovTaxonomyFile | undefined;
};

describe('superseded nodes in the editor store (t/4355)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    __resetSupersededCacheForTests();
    useTaxonomyStore.setState({ dirty: new Set(), saveError: null, validationErrors: {}, edgesFile: null, conflicts: [] });
    await load();
  });

  it('AC 1: a superseded node is absent from the selectable list but resolvable by id', () => {
    const s = useTaxonomyStore.getState();
    expect(s.accelerationist!.nodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-003']);
    expect(s.getLabelForId('acc-beliefs-002')).toBe('label acc-beliefs-002');
    expect(s.getDescriptionForId('acc-beliefs-002')).toBe('d');
    expect(s.lookupPinnedData('acc-beliefs-002')).toMatchObject({ type: 'pov', pov: 'accelerationist', node: { id: 'acc-beliefs-002' } });
  });

  it('AC 2: an unrelated edit and save writes the superseded node back byte-identical, at its original position', async () => {
    useTaxonomyStore.getState().updatePovNode('accelerationist', 'acc-beliefs-001', { label: 'edited' });
    await useTaxonomyStore.getState().save();
    const written = savedAcc()!;
    expect(written.nodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-002', 'acc-beliefs-003']);
    expect(JSON.stringify(written.nodes[1])).toBe(JSON.stringify(A2));
    expect(written.nodes[1].superseded_by).toBe('acc-beliefs-001');
    // ...and the live state still holds it out of selection after the save.
    expect(useTaxonomyStore.getState().accelerationist!.nodes.map(n => n.id)).toEqual(['acc-beliefs-001', 'acc-beliefs-003']);
  });

  it('edits, deletes and renames of a superseded id are refused (read-only, cited history)', () => {
    const s = useTaxonomyStore.getState();
    s.updatePovNode('accelerationist', 'acc-beliefs-002', { label: 'nope' });
    s.deletePovNode('accelerationist', 'acc-beliefs-002');
    expect(s.movePovNodeCategory('accelerationist', 'acc-beliefs-002', 'Desires')).toBeNull();
    s.movePovNode('accelerationist', 'acc-beliefs-002', 'safetyist', 'Beliefs');
    const after = useTaxonomyStore.getState();
    expect(after.dirty.size).toBe(0);
    expect(after.getLabelForId('acc-beliefs-002')).toBe('label acc-beliefs-002');
  });

  it('a new node never reuses a superseded id', () => {
    const newId = useTaxonomyStore.getState().createPovNode('accelerationist', 'Beliefs');
    expect(newId).not.toBe('acc-beliefs-002');
    expect(['acc-beliefs-001', 'acc-beliefs-002', 'acc-beliefs-003']).not.toContain(newId);
  });

  it('rename cascade: renaming the replacement rewrites superseded_by (the one allowed change), and saves it', async () => {
    const newId = useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-001', 'Desires');
    expect(newId).toMatch(/^acc-desires-\d{3}$/);
    await useTaxonomyStore.getState().save();
    const written = savedAcc()!;
    const twin = written.nodes.find(n => n.id === 'acc-beliefs-002')!;
    expect(twin.superseded_by).toBe(newId);
    expect(written.nodes.indexOf(twin)).toBe(1);
  });

  it('rename cascade: renaming a superseded node\'s parent rewrites its parent_id too', () => {
    const newId = useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-003', 'Desires');
    const held = useTaxonomyStore.getState().supersededNodes.accelerationist[0].node;
    expect(held.parent_id).toBe(newId);
  });

  it('a category move now rewrites edge endpoints (previously only a cross-POV move did)', () => {
    useTaxonomyStore.setState({ edgesFile: { edges: [{ source: 'acc-beliefs-001', target: 'saf-beliefs-001', type: 'SUPPORTS' }] } as never });
    const newId = useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-001', 'Desires');
    const s = useTaxonomyStore.getState();
    expect(s.edgesFile!.edges[0].source).toBe(newId);
    expect(s.dirty.has('edges')).toBe(true);
  });

  it('integrity auto-fix keeps edges that point at a superseded node (it still exists)', () => {
    useTaxonomyStore.setState({
      edgesFile: { edges: [
        { source: 'acc-beliefs-001', target: 'acc-beliefs-002', type: 'SUPPORTS' },
        { source: 'acc-beliefs-001', target: 'acc-beliefs-999', type: 'SUPPORTS' },
      ] } as never,
      integrityIssues: [{ severity: 'error', code: 'EDGE_DANGLING_TARGET', entityId: 'acc-beliefs-999', message: 'x' }] as never,
    });
    useTaxonomyStore.getState().fixIntegrityErrors();
    expect(useTaxonomyStore.getState().edgesFile!.edges.map(e => e.target)).toEqual(['acc-beliefs-002']);
  });
});

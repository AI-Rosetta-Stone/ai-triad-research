// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4186/t/4197 save-conflict tests, split out of useTaxonomyStore.test.ts (t/4197,
// Rosetta Stone p/775#45, TL p/775#46) to keep that file under the 2000-line budget.
// Mirrors its mock setup — vi.mock is file-scoped/hoisted, so this file needs its own.

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
import type { PovTaxonomyFile, PovNode } from '../types/taxonomy';

function makePovNode(overrides: Partial<PovNode> = {}): PovNode {
  return {
    id: 'acc-beliefs-001',
    category: 'Beliefs',
    label: 'Test node',
    description: 'A test belief node',
    parent_id: null,
    children: [],
    situation_refs: [],
    ...overrides,
  };
}

function makePovFile(nodes: PovNode[] = [makePovNode()]): PovTaxonomyFile {
  return {
    pov: 'accelerationist',
    last_modified: '2026-01-01',
    nodes,
  } as PovTaxonomyFile;
}

describe('useTaxonomyStore save conflicts (t/4186/t/4197)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaxonomyStore.setState({
      accelerationist: null,
      dirty: new Set(),
      saveError: null,
      validationErrors: {},
    });
  });

  // t/4186/t/4197: WRITE_CONFLICT and BASE_VERSION_REQUIRED (discriminated on `code`, p/772#1,
  // p/775#24) both show the bridge's conflict message — never the generic "Save failed: ..."
  // prefix — never success, and keep the edit. The message itself is the bridge's `.problem`
  // (taxonomyVersions.ts), surfaced here via mapErrorToUserMessage so the two layers can't drift;
  // this test file mocks that to String(err), so it asserts routing, not the bridge's wording.
  it.each(['WRITE_CONFLICT', 'BASE_VERSION_REQUIRED'] as const)(
    'shows the bridge message (no "Save failed" prefix) and preserves dirty/edits on a %s save error',
    async (code) => {
      const conflictErr = Object.assign(new Error(`conflict: ${code}`), { code });
      mockApi.syncCommit.mockRejectedValueOnce(conflictErr);
      useTaxonomyStore.setState({ accelerationist: makePovFile(), dirty: new Set(['accelerationist']), saveError: null });
      await useTaxonomyStore.getState().save();
      const state = useTaxonomyStore.getState();
      expect(state.saveError).toBe(String(conflictErr));
      expect(state.saveError).not.toContain('Save failed');
      expect(state.dirty.has('accelerationist')).toBe(true);
    },
  );

  // t/4197 (TL p/775#24): the pre-save re-read must stay on the plain, cell-blind load — if it
  // ever switched to loadTaxonomyFileForEdit, the save would carry the newest version as its own
  // base and the precondition would always pass, reopening the lost update this feature fixes.
  it('the pre-save logical_form re-read never calls loadTaxonomyFileForEdit', async () => {
    mockApi.loadTaxonomyFile.mockResolvedValue({ nodes: [] });
    useTaxonomyStore.setState({ accelerationist: makePovFile(), dirty: new Set(['accelerationist']) });
    await useTaxonomyStore.getState().save();
    expect(mockApi.loadTaxonomyFile).toHaveBeenCalledWith('accelerationist');
    expect(mockApi.loadTaxonomyFileForEdit).not.toHaveBeenCalled();
  });
});

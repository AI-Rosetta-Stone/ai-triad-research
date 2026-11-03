// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4628 applyAnonymousSessionDefaults tests, split out of useTaxonomyStore.test.ts (same
// reason as useTaxonomyStore.saveConflict.test.ts: keep that file under the 2000-line budget).
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

const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: mockRecord }),
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

// Mock localStorage
const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
  removeItem: vi.fn((key: string) => { storage.delete(key); }),
  clear: vi.fn(() => { storage.clear(); }),
  length: 0,
  key: vi.fn(),
});

import { useTaxonomyStore } from './useTaxonomyStore';

// t/4628: anonymous hosted users always start on the default model/backend, ignoring any
// stored selection, without deleting what's stored (AC1/AC2/AC4).
describe('useTaxonomyStore applyAnonymousSessionDefaults (t/4628)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    useTaxonomyStore.setState({ aiBackend: 'gemini', geminiModel: 'gemini-3.5-flash-lite' });
  });

  it('AC1: overrides a stored non-default model/backend to the gemini default when anonymous', () => {
    storage.set('taxonomy-editor-gemini-model', 'claude-sonnet-4-6');
    storage.set('taxonomy-editor-ai-backend', 'claude');

    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);

    const state = useTaxonomyStore.getState();
    expect(state.geminiModel).toBe('gemini-3.5-flash-lite');
    expect(state.aiBackend).toBe('gemini');
  });

  it('condition 3: leaves the stored values in localStorage untouched (ignored, not deleted)', () => {
    storage.set('taxonomy-editor-gemini-model', 'claude-sonnet-4-6');
    storage.set('taxonomy-editor-ai-backend', 'claude');

    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);

    expect(storage.get('taxonomy-editor-gemini-model')).toBe('claude-sonnet-4-6');
    expect(storage.get('taxonomy-editor-ai-backend')).toBe('claude');
  });

  it('condition 4: logs a WARN naming the overridden values when a stored value is actually ignored', () => {
    storage.set('taxonomy-editor-gemini-model', 'claude-sonnet-4-6');
    storage.set('taxonomy-editor-ai-backend', 'claude');

    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);

    const warnCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('Anonymous session: ignoring stored AI selection'));
    expect(warnCall).toBeDefined();
    expect(warnCall![0].level).toBe('warn');
    expect(warnCall![0].message).toContain('claude-sonnet-4-6');
    expect(warnCall![0].message).toContain('claude');
  });

  it('condition 4: does NOT warn when nothing was stored (first-ever anonymous visit)', () => {
    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);

    const warnCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('Anonymous session: ignoring stored AI selection'));
    expect(warnCall).toBeUndefined();
  });

  it('AC2: a signed-in session (isAnonymous=false) is a no-op — current model/backend untouched', () => {
    useTaxonomyStore.getState().setAIBackend('claude'); // also sets geminiModel to claude's default

    useTaxonomyStore.getState().applyAnonymousSessionDefaults(false);

    const state = useTaxonomyStore.getState();
    expect(state.geminiModel).toBe('claude-sonnet-4-6');
    expect(state.aiBackend).toBe('claude');
  });

  it('wanted #2: an anonymous in-visit model switch updates state but does not persist', () => {
    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);
    storage.clear(); // isolate: only the switch below should (not) write

    useTaxonomyStore.getState().setGeminiModel('gemini-2.5-pro');

    expect(useTaxonomyStore.getState().geminiModel).toBe('gemini-2.5-pro');
    expect(storage.get('taxonomy-editor-gemini-model')).toBeUndefined();
  });

  it('wanted #2: an anonymous in-visit backend switch updates state but does not persist', () => {
    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);
    storage.clear();

    useTaxonomyStore.getState().setAIBackend('claude');

    const state = useTaxonomyStore.getState();
    expect(state.aiBackend).toBe('claude');
    expect(storage.get('taxonomy-editor-ai-backend')).toBeUndefined();
  });

  it('condition 2: a later signed-in session (flag reset to false) persists normally again', () => {
    useTaxonomyStore.getState().applyAnonymousSessionDefaults(true);
    useTaxonomyStore.getState().applyAnonymousSessionDefaults(false); // simulates the post-reload re-init

    useTaxonomyStore.getState().setGeminiModel('gemini-2.5-pro');

    expect(storage.get('taxonomy-editor-gemini-model')).toBe('gemini-2.5-pro');
  });
});

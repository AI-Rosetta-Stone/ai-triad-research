// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──

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

const { mockRecord, mockStripInvalidLogicalForm } = vi.hoisted(() => ({
  mockRecord: vi.fn(),
  // t/3250: loadAll calls this per node. t/3378: tests override this per-case to simulate strips.
  mockStripInvalidLogicalForm: vi.fn().mockReturnValue({ removed: false }),
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({
    record: mockRecord,
  }),
}));

vi.mock('../utils/validation', () => ({
  povTaxonomyFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  crossCuttingFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  conflictFileSchema: { safeParse: vi.fn().mockReturnValue({ success: true }) },
  extractPovErrors: vi.fn().mockReturnValue({}),
  extractConflictErrors: vi.fn().mockReturnValue({}),
  stripInvalidLogicalForm: mockStripInvalidLogicalForm,
}));

vi.mock('../utils/similarity', () => ({
  rankBySimilarity: vi.fn().mockReturnValue([]),
}));

vi.mock('../utils/errorMessages', () => ({
  mapErrorToUserMessage: vi.fn((err: unknown) => String(err)),
}));

vi.mock('../prompts/analysis', () => ({
  distinctionAnalysisPrompt: vi.fn().mockReturnValue('mock-distinction-prompt'),
  nodeCritiquePrompt: vi.fn().mockReturnValue('mock-critique-prompt'),
}));

vi.mock('../data/lineageCategories', () => ({
  loadLineageCategoriesData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../data/lineageLookup', () => ({
  loadLineageInfoData: vi.fn().mockResolvedValue(undefined),
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

// Mock document.documentElement for theme/pane-spacing
vi.stubGlobal('document', {
  documentElement: {
    setAttribute: vi.fn(),
    getAttribute: vi.fn(),
  },
});

// Mock window.matchMedia for system theme detection
vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

import { useTaxonomyStore } from './useTaxonomyStore';
import type { PovTaxonomyFile, CrossCuttingFile, ConflictFile, PovNode, Edge, EdgesFile } from '../types/taxonomy';
import { buildSituationBaseline } from '../utils/situationBdiGate';
import { povTagMembershipErrors } from '../utils/povTagGate';

/** A complete, compliant per-POV interpretation (t/3888). */
const fullBdi = (tag: string) => ({ belief: `${tag} belief`, desire: `${tag} desire`, intention: `${tag} intention`, summary: `${tag} summary` });

// ── Factories ──

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

function makeSituationsFile(): CrossCuttingFile {
  return {
    last_modified: '2026-01-01',
    nodes: [
      {
        id: 'sit-001',
        label: 'Test situation',
        description: 'A test situation',
        interpretations: { accelerationist: 'acc view', safetyist: 'saf view', skeptic: 'skp view' },
        linked_nodes: [],
        conflict_ids: [],
      },
    ],
  } as CrossCuttingFile;
}

function makeConflict(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    claim_id: 'conflict-test-001',
    claim_label: 'Test conflict',
    description: 'A test conflict claim',
    status: 'open',
    linked_taxonomy_nodes: [],
    instances: [],
    human_notes: [],
    ...overrides,
  } as ConflictFile;
}

function resetStore() {
  useTaxonomyStore.setState({
    accelerationist: null,
    safetyist: null,
    skeptic: null,
    situations: null,
    situationsBaseline: {},
    policyRegistry: null,
    conflicts: [],
    aggregatedCruxes: null,
    activeTab: 'accelerationist',
    selectedNodeId: null,
    dirty: new Set(),
    validationErrors: {},
    saveError: null,
    loading: false,
    backgroundLoading: false,
    loadingProgress: { completed: [], total: 0 },
    pinnedStack: [],
    findQuery: '',
    findMode: 'raw',
    findCaseSensitive: false,
    embeddingCache: new Map(),
    embeddingDirty: true,
    embeddingLoading: false,
    embeddingError: null,
    hasApiKey: false,
    semanticResults: [],
    similarResults: null,
    similarLoading: false,
    similarStep: null,
    similarError: null,
    similarThreshold: 60,
    analysisResult: null,
    analysisLoading: false,
    analysisError: null,
    analysisStep: 0,
    analysisRetry: null,
    analysisCached: false,
    analysisElementA: null,
    analysisElementB: null,
    analysisTitle: 'Analysis',
    analysisCritiquePov: null,
    analysisCritiqueNodeId: null,
    analysisCritiqueOriginalNode: null,
    clusterView: null,
    clusterLoading: false,
    clusterError: null,
    conflictClusters: null,
    conflictClusterLoading: false,
    conflictClusterError: null,
    edgesFile: null,
    edgesLoading: false,
    relatedNodeId: null,
    selectedEdge: null,
    toolbarPanel: null,
    pendingLineageValue: null,
    pendingSearchRelatedId: null,
    previousView: null,
    attributeFilter: null,
    attributeInfo: null,
  });
}

// ── Tests ──

describe('useTaxonomyStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    resetStore();
  });

  // ═══════════════════════════════════════════════
  // Settings slice
  // ═══════════════════════════════════════════════

  describe('settings', () => {
    describe('colorScheme', () => {
      it('defaults to harvard', () => {
        expect(useTaxonomyStore.getState().colorScheme).toBe('harvard');
      });

      it('setColorScheme updates state and persists', () => {
        useTaxonomyStore.getState().setColorScheme('dark');
        expect(useTaxonomyStore.getState().colorScheme).toBe('dark');
        expect(storage.get('taxonomy-editor-theme')).toBe('dark');
      });

      it('setColorScheme applies data-theme attribute', () => {
        useTaxonomyStore.getState().setColorScheme('bkc');
        expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'bkc');
      });

      it('system theme delegates to matchMedia', () => {
        (window.matchMedia as ReturnType<typeof vi.fn>).mockReturnValueOnce({ matches: true });
        useTaxonomyStore.getState().setColorScheme('system');
        expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-theme', 'dark');
      });
    });

    describe('aiBackend', () => {
      it('defaults to gemini', () => {
        expect(useTaxonomyStore.getState().aiBackend).toBe('gemini');
      });

      it('setAIBackend updates backend and switches to default model', () => {
        useTaxonomyStore.getState().setAIBackend('claude');
        const state = useTaxonomyStore.getState();
        expect(state.aiBackend).toBe('claude');
        expect(state.geminiModel).toBe('claude-sonnet-4-6');
        expect(storage.get('taxonomy-editor-ai-backend')).toBe('claude');
      });
    });

    describe('geminiModel', () => {
      it('setGeminiModel updates and persists', () => {
        useTaxonomyStore.getState().setGeminiModel('gemini-2.5-pro');
        expect(useTaxonomyStore.getState().geminiModel).toBe('gemini-2.5-pro');
        expect(storage.get('taxonomy-editor-gemini-model')).toBe('gemini-2.5-pro');
      });
    });

    // t/4628: anonymous hosted users always start on the default model/backend, ignoring any
    // stored selection, without deleting what's stored (AC1/AC2/AC4).
    describe('applyAnonymousSessionDefaults (t/4628)', () => {
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

    describe('paneSpacing', () => {
      it('defaults to normal', () => {
        expect(useTaxonomyStore.getState().paneSpacing).toBe('normal');
      });

      it('setPaneSpacing updates and sets DOM attribute', () => {
        useTaxonomyStore.getState().setPaneSpacing('concise');
        expect(useTaxonomyStore.getState().paneSpacing).toBe('concise');
        expect(document.documentElement.setAttribute).toHaveBeenCalledWith('data-pane-spacing', 'concise');
        expect(storage.get('taxonomy-editor-pane-spacing')).toBe('concise');
      });
    });

    describe('zoom', () => {
      it('zoomIn increases by 10, capped at 200', () => {
        useTaxonomyStore.setState({ zoomLevel: 100 });
        useTaxonomyStore.getState().zoomIn();
        expect(useTaxonomyStore.getState().zoomLevel).toBe(110);
      });

      it('zoomIn caps at 200', () => {
        useTaxonomyStore.setState({ zoomLevel: 200 });
        useTaxonomyStore.getState().zoomIn();
        expect(useTaxonomyStore.getState().zoomLevel).toBe(200);
      });

      it('zoomOut decreases by 10, floor at 60', () => {
        useTaxonomyStore.setState({ zoomLevel: 100 });
        useTaxonomyStore.getState().zoomOut();
        expect(useTaxonomyStore.getState().zoomLevel).toBe(90);
      });

      it('zoomOut floors at 60', () => {
        useTaxonomyStore.setState({ zoomLevel: 60 });
        useTaxonomyStore.getState().zoomOut();
        expect(useTaxonomyStore.getState().zoomLevel).toBe(60);
      });

      it('zoomReset restores to 100', () => {
        useTaxonomyStore.setState({ zoomLevel: 150 });
        useTaxonomyStore.getState().zoomReset();
        expect(useTaxonomyStore.getState().zoomLevel).toBe(100);
        expect(storage.get('taxonomy-editor-zoom')).toBe('100');
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Search slice
  // ═══════════════════════════════════════════════

  describe('search', () => {
    describe('find controls', () => {
      it('setFindQuery updates findQuery', () => {
        useTaxonomyStore.getState().setFindQuery('test');
        expect(useTaxonomyStore.getState().findQuery).toBe('test');
      });

      it('setFindMode updates findMode', () => {
        useTaxonomyStore.getState().setFindMode('regex');
        expect(useTaxonomyStore.getState().findMode).toBe('regex');
      });

      it('setFindCaseSensitive updates flag', () => {
        useTaxonomyStore.getState().setFindCaseSensitive(true);
        expect(useTaxonomyStore.getState().findCaseSensitive).toBe(true);
      });
    });

    describe('similarThreshold', () => {
      it('setSimilarThreshold updates threshold', () => {
        useTaxonomyStore.getState().setSimilarThreshold(80);
        expect(useTaxonomyStore.getState().similarThreshold).toBe(80);
      });
    });

    describe('clearSimilarSearch', () => {
      it('clears results and error', () => {
        useTaxonomyStore.setState({ similarResults: [{ id: 'x', score: 0.9 }], similarError: 'err' });
        useTaxonomyStore.getState().clearSimilarSearch();
        expect(useTaxonomyStore.getState().similarResults).toBeNull();
        expect(useTaxonomyStore.getState().similarError).toBeNull();
      });

      it('closes search toolbar panel', () => {
        useTaxonomyStore.setState({ similarResults: [{ id: 'x', score: 0.9 }], toolbarPanel: 'search' });
        useTaxonomyStore.getState().clearSimilarSearch();
        expect(useTaxonomyStore.getState().toolbarPanel).toBeNull();
      });
    });

    describe('buildEmbeddingTexts', () => {
      it('returns all nodes when no scope filters', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', description: 'node1' })]),
          safetyist: makePovFile([makePovNode({ id: 'saf-beliefs-001', description: 'node2' })]),
          skeptic: null,
          situations: makeSituationsFile(),
          conflicts: [makeConflict()],
        });

        const { ids, texts } = useTaxonomyStore.getState().buildEmbeddingTexts(new Set(), new Set());
        expect(ids).toContain('acc-beliefs-001');
        expect(ids).toContain('saf-beliefs-001');
        expect(ids).toContain('sit-001');
        expect(ids).toContain('conflict-test-001');
        expect(ids.length).toBe(4);
      });

      it('filters by POV scope', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001' })]),
          safetyist: makePovFile([makePovNode({ id: 'saf-beliefs-001' })]),
          skeptic: null,
          situations: makeSituationsFile(),
          conflicts: [],
        });

        const { ids } = useTaxonomyStore.getState().buildEmbeddingTexts(
          new Set(['accelerationist'] as any),
          new Set(),
        );
        expect(ids).toContain('acc-beliefs-001');
        expect(ids).not.toContain('saf-beliefs-001');
        expect(ids).not.toContain('sit-001');
      });

      it('filters by aspect scope', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([
            makePovNode({ id: 'acc-beliefs-001', category: 'Beliefs' }),
            makePovNode({ id: 'acc-desires-001', category: 'Desires' }),
          ]),
          safetyist: null,
          skeptic: null,
          situations: null,
          conflicts: [],
        });

        const { ids } = useTaxonomyStore.getState().buildEmbeddingTexts(
          new Set(),
          new Set(['Beliefs'] as any),
        );
        expect(ids).toContain('acc-beliefs-001');
        expect(ids).not.toContain('acc-desires-001');
      });
    });

    describe('attributeFilter', () => {
      it('runAttributeFilter matches string fields exactly', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([
            makePovNode({
              id: 'acc-beliefs-001',
              label: 'Node A',
              graph_attributes: { epistemic_status: 'speculative' } as any,
            }),
            makePovNode({
              id: 'acc-beliefs-002',
              label: 'Node B',
              graph_attributes: { epistemic_status: 'established' } as any,
            }),
          ]),
          safetyist: null,
          skeptic: null,
          situations: null,
        });

        useTaxonomyStore.getState().runAttributeFilter('epistemic_status', 'speculative');
        const filter = useTaxonomyStore.getState().attributeFilter;
        expect(filter).not.toBeNull();
        expect(filter!.results).toHaveLength(1);
        expect(filter!.results[0].id).toBe('acc-beliefs-001');
      });

      it('runAttributeFilter matches array fields', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([
            makePovNode({
              id: 'acc-beliefs-001',
              label: 'Node A',
              graph_attributes: { assumes: ['rationality', 'utility-maximization'] } as any,
            }),
          ]),
          safetyist: null,
          skeptic: null,
          situations: null,
        });

        useTaxonomyStore.getState().runAttributeFilter('assumes', 'rationality');
        const filter = useTaxonomyStore.getState().attributeFilter;
        expect(filter!.results).toHaveLength(1);
      });

      it('clearAttributeFilter resets filter and toolbar', () => {
        useTaxonomyStore.setState({
          attributeFilter: { field: 'x', value: 'y', results: [] },
          toolbarPanel: 'attrFilter',
        });
        useTaxonomyStore.getState().clearAttributeFilter();
        expect(useTaxonomyStore.getState().attributeFilter).toBeNull();
        expect(useTaxonomyStore.getState().toolbarPanel).toBeNull();
      });
    });

    describe('attributeInfo', () => {
      it('showAttributeInfo sets info and toolbar panel', () => {
        useTaxonomyStore.getState().showAttributeInfo('field', 'value');
        expect(useTaxonomyStore.getState().attributeInfo).toEqual({ field: 'field', value: 'value' });
        expect(useTaxonomyStore.getState().toolbarPanel).toBe('attrInfo');
      });

      it('clearAttributeInfo resets', () => {
        useTaxonomyStore.setState({ attributeInfo: { field: 'f', value: 'v' }, toolbarPanel: 'attrInfo' });
        useTaxonomyStore.getState().clearAttributeInfo();
        expect(useTaxonomyStore.getState().attributeInfo).toBeNull();
        expect(useTaxonomyStore.getState().toolbarPanel).toBeNull();
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Analysis slice
  // ═══════════════════════════════════════════════

  describe('analysis', () => {
    describe('clearAnalysis', () => {
      it('resets all analysis state', () => {
        useTaxonomyStore.setState({
          analysisResult: 'some result',
          analysisLoading: true,
          analysisError: 'err',
          analysisStep: 3,
          analysisCached: true,
          analysisElementA: { label: 'a', description: 'a', category: 'Beliefs' },
          analysisElementB: { label: 'b', description: 'b', category: 'Desires' },
          analysisTitle: 'Custom Title',
          analysisCritiquePov: 'accelerationist' as any,
          analysisCritiqueNodeId: 'x',
          analysisCritiqueOriginalNode: makePovNode(),
        });

        useTaxonomyStore.getState().clearAnalysis();
        const s = useTaxonomyStore.getState();
        expect(s.analysisResult).toBeNull();
        expect(s.analysisLoading).toBe(false);
        expect(s.analysisError).toBeNull();
        expect(s.analysisStep).toBe(0);
        expect(s.analysisCached).toBe(false);
        expect(s.analysisElementA).toBeNull();
        expect(s.analysisElementB).toBeNull();
        expect(s.analysisTitle).toBe('Analysis');
        expect(s.analysisCritiquePov).toBeNull();
        expect(s.analysisCritiqueNodeId).toBeNull();
        expect(s.analysisCritiqueOriginalNode).toBeNull();
      });
    });

    describe('runAnalyzeDistinction', () => {
      it('calls generateText and updates result on success', async () => {
        mockApi.generateText.mockResolvedValueOnce({ text: 'analysis result text' });
        const elemA = { label: 'A', description: 'desc A', category: 'Beliefs' };
        const elemB = { label: 'B', description: 'desc B', category: 'Desires' };

        await useTaxonomyStore.getState().runAnalyzeDistinction(elemA, elemB);

        expect(mockApi.generateText).toHaveBeenCalled();
        const s = useTaxonomyStore.getState();
        expect(s.analysisResult).toBe('analysis result text');
        expect(s.analysisLoading).toBe(false);
        expect(s.analysisError).toBeNull();
      });

      it('sets error on generateText failure', async () => {
        mockApi.generateText.mockRejectedValueOnce(new Error('API down'));
        const elemA = { label: 'A', description: 'desc A', category: 'Beliefs' };
        const elemB = { label: 'B', description: 'desc B', category: 'Desires' };

        await useTaxonomyStore.getState().runAnalyzeDistinction(elemA, elemB);

        const s = useTaxonomyStore.getState();
        expect(s.analysisResult).toBeNull();
        expect(s.analysisLoading).toBe(false);
        expect(s.analysisError).toBeTruthy();
      });
    });

    describe('clearClusterView', () => {
      it('clears cluster data', () => {
        useTaxonomyStore.setState({
          clusterView: { clusters: [{ label: 'C1', nodeIds: ['a'] }] },
          clusterError: 'err',
        });
        useTaxonomyStore.getState().clearClusterView();
        expect(useTaxonomyStore.getState().clusterView).toBeNull();
        expect(useTaxonomyStore.getState().clusterError).toBeNull();
      });
    });

    describe('clearConflictClusters', () => {
      it('clears conflict cluster data', () => {
        useTaxonomyStore.setState({
          conflictClusters: [{ label: 'CC1', nodeIds: ['a'] }],
          conflictClusterError: 'err',
        });
        useTaxonomyStore.getState().clearConflictClusters();
        expect(useTaxonomyStore.getState().conflictClusters).toBeNull();
        expect(useTaxonomyStore.getState().conflictClusterError).toBeNull();
      });
    });

    describe('checkApiKey', () => {
      it('sets hasApiKey from bridge response', async () => {
        mockApi.hasApiKey.mockResolvedValueOnce(true);
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(true);
      });

      it('defaults to false on error', async () => {
        mockApi.hasApiKey.mockRejectedValueOnce(new Error('fail'));
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(false);
      });

      it('falls back to free-tier proxy when BYOK returns false (anonymous persona)', async () => {
        mockApi.hasApiKey.mockResolvedValueOnce(false);
        (mockApi as Record<string, unknown>).getProxyTier = vi.fn().mockResolvedValueOnce({
          level: 'free',
          limits: { requestsPerMinute: 10, tokensPerDay: 50000 },
          allowedBackends: ['gemini'],
          principalName: null,
        });
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(true);
        delete (mockApi as Record<string, unknown>).getProxyTier;
      });

      it('stays false when free-tier proxy has no allowed backends', async () => {
        mockApi.hasApiKey.mockResolvedValueOnce(false);
        (mockApi as Record<string, unknown>).getProxyTier = vi.fn().mockResolvedValueOnce({
          level: 'free',
          limits: { requestsPerMinute: 10, tokensPerDay: 50000 },
          allowedBackends: [],
          principalName: null,
        });
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(false);
        delete (mockApi as Record<string, unknown>).getProxyTier;
      });

      it('stays false when getProxyTier is unavailable (Electron persona)', async () => {
        mockApi.hasApiKey.mockResolvedValueOnce(false);
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(false);
      });

      it('stays false when getProxyTier rejects (proxy down)', async () => {
        mockApi.hasApiKey.mockResolvedValueOnce(false);
        (mockApi as Record<string, unknown>).getProxyTier = vi.fn().mockRejectedValueOnce(new Error('503'));
        await useTaxonomyStore.getState().checkApiKey();
        expect(useTaxonomyStore.getState().hasApiKey).toBe(false);
        delete (mockApi as Record<string, unknown>).getProxyTier;
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — navigation
  // ═══════════════════════════════════════════════

  describe('navigation', () => {
    it('setActiveTab changes tab and clears selection', () => {
      useTaxonomyStore.setState({ activeTab: 'accelerationist', selectedNodeId: 'x' });
      useTaxonomyStore.getState().setActiveTab('safetyist');
      expect(useTaxonomyStore.getState().activeTab).toBe('safetyist');
      expect(useTaxonomyStore.getState().selectedNodeId).toBeNull();
    });

    it('setSelectedNodeId updates selection', () => {
      useTaxonomyStore.getState().setSelectedNodeId('acc-beliefs-001');
      expect(useTaxonomyStore.getState().selectedNodeId).toBe('acc-beliefs-001');
    });

    it('navigateToNode sets both tab and node', () => {
      useTaxonomyStore.getState().navigateToNode('skeptic', 'skp-desires-001');
      expect(useTaxonomyStore.getState().activeTab).toBe('skeptic');
      expect(useTaxonomyStore.getState().selectedNodeId).toBe('skp-desires-001');
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — pinned stack
  // ═══════════════════════════════════════════════

  describe('pinned stack', () => {
    const pinnedA: any = { type: 'pov', pov: 'accelerationist', node: makePovNode() };
    const pinnedB: any = { type: 'situations', node: { id: 'sit-001', label: 'Test' } };

    it('pinAtDepth adds to stack', () => {
      useTaxonomyStore.getState().pinAtDepth(0, pinnedA);
      expect(useTaxonomyStore.getState().pinnedStack).toHaveLength(1);
    });

    it('pinAtDepth truncates deeper items', () => {
      useTaxonomyStore.setState({ pinnedStack: [pinnedA, pinnedB] });
      const pinnedC: any = { type: 'pov', pov: 'safetyist', node: makePovNode({ id: 'saf-beliefs-001' }) };
      useTaxonomyStore.getState().pinAtDepth(1, pinnedC);
      expect(useTaxonomyStore.getState().pinnedStack).toHaveLength(2);
      expect(useTaxonomyStore.getState().pinnedStack[1]).toBe(pinnedC);
    });

    it('closePinnedFromDepth truncates', () => {
      useTaxonomyStore.setState({ pinnedStack: [pinnedA, pinnedB] });
      useTaxonomyStore.getState().closePinnedFromDepth(1);
      expect(useTaxonomyStore.getState().pinnedStack).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — POV node CRUD
  // ═══════════════════════════════════════════════

  describe('POV node CRUD', () => {
    beforeEach(() => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([
          makePovNode({ id: 'acc-beliefs-001', label: 'Belief 1', description: 'First belief' }),
          makePovNode({ id: 'acc-beliefs-002', label: 'Belief 2', description: 'Second belief', category: 'Beliefs' }),
        ]),
      });
    });

    describe('createPovNode', () => {
      it('adds a new node and returns its ID', () => {
        const newId = useTaxonomyStore.getState().createPovNode('accelerationist', 'Desires');
        expect(newId).toMatch(/^acc-desires-/);
        const file = useTaxonomyStore.getState().accelerationist!;
        expect(file.nodes).toHaveLength(3);
        expect(useTaxonomyStore.getState().selectedNodeId).toBe(newId);
        expect(useTaxonomyStore.getState().dirty.has('accelerationist')).toBe(true);
      });

      it('returns empty string if file not loaded', () => {
        const newId = useTaxonomyStore.getState().createPovNode('skeptic', 'Beliefs');
        expect(newId).toBe('');
      });
    });

    describe('updatePovNode', () => {
      it('updates node fields and marks dirty', () => {
        useTaxonomyStore.getState().updatePovNode('accelerationist', 'acc-beliefs-001', { label: 'Updated' });
        const file = useTaxonomyStore.getState().accelerationist!;
        const node = file.nodes.find(n => n.id === 'acc-beliefs-001')!;
        expect(node.label).toBe('Updated');
        expect(useTaxonomyStore.getState().dirty.has('accelerationist')).toBe(true);
      });

      it('preserves other node fields', () => {
        useTaxonomyStore.getState().updatePovNode('accelerationist', 'acc-beliefs-001', { label: 'New' });
        const node = useTaxonomyStore.getState().accelerationist!.nodes.find(n => n.id === 'acc-beliefs-001')!;
        expect(node.description).toBe('First belief');
        expect(node.category).toBe('Beliefs');
      });

      it('does nothing if POV file not loaded', () => {
        useTaxonomyStore.getState().updatePovNode('skeptic', 'skp-beliefs-001', { label: 'x' });
        expect(useTaxonomyStore.getState().dirty.size).toBe(0);
      });
    });

    describe('deletePovNode', () => {
      it('removes node and marks dirty', () => {
        useTaxonomyStore.getState().deletePovNode('accelerationist', 'acc-beliefs-001');
        const file = useTaxonomyStore.getState().accelerationist!;
        expect(file.nodes).toHaveLength(1);
        expect(file.nodes[0].id).toBe('acc-beliefs-002');
        expect(useTaxonomyStore.getState().dirty.has('accelerationist')).toBe(true);
      });

      it('clears selectedNodeId if deleted node was selected', () => {
        useTaxonomyStore.setState({ selectedNodeId: 'acc-beliefs-001' });
        useTaxonomyStore.getState().deletePovNode('accelerationist', 'acc-beliefs-001');
        expect(useTaxonomyStore.getState().selectedNodeId).toBeNull();
      });

      it('preserves selectedNodeId if different node deleted', () => {
        useTaxonomyStore.setState({ selectedNodeId: 'acc-beliefs-002' });
        useTaxonomyStore.getState().deletePovNode('accelerationist', 'acc-beliefs-001');
        expect(useTaxonomyStore.getState().selectedNodeId).toBe('acc-beliefs-002');
      });
    });

    describe('movePovNodeCategory', () => {
      it('changes category and assigns new ID', () => {
        useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-001', 'Desires');
        const file = useTaxonomyStore.getState().accelerationist!;
        const moved = file.nodes.find(n => n.id.startsWith('acc-desires-'));
        expect(moved).toBeDefined();
        expect(moved!.category).toBe('Desires');
        expect(moved!.label).toBe('Belief 1');
        expect(file.nodes.find(n => n.id === 'acc-beliefs-001')).toBeUndefined();
      });

      it('updates parent_id references in siblings', () => {
        const parent = makePovNode({ id: 'acc-beliefs-001', label: 'Parent', children: ['acc-beliefs-002'] });
        const child = makePovNode({ id: 'acc-beliefs-002', label: 'Child', parent_id: 'acc-beliefs-001' });
        useTaxonomyStore.setState({ accelerationist: makePovFile([parent, child]) });

        useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-001', 'Desires');
        const file = useTaxonomyStore.getState().accelerationist!;
        const childNode = file.nodes.find(n => n.id === 'acc-beliefs-002')!;
        expect(childNode.parent_id).toMatch(/^acc-desires-/);
      });
    });

    describe('movePovNode (cross-POV)', () => {
      it('moves node from source to target POV', () => {
        useTaxonomyStore.setState({
          safetyist: makePovFile([]),
        });

        useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Desires');

        const accFile = useTaxonomyStore.getState().accelerationist!;
        const safFile = useTaxonomyStore.getState().safetyist!;

        expect(accFile.nodes.find(n => n.id === 'acc-beliefs-001')).toBeUndefined();
        const moved = safFile.nodes.find(n => n.id.startsWith('saf-desires-'));
        expect(moved).toBeDefined();
        expect(moved!.label).toBe('Belief 1');
        expect(useTaxonomyStore.getState().dirty.has('accelerationist')).toBe(true);
        expect(useTaxonomyStore.getState().dirty.has('safetyist')).toBe(true);
      });

      it('resets parent_id and children on cross-POV move', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([
            makePovNode({ id: 'acc-beliefs-001', children: ['acc-beliefs-002'] }),
            makePovNode({ id: 'acc-beliefs-002', parent_id: 'acc-beliefs-001' }),
          ]),
          safetyist: makePovFile([]),
        });

        useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Beliefs');
        const moved = useTaxonomyStore.getState().safetyist!.nodes.find(n => n.id.startsWith('saf-beliefs-'));
        expect(moved!.parent_id).toBeNull();
        expect(moved!.children).toEqual([]);
      });

      it('updates conflict linked_taxonomy_nodes on cross-POV move', () => {
        useTaxonomyStore.setState({
          accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001' })]),
          safetyist: makePovFile([]),
          conflicts: [makeConflict({ linked_taxonomy_nodes: ['acc-beliefs-001'] })],
        });

        useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Beliefs');
        const conflict = useTaxonomyStore.getState().conflicts[0];
        expect(conflict.linked_taxonomy_nodes).not.toContain('acc-beliefs-001');
        expect(conflict.linked_taxonomy_nodes[0]).toMatch(/^saf-beliefs-/);
      });

      // t/3972: POV tags are POV-scoped. The move used to spread `...oldNode`, carrying them into a POV
      // where they're invalid (SO e/249#6 surviving vector). These assert tags DON'T survive the boundary.
      describe('pov_tags (t/3972)', () => {
        const stripWarn = () => mockRecord.mock.calls.find(([e]) => e.message?.includes('Cross-POV move stripped POV tags'));
        const movedSafNode = () => useTaxonomyStore.getState().safetyist!.nodes.find(n => n.id.startsWith('saf-beliefs-'))!;

        it('strips the tags, reports them, and WARNs naming the node and tags', () => {
          useTaxonomyStore.setState({
            accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', pov_tags: ['critical'] })]),
            safetyist: makePovFile([]),
            lastPovMoveReport: null,
          });
          useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Beliefs');

          const moved = movedSafNode();
          expect(moved).not.toHaveProperty('pov_tags'); // the negative assertion: absent, not just empty
          expect(useTaxonomyStore.getState().lastPovMoveReport).toEqual({
            fromId: 'acc-beliefs-001', toId: moved.id, sourcePov: 'accelerationist', targetPov: 'safetyist', strippedTags: ['critical'],
          });
          const [entry] = stripWarn()!;
          expect(entry.level).toBe('warn');
          expect(entry.data).toMatchObject({ from_id: 'acc-beliefs-001', to_id: moved.id, stripped_tags: ['critical'] });
        });

        it('reports a PowerShell-unrolled scalar as one stripped tag rather than dropping it silently', () => {
          useTaxonomyStore.setState({
            accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', pov_tags: 'critical' as unknown as string[] })]),
            safetyist: makePovFile([]),
          });
          useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Beliefs');
          expect(movedSafNode()).not.toHaveProperty('pov_tags');
          expect(useTaxonomyStore.getState().lastPovMoveReport!.strippedTags).toEqual(['critical']);
        });

        it('an untagged node moves with an empty report and no WARN', () => {
          useTaxonomyStore.setState({
            accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001' })]),
            safetyist: makePovFile([]),
          });
          useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'safetyist', 'Beliefs');
          expect(useTaxonomyStore.getState().lastPovMoveReport!.strippedTags).toEqual([]);
          expect(stripWarn()).toBeUndefined();
        });

        it('a same-POV move through movePovNode keeps the tags (one-element array intact)', () => {
          useTaxonomyStore.setState({
            accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', pov_tags: ['critical'] })]),
            lastPovMoveReport: null,
          });
          useTaxonomyStore.getState().movePovNode('accelerationist', 'acc-beliefs-001', 'accelerationist', 'Desires');
          const moved = useTaxonomyStore.getState().accelerationist!.nodes.find(n => n.id.startsWith('acc-desires-'))!;
          expect(moved.pov_tags).toEqual(['critical']);
          expect(useTaxonomyStore.getState().lastPovMoveReport).toBeNull();
          expect(stripWarn()).toBeUndefined();
        });

        it('clearPovMoveReport clears the report', () => {
          useTaxonomyStore.setState({ lastPovMoveReport: { fromId: 'a', toId: 'b', sourcePov: 'accelerationist', targetPov: 'safetyist', strippedTags: ['x'] } });
          useTaxonomyStore.getState().clearPovMoveReport();
          expect(useTaxonomyStore.getState().lastPovMoveReport).toBeNull();
        });
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — situation node CRUD
  // ═══════════════════════════════════════════════

  describe('situation node CRUD', () => {
    beforeEach(() => {
      useTaxonomyStore.setState({ situations: makeSituationsFile() });
    });

    describe('createSituationNode', () => {
      it('adds a new situation node', () => {
        const newId = useTaxonomyStore.getState().createSituationNode();
        expect(newId).toMatch(/^sit-/);
        expect(useTaxonomyStore.getState().situations!.nodes).toHaveLength(2);
        expect(useTaxonomyStore.getState().dirty.has('situations')).toBe(true);
      });

      it('returns empty string if situations not loaded', () => {
        useTaxonomyStore.setState({ situations: null });
        expect(useTaxonomyStore.getState().createSituationNode()).toBe('');
      });

      // t/3888: the flat '' it used to mint routed the editor to a free-text box that wrote prose.
      it('mints the BDI shape for every POV, not a flat string', () => {
        const newId = useTaxonomyStore.getState().createSituationNode();
        const node = useTaxonomyStore.getState().situations!.nodes.find(n => n.id === newId)!;
        for (const pov of ['accelerationist', 'safetyist', 'skeptic'] as const) {
          expect(node.interpretations[pov]).toEqual({ belief: '', desire: '', intention: '', summary: '' });
        }
      });
    });

    describe('updateSituationNode', () => {
      it('updates node and marks dirty', () => {
        useTaxonomyStore.getState().updateSituationNode('sit-001', { label: 'Updated situation' });
        const node = useTaxonomyStore.getState().situations!.nodes.find(n => n.id === 'sit-001')!;
        expect(node.label).toBe('Updated situation');
        expect(useTaxonomyStore.getState().dirty.has('situations')).toBe(true);
      });

      // t/3888: the patch carries only the edited POV; the others keep their stored value.
      it('merges interpretations per POV, leaving untouched POVs (even legacy flat ones) as stored', () => {
        useTaxonomyStore.getState().updateSituationNode('sit-001', { interpretations: { safetyist: fullBdi('saf') } });
        const node = useTaxonomyStore.getState().situations!.nodes.find(n => n.id === 'sit-001')!;
        expect(node.interpretations.safetyist).toEqual(fullBdi('saf'));
        expect(node.interpretations.accelerationist).toBe('acc view');
        expect(node.interpretations.skeptic).toBe('skp view');
      });
    });

    describe('deleteSituationNode', () => {
      it('removes node', () => {
        useTaxonomyStore.getState().deleteSituationNode('sit-001');
        expect(useTaxonomyStore.getState().situations!.nodes).toHaveLength(0);
      });

      it('clears selection if deleted node was selected', () => {
        useTaxonomyStore.setState({ selectedNodeId: 'sit-001' });
        useTaxonomyStore.getState().deleteSituationNode('sit-001');
        expect(useTaxonomyStore.getState().selectedNodeId).toBeNull();
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — conflict CRUD
  // ═══════════════════════════════════════════════

  describe('conflict CRUD', () => {
    beforeEach(() => {
      useTaxonomyStore.setState({
        conflicts: [makeConflict()],
      });
    });

    describe('createConflict', () => {
      it('creates a new conflict with generated ID', () => {
        const newId = useTaxonomyStore.getState().createConflict('New claim');
        expect(newId).toMatch(/^conflict-/);
        expect(useTaxonomyStore.getState().conflicts).toHaveLength(2);
        expect(useTaxonomyStore.getState().dirty.has(newId)).toBe(true);
      });
    });

    describe('updateConflict', () => {
      it('updates conflict fields', () => {
        useTaxonomyStore.getState().updateConflict('conflict-test-001', { status: 'resolved' });
        const conflict = useTaxonomyStore.getState().conflicts.find(c => c.claim_id === 'conflict-test-001')!;
        expect(conflict.status).toBe('resolved');
      });
    });

    describe('deleteConflict', () => {
      it('removes conflict', () => {
        useTaxonomyStore.getState().deleteConflict('conflict-test-001');
        expect(useTaxonomyStore.getState().conflicts).toHaveLength(0);
      });

      it('clears selection if deleted conflict was selected', () => {
        useTaxonomyStore.setState({ selectedNodeId: 'conflict-test-001' });
        useTaxonomyStore.getState().deleteConflict('conflict-test-001');
        expect(useTaxonomyStore.getState().selectedNodeId).toBeNull();
      });
    });

    describe('conflict instances', () => {
      it('addConflictInstance appends to instances', () => {
        const instance = { source_pov: 'accelerationist', context: 'test' } as any;
        useTaxonomyStore.getState().addConflictInstance('conflict-test-001', instance);
        expect(useTaxonomyStore.getState().conflicts[0].instances).toHaveLength(1);
      });

      it('removeConflictInstance removes by index', () => {
        const instances = [{ source_pov: 'a' }, { source_pov: 'b' }] as any[];
        useTaxonomyStore.setState({
          conflicts: [makeConflict({ instances })],
        });
        useTaxonomyStore.getState().removeConflictInstance('conflict-test-001', 0);
        expect(useTaxonomyStore.getState().conflicts[0].instances).toHaveLength(1);
        expect(useTaxonomyStore.getState().conflicts[0].instances[0].source_pov).toBe('b');
      });

      it('updateConflictInstance updates by index', () => {
        const instances = [{ source_pov: 'a', context: 'old' }] as any[];
        useTaxonomyStore.setState({
          conflicts: [makeConflict({ instances })],
        });
        useTaxonomyStore.getState().updateConflictInstance('conflict-test-001', 0, { context: 'new' });
        expect(useTaxonomyStore.getState().conflicts[0].instances[0].context).toBe('new');
      });
    });

    describe('conflict notes', () => {
      it('addConflictNote appends', () => {
        const note = { note: 'Test note', author: 'user' } as any;
        useTaxonomyStore.getState().addConflictNote('conflict-test-001', note);
        expect(useTaxonomyStore.getState().conflicts[0].human_notes).toHaveLength(1);
      });

      it('removeConflictNote removes by index', () => {
        const notes = [{ note: 'A' }, { note: 'B' }] as any[];
        useTaxonomyStore.setState({
          conflicts: [makeConflict({ human_notes: notes })],
        });
        useTaxonomyStore.getState().removeConflictNote('conflict-test-001', 0);
        expect(useTaxonomyStore.getState().conflicts[0].human_notes).toHaveLength(1);
        expect(useTaxonomyStore.getState().conflicts[0].human_notes[0].note).toBe('B');
      });

      it('updateConflictNote updates by index', () => {
        const notes = [{ note: 'old', author: 'user' }] as any[];
        useTaxonomyStore.setState({
          conflicts: [makeConflict({ human_notes: notes })],
        });
        useTaxonomyStore.getState().updateConflictNote('conflict-test-001', 0, { note: 'new' });
        expect(useTaxonomyStore.getState().conflicts[0].human_notes[0].note).toBe('new');
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — lookup helpers
  // ═══════════════════════════════════════════════

  describe('lookup helpers', () => {
    beforeEach(() => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', label: 'Acc Belief', description: 'desc-acc' })]),
        safetyist: null,
        skeptic: null,
        situations: makeSituationsFile(),
        conflicts: [makeConflict({ claim_id: 'conflict-test-001', claim_label: 'Test Conflict' })],
        policyRegistry: [{ id: 'pol-001', action: 'Policy Action', source_povs: [], member_count: 0 }],
      });
    });

    describe('getAllNodeIds', () => {
      it('returns IDs from all loaded POVs and situations', () => {
        const ids = useTaxonomyStore.getState().getAllNodeIds();
        expect(ids).toContain('acc-beliefs-001');
        expect(ids).toContain('sit-001');
        expect(ids).toHaveLength(2);
      });
    });

    describe('getAllConflictIds', () => {
      it('returns all conflict IDs', () => {
        const ids = useTaxonomyStore.getState().getAllConflictIds();
        expect(ids).toEqual(['conflict-test-001']);
      });
    });

    describe('getLabelForId', () => {
      it('finds POV node label', () => {
        expect(useTaxonomyStore.getState().getLabelForId('acc-beliefs-001')).toBe('Acc Belief');
      });

      it('finds situation label', () => {
        expect(useTaxonomyStore.getState().getLabelForId('sit-001')).toBe('Test situation');
      });

      it('finds conflict label', () => {
        expect(useTaxonomyStore.getState().getLabelForId('conflict-test-001')).toBe('Test Conflict');
      });

      it('finds policy action', () => {
        expect(useTaxonomyStore.getState().getLabelForId('pol-001')).toBe('Policy Action');
      });

      it('returns empty string for unknown ID', () => {
        expect(useTaxonomyStore.getState().getLabelForId('unknown-999')).toBe('');
      });
    });

    describe('getDescriptionForId', () => {
      it('finds POV node description', () => {
        expect(useTaxonomyStore.getState().getDescriptionForId('acc-beliefs-001')).toBe('desc-acc');
      });

      it('finds situation description', () => {
        expect(useTaxonomyStore.getState().getDescriptionForId('sit-001')).toBe('A test situation');
      });

      it('returns empty string for unknown ID', () => {
        expect(useTaxonomyStore.getState().getDescriptionForId('unknown-999')).toBe('');
      });
    });

    describe('lookupPinnedData', () => {
      it('returns pov pinned data for POV node', () => {
        const result = useTaxonomyStore.getState().lookupPinnedData('acc-beliefs-001');
        expect(result).not.toBeNull();
        expect(result!.type).toBe('pov');
      });

      it('returns situations pinned data for situation node', () => {
        const result = useTaxonomyStore.getState().lookupPinnedData('sit-001');
        expect(result).not.toBeNull();
        expect(result!.type).toBe('situations');
      });

      it('returns conflict pinned data', () => {
        const result = useTaxonomyStore.getState().lookupPinnedData('conflict-test-001');
        expect(result).not.toBeNull();
        expect(result!.type).toBe('conflict');
      });

      it('returns null for unknown ID', () => {
        expect(useTaxonomyStore.getState().lookupPinnedData('unknown-999')).toBeNull();
      });

      // t/3401: pol-* ids previously fell through every branch to null — the debate ref-popup
      // showed "Node not found" for a policy reference. Both arms per the ticket's UAT triage.
      describe('policy refs (t/3401)', () => {
        it('resolves a pol-* id to the policy registry entry, with referencing nodes', () => {
          useTaxonomyStore.setState({
            accelerationist: makePovFile([
              makePovNode({
                id: 'acc-beliefs-001',
                label: 'Acc Belief',
                graph_attributes: { policy_actions: [{ policy_id: 'pol-001', action: 'Node action', framing: 'Node framing' }] } as never,
              }),
            ]),
          });
          const result = useTaxonomyStore.getState().lookupPinnedData('pol-001');
          expect(result).not.toBeNull();
          expect(result!.type).toBe('policy');
          if (result!.type === 'policy') {
            expect(result!.policy.action).toBe('Policy Action');
            expect(result!.referencingNodes).toEqual([
              { id: 'acc-beliefs-001', label: 'Acc Belief', pov: 'accelerationist', action: 'Node action', framing: 'Node framing' },
            ]);
          }
        });

        it('returns a policy with an empty referencingNodes list when no loaded node references it', () => {
          const result = useTaxonomyStore.getState().lookupPinnedData('pol-001');
          expect(result).not.toBeNull();
          expect(result!.type).toBe('policy');
          if (result!.type === 'policy') expect(result!.referencingNodes).toEqual([]);
        });

        it('returns null for an unknown pol-* id (graceful fallback persists)', () => {
          expect(useTaxonomyStore.getState().lookupPinnedData('pol-does-not-exist')).toBeNull();
        });
      });

      it('returns structuredClone (not a reference)', () => {
        const result = useTaxonomyStore.getState().lookupPinnedData('acc-beliefs-001')!;
        if (result.type === 'pov') {
          result.node.label = 'MUTATED';
          expect(useTaxonomyStore.getState().accelerationist!.nodes[0].label).toBe('Acc Belief');
        }
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — edges
  // ═══════════════════════════════════════════════

  describe('edges', () => {
    describe('loadEdges', () => {
      it('loads edges from API', async () => {
        const edgesFile = { edges: [{ source: 'a', target: 'b', type: 'supports' }] };
        mockApi.loadEdges.mockResolvedValueOnce(edgesFile);

        await useTaxonomyStore.getState().loadEdges();
        expect(useTaxonomyStore.getState().edgesFile).toEqual(edgesFile);
        expect(useTaxonomyStore.getState().edgesLoading).toBe(false);
      });

      it('skips if already loaded', async () => {
        useTaxonomyStore.setState({ edgesFile: { edges: [] } as any });
        await useTaxonomyStore.getState().loadEdges();
        expect(mockApi.loadEdges).not.toHaveBeenCalled();
      });
    });

    describe('showRelatedEdges', () => {
      it('sets relatedNodeId and toolbar panel', () => {
        useTaxonomyStore.setState({ edgesFile: { edges: [] } as any });
        useTaxonomyStore.getState().showRelatedEdges('acc-beliefs-001');
        expect(useTaxonomyStore.getState().relatedNodeId).toBe('acc-beliefs-001');
        expect(useTaxonomyStore.getState().toolbarPanel).toBe('related');
      });

      it('clears when passed null', () => {
        useTaxonomyStore.setState({ relatedNodeId: 'x', toolbarPanel: 'related' });
        useTaxonomyStore.getState().showRelatedEdges(null);
        expect(useTaxonomyStore.getState().relatedNodeId).toBeNull();
        expect(useTaxonomyStore.getState().toolbarPanel).toBeNull();
      });
    });

    describe('selectEdge', () => {
      it('sets selectedEdge', () => {
        const edge = { source: 'a', target: 'b', type: 'supports' } as Edge;
        useTaxonomyStore.getState().selectEdge(edge);
        expect(useTaxonomyStore.getState().selectedEdge).toBe(edge);
      });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — toolbar navigation
  // ═══════════════════════════════════════════════

  describe('toolbar navigation', () => {
    it('setToolbarPanel updates panel and saves previousView', () => {
      useTaxonomyStore.setState({ toolbarPanel: 'search', selectedNodeId: 'abc' });
      useTaxonomyStore.getState().setToolbarPanel('lineage');
      expect(useTaxonomyStore.getState().toolbarPanel).toBe('lineage');
      expect(useTaxonomyStore.getState().previousView).toEqual({ panel: 'search', nodeId: 'abc' });
    });

    it('navigateToLineage sets panel and value', () => {
      useTaxonomyStore.getState().navigateToLineage('kantian-ethics');
      expect(useTaxonomyStore.getState().toolbarPanel).toBe('lineage');
      expect(useTaxonomyStore.getState().pendingLineageValue).toBe('kantian-ethics');
    });

    it('navigateToSearchRelated sets panel and nodeId', () => {
      useTaxonomyStore.getState().navigateToSearchRelated('acc-beliefs-001');
      expect(useTaxonomyStore.getState().toolbarPanel).toBe('search');
      expect(useTaxonomyStore.getState().pendingSearchRelatedId).toBe('acc-beliefs-001');
    });

    it('navigateBack restores previousView', () => {
      useTaxonomyStore.setState({
        toolbarPanel: 'lineage',
        previousView: { panel: 'search', nodeId: 'abc' },
      });
      useTaxonomyStore.getState().navigateBack();
      expect(useTaxonomyStore.getState().toolbarPanel).toBe('search');
      expect(useTaxonomyStore.getState().selectedNodeId).toBe('abc');
      expect(useTaxonomyStore.getState().previousView).toBeNull();
    });

    it('navigateBack with no previousView clears panel', () => {
      useTaxonomyStore.setState({ toolbarPanel: 'lineage', previousView: null });
      useTaxonomyStore.getState().navigateBack();
      expect(useTaxonomyStore.getState().toolbarPanel).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — loadAll
  // ═══════════════════════════════════════════════

  describe('loadAll', () => {
    it('loads accelerationist first then remaining in parallel', async () => {
      const accFile = makePovFile([makePovNode({ id: 'acc-beliefs-001' })]);
      const safFile = makePovFile([makePovNode({ id: 'saf-beliefs-001' })]);
      const skpFile = makePovFile([makePovNode({ id: 'skp-beliefs-001' })]);
      const sitFile = makeSituationsFile();

      mockApi.loadTaxonomyFileForEdit.mockImplementation((pov: string) => {
        if (pov === 'accelerationist') return Promise.resolve(accFile);
        if (pov === 'safetyist') return Promise.resolve(safFile);
        if (pov === 'skeptic') return Promise.resolve(skpFile);
        if (pov === 'situations') return Promise.resolve(sitFile);
        return Promise.resolve(null);
      });
      mockApi.loadPolicyRegistry.mockResolvedValueOnce({ policies: [{ id: 'pol-001', action: 'Act' }] });

      await useTaxonomyStore.getState().loadAll();

      expect(useTaxonomyStore.getState().accelerationist).not.toBeNull();
      expect(useTaxonomyStore.getState().safetyist).not.toBeNull();
      expect(useTaxonomyStore.getState().skeptic).not.toBeNull();
      expect(useTaxonomyStore.getState().situations).not.toBeNull();
      expect(useTaxonomyStore.getState().loading).toBe(false);
      expect(useTaxonomyStore.getState().backgroundLoading).toBe(false);
    });

    it('sets loading state during initial load', async () => {
      let wasLoading = false;
      const unsubscribe = useTaxonomyStore.subscribe((state) => {
        if (state.loading) wasLoading = true;
      });

      mockApi.loadTaxonomyFileForEdit.mockResolvedValue({ nodes: [] });
      mockApi.loadPolicyRegistry.mockResolvedValue({ policies: [] });
      await useTaxonomyStore.getState().loadAll();

      unsubscribe();
      expect(wasLoading).toBe(true);
    });

    it('handles load failure gracefully', async () => {
      mockApi.loadTaxonomyFileForEdit.mockRejectedValueOnce(new Error('Network error'));
      await useTaxonomyStore.getState().loadAll();
      expect(useTaxonomyStore.getState().loading).toBe(false);
      expect(useTaxonomyStore.getState().saveError).toBeTruthy();
    });

    // t/4208: call-target assertion moved to useTaxonomyStore.loadAllForEdit.test.ts (max-lines).
  });

  // t/3378: aggregate strip-count observability on top of the existing per-node WARN (t/3250) —
  // a mass strip (the t/3375 class, 133 frames) should be visible without counting log lines.
  describe('loadAll — logical_form strip summary (t/3378)', () => {
    function mockOtherPovsEmpty(accFile: PovTaxonomyFile) {
      mockApi.loadTaxonomyFileForEdit.mockImplementation((pov: string) => {
        if (pov === 'accelerationist') return Promise.resolve(accFile);
        return Promise.resolve({ nodes: [] });
      });
    }

    it('emits an aggregate WARN with the strip count when frames are stripped on load', async () => {
      const accFile = makePovFile([
        makePovNode({ id: 'acc-beliefs-001' }),
        makePovNode({ id: 'acc-beliefs-002' }),
      ]);
      mockOtherPovsEmpty(accFile);
      mockStripInvalidLogicalForm.mockReturnValue({ removed: true, issue: 'bad frame' });

      await useTaxonomyStore.getState().loadAll();

      const summaryCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('logical_form strip summary'));
      expect(summaryCall).toBeTruthy();
      expect(summaryCall![0]).toMatchObject({ level: 'warn', data: { pov: 'accelerationist', strippedCount: 2 } });
    });

    it('does not emit a strip summary on a clean load (no strips)', async () => {
      mockOtherPovsEmpty(makePovFile([makePovNode()]));
      mockStripInvalidLogicalForm.mockReturnValue({ removed: false });

      await useTaxonomyStore.getState().loadAll();

      const summaryCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('logical_form strip summary'));
      expect(summaryCall).toBeUndefined();
    });

    it('escalates to level "error" when the stripped count exceeds the systemic threshold (>5)', async () => {
      const nodes = Array.from({ length: 6 }, (_, i) => makePovNode({ id: `acc-beliefs-${i}` }));
      mockOtherPovsEmpty(makePovFile(nodes));
      mockStripInvalidLogicalForm.mockReturnValue({ removed: true, issue: 'bad frame' });

      await useTaxonomyStore.getState().loadAll();

      const summaryCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('logical_form strip summary'));
      expect(summaryCall![0]).toMatchObject({ level: 'error', data: { strippedCount: 6 } });
    });
  });

  // ═══════════════════════════════════════════════
  // Taxonomy data — save
  // ═══════════════════════════════════════════════

  describe('save', () => {
    it('does nothing when dirty set is empty', async () => {
      useTaxonomyStore.setState({ dirty: new Set() });
      await useTaxonomyStore.getState().save();
      expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();
    });

    it('saves dirty POV files', async () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile(),
        dirty: new Set(['accelerationist']),
      });

      await useTaxonomyStore.getState().save();
      expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('accelerationist', expect.any(Object));
      expect(mockApi.syncCommit).toHaveBeenCalled();
      expect(useTaxonomyStore.getState().dirty.size).toBe(0);
    });

    it('saves dirty situations file', async () => {
      // t/3888: a real store always has the baseline that load sets. Without it every node looks
      // new and is BDI-gated, and this fixture's flat (legacy) interpretations are refused.
      const situations = makeSituationsFile();
      useTaxonomyStore.setState({
        situations,
        situationsBaseline: buildSituationBaseline(situations.nodes),
        dirty: new Set(['situations']),
      });

      await useTaxonomyStore.getState().save();
      expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('situations', expect.any(Object));
    });

    // ── t/3888: BDI save gate on changed situations ──────────────────────────
    describe('situation BDI gate (t/3888)', () => {
      /** Load-equivalent state: file + the baseline loadAll would set, then dirty. */
      function loadSituations(nodes: CrossCuttingFile['nodes']) {
        const file = { ...makeSituationsFile(), nodes };
        useTaxonomyStore.setState({ situations: file, situationsBaseline: buildSituationBaseline(nodes), dirty: new Set(['situations']) });
      }
      const sit = (id: string, interpretations: CrossCuttingFile['nodes'][number]['interpretations'], description = 'A situation that tests the gate.') =>
        ({ id, label: `Label ${id}`, description, interpretations, linked_nodes: [], conflict_ids: [] });
      const flat = { accelerationist: 'acc prose', safetyist: 'saf prose', skeptic: 'skp prose' };
      const full = { accelerationist: fullBdi('acc'), safetyist: fullBdi('saf'), skeptic: fullBdi('skp') };

      it('refuses a new situation left with empty B/D/I, names node/POV/fields, and writes nothing', async () => {
        loadSituations([sit('sit-001', full)]);
        const newId = useTaxonomyStore.getState().createSituationNode();

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();
        const { saveError, validationErrors } = useTaxonomyStore.getState();
        expect(saveError).toContain(newId);
        expect(saveError).toContain('accelerationist: belief, desire, intention are empty or a placeholder');
        expect(validationErrors[`nodes.${newId}.interpretations.skeptic`]).toMatch(/belief, desire, intention/);
      });

      it('refuses a flat string written into a changed situation', async () => {
        loadSituations([sit('sit-001', full)]);
        const node = useTaxonomyStore.getState().situations!.nodes[0];
        useTaxonomyStore.setState({ situations: { ...useTaxonomyStore.getState().situations!, nodes: [{ ...node, interpretations: { ...full, safetyist: 'flat prose' } }] } });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();
        expect(useTaxonomyStore.getState().validationErrors['nodes.sit-001.interpretations.safetyist']).toMatch(/not broken into belief, desire and intention/);
      });

      it('refuses a null-sentinel placeholder and names only that field', async () => {
        loadSituations([sit('sit-001', full)]);
        useTaxonomyStore.getState().updateSituationNode('sit-001', { interpretations: { accelerationist: { ...fullBdi('acc'), desire: 'N/A' } } });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).not.toHaveBeenCalled();
        expect(useTaxonomyStore.getState().validationErrors['nodes.sit-001.interpretations.accelerationist']).toBe('accelerationist: desire is empty or a placeholder (N/A, TBD, none…)');
      });

      it('saves a complete BDI change and makes the saved state the new baseline', async () => {
        loadSituations([sit('sit-001', full)]);
        useTaxonomyStore.getState().updateSituationNode('sit-001', { interpretations: { skeptic: fullBdi('skp2') } });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('situations', expect.any(Object));
        const { situations, situationsBaseline } = useTaxonomyStore.getState();
        expect(situationsBaseline).toEqual(buildSituationBaseline(situations!.nodes));
      });

      // SO e/244#2 Q1, arm 2: an unchanged live flat node must not block an unrelated save.
      it('lets an untouched legacy flat node through while another node changes', async () => {
        loadSituations([sit('sit-001', flat), sit('sit-002', full)]);
        useTaxonomyStore.getState().updateSituationNode('sit-002', { interpretations: { accelerationist: fullBdi('acc2') } });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('situations', expect.any(Object));
      });

      // SO Q1, condition 1: "changed" is defined over interpretations only.
      it('does not gate a label-only edit of a legacy flat node', async () => {
        loadSituations([sit('sit-001', flat)]);
        useTaxonomyStore.getState().updateSituationNode('sit-001', { label: 'Renamed label' });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('situations', expect.any(Object));
      });

      it('exempts a [DEPRECATED] situation even when its flat interpretation changed', async () => {
        loadSituations([sit('sit-154', flat, '[DEPRECATED] A situation that was retired.')]);
        const node = useTaxonomyStore.getState().situations!.nodes[0];
        useTaxonomyStore.setState({ situations: { ...useTaxonomyStore.getState().situations!, nodes: [{ ...node, interpretations: { ...flat, skeptic: 'edited prose' } }] } });

        await useTaxonomyStore.getState().save();

        expect(mockApi.saveTaxonomyFile).toHaveBeenCalledWith('situations', expect.any(Object));
      });
    });

    it('saves dirty conflict files', async () => {
      useTaxonomyStore.setState({
        conflicts: [makeConflict()],
        dirty: new Set(['conflict-test-001']),
      });

      await useTaxonomyStore.getState().save();
      expect(mockApi.saveConflictFile).toHaveBeenCalledWith('conflict-test-001', expect.any(Object));
    });

    it('saves the dirty edges file via saveEdges (t/1816 new-edge persistence)', async () => {
      // Edges must reference existing nodes, else save()'s integrity auto-fix strips them
      // as dangling before the save branch runs. makePovNode/makeSituationsFile provide
      // acc-beliefs-001 and sit-001.
      const edgesFile = { edges: [{ source: 'acc-beliefs-001', target: 'sit-001', type: 'CONVERGES_WITH' }] } as unknown as EdgesFile;
      useTaxonomyStore.setState({
        accelerationist: makePovFile(),
        situations: makeSituationsFile(),
        edgesFile,
        dirty: new Set(['edges']),
      });

      await useTaxonomyStore.getState().save();
      expect(mockApi.saveEdges).toHaveBeenCalledWith(edgesFile);
      expect(useTaxonomyStore.getState().dirty.size).toBe(0);
    });

    it('sets saveError on failure', async () => {
      mockApi.saveTaxonomyFile.mockRejectedValueOnce(new Error('Disk full'));
      useTaxonomyStore.setState({
        accelerationist: makePovFile(),
        dirty: new Set(['accelerationist']),
      });

      await useTaxonomyStore.getState().save();
      expect(useTaxonomyStore.getState().saveError).toBeTruthy();
    });

    // t/4186/t/4197 WRITE_CONFLICT/BASE_VERSION_REQUIRED and pre-save-re-read-stays-plain tests
    // moved to useTaxonomyStore.saveConflict.test.ts (t/4197, max-lines, p/775#45/#46).

    it('dismissSaveError clears error', () => {
      useTaxonomyStore.setState({ saveError: 'Some error' });
      useTaxonomyStore.getState().dismissSaveError();
      expect(useTaxonomyStore.getState().saveError).toBeNull();
    });

    // t/3376: a whole-file save must never persist a load-time strip of `logical_form`
    // (t/3375: 133 acc frames silently deleted this way). Both-arms per the approved design.
    describe('logical_form reattach-on-save (t/3376)', () => {
      it('reattaches a logical_form present on disk but missing in memory before saving', async () => {
        const memoryNode = makePovNode({ id: 'acc-beliefs-001' }); // no logical_form — stripped at load
        const diskNode = { ...memoryNode, logical_form: { predicate: 'cost' } };
        mockApi.loadTaxonomyFile.mockImplementation((pov: string) =>
          pov === 'accelerationist' ? Promise.resolve(makePovFile([diskNode])) : Promise.resolve({ nodes: [] }),
        );
        useTaxonomyStore.setState({
          accelerationist: makePovFile([memoryNode]),
          dirty: new Set(['accelerationist']),
        });

        await useTaxonomyStore.getState().save();

        const [, savedFile] = mockApi.saveTaxonomyFile.mock.calls.find(([pov]) => pov === 'accelerationist')!;
        expect((savedFile as PovTaxonomyFile).nodes[0].logical_form).toEqual({ predicate: 'cost' });
      });

      it('leaves a node with a valid in-memory logical_form untouched (no reattach)', async () => {
        const memoryLf = { predicate: 'keep-me' };
        const memoryNode = { ...makePovNode({ id: 'acc-beliefs-001' }), logical_form: memoryLf };
        // Disk carries a DIFFERENT value — proves the reattach only fires when memory is undefined.
        const diskNode = { ...memoryNode, logical_form: { predicate: 'should-not-be-used' } };
        mockApi.loadTaxonomyFile.mockImplementation((pov: string) =>
          pov === 'accelerationist' ? Promise.resolve(makePovFile([diskNode])) : Promise.resolve({ nodes: [] }),
        );
        useTaxonomyStore.setState({
          accelerationist: makePovFile([memoryNode]),
          dirty: new Set(['accelerationist']),
        });

        await useTaxonomyStore.getState().save();

        const [, savedFile] = mockApi.saveTaxonomyFile.mock.calls.find(([pov]) => pov === 'accelerationist')!;
        expect((savedFile as PovTaxonomyFile).nodes[0].logical_form).toEqual(memoryLf);
      });

      it('fails open (but loud) when the re-read throws — the save still completes', async () => {
        const memoryNode = makePovNode({ id: 'acc-beliefs-001' });
        mockApi.loadTaxonomyFile.mockImplementation((pov: string) =>
          pov === 'accelerationist' ? Promise.reject(new Error('network error')) : Promise.resolve({ nodes: [] }),
        );
        useTaxonomyStore.setState({
          accelerationist: makePovFile([memoryNode]),
          dirty: new Set(['accelerationist']),
        });

        await useTaxonomyStore.getState().save();

        // Save is not aborted by the re-read failure — the original in-memory file still saves.
        const [, savedFile] = mockApi.saveTaxonomyFile.mock.calls.find(([pov]) => pov === 'accelerationist')!;
        expect((savedFile as PovTaxonomyFile).nodes[0]).toEqual(memoryNode);
        expect(useTaxonomyStore.getState().saveError).toBeNull();
        // Loud, not silent: a WARN is recorded for the skipped reattach (fallback-path logging).
        const warnCall = mockRecord.mock.calls.find(([entry]) => entry.message?.includes('reattach-on-save') && entry.message?.includes('re-read'));
        expect(warnCall).toBeTruthy();
        expect(warnCall![0]).toMatchObject({ level: 'warn' });
      });
    });

    // t/3955 (TL t/3955#4 cond 2): a tagged node survives each editor write path with its tags still an
    // ARRAY. One-element arrays on purpose: that is the common case and where an unroll would show.
    // Validation is mocked in this harness, so these test the write paths, not the tag rules.
    describe('pov_tags round-trip (t/3955)', () => {
      const tagged = () => makePovNode({ id: 'acc-beliefs-001', pov_tags: ['critical'] });
      const savedNode = (id: string) => {
        const [, f] = mockApi.saveTaxonomyFile.mock.calls.find(([pov]) => pov === 'accelerationist')!;
        return (f as PovTaxonomyFile).nodes.find((n) => n.id === id)!;
      };

      it('survives save() unchanged, through the logical_form reattach step', async () => {
        mockApi.loadTaxonomyFile.mockImplementation((pov: string) =>
          pov === 'accelerationist' ? Promise.resolve(makePovFile([tagged()])) : Promise.resolve({ nodes: [] }),
        );
        // Tags already on disk at load are in the baseline (t/3973), as a real load would record them.
        useTaxonomyStore.setState({ accelerationist: makePovFile([tagged()]), dirty: new Set(['accelerationist']), povTagsBaseline: { 'acc-beliefs-001': '["critical"]' } });
        await useTaxonomyStore.getState().save();
        expect(savedNode('acc-beliefs-001').pov_tags).toEqual(['critical']);
      });

      it('survives updatePovNode (an unrelated field edit) and the following save()', async () => {
        useTaxonomyStore.setState({ accelerationist: makePovFile([tagged()]), povTagsBaseline: { 'acc-beliefs-001': '["critical"]' } });
        useTaxonomyStore.getState().updatePovNode('accelerationist', 'acc-beliefs-001', { label: 'Renamed' });
        const node = useTaxonomyStore.getState().accelerationist!.nodes[0];
        expect(node.label).toBe('Renamed');
        expect(node.pov_tags).toEqual(['critical']);
        await useTaxonomyStore.getState().save();
        expect(savedNode('acc-beliefs-001').pov_tags).toEqual(['critical']);
      });

      it('survives movePovNodeCategory (same POV, new id)', () => {
        useTaxonomyStore.setState({ accelerationist: makePovFile([tagged()]) });
        const newId = useTaxonomyStore.getState().movePovNodeCategory('accelerationist', 'acc-beliefs-001', 'Desires');
        expect(newId).toBeTruthy();
        const moved = useTaxonomyStore.getState().accelerationist!.nodes.find((n) => n.id === newId)!;
        expect(moved.pov_tags).toEqual(['critical']);
        expect(Array.isArray(moved.pov_tags)).toBe(true);
      });
    });

    // t/3973: registry MEMBERSHIP is gated on nodes changed since load; STRUCTURAL problems block everywhere.
    // These arms put 'critical' on an ACCELERATIONIST node: the committed registry has no accelerationist tags
    // (only skeptic ones, t/3956), so the tag is unregistered ("orphaned") there.
    describe('pov_tags save gate (t/3973)', () => {
      const saveCalledFor = (pov: string) => mockApi.saveTaxonomyFile.mock.calls.some(([p]) => p === pov);
      const orphanWarn = () => mockRecord.mock.calls.find(([e]) => e.message?.includes('unregistered POV tags already on nodes'));
      const seed = (node: Partial<PovNode>, baseline: Record<string, string>) => useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', ...node })]),
        dirty: new Set(['accelerationist']),
        validationErrors: {},
        povTagsBaseline: baseline,
      });

      it('an UNTOUCHED node with an orphaned tag still saves, and WARNs naming it', async () => {
        seed({ pov_tags: ['critical'], label: 'Edited elsewhere in the file' }, { 'acc-beliefs-001': '["critical"]' });
        await useTaxonomyStore.getState().save();
        expect(useTaxonomyStore.getState().validationErrors).toEqual({});
        expect(saveCalledFor('accelerationist')).toBe(true);
        expect(orphanWarn()![0]).toMatchObject({ level: 'warn', data: { count: 1, nodes: [{ node_id: 'acc-beliefs-001' }] } });
      });

      it('an EDITED node given an unregistered tag is blocked, keyed to that node', async () => {
        seed({ pov_tags: ['critical'] }, { 'acc-beliefs-001': 'null' });
        await useTaxonomyStore.getState().save();
        expect(useTaxonomyStore.getState().validationErrors['nodes.acc-beliefs-001.pov_tags']).toMatch(/not registered/);
        expect(saveCalledFor('accelerationist')).toBe(false);
        expect(orphanWarn()).toBeUndefined();
      });

      it('a NEW node (absent from the baseline) with an unregistered tag is blocked', async () => {
        seed({ pov_tags: ['critical'] }, {});
        await useTaxonomyStore.getState().save();
        expect(useTaxonomyStore.getState().validationErrors['nodes.acc-beliefs-001.pov_tags']).toMatch(/not registered/);
        expect(saveCalledFor('accelerationist')).toBe(false);
      });

      // Structural problems block via the SCHEMA on every node; that arm is proven against the real schema in
      // utils/validation.povTags.test.ts (this harness mocks validation). Here: the membership gate never
      // treats a structural problem as a forgivable orphan, so it can't WARN one through on an untouched node.
      it('the gate never treats a STRUCTURAL problem as a forgivable orphan (no WARN, no membership error)', () => {
        const scalar = makePovNode({ id: 'acc-beliefs-001', pov_tags: 'critical' as unknown as string[] });
        expect(povTagMembershipErrors([scalar], { 'acc-beliefs-001': '"critical"' })).toEqual({});
        expect(orphanWarn()).toBeUndefined();
      });

      // t/3984: the untouched orphans the gate lets through are shown to the user after the save.
      it('a successful save records the untouched orphans for the notice, and never sets saveError', async () => {
        seed({ pov_tags: ['critical'] }, { 'acc-beliefs-001': '["critical"]' });
        await useTaxonomyStore.getState().save();
        expect(useTaxonomyStore.getState().orphanedTagNodeIds).toEqual(['acc-beliefs-001']);
        expect(useTaxonomyStore.getState().saveError).toBeNull();
      });

      it('a save with no orphans clears the notice', async () => {
        useTaxonomyStore.setState({ orphanedTagNodeIds: ['stale-from-last-save'] });
        seed({ pov_tags: [] }, { 'acc-beliefs-001': 'null' });
        await useTaxonomyStore.getState().save();
        expect(useTaxonomyStore.getState().orphanedTagNodeIds).toEqual([]);
      });

      it('a BLOCKED save leaves the notice untouched (the errors are what the user needs then)', async () => {
        useTaxonomyStore.setState({ orphanedTagNodeIds: [] });
        seed({ pov_tags: ['critical'] }, { 'acc-beliefs-001': 'null' }); // edited → blocked
        await useTaxonomyStore.getState().save();
        expect(saveCalledFor('accelerationist')).toBe(false);
        expect(useTaxonomyStore.getState().orphanedTagNodeIds).toEqual([]);
      });

      it('the baseline refreshes after a successful save', async () => {
        seed({ pov_tags: [] }, { 'acc-beliefs-001': 'null' });
        await useTaxonomyStore.getState().save();
        expect(saveCalledFor('accelerationist')).toBe(true);
        expect(useTaxonomyStore.getState().povTagsBaseline['acc-beliefs-001']).toBe('[]');
      });

      it('an EDITED node with a REGISTERED tag passes the gate (registry injected; committed one is empty)', () => {
        const registry = { version: 1, povs: { accelerationist: [{ id: 'critical', label: 'Critical', soul_doc: 'accelerationist.critical', description: 'd' }] } };
        const node = makePovNode({ id: 'acc-beliefs-001', pov_tags: ['critical'] });
        expect(povTagMembershipErrors([node], { 'acc-beliefs-001': 'null' }, registry)).toEqual({});
        expect(povTagMembershipErrors([node], { 'acc-beliefs-001': 'null' })).toHaveProperty(['nodes.acc-beliefs-001.pov_tags']); // control: same edit, real (empty) registry
      });
    });

    // t/2064: the post-save embedding refresh reports { staleNodeIds }; surface degradation
    // via the embeddingsStale store flag (NOT saveError — the durable save already succeeded),
    // instead of the old fire-and-forget swallow. The refresh is non-blocking, so flush a tick.
    const flushRefresh = () => new Promise((r) => setTimeout(r, 0));

    it('flags embeddingsStale when the refresh returns stale nodes; save stays clean (t/2064 AC)', async () => {
      mockApi.updateNodeEmbeddings.mockResolvedValueOnce({ staleNodeIds: ['acc-beliefs-001'] });
      useTaxonomyStore.setState({ accelerationist: makePovFile(), dirty: new Set(['accelerationist']) });

      await useTaxonomyStore.getState().save();
      await flushRefresh();

      expect(mockApi.updateNodeEmbeddings).toHaveBeenCalled();
      expect(useTaxonomyStore.getState().embeddingsStale).toBe(true);
      expect(useTaxonomyStore.getState().staleEmbeddingNodeIds).toEqual(['acc-beliefs-001']);
      expect(useTaxonomyStore.getState().saveError).toBeNull(); // durable save unaffected
    });

    it('clears embeddingsStale when the refresh reports full success (empty staleNodeIds)', async () => {
      mockApi.updateNodeEmbeddings.mockResolvedValueOnce({ staleNodeIds: [] });
      useTaxonomyStore.setState({
        embeddingsStale: true, staleEmbeddingNodeIds: ['stale-prior'],
        accelerationist: makePovFile(), dirty: new Set(['accelerationist']),
      });

      await useTaxonomyStore.getState().save();
      await flushRefresh();

      expect(useTaxonomyStore.getState().embeddingsStale).toBe(false);
      expect(useTaxonomyStore.getState().staleEmbeddingNodeIds).toEqual([]);
    });

    it('flags embeddingsStale when the refresh rejects — no silent swallow (t/2064)', async () => {
      mockApi.updateNodeEmbeddings.mockRejectedValueOnce(new Error('embed OOM'));
      useTaxonomyStore.setState({ accelerationist: makePovFile(), dirty: new Set(['accelerationist']) });

      await useTaxonomyStore.getState().save();
      await flushRefresh();

      expect(useTaxonomyStore.getState().embeddingsStale).toBe(true);
      expect(useTaxonomyStore.getState().saveError).toBeNull(); // durable save still succeeded
    });

    it('dismissEmbeddingsStale clears the flag', () => {
      useTaxonomyStore.setState({ embeddingsStale: true, staleEmbeddingNodeIds: ['x'] });
      useTaxonomyStore.getState().dismissEmbeddingsStale();
      expect(useTaxonomyStore.getState().embeddingsStale).toBe(false);
      expect(useTaxonomyStore.getState().staleEmbeddingNodeIds).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════
  // Semantic search (async)
  // ═══════════════════════════════════════════════

  describe('runSemanticSearch', () => {
    it('returns empty results for blank query', async () => {
      await useTaxonomyStore.getState().runSemanticSearch('   ', new Set(), new Set());
      expect(useTaxonomyStore.getState().semanticResults).toEqual([]);
    });

    it('computes embeddings and runs search', async () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode({ id: 'acc-beliefs-001', description: 'test' })]),
        safetyist: null,
        skeptic: null,
        situations: null,
        conflicts: [],
      });

      mockApi.computeEmbeddings.mockResolvedValueOnce({ vectors: [[0.1, 0.2]] });
      mockApi.computeQueryEmbedding.mockResolvedValueOnce({ vector: [0.1, 0.2] });
      const { rankBySimilarity } = await import('../utils/similarity');
      (rankBySimilarity as ReturnType<typeof vi.fn>).mockReturnValueOnce([{ id: 'acc-beliefs-001', score: 0.95 }]);

      await useTaxonomyStore.getState().runSemanticSearch('test query', new Set(), new Set());

      expect(useTaxonomyStore.getState().semanticResults).toHaveLength(1);
      expect(useTaxonomyStore.getState().embeddingLoading).toBe(false);
    });

    it('handles embedding error gracefully', async () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode()]),
        safetyist: null,
        skeptic: null,
        situations: null,
        conflicts: [],
      });

      mockApi.computeEmbeddings.mockRejectedValueOnce(new Error('API error'));

      await useTaxonomyStore.getState().runSemanticSearch('query', new Set(), new Set());

      expect(useTaxonomyStore.getState().embeddingLoading).toBe(false);
      expect(useTaxonomyStore.getState().embeddingError).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════
  // Similar search (async)
  // ═══════════════════════════════════════════════

  describe('runSimilarSearch', () => {
    it('returns empty for blank query', async () => {
      await useTaxonomyStore.getState().runSimilarSearch('node1', '', '');
      expect(useTaxonomyStore.getState().similarResults).toEqual([]);
      expect(useTaxonomyStore.getState().similarLoading).toBe(false);
    });

    it('runs search and excludes source node', async () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([
          makePovNode({ id: 'acc-beliefs-001', description: 'test' }),
          makePovNode({ id: 'acc-beliefs-002', description: 'similar' }),
        ]),
        safetyist: null,
        skeptic: null,
        situations: null,
        conflicts: [],
      });

      mockApi.computeEmbeddings.mockResolvedValueOnce({ vectors: [[0.1], [0.2]] });
      mockApi.computeQueryEmbedding.mockResolvedValueOnce({ vector: [0.1] });
      const { rankBySimilarity } = await import('../utils/similarity');
      (rankBySimilarity as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { id: 'acc-beliefs-001', score: 1.0 },
        { id: 'acc-beliefs-002', score: 0.8 },
      ]);

      await useTaxonomyStore.getState().runSimilarSearch('acc-beliefs-001', 'Test', 'test description');

      const results = useTaxonomyStore.getState().similarResults!;
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('acc-beliefs-002');
    });
  });

  describe('fixIntegrityErrors — edge dangling references', () => {
    function makeEdge(overrides: Partial<Edge> = {}): Edge {
      return {
        source: 'acc-beliefs-001',
        target: 'sit-001',
        type: 'CONVERGES_WITH',
        bidirectional: false,
        confidence: 0.8,
        weight: 0.8,
        rationale: 'test',
        status: 'proposed',
        discovered_at: '2026-01-01',
        model: 'test',
        ...overrides,
      } as Edge;
    }

    function makeEdgesFile(edges: Edge[]): EdgesFile {
      return { _schema_version: '1', _doc: '', last_modified: '2026-01-01', edge_types: [], edges } as EdgesFile;
    }

    it('drops an edge with a fabricated dangling source and clears the save error', () => {
      const validEdge = makeEdge();
      const danglingEdge = makeEdge({ source: 'acc-convergence' }); // symbolic, no such node
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode()]),
        situations: makeSituationsFile(),
        edgesFile: makeEdgesFile([validEdge, danglingEdge]),
        integrityIssues: [
          { severity: 'error', code: 'EDGE_DANGLING_SOURCE', entityId: 'acc-convergence', message: "Edge source 'acc-convergence' does not exist in taxonomy", fix: '' },
        ],
        saveError: 'Integrity check failed (1 error):\nEDGE_DANGLING_SOURCE: acc-convergence',
      });

      useTaxonomyStore.getState().fixIntegrityErrors();

      const state = useTaxonomyStore.getState();
      expect(state.edgesFile!.edges).toHaveLength(1);
      expect(state.edgesFile!.edges[0].source).toBe('acc-beliefs-001');
      expect(state.dirty.has('edges')).toBe(true);
      expect(state.saveError).toBeNull();
      expect(state.integrityIssues).toHaveLength(0);
    });

    it('drops an edge with a dangling target', () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode()]),
        situations: makeSituationsFile(),
        edgesFile: makeEdgesFile([makeEdge({ target: 'nonexistent-001' })]),
        integrityIssues: [
          { severity: 'error', code: 'EDGE_DANGLING_TARGET', entityId: 'nonexistent-001', message: "Edge target 'nonexistent-001' does not exist in taxonomy", fix: '' },
        ],
        saveError: 'Integrity check failed (1 error):\nEDGE_DANGLING_TARGET: nonexistent-001',
      });

      useTaxonomyStore.getState().fixIntegrityErrors();

      const state = useTaxonomyStore.getState();
      expect(state.edgesFile!.edges).toHaveLength(0);
      expect(state.dirty.has('edges')).toBe(true);
      expect(state.saveError).toBeNull();
    });

    it('keeps edges whose endpoints both resolve (situation target is valid)', () => {
      useTaxonomyStore.setState({
        accelerationist: makePovFile([makePovNode()]),
        situations: makeSituationsFile(),
        edgesFile: makeEdgesFile([makeEdge({ source: 'acc-beliefs-001', target: 'sit-001' })]),
        integrityIssues: [],
        saveError: null,
      });

      useTaxonomyStore.getState().fixIntegrityErrors();

      // No integrity issues → no-op, edge preserved.
      expect(useTaxonomyStore.getState().edgesFile!.edges).toHaveLength(1);
    });
  });
});

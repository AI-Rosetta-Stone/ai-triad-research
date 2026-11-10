// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks (available before vi.mock factories execute) ──

const { mockApi, mockTaxonomyState, mockPromptConfigState } = vi.hoisted(() => {
  const mockApi = {
    generateText: vi.fn().mockResolvedValue({ text: '{}' }),
    generateTextWithSearch: vi.fn().mockResolvedValue({ text: '', searchQueries: [], citations: [] }),
    onGenerateTextProgress: vi.fn().mockReturnValue(() => {}),
    listDebateSessions: vi.fn().mockResolvedValue([]),
    listDebateSessionsMeta: vi.fn().mockResolvedValue([]),
    loadDebateSession: vi.fn().mockResolvedValue({}),
    saveDebateSession: vi.fn().mockResolvedValue(undefined),
    deleteDebateSession: vi.fn().mockResolvedValue(undefined),
    setDebateTemperature: vi.fn().mockResolvedValue(undefined),
    sendDiagnosticsState: vi.fn(),
    openDiagnosticsWindow: vi.fn().mockResolvedValue(undefined),
    closeDiagnosticsWindow: vi.fn(),
    computeEmbeddings: vi.fn().mockResolvedValue({ vectors: [] }),
    computeQueryEmbedding: vi.fn().mockResolvedValue({ vector: [] }),
    nliClassify: vi.fn().mockResolvedValue({ results: [] }),
    loadEdges: vi.fn().mockResolvedValue({ edges: [] }),
    loadDictionary: vi.fn().mockResolvedValue({ standardized: [], colloquial: [], lintViolations: [] }),
    exportDebateToFile: vi.fn().mockResolvedValue({ cancelled: true }),
    generateNewsReport: vi.fn().mockResolvedValue({ article: 'mock-news-article' }),
    trackEvent: vi.fn(),
  };

  const mockTaxonomyState = {
    accelerationist: { nodes: [] as unknown[] },
    safetyist: { nodes: [] as unknown[] },
    skeptic: { nodes: [] as unknown[] },
    situations: { nodes: [] as unknown[] },
    edgesFile: { edges: [] as unknown[] },
    policyRegistry: [] as unknown[],
    conflicts: [] as unknown[],
    getLabelForId: vi.fn().mockReturnValue('mock-label'),
    getDescriptionForId: vi.fn().mockReturnValue('mock-description'),
    loadEdges: vi.fn().mockResolvedValue(undefined),
    createPovNode: vi.fn().mockReturnValue('new-node-id'),
    updatePovNode: vi.fn(),
    movePovNodeCategory: vi.fn().mockReturnValue(null),
    save: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue(undefined),
    saveError: null as string | null,
  };

  const mockPromptConfigState = {
    loadSessionConfig: vi.fn(),
    resetSession: vi.fn(),
    exportSessionConfig: vi.fn().mockReturnValue({}),
  };

  return { mockApi, mockTaxonomyState, mockPromptConfigState };
});

// ── Mock dependencies BEFORE importing the store ────────────

// Pin Electron mode: these pre-delta tests assert the always-full-save path
// (api.saveDebateSession), which is the Electron branch of the t/1637 delta
// rework. The web/delta path is covered by saveDebateDelta.test.ts.
vi.mock('@bridge', () => ({ api: mockApi, setActiveDebateId: vi.fn(), isElectronMode: () => true }));

vi.mock('./useTaxonomyStore', () => ({
  useTaxonomyStore: {
    getState: () => mockTaxonomyState,
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('./usePromptConfigStore', () => ({
  usePromptConfigStore: {
    getState: () => mockPromptConfigState,
  },
}));

// Mock prompt modules (they return strings; we only care that the store calls them)
vi.mock('../prompts/debate', () => ({
  clarificationPrompt: vi.fn().mockReturnValue('mock-clarification-prompt'),
  situationClarificationPrompt: vi.fn().mockReturnValue('mock-sit-clarification-prompt'),
  documentClarificationPrompt: vi.fn().mockReturnValue('mock-doc-clarification-prompt'),
  concludingPrompt: vi.fn().mockReturnValue('mock-synthesis-prompt'),
  userSeedClaimsPrompt: vi.fn().mockReturnValue('mock-seed-prompt'),
  openingStatementPrompt: vi.fn().mockReturnValue('mock-opening-prompt'),
  debateResponsePrompt: vi.fn().mockReturnValue('mock-response-prompt'),
  crossRespondPrompt: vi.fn().mockReturnValue('mock-cross-respond-prompt'),
  debateSynthesisPrompt: vi.fn().mockReturnValue('mock-debate-synthesis-prompt'),
  probingQuestionsPrompt: vi.fn().mockReturnValue('mock-probing-prompt'),
  factCheckPrompt: vi.fn().mockReturnValue('mock-fact-check-prompt'),
  contextCompressionPrompt: vi.fn().mockReturnValue('mock-compression-prompt'),
  entrySummarizationPrompt: vi.fn().mockReturnValue('mock-summarization-prompt'),
  missingArgumentsPrompt: vi.fn().mockReturnValue('mock-missing-args-prompt'),
  taxonomyRefinementPrompt: vi.fn().mockReturnValue('mock-taxonomy-refinement-prompt'),
  reflectionPrompt: vi.fn().mockReturnValue('mock-reflection-prompt'),
  midDebateGapPrompt: vi.fn().mockReturnValue('mock-gap-prompt'),
  crossCuttingNodePrompt: vi.fn().mockReturnValue('mock-cc-prompt'),
  formatSituationDebateContext: vi.fn().mockReturnValue('mock-situation-context'),
}));

vi.mock('../prompts/argumentNetwork', () => ({
  extractClaimsPrompt: vi.fn().mockReturnValue('mock-extract-prompt'),
  classifyClaimsPrompt: vi.fn().mockReturnValue('mock-classify-prompt'),
  formatArgumentNetworkContext: vi.fn().mockReturnValue(''),
  formatCommitments: vi.fn().mockReturnValue(''),
  formatEstablishedPoints: vi.fn().mockReturnValue(''),
  updateUnansweredLedger: vi.fn().mockReturnValue([]),
  formatConcessionCandidatesHint: vi.fn().mockReturnValue(''),
  processExtractedClaims: vi.fn().mockReturnValue({
    newNodes: [], newEdges: [], accepted: [], rejected: [],
    commitments: { asserted: [], conceded: [], challenged: [] },
    rejectionReasons: {}, rejectedOverlapPcts: [], maxOverlapVsExisting: 0,
  }),
}));

vi.mock('@lib/debate/documentAnalysis', () => ({
  documentAnalysisPrompt: vi.fn().mockReturnValue({ prompt: 'mock-doc-analysis-prompt' }),
  buildTaxonomySample: vi.fn().mockReturnValue('mock-taxonomy-sample'),
  documentAnalysisContext: vi.fn().mockReturnValue(''),
}));

vi.mock('../utils/convergenceScoring', () => ({
  updateConvergenceTracker: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../utils/taxonomyRelevance', () => ({
  cosineSimilarity: vi.fn().mockReturnValue(0),
  scoreNodeRelevance: vi.fn().mockReturnValue(0),
  scoreNodeRelevanceMeanTopN: vi.fn().mockReturnValue(new Map()),
  scoreNodesViaAN: vi.fn().mockReturnValue(new Map()),
  scoreNodesLexical: vi.fn().mockReturnValue(new Map()),
  selectRelevantNodes: vi.fn().mockReturnValue([]),
  selectRelevantSituationNodes: vi.fn().mockReturnValue([]),
  buildRelevanceQuery: vi.fn().mockReturnValue('mock-query'),
}));

vi.mock('../utils/taxonomyContext', () => ({
  formatTaxonomyContext: vi.fn().mockReturnValue('mock-taxonomy-context'),
}));

vi.mock('../utils/errorMessages', () => ({
  mapErrorToUserMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock('../lib/trace', () => ({
  trace: vi.fn(),
  newCallId: vi.fn().mockReturnValue('call-001'),
  TraceEventName: new Proxy({}, { get: (_, prop) => String(prop) }),
}));

vi.mock('@lib/debate', () => ({
  normalizeBdiLayer: vi.fn((x: string) => x),
}));

vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodeTypeFromId: vi.fn().mockReturnValue('pov'),
}));

vi.mock('@lib/debate/qbaf', () => ({
  computeQbafStrengths: vi.fn().mockReturnValue({ strengths: new Map() }),
}));

vi.mock('@lib/debate/argumentNetwork', () => ({
  factCheckToBaseStrength: vi.fn().mockReturnValue(0.5),
}));

vi.mock('@lib/debate/networkGc', () => ({
  needsGc: vi.fn().mockReturnValue(false),
  pruneArgumentNetwork: vi.fn().mockReturnValue({ nodes: [], edges: [], prunedNodes: [], before: 0, after: 0 }),
  GC_TRIGGER: 200,
  GC_TARGET: 150,
}));

vi.mock(import('@lib/debate/types'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDebatePhase: vi.fn().mockReturnValue('setup'),
  };
});

vi.mock(import('@lib/debate/helpers'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateId: vi.fn().mockReturnValue('test-id-default'),
    nowISO: vi.fn().mockReturnValue('2026-05-01T00:00:00.000Z'),
    formatRecentTranscript: vi.fn().mockReturnValue('mock-transcript'),
  };
});

// Make generateId return unique IDs on each call
let idCounter = 0;
const { generateId, nowISO } = await import('@lib/debate/helpers');
vi.mocked(generateId).mockImplementation(() => `test-id-${++idCounter}`);

vi.mock('@lib/debate/turnValidator', () => ({
  resolveTurnValidationConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('@lib/debate/convergenceSignals', () => ({
  computeConvergenceSignals: vi.fn().mockReturnValue({ round: 1, signals: {} }),
}));

vi.mock('@lib/debate/cruxResolution', () => ({
  updateCruxTracker: vi.fn().mockReturnValue(undefined),
}));

vi.mock('@lib/debate/taxonomyGapAnalysis', () => ({
  computeTaxonomyGapAnalysis: vi.fn().mockReturnValue(null),
}));

vi.mock('@lib/debate/moderator', () => ({
  updateModeratorState: vi.fn().mockReturnValue({}),
  MOVE_RESPONSE_CONFIG: {},
  DIRECT_RESPONSE_PATTERNS: [],
}));

vi.mock('@lib/debate/orchestration', () => ({
  runModeratorSelection: vi.fn().mockResolvedValue({ speaker: 'accelerationist', intervention: null }),
  executeTurnWithRetry: vi.fn().mockResolvedValue({ text: '{}', attempts: 1 }),
}));

vi.mock('@lib/debate/sessionPruning', () => ({
  pruneSessionData: vi.fn((x: unknown) => x),
  pruneModeratorState: vi.fn((x: unknown) => x),
}));

vi.mock('@lib/debate/turnPipeline', () => ({
  runTurnPipeline: vi.fn().mockResolvedValue({}),
  assemblePipelineResult: vi.fn().mockReturnValue({}),
  runOpeningPipeline: vi.fn().mockResolvedValue({}),
  assembleOpeningPipelineResult: vi.fn().mockReturnValue({}),
  getOpeningRepairHints: vi.fn().mockReturnValue([]),
}));

vi.mock('@lib/debate/topicCritique', () => ({
  computeStructuralScore: vi.fn().mockReturnValue({ total: 8, activated_nodes: [], coverage: {} }),
  critiqueTopicPrompt: vi.fn().mockReturnValue('mock-critique-prompt'),
  parseTopicCritique: vi.fn().mockReturnValue({
    rating: 'good', composite_score: 14, frame_score: { total: 6 },
    structural_score: { total: 8, activated_nodes: [], coverage: {} },
    rewritten_topic: null, lineage_frame: [],
  }),
  formatCritiqueForRefinement: vi.fn().mockReturnValue(''),
  formatStructuralContext: vi.fn().mockReturnValue('mock-structural-context'),
  computeLineageDistribution: vi.fn().mockReturnValue([]),
  formatLineageContext: vi.fn().mockReturnValue(''),
}));

vi.mock('@lib/debate/prompts', () => ({
  decomposeResolutionPrompt: vi.fn().mockReturnValue('mock-decompose-prompt'),
  topicScopeExtractionPrompt: vi.fn().mockReturnValue('mock-scope-prompt'),
  setTopicScope: vi.fn(),
  synthExtractPrompt: vi.fn().mockReturnValue('mock-synth-extract-prompt'),
  synthMapPrompt: vi.fn().mockReturnValue('mock-synth-map-prompt'),
  synthEvaluatePrompt: vi.fn().mockReturnValue('mock-synth-evaluate-prompt'),
}));

vi.mock('@lib/debate/phaseTransitions', () => ({
  loadProvisionalWeights: vi.fn().mockReturnValue({}),
  initPhaseState: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 0, total_rounds_elapsed: 0 }),
  evaluatePhaseTransition: vi.fn().mockReturnValue({ action: 'continue', reason: 'test' }),
  advanceRound: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 1, total_rounds_elapsed: 1 }),
  applyTransition: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 0, total_rounds_elapsed: 1 }),
  buildSignalRegistry: vi.fn().mockReturnValue([]),
  computeSaturationScore: vi.fn().mockReturnValue(0),
  computeConvergenceScore: vi.fn().mockReturnValue(0),
  detectCruxNodes: vi.fn().mockReturnValue([]),
}));

vi.mock('@lib/debate/gapCheck', () => ({
  shouldRunGapCheck: vi.fn().mockReturnValue(false),
  findUnengagedHighRelevanceNodes: vi.fn().mockReturnValue([]),
  collectEngagedNodeIds: vi.fn().mockReturnValue(new Set()),
  MAX_GAP_INJECTIONS: 3,
}));

vi.mock('@lib/debate/neutralEvaluator', () => ({
  runNeutralEvaluation: vi.fn().mockResolvedValue({ checkpoint: 'baseline', claims: [], cruxes: [] }),
  buildSpeakerMapping: vi.fn().mockReturnValue({}),
}));

vi.mock('@lib/debate/doctrinalAnchoring', () => ({
  embedDoctrinalBoundaries: vi.fn().mockResolvedValue({}),
  computeDoctrinalAnchoring: vi.fn().mockReturnValue([]),
  checkThresholdAnomalies: vi.fn().mockReturnValue(null),
}));

vi.mock('@lib/debate/beliefConfidence', () => ({
  computeBeliefConfidence: vi.fn().mockReturnValue(0.5),
}));

vi.mock('@lib/debate/desirePriority', () => ({
  computeTreePriority: vi.fn().mockReturnValue(0.5),
}));

vi.mock('@lib/debate/intentionOperationality', () => ({
  computeOperationality: vi.fn().mockReturnValue(0.5),
}));

vi.mock('@lib/debate/vocabularyDisambiguation', () => ({
  disambiguateTerms: vi.fn().mockReturnValue({ terms: [], ambiguousCount: 0 }),
}));

vi.mock('@lib/debate/processReward', () => ({
  computeProcessReward: vi.fn().mockReturnValue({ score: 0.5, breakdown: {} }),
}));

vi.mock('../data/lineageCategories', () => ({
  getLineageMapping: vi.fn().mockReturnValue({}),
  getL2Categories: vi.fn().mockReturnValue([]),
  isLineageDataLoaded: vi.fn().mockReturnValue(false),
}));

vi.mock('@lib/debate/lookaheadGate', () => ({
  evaluateLookaheadPerClaim: vi.fn().mockReturnValue([]),
  buildClaimAnalysis: vi.fn().mockReturnValue({ claims: [] }),
}));

vi.mock('../utils/dolceCompliance', () => ({
  checkDolceCompliance: vi.fn().mockReturnValue([]),
}));

vi.mock('@lib/debate/vocabularyContext', () => ({
  formatVocabularyContext: vi.fn().mockReturnValue(''),
}));

// Defensive embedder stub (t/2354): the real renderer embedder (onnxruntime + MiniLM)
// is only reached via the real electron-bridge, which is mocked above — but stub it
// directly too so no code path can load the model (the CI "embed OOM" / "Embedding
// unavailable" flake) even if a future change imports it here. Deterministic, no model load.
vi.mock('../utils/localEmbedding', () => ({
  tryInitLocalEmbedding: vi.fn().mockResolvedValue(false),
  isLocalEmbeddingReady: vi.fn().mockReturnValue(false),
  getLocalEmbeddingBackend: vi.fn().mockReturnValue('mock'),
  notifyBridgeFallback: vi.fn(),
  localComputeEmbedding: vi.fn().mockResolvedValue([]),
  localComputeEmbeddings: vi.fn().mockResolvedValue([]),
}));

// Global __APP_VERSION__
vi.stubGlobal('__APP_VERSION__', '0.7.4');

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
vi.stubGlobal('localStorage', localStorageMock);

// ── Hermeticity guard (t/2354) ──────────────────────────────
// Block the raw network so these unit tests can NEVER make a live AI call. The AI
// boundaries are mocked above (@bridge, orchestration, turnPipeline, …), but this
// is the fail-fast backstop: any un-mocked or cross-file-bled path that tries to
// hit the network throws loudly HERE (attributed to this suite) instead of a
// nondeterministic live Gemini 429 in CI — so the isolation can't silently regress.
// Plain throwing functions (not vi.fn) so vi.clearAllMocks can't strip the guard.
const blockNetwork = (what: string) => () => {
  throw new Error(`[t/2354 hermeticity guard] ${what} is blocked in unit tests — mock the AI/embedding boundary instead of making a live call`);
};
vi.stubGlobal('fetch', blockNetwork('fetch'));
vi.stubGlobal('WebSocket', blockNetwork('WebSocket'));
vi.stubGlobal('XMLHttpRequest', blockNetwork('XMLHttpRequest'));

// ── Import the store under test ─────────────────────────────

import { useDebateStore } from './useDebateStore';

// ── Helpers ─────────────────────────────────────────────────

/** Reset the store to initial state between tests */
function resetStore(): void {
  useDebateStore.setState({
    sessions: [],
    sessionsLoading: false,
    activeDebateId: null,
    activeDebate: null,
    debateLoading: false,
    debateGenerating: null,
    debateError: null,
    responseLength: 'detailed',
    audience: 'policymakers',
    debateProgress: null,
    debateActivity: null,
    gapInjections: [],
    crossCuttingProposals: [],
    taxonomyGapAnalysis: null,
    reflections: [],
    inspectedNodeId: null,
    debateModel: null,
    debateTemperature: null,
    vocabularyTerms: null,
    diagnosticsEnabled: false,
    selectedDiagEntry: null,
    diagPopoutOpen: false,
    debateWarnings: [],
    debateRetryAction: null,
    dailyLimitPaused: false,
    openingOrder: [],
    initialCrossRespondRounds: 3,
    topicCritiqueLoading: false,
    newItemProposalStatus: {},
  });
}

/** Create a minimal valid DebateSession for testing */
function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    title: 'Test Debate',
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    phase: 'setup' as const,
    topic: { original: 'AI governance', refined: null, final: 'AI governance' },
    source_type: 'topic' as const,
    source_ref: '',
    source_content: '',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'] as string[],
    user_is_pover: false,
    transcript: [] as Array<{ id: string; timestamp: string; type: string; speaker: string; content: string; taxonomy_refs: string[]; metadata?: Record<string, unknown>; display_tier?: string; summaries?: { brief: string; medium: string } }>,
    context_summaries: [] as Array<{ up_to_entry_id: string; summary: string }>,
    generated_with_prompt_version: 'dolce-phase-1',
    audience: 'policymakers' as const,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

beforeEach(() => {
  resetStore();
  idCounter = 0;
  vi.clearAllMocks();
  vi.mocked(generateId).mockImplementation(() => `test-id-${++idCounter}`);
  vi.mocked(nowISO).mockReturnValue('2026-05-01T00:00:00.000Z');
  mockApi.onGenerateTextProgress.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── 1. Store Initialization ─────────────────────────────────

describe('Store initialization', () => {
  it('has null activeDebate on init', () => {
    const state = useDebateStore.getState();
    expect(state.activeDebate).toBeNull();
    expect(state.activeDebateId).toBeNull();
  });

  it('has empty sessions list on init', () => {
    expect(useDebateStore.getState().sessions).toEqual([]);
    expect(useDebateStore.getState().sessionsLoading).toBe(false);
  });

  it('defaults debateLoading to false', () => {
    expect(useDebateStore.getState().debateLoading).toBe(false);
  });

  it('defaults debateGenerating to null', () => {
    expect(useDebateStore.getState().debateGenerating).toBeNull();
  });

  it('defaults debateError to null', () => {
    expect(useDebateStore.getState().debateError).toBeNull();
  });

  it('defaults responseLength to detailed', () => {
    expect(useDebateStore.getState().responseLength).toBe('detailed');
  });

  it('defaults audience to policymakers', () => {
    expect(useDebateStore.getState().audience).toBe('policymakers');
  });

  it('defaults diagnosticsEnabled to false', () => {
    expect(useDebateStore.getState().diagnosticsEnabled).toBe(false);
  });

  it('defaults debateWarnings to empty array', () => {
    expect(useDebateStore.getState().debateWarnings).toEqual([]);
  });

  it('defaults gap analysis state to null/empty', () => {
    const state = useDebateStore.getState();
    expect(state.gapInjections).toEqual([]);
    expect(state.crossCuttingProposals).toEqual([]);
    expect(state.taxonomyGapAnalysis).toBeNull();
  });

  it('defaults reflections to empty array', () => {
    expect(useDebateStore.getState().reflections).toEqual([]);
  });

  it('defaults debateModel and debateTemperature to null', () => {
    const state = useDebateStore.getState();
    expect(state.debateModel).toBeNull();
    expect(state.debateTemperature).toBeNull();
  });

  it('defaults openingOrder to empty array', () => {
    expect(useDebateStore.getState().openingOrder).toEqual([]);
  });

  it('defaults initialCrossRespondRounds to 3', () => {
    expect(useDebateStore.getState().initialCrossRespondRounds).toBe(3);
  });
});

// ── 2. Debate Lifecycle ─────────────────────────────────────

describe('createDebate', () => {
  it('creates a session with correct fields and saves via IPC', async () => {
    const id = await useDebateStore.getState().createDebate(
      'AI governance policy',
      ['accelerationist', 'safetyist', 'skeptic'],
      false,
    );

    expect(id).toBeTruthy();
    expect(mockApi.saveDebateSession).toHaveBeenCalledTimes(1);
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.title).toBe('AI governance policy');
    expect(saved.phase).toBe('setup');
    expect(saved.source_type).toBe('topic');
    expect(saved.active_povers).toEqual(['accelerationist', 'safetyist', 'skeptic']);
    expect(saved.user_is_pover).toBe(false);
    expect(saved.transcript).toEqual([]);
  });

  it('truncates long topic titles to 60 chars', async () => {
    const longTopic = 'A'.repeat(80);
    await useDebateStore.getState().createDebate(longTopic, ['accelerationist'], false);
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect((saved.title as string).length).toBeLessThanOrEqual(60);
    expect((saved.title as string).endsWith('...')).toBe(true);
  });

  it('sets activeDebateId and activeDebate in state', async () => {
    const id = await useDebateStore.getState().createDebate(
      'Test topic', ['accelerationist', 'safetyist'], false,
    );
    const state = useDebateStore.getState();
    expect(state.activeDebateId).toBe(id);
    expect(state.activeDebate).not.toBeNull();
    expect(state.activeDebate!.topic.original).toBe('Test topic');
  });

  it('stores debate-specific model override', async () => {
    await useDebateStore.getState().createDebate(
      'Topic', ['accelerationist'], false, 'topic', '', '', 'gemini-2.0-pro',
    );
    expect(useDebateStore.getState().debateModel).toBe('gemini-2.0-pro');
  });

  it('stores debate-specific temperature', async () => {
    await useDebateStore.getState().createDebate(
      'Topic', ['accelerationist'], false, 'topic', '', '', undefined, undefined, 0.9,
    );
    expect(useDebateStore.getState().debateTemperature).toBe(0.9);
    expect(mockApi.setDebateTemperature).toHaveBeenCalledWith(0.9);
  });

  it('stores audience in session', async () => {
    await useDebateStore.getState().createDebate(
      'Topic', ['accelerationist'], false, 'topic', '', '', undefined, undefined, undefined, 'researchers',
    );
    const session = useDebateStore.getState().activeDebate;
    expect(session!.audience).toBe('researchers');
  });

  it('calls loadSessions after creation', async () => {
    await useDebateStore.getState().createDebate('Topic', ['accelerationist'], false);
    expect(mockApi.listDebateSessionsMeta).toHaveBeenCalled();
  });

  // ── excludeGreatestHits option → persisted config (t/1980) ──
  // Store is the single writer for app-created debates; the option maps to the
  // snake_case persisted field the renderer scoring + CLI engine both read.
  it('persists exclude_greatest_hits=true when the option is set', async () => {
    await useDebateStore.getState().createDebate(
      'Topic', ['accelerationist'], false, 'topic', '', '', undefined, undefined,
      undefined, undefined, { excludeGreatestHits: true },
    );
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.exclude_greatest_hits).toBe(true);
    expect(useDebateStore.getState().activeDebate!.exclude_greatest_hits).toBe(true);
  });

  it('defaults exclude_greatest_hits to false when the option is omitted', async () => {
    await useDebateStore.getState().createDebate('Topic', ['accelerationist'], false);
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.exclude_greatest_hits).toBe(false);
    expect(useDebateStore.getState().activeDebate!.exclude_greatest_hits).toBe(false);
  });

  it('persists exclude_greatest_hits=false when the option is explicitly false', async () => {
    await useDebateStore.getState().createDebate(
      'Topic', ['accelerationist'], false, 'topic', '', '', undefined, undefined,
      undefined, undefined, { excludeGreatestHits: false },
    );
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.exclude_greatest_hits).toBe(false);
  });
});

describe('loadDebate', () => {
  it('loads a session from IPC and sets activeDebate', async () => {
    const session = makeSession();
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    const state = useDebateStore.getState();
    expect(state.activeDebateId).toBe('session-1');
    expect(state.activeDebate).toBeTruthy();
    expect(state.debateLoading).toBe(false);
  });

  it('sets debateError on load failure', async () => {
    mockApi.loadDebateSession.mockRejectedValueOnce(new Error('File not found'));

    await useDebateStore.getState().loadDebate('nonexistent');

    const state = useDebateStore.getState();
    expect(state.debateError).toBeTruthy();
    expect(state.debateLoading).toBe(false);
  });

  it('clears warnings when loading', async () => {
    useDebateStore.setState({ debateWarnings: ['old warning'] });
    mockApi.loadDebateSession.mockResolvedValueOnce(makeSession());

    await useDebateStore.getState().loadDebate('session-1');

    expect(useDebateStore.getState().debateWarnings).toEqual([]);
  });

  it('restores debateModel from session', async () => {
    const session = makeSession({ debate_model: 'gemini-2.0-pro' });
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    expect(useDebateStore.getState().debateModel).toBe('gemini-2.0-pro');
  });

  // ── exclude_greatest_hits round-trips on load (t/1980) ──
  it('carries exclude_greatest_hits back on load', async () => {
    const session = makeSession({ exclude_greatest_hits: true });
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    expect(useDebateStore.getState().activeDebate!.exclude_greatest_hits).toBe(true);
  });

  it('treats a pre-feature debate with no exclude_greatest_hits as false (absent ⇒ false)', async () => {
    const session = makeSession(); // no exclude_greatest_hits field (lazy migration)
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    // Absent on the raw session; readers coalesce `?? false`.
    expect(useDebateStore.getState().activeDebate!.exclude_greatest_hits ?? false).toBe(false);
  });

  it('restores audience from session', async () => {
    const session = makeSession({ audience: 'researchers' });
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    expect(useDebateStore.getState().audience).toBe('researchers');
  });

  it('detects interrupted_turn and adds recovery notification', async () => {
    const session = makeSession({
      interrupted_turn: {
        speaker: 'safetyist',
        phase: 'debate',
        round: 8,
        timestamp: '2026-06-06T14:30:57.000Z',
      },
    });
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    const state = useDebateStore.getState();
    expect(state.activeDebate).toBeTruthy();
    // Should have added a system transcript entry about the interrupted turn
    const recovery = state.activeDebate!.transcript.find(
      e => e.type === 'system' && e.content.includes('[Recovered]'),
    );
    expect(recovery).toBeTruthy();
    expect(recovery!.content).toContain('Safetyist');
    expect(recovery!.content).toContain('round 8');
    // interrupted_turn field should be cleared from the session
    expect(state.activeDebate!.interrupted_turn).toBeUndefined();
    // Should have saved to persist the cleanup
    expect(mockApi.saveDebateSession).toHaveBeenCalled();
  });

  it('does not add recovery notification when no interrupted_turn', async () => {
    const session = makeSession();
    mockApi.loadDebateSession.mockResolvedValueOnce(session);

    await useDebateStore.getState().loadDebate('session-1');

    const state = useDebateStore.getState();
    expect(state.activeDebate!.transcript).toHaveLength(0);
    expect(mockApi.saveDebateSession).not.toHaveBeenCalled();
  });
});

describe('deleteDebate', () => {
  it('deletes via IPC and clears activeDebate if it was active', async () => {
    useDebateStore.setState({
      activeDebateId: 'session-1',
      activeDebate: makeSession() as any,
    });

    await useDebateStore.getState().deleteDebate('session-1');

    expect(mockApi.deleteDebateSession).toHaveBeenCalledWith('session-1');
    expect(useDebateStore.getState().activeDebateId).toBeNull();
    expect(useDebateStore.getState().activeDebate).toBeNull();
  });

  it('does not clear activeDebate if deleting a different session', async () => {
    useDebateStore.setState({
      activeDebateId: 'session-1',
      activeDebate: makeSession() as any,
    });

    await useDebateStore.getState().deleteDebate('session-2');

    expect(useDebateStore.getState().activeDebateId).toBe('session-1');
  });

  // t/94: a failed delete now rejects so the bulk-delete dialog (its only caller) can report it, and
  // no longer sets debateError, which would show the same failure twice (t/94#2).
  it('rejects on delete failure, without setting debateError', async () => {
    useDebateStore.setState({ debateError: null });
    mockApi.deleteDebateSession.mockRejectedValueOnce(new Error('Permission denied'));

    await expect(useDebateStore.getState().deleteDebate('session-1')).rejects.toThrow('Permission denied');

    expect(useDebateStore.getState().debateError).toBeNull();
  });
});

describe('renameDebate', () => {
  it('renames a session and updates active debate', async () => {
    const session = makeSession();
    useDebateStore.setState({ activeDebateId: 'session-1', activeDebate: session as any });
    mockApi.loadDebateSession.mockResolvedValueOnce({ ...session });

    await useDebateStore.getState().renameDebate('session-1', 'New Title');

    expect(mockApi.saveDebateSession).toHaveBeenCalled();
    const saved = mockApi.saveDebateSession.mock.calls[0][0] as Record<string, unknown>;
    expect(saved.title).toBe('New Title');
  });

  it('sets debateError on rename failure', async () => {
    mockApi.loadDebateSession.mockRejectedValueOnce(new Error('Not found'));

    await useDebateStore.getState().renameDebate('session-1', 'New Title');

    expect(useDebateStore.getState().debateError).toBeTruthy();
  });
});

describe('closeDebate', () => {
  it('clears all debate state', () => {
    useDebateStore.setState({
      activeDebateId: 'session-1',
      activeDebate: makeSession() as any,
      debateError: 'some error',
      debateWarnings: ['warning1'],
      debateGenerating: 'accelerationist',
      debateModel: 'gemini-2.0-pro',
      debateTemperature: 0.8,
      vocabularyTerms: { standardized: [], colloquial: [] },
    });

    useDebateStore.getState().closeDebate();

    const state = useDebateStore.getState();
    expect(state.activeDebateId).toBeNull();
    expect(state.activeDebate).toBeNull();
    expect(state.debateError).toBeNull();
    expect(state.debateWarnings).toEqual([]);
    expect(state.debateGenerating).toBeNull();
    expect(state.debateModel).toBeNull();
    expect(state.debateTemperature).toBeNull();
    expect(state.vocabularyTerms).toBeNull();
  });

  it('calls setDebateTemperature(null) on close', () => {
    useDebateStore.setState({ activeDebateId: 'x', activeDebate: makeSession() as any });
    useDebateStore.getState().closeDebate();
    expect(mockApi.setDebateTemperature).toHaveBeenCalledWith(null);
  });
});

// ── 3. Phase Management ─────────────────────────────────────

describe('updatePhase', () => {
  it('sets the phase on activeDebate', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });

    useDebateStore.getState().updatePhase('clarification');

    expect(useDebateStore.getState().activeDebate!.phase).toBe('clarification');
  });

  it('does nothing when activeDebate is null', () => {
    useDebateStore.getState().updatePhase('opening');
    expect(useDebateStore.getState().activeDebate).toBeNull();
  });

  it('updates updated_at timestamp', () => {
    useDebateStore.setState({ activeDebate: makeSession({ updated_at: 'old' }) as any });

    useDebateStore.getState().updatePhase('debate');

    expect(useDebateStore.getState().activeDebate!.updated_at).toBe('2026-05-01T00:00:00.000Z');
  });
});

// ── 4. Turn Processing / Transcript ─────────────────────────

describe('addTranscriptEntry', () => {
  it('adds an entry with generated id and timestamp', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });

    const entryId = useDebateStore.getState().addTranscriptEntry({
      type: 'user',
      speaker: 'user',
      content: 'What about regulation?',
      taxonomy_refs: [],
    });

    expect(entryId).toBeTruthy();
    const transcript = useDebateStore.getState().activeDebate!.transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0].content).toBe('What about regulation?');
    expect(transcript[0].timestamp).toBeTruthy();
    expect(transcript[0].id).toBe(entryId);
  });

  it('returns an id even when activeDebate is null (no-op)', () => {
    const entryId = useDebateStore.getState().addTranscriptEntry({
      type: 'user',
      speaker: 'user',
      content: 'test',
      taxonomy_refs: [],
    });
    expect(entryId).toBeTruthy();
  });

  it('appends to existing transcript', () => {
    const session = makeSession({
      transcript: [
        { id: 'e1', timestamp: '2026-05-01T00:00:00.000Z', type: 'user', speaker: 'user', content: 'First', taxonomy_refs: [] },
      ],
    });
    useDebateStore.setState({ activeDebate: session as any });

    useDebateStore.getState().addTranscriptEntry({
      type: 'user',
      speaker: 'user',
      content: 'Second',
      taxonomy_refs: [],
    });

    expect(useDebateStore.getState().activeDebate!.transcript).toHaveLength(2);
    expect(useDebateStore.getState().activeDebate!.transcript[1].content).toBe('Second');
  });

  it('preserves existing transcript entries (immutable append)', () => {
    const existingEntry = { id: 'e1', timestamp: 't1', type: 'user', speaker: 'user', content: 'Existing', taxonomy_refs: [] as string[] };
    const session = makeSession({ transcript: [existingEntry] });
    useDebateStore.setState({ activeDebate: session as any });

    useDebateStore.getState().addTranscriptEntry({
      type: 'system', speaker: 'system', content: 'New', taxonomy_refs: [],
    });

    const transcript = useDebateStore.getState().activeDebate!.transcript;
    expect(transcript[0].content).toBe('Existing');
    expect(transcript[1].content).toBe('New');
  });
});

describe('deleteTranscriptEntries', () => {
  it('removes specified entries by id', async () => {
    const session = makeSession({
      transcript: [
        { id: 'e1', timestamp: 't', type: 'user', speaker: 'user', content: 'Keep', taxonomy_refs: [] },
        { id: 'e2', timestamp: 't', type: 'user', speaker: 'user', content: 'Remove', taxonomy_refs: [] },
        { id: 'e3', timestamp: 't', type: 'user', speaker: 'user', content: 'Keep too', taxonomy_refs: [] },
      ],
    });
    useDebateStore.setState({ activeDebate: session as any });

    await useDebateStore.getState().deleteTranscriptEntries(['e2']);

    const transcript = useDebateStore.getState().activeDebate!.transcript;
    expect(transcript).toHaveLength(2);
    expect(transcript.map((e: any) => e.id)).toEqual(['e1', 'e3']);
  });

  it('calls saveDebate after deletion', async () => {
    const session = makeSession({
      transcript: [{ id: 'e1', timestamp: 't', type: 'user', speaker: 'user', content: 'x', taxonomy_refs: [] }],
    });
    useDebateStore.setState({ activeDebate: session as any });

    await useDebateStore.getState().deleteTranscriptEntries(['e1']);

    expect(mockApi.saveDebateSession).toHaveBeenCalled();
  });
});

// ── 5. Error Handling ───────────────────────────────────────

describe('Error handling', () => {
  describe('setError', () => {
    it('sets debateError state', () => {
      useDebateStore.getState().setError('Something went wrong');
      expect(useDebateStore.getState().debateError).toBe('Something went wrong');
    });

    it('clears debateError with null', () => {
      useDebateStore.setState({ debateError: 'existing error' });
      useDebateStore.getState().setError(null);
      expect(useDebateStore.getState().debateError).toBeNull();
    });
  });

  describe('loadSessions error handling', () => {
    it('sets sessionsLoading false on error (does not throw)', async () => {
      mockApi.listDebateSessionsMeta.mockRejectedValueOnce(new Error('Network error'));

      await useDebateStore.getState().loadSessions();

      expect(useDebateStore.getState().sessionsLoading).toBe(false);
    });
  });

  describe('saveDebate error handling', () => {
    it('sets debateError when save fails', async () => {
      useDebateStore.setState({ activeDebate: makeSession() as any });
      mockApi.saveDebateSession.mockRejectedValueOnce(new Error('Disk full'));

      await useDebateStore.getState().saveDebate('test');

      expect(useDebateStore.getState().debateError).toBeTruthy();
    });

    it('does nothing when activeDebate is null', async () => {
      await useDebateStore.getState().saveDebate('test');
      expect(mockApi.saveDebateSession).not.toHaveBeenCalled();
    });
  });

  describe('runClarification error handling', () => {
    it('adds error transcript entry when AI generation fails', async () => {
      useDebateStore.setState({ activeDebate: makeSession() as any });
      mockApi.generateText.mockRejectedValueOnce(new Error('API timeout'));

      await useDebateStore.getState().runClarification();

      const transcript = useDebateStore.getState().activeDebate!.transcript;
      const errorEntry = transcript.find((e: any) => e.type === 'system' && e.content.includes('Failed'));
      expect(errorEntry).toBeTruthy();
      // Must clear generating state
      expect(useDebateStore.getState().debateGenerating).toBeNull();
    });

    it('does not run if already generating', async () => {
      useDebateStore.setState({
        activeDebate: makeSession() as any,
        debateGenerating: 'accelerationist',
      });

      await useDebateStore.getState().runClarification();

      expect(mockApi.generateText).not.toHaveBeenCalled();
    });

    it('does not run if clarification already exists in transcript', async () => {
      const session = makeSession({
        transcript: [
          { id: 'c1', timestamp: 't', type: 'clarification', speaker: 'system', content: 'Q1', taxonomy_refs: [] },
        ],
      });
      useDebateStore.setState({ activeDebate: session as any });

      await useDebateStore.getState().runClarification();

      expect(mockApi.generateText).not.toHaveBeenCalled();
    });
  });

  describe('submitAnswersAndSynthesize error handling', () => {
    it('handles single generation failure gracefully in retry loop', async () => {
      const session = makeSession({
        transcript: [
          { id: 'c1', timestamp: 't', type: 'clarification', speaker: 'system', content: 'Q1', taxonomy_refs: [], metadata: { questions: ['What scope?'] } },
        ],
      });
      useDebateStore.setState({ activeDebate: session as any });
      mockApi.generateText.mockRejectedValueOnce(new Error('Rate limited'));

      await useDebateStore.getState().submitAnswersAndSynthesize('My answers');

      // A single generation failure is caught in the refinement retry loop and
      // the function continues gracefully — debateError is not set.
      expect(useDebateStore.getState().debateError).toBeNull();
    });
  });

  describe('compressOldTranscript error handling', () => {
    it('pushes warning (not debateError) on compression failure (t/957)', async () => {
      const entries = Array.from({ length: 15 }, (_, i) => ({
        id: `e${i}`, timestamp: 't', type: 'debate', speaker: 'accelerationist', content: `Entry ${i}`, taxonomy_refs: [],
      }));
      useDebateStore.setState({ activeDebate: makeSession({ transcript: entries }) as any });
      mockApi.generateText.mockRejectedValueOnce(new Error('Compression failed'));

      await useDebateStore.getState().compressOldTranscript();

      expect(useDebateStore.getState().debateError).toBeNull();
      expect(useDebateStore.getState().debateWarnings.some(w => w.includes('Context compression skipped'))).toBe(true);
      expect(useDebateStore.getState().debateGenerating).toBeNull();
    });
  });
});

// ── 6. Concurrent Mutations ─────────────────────────────────

describe('Concurrent mutations', () => {
  it('multiple set() calls accumulate correctly', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });

    // Simulate rapid state updates
    useDebateStore.getState().setError('error1');
    useDebateStore.getState().setGenerating('accelerationist');
    useDebateStore.getState().inspectNode('AN-1');

    const state = useDebateStore.getState();
    expect(state.debateError).toBe('error1');
    expect(state.debateGenerating).toBe('accelerationist');
    expect(state.inspectedNodeId).toBe('AN-1');
  });

  it('multiple addTranscriptEntry calls produce distinct entries', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });

    const id1 = useDebateStore.getState().addTranscriptEntry({
      type: 'user', speaker: 'user', content: 'First', taxonomy_refs: [],
    });
    const id2 = useDebateStore.getState().addTranscriptEntry({
      type: 'user', speaker: 'user', content: 'Second', taxonomy_refs: [],
    });

    expect(id1).not.toBe(id2);
    expect(useDebateStore.getState().activeDebate!.transcript).toHaveLength(2);
  });
});

// ── 7. Session Data Management ──────────────────────────────

describe('Session data management', () => {
  describe('updateTopic', () => {
    it('updates topic fields on activeDebate', () => {
      useDebateStore.setState({ activeDebate: makeSession() as any });

      useDebateStore.getState().updateTopic({ refined: 'Refined AI governance' });

      const topic = useDebateStore.getState().activeDebate!.topic;
      expect(topic.refined).toBe('Refined AI governance');
      expect(topic.original).toBe('AI governance'); // unchanged
    });

    it('does nothing when activeDebate is null', () => {
      useDebateStore.getState().updateTopic({ refined: 'test' });
      expect(useDebateStore.getState().activeDebate).toBeNull();
    });
  });

  describe('togglePover', () => {
    it('adds a POVer to active_povers', async () => {
      const session = makeSession({ active_povers: ['accelerationist', 'safetyist'] });
      useDebateStore.setState({ activeDebate: session as any });

      await useDebateStore.getState().togglePover('skeptic');

      expect(useDebateStore.getState().activeDebate!.active_povers).toContain('skeptic');
    });

    it('removes a POVer if currently present', async () => {
      const session = makeSession({ active_povers: ['accelerationist', 'safetyist', 'skeptic'] });
      useDebateStore.setState({ activeDebate: session as any });

      await useDebateStore.getState().togglePover('skeptic');

      expect(useDebateStore.getState().activeDebate!.active_povers).not.toContain('skeptic');
    });

    it('does not remove if it would leave fewer than 1 AI POVer', async () => {
      const session = makeSession({ active_povers: ['accelerationist'] });
      useDebateStore.setState({ activeDebate: session as any });

      await useDebateStore.getState().togglePover('accelerationist');

      // Should still have accelerationist since removing would leave 0 AI povers
      expect(useDebateStore.getState().activeDebate!.active_povers).toContain('accelerationist');
    });

    it('saves after toggling', async () => {
      const session = makeSession();
      useDebateStore.setState({ activeDebate: session as any });

      await useDebateStore.getState().togglePover('skeptic');

      expect(mockApi.saveDebateSession).toHaveBeenCalled();
    });
  });

  describe('setResponseLength', () => {
    it('updates the responseLength state', () => {
      useDebateStore.getState().setResponseLength('brief');
      expect(useDebateStore.getState().responseLength).toBe('brief');
    });
  });

  describe('setAudience', () => {
    it('updates audience state', () => {
      useDebateStore.getState().setAudience('researchers');
      expect(useDebateStore.getState().audience).toBe('researchers');
    });

    it('also updates audience on activeDebate if present', () => {
      useDebateStore.setState({ activeDebate: makeSession() as any });

      useDebateStore.getState().setAudience('general_public');

      expect(useDebateStore.getState().activeDebate!.audience).toBe('general_public');
    });
  });
});

// ── 8. Abort/Cancel ─────────────────────────────────────────

describe('cancelDebate', () => {
  it('clears debateGenerating and debateActivity', () => {
    useDebateStore.setState({
      debateGenerating: 'accelerationist',
      debateActivity: 'Generating response...',
    });

    useDebateStore.getState().cancelDebate();

    expect(useDebateStore.getState().debateGenerating).toBeNull();
    expect(useDebateStore.getState().debateActivity).toBeNull();
  });
});

// ── 9. Config Management ────────────────────────────────────

describe('Config management', () => {
  describe('setOpeningOrder', () => {
    it('sets the opening order for debate statements', () => {
      useDebateStore.getState().setOpeningOrder(['safetyist', 'skeptic', 'accelerationist']);
      expect(useDebateStore.getState().openingOrder).toEqual(['safetyist', 'skeptic', 'accelerationist']);
    });
  });

  describe('setInitialCrossRespondRounds', () => {
    it('sets the cross-respond rounds count', () => {
      useDebateStore.getState().setInitialCrossRespondRounds(5);
      expect(useDebateStore.getState().initialCrossRespondRounds).toBe(5);
    });
  });

  describe('setEntryDisplayTier', () => {
    it('sets the display tier for a transcript entry', () => {
      const session = makeSession({
        transcript: [
          { id: 'e1', timestamp: 't', type: 'debate', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [] },
        ],
      });
      useDebateStore.setState({ activeDebate: session as any });

      useDebateStore.getState().setEntryDisplayTier('e1', 'brief');

      const entry = useDebateStore.getState().activeDebate!.transcript.find((e: any) => e.id === 'e1');
      expect(entry!.display_tier).toBe('brief');
    });

    it('does nothing for nonexistent entry id', () => {
      const session = makeSession({
        transcript: [
          { id: 'e1', timestamp: 't', type: 'debate', speaker: 'accelerationist', content: 'Hello', taxonomy_refs: [] },
        ],
      });
      useDebateStore.setState({ activeDebate: session as any });

      useDebateStore.getState().setEntryDisplayTier('nonexistent', 'brief');

      // Should not throw; transcript unchanged
      expect(useDebateStore.getState().activeDebate!.transcript).toHaveLength(1);
    });
  });
});

// ── 10. Diagnostics ─────────────────────────────────────────

describe('Diagnostics', () => {
  describe('selectDiagEntry', () => {
    it('sets selectedDiagEntry', () => {
      useDebateStore.getState().selectDiagEntry('entry-42');
      expect(useDebateStore.getState().selectedDiagEntry).toBe('entry-42');
    });

    it('clears selectedDiagEntry with null', () => {
      useDebateStore.setState({ selectedDiagEntry: 'entry-42' });
      useDebateStore.getState().selectDiagEntry(null);
      expect(useDebateStore.getState().selectedDiagEntry).toBeNull();
    });
  });

  describe('setDiagPopoutOpen', () => {
    it('sets diagPopoutOpen flag', () => {
      useDebateStore.getState().setDiagPopoutOpen(true);
      expect(useDebateStore.getState().diagPopoutOpen).toBe(true);
    });
  });
});

// ── 11. Warnings ────────────────────────────────────────────

describe('Warnings', () => {
  describe('clearWarnings', () => {
    it('clears all debate warnings', () => {
      useDebateStore.setState({ debateWarnings: ['w1', 'w2', 'w3'] });

      useDebateStore.getState().clearWarnings();

      expect(useDebateStore.getState().debateWarnings).toEqual([]);
    });
  });
});

// ── 12. Claims Management (Phase 2.5) ──────────────────────

describe('Claims management', () => {
  const sessionWithClaims = () => makeSession({
    document_analysis: {
      i_nodes: [
        { id: 'inode-1', text: 'AI is transformative', taxonomy_refs: [] },
        { id: 'inode-2', text: 'Regulation is needed', taxonomy_refs: [] },
      ],
      tension_points: [
        { id: 'tp-1', description: 'Innovation vs Safety', i_node_ids: ['inode-1', 'inode-2'] },
      ],
      claims_summary: 'Two key claims',
    },
    argument_network: {
      nodes: [
        { id: 'inode-1', text: 'AI is transformative', speaker: 'document', source_entry_id: '', taxonomy_refs: [], turn_number: 0 },
        { id: 'inode-2', text: 'Regulation is needed', speaker: 'document', source_entry_id: '', taxonomy_refs: [], turn_number: 0 },
      ],
      edges: [],
    },
  });

  describe('updateClaim', () => {
    it('updates claim text in document_analysis and argument_network', () => {
      useDebateStore.setState({ activeDebate: sessionWithClaims() as any });

      useDebateStore.getState().updateClaim('inode-1', 'AI is very transformative');

      const state = useDebateStore.getState().activeDebate!;
      const iNode = (state as any).document_analysis.i_nodes.find((n: any) => n.id === 'inode-1');
      expect(iNode.text).toBe('AI is very transformative');

      const anNode = (state as any).argument_network.nodes.find((n: any) => n.id === 'inode-1');
      expect(anNode.text).toBe('AI is very transformative');
    });

    it('does nothing when document_analysis is absent', () => {
      useDebateStore.setState({ activeDebate: makeSession() as any });
      useDebateStore.getState().updateClaim('inode-1', 'new text');
      // No error thrown
    });
  });

  describe('deleteClaim', () => {
    it('removes claim from document_analysis and argument_network', () => {
      useDebateStore.setState({ activeDebate: sessionWithClaims() as any });

      useDebateStore.getState().deleteClaim('inode-1');

      const state = useDebateStore.getState().activeDebate!;
      const iNodes = (state as any).document_analysis.i_nodes;
      expect(iNodes).toHaveLength(1);
      expect(iNodes[0].id).toBe('inode-2');

      const anNodes = (state as any).argument_network.nodes;
      expect(anNodes).toHaveLength(1);
    });

    it('removes tension points that become empty after deletion', () => {
      // Create a session where a tension point only refers to the claim being deleted
      const session = makeSession({
        document_analysis: {
          i_nodes: [
            { id: 'inode-1', text: 'Claim 1', taxonomy_refs: [] },
            { id: 'inode-2', text: 'Claim 2', taxonomy_refs: [] },
          ],
          tension_points: [
            { id: 'tp-solo', description: 'Solo tension', i_node_ids: ['inode-1'] },
            { id: 'tp-multi', description: 'Multi tension', i_node_ids: ['inode-1', 'inode-2'] },
          ],
          claims_summary: 'Two claims',
        },
        argument_network: { nodes: [], edges: [] },
      });
      useDebateStore.setState({ activeDebate: session as any });

      useDebateStore.getState().deleteClaim('inode-1');

      const tensions = (useDebateStore.getState().activeDebate as any).document_analysis.tension_points;
      // tp-solo should be removed (empty i_node_ids), tp-multi should remain with just inode-2
      expect(tensions).toHaveLength(1);
      expect(tensions[0].id).toBe('tp-multi');
      expect(tensions[0].i_node_ids).toEqual(['inode-2']);
    });
  });
});

// ── 13. Argument Network Sub-Scores ─────────────────────────

describe('updateAnNodeSubScore', () => {
  it('updates a sub-score and recalculates base_strength', () => {
    const session = makeSession({
      argument_network: {
        nodes: [
          {
            id: 'AN-1', text: 'Claim', speaker: 'accelerationist',
            source_entry_id: 'e1', taxonomy_refs: [], turn_number: 1,
            bdi_sub_scores: { evidence: 0.4, specificity: 0.6 },
            base_strength: 0.5,
          },
        ],
        edges: [],
      },
    });
    useDebateStore.setState({ activeDebate: session as any });

    useDebateStore.getState().updateAnNodeSubScore('AN-1', 'evidence', 0.8);

    const node = (useDebateStore.getState().activeDebate as any).argument_network.nodes[0];
    expect(node.bdi_sub_scores.evidence).toBe(0.8);
    // base_strength = average of (0.8, 0.6) = 0.7
    expect(node.base_strength).toBeCloseTo(0.7);
  });

  it('does nothing when argument_network is absent', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });
    useDebateStore.getState().updateAnNodeSubScore('AN-1', 'evidence', 0.5);
    // No error thrown
  });

  it('does nothing for nonexistent node', () => {
    const session = makeSession({
      argument_network: {
        nodes: [
          { id: 'AN-1', text: 'Claim', speaker: 'accelerationist', bdi_sub_scores: { x: 0.5 }, base_strength: 0.5 },
        ],
        edges: [],
      },
    });
    useDebateStore.setState({ activeDebate: session as any });

    useDebateStore.getState().updateAnNodeSubScore('AN-999', 'x', 0.9);

    // Original node unchanged
    const node = (useDebateStore.getState().activeDebate as any).argument_network.nodes[0];
    expect(node.bdi_sub_scores.x).toBe(0.5);
  });
});

// ── 14. Reflections ─────────────────────────────────────────

describe('Reflection edits', () => {
  const makeReflections = () => [
    {
      pover: 'accelerationist',
      label: 'Accelerationist',
      reflection_summary: 'Reflections on AI acceleration',
      edits: [
        {
          edit_type: 'revise' as const,
          node_id: 'acc-B-001',
          category: 'Beliefs' as const,
          current_label: 'Old label',
          proposed_label: 'New label',
          current_description: 'Old desc',
          proposed_description: 'New desc',
          rationale: 'Better framing',
          confidence: 'high' as const,
          evidence_entries: ['e1'],
          status: 'pending' as const,
        },
        {
          edit_type: 'add' as const,
          node_id: null,
          category: 'Desires' as const,
          current_label: null,
          proposed_label: 'New desire',
          current_description: null,
          proposed_description: 'A new desired outcome',
          rationale: 'Identified in debate',
          confidence: 'medium' as const,
          evidence_entries: ['e2'],
          status: 'pending' as const,
        },
      ],
    },
  ];

  describe('dismissReflectionEdit', () => {
    it('marks an edit as dismissed', () => {
      useDebateStore.setState({ reflections: makeReflections() });

      useDebateStore.getState().dismissReflectionEdit('accelerationist', 0);

      const edits = useDebateStore.getState().reflections[0].edits;
      expect(edits[0].status).toBe('dismissed');
      expect(edits[1].status).toBe('pending'); // unchanged
    });
  });

  describe('applyReflectionEdit', () => {
    it('marks an edit as approved after successful save and returns ok', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({
        reflections: makeReflections(),
        activeDebateId: 'debate-1',
      });

      const result = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      const edits = useDebateStore.getState().reflections[0].edits;
      expect(edits[0].status).toBe('approved');
      expect(result).toMatchObject({ ok: true });
    });

    it('calls taxonomy store for revise edits', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({ reflections: makeReflections() });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      expect(mockTaxonomyState.updatePovNode).toHaveBeenCalledWith(
        'accelerationist',
        'acc-B-001',
        expect.objectContaining({ label: 'New label', description: 'New desc' }),
        expect.objectContaining({ source: 'debate_reflection' }),
      );
      expect(mockTaxonomyState.save).toHaveBeenCalled();
    });

    it('calls taxonomy store for add edits', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({
        reflections: makeReflections(),
        activeDebateId: 'debate-1',
      });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 1);

      expect(mockTaxonomyState.createPovNode).toHaveBeenCalledWith('accelerationist', 'Desires');
    });

    it('does nothing for nonexistent reflection', async () => {
      useDebateStore.setState({ reflections: makeReflections() });

      await useDebateStore.getState().applyReflectionEdit('nonexistent-pov', 0);

      expect(mockTaxonomyState.updatePovNode).not.toHaveBeenCalled();
    });

    it('does not mark approved when save fails and returns error', async () => {
      mockTaxonomyState.saveError = 'Validation failed';
      useDebateStore.setState({ reflections: makeReflections() });

      const result = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      const edits = useDebateStore.getState().reflections[0].edits;
      expect(edits[0].status).toBe('pending');
      expect(result).toEqual({ ok: false, error: 'Validation failed' });
      expect(mockTaxonomyState.save).toHaveBeenCalled();
    });

    it('applies user-edited overrides instead of proposed text', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({ reflections: makeReflections() });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 0, {
        label: 'User-edited label',
        description: 'User-edited description',
      });

      expect(mockTaxonomyState.updatePovNode).toHaveBeenCalledWith(
        'accelerationist',
        'acc-B-001',
        expect.objectContaining({ label: 'User-edited label', description: 'User-edited description' }),
        expect.objectContaining({ source: 'debate_reflection' }),
      );
      expect(mockTaxonomyState.save).toHaveBeenCalled();
    });

    it('falls back to proposed text when overrides are undefined', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({ reflections: makeReflections() });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 0, undefined);

      expect(mockTaxonomyState.updatePovNode).toHaveBeenCalledWith(
        'accelerationist',
        'acc-B-001',
        expect.objectContaining({ label: 'New label', description: 'New desc' }),
        expect.objectContaining({ source: 'debate_reflection' }),
      );
    });

    it('applies partial overrides (label only)', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({ reflections: makeReflections() });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 0, {
        label: 'Custom label',
      });

      expect(mockTaxonomyState.updatePovNode).toHaveBeenCalledWith(
        'accelerationist',
        'acc-B-001',
        expect.objectContaining({ label: 'Custom label', description: 'New desc' }),
        expect.objectContaining({ source: 'debate_reflection' }),
      );
    });
  });

  // t/3492: qualify edits that change the description's genus word ("A Belief..." /
  // "A Desire..." / "An Intention...") must rename the node via movePovNodeCategory —
  // edit.category reflects the OLD category for edit_existing, so it can't be trusted here.
  describe('applyReflectionEdit — qualify category change (t/3492)', () => {
    const makeQualifyReflection = (proposedDescription: string) => [
      {
        pover: 'accelerationist',
        label: 'Accelerationist',
        reflection_summary: 'Reflections on AI acceleration',
        edits: [
          {
            edit_type: 'qualify' as const,
            node_id: 'acc-intentions-088',
            category: 'Intentions' as const,
            current_label: 'Old label',
            proposed_label: 'Old label',
            current_description: 'An Intention within accelerationist discourse that...',
            proposed_description: proposedDescription,
            rationale: 'The debate revealed this is actually a belief, not an intention',
            confidence: 'high' as const,
            evidence_entries: ['e1'],
            status: 'pending' as const,
          },
        ],
      },
    ];

    it('renames the node via movePovNodeCategory when the genus word implies a new category', async () => {
      mockTaxonomyState.saveError = null;
      mockTaxonomyState.movePovNodeCategory.mockReturnValueOnce('acc-beliefs-005');
      useDebateStore.setState({
        reflections: makeQualifyReflection('A Belief within accelerationist discourse that dynamic defense outpaces static rules.'),
      });

      const result = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      expect(mockTaxonomyState.movePovNodeCategory).toHaveBeenCalledWith('accelerationist', 'acc-intentions-088', 'Beliefs');
      expect(result).toMatchObject({ ok: true, enrichNodeId: 'acc-beliefs-005' });
    });

    it('does not call movePovNodeCategory when the genus word matches the current category', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({
        reflections: makeQualifyReflection('An Intention within accelerationist discourse that dynamic defense outpaces static rules.'),
      });

      await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      expect(mockTaxonomyState.movePovNodeCategory).not.toHaveBeenCalled();
    });

    it('does not call movePovNodeCategory and does not error when the description has no genus match', async () => {
      mockTaxonomyState.saveError = null;
      useDebateStore.setState({
        reflections: makeQualifyReflection('Dynamic defense outpaces static rules — a malformed description with no genus line.'),
      });

      const result = await useDebateStore.getState().applyReflectionEdit('accelerationist', 0);

      expect(mockTaxonomyState.movePovNodeCategory).not.toHaveBeenCalled();
      expect(result).toMatchObject({ ok: true });
    });
  });
});

// ── hermeticity guard self-check (t/2354) ───────────────────
// Fails if the network guard is ever removed, so the keyless/no-live-AI isolation
// can't silently regress into the CI 429/embed-OOM flake.
describe('hermeticity guard (t/2354)', () => {
  it('blocks fetch so no live AI call can happen in this suite', () => {
    expect(() => (globalThis as unknown as { fetch: (u: string) => unknown }).fetch('https://example.test'))
      .toThrow(/hermeticity guard/);
  });
});


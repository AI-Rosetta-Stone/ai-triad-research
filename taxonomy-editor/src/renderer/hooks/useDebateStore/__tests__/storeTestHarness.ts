// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Shared mock harness for the useDebateStore test suite (ADR-007 Phase-2 split, t/1690).
//
// useDebateStore is a monolithic store that transitively imports the entire slice
// tree, so ANY test that exercises it needs the full dependency mock set below. To
// keep the split concern-scoped test files (under the 2000-LOC test budget) DRY,
// the mocks, fixtures, and per-test reset live here once and are imported by every
// split file. Import this module FIRST in each test file so its hoisted vi.mock
// registrations run before the store (and its deps) are imported.

import { vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks (available before vi.mock factories execute) ──

const { mockApi, mockTaxonomyState, mockPromptConfigState } = vi.hoisted(() => {
  const mockApi = {
    generateText: vi.fn().mockResolvedValue({ text: '{}' }),
    hasApiKey: vi.fn().mockResolvedValue(true),
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
    geminiModel: 'gemini-flash-lite-latest' as string,
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

vi.mock('../../useTaxonomyStore', () => ({
  useTaxonomyStore: {
    getState: () => mockTaxonomyState,
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

vi.mock('../../usePromptConfigStore', () => ({
  usePromptConfigStore: {
    getState: () => mockPromptConfigState,
  },
}));

// Mock prompt modules (they return strings; we only care that the store calls them)
vi.mock('../../../prompts/debate', () => ({
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
  situationTopicSynthesisPrompt: vi.fn().mockReturnValue('mock-situation-topic-synthesis-prompt'),
}));

vi.mock('../../../prompts/argumentNetwork', () => ({
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

vi.mock('../../../utils/convergenceScoring', () => ({
  updateConvergenceTracker: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../utils/taxonomyRelevance', () => ({
  cosineSimilarity: vi.fn().mockReturnValue(0),
  scoreNodeRelevance: vi.fn().mockReturnValue(0),
  scoreNodeRelevanceMeanTopN: vi.fn().mockReturnValue(new Map()),
  scoreNodesViaAN: vi.fn().mockReturnValue(new Map()),
  scoreNodesLexical: vi.fn().mockReturnValue(new Map()),
  selectRelevantNodes: vi.fn().mockReturnValue([]),
  selectRelevantSituationNodes: vi.fn().mockReturnValue([]),
  buildRelevanceQuery: vi.fn().mockReturnValue('mock-query'),
}));

vi.mock('../../../utils/taxonomyContext', () => ({
  formatTaxonomyContext: vi.fn().mockReturnValue('mock-taxonomy-context'),
}));

vi.mock('../../../utils/errorMessages', () => ({
  mapErrorToUserMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock('../../../lib/trace', () => ({
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

// t/4044: partial (real constants such as DEFAULT_ATTACK_WEIGHTS kept) so tests can run the real
// extractCalibrationData over a created session; the mocked function is unchanged.
vi.mock(import('@lib/debate/qbaf'), async (importOriginal) => ({
  ...(await importOriginal()),
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
  // t/3226: requestSynthesis now runs the debate-end finalization sweep. Passthrough mock —
  // the real transition (identified→undecided) is unit-tested in lib/debate; here it's a no-op.
  finalizeUndecidedCruxes: vi.fn((tracker?: unknown[]) => tracker ?? []),
}));

vi.mock('@lib/debate/taxonomyGapAnalysis', () => ({
  computeTaxonomyGapAnalysis: vi.fn().mockReturnValue(null),
}));

vi.mock('@lib/debate/moderator', () => ({
  updateModeratorState: vi.fn().mockReturnValue({}),
  computeDebateHealthScore: vi.fn().mockReturnValue({ value: 0.8, trend: 0, components: {} }),
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
  // t/3521: clarificationSlice.ts now calls this instead of runOpeningPipeline directly —
  // the floor + repair-retry sequence moved into lib/debate/turnPipeline/opening.ts, single
  // source of truth shared with the engine path.
  runOpeningPipelineWithRepair: vi.fn().mockResolvedValue({}),
  assembleOpeningPipelineResult: vi.fn().mockReturnValue({}),
  getOpeningRepairHints: vi.fn().mockReturnValue([]),
  // t/3518 Phase 2: openingBriefTimeoutFloor is retired — clarificationSlice.ts now computes
  // briefTimeoutMs via @lib/ai-client's getModelMinTimeout (a real, unmocked pure function
  // reading the bundled ai-models.json), so there's no predicate left here to re-implement.
  // DEFAULT_BRIEF_TIMEOUT_MS is a real constant (not a function) that the slice still imports
  // from this module — mirror its actual value rather than mask it, or every real import of
  // it from a mocked module throws "no export defined on the mock" at runtime.
  DEFAULT_BRIEF_TIMEOUT_MS: 120_000,
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

// t/4044: partial (real PROMPT_VERSION kept), as for qbaf above; the mocked prompt builders are unchanged.
vi.mock(import('@lib/debate/prompts'), async (importOriginal) => ({
  ...(await importOriginal()),
  decomposeResolutionPrompt: vi.fn().mockReturnValue('mock-decompose-prompt'),
  topicScopeExtractionPrompt: vi.fn().mockReturnValue('mock-scope-prompt'),
  setTopicScope: vi.fn(),
  synthExtractPrompt: vi.fn().mockReturnValue('mock-synth-extract-prompt'),
  synthMapPrompt: vi.fn().mockReturnValue('mock-synth-map-prompt'),
  synthEvaluatePrompt: vi.fn().mockReturnValue('mock-synth-evaluate-prompt'),
  narrativeVoicingPrompt: vi.fn().mockReturnValue('mock-narrative-voicing-prompt'),
}));

vi.mock('@lib/debate/phaseTransitions', () => ({
  loadProvisionalWeights: vi.fn().mockReturnValue({}),
  // t/3937: by default the caps are the preset, so existing loop-count tests keep their meaning.
  // adaptiveLoopCap.test.ts swaps in the real implementations via vi.importActual.
  effectiveRoundCap: vi.fn((config: { maxTotalRounds: number }) => config.maxTotalRounds),
  maxTurnCeiling: vi.fn((config: { maxTotalRounds: number }) => config.maxTotalRounds),
  initPhaseState: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 0, total_rounds_elapsed: 0 }),
  evaluatePhaseTransition: vi.fn().mockReturnValue({ action: 'continue', reason: 'test' }),
  advanceRound: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 1, total_rounds_elapsed: 1, argumentation_exit_threshold: 0.6, concluding_exit_threshold: 0.7 }),
  applyTransition: vi.fn().mockReturnValue({ current_phase: 'confrontation', rounds_in_phase: 0, total_rounds_elapsed: 1 }),
  buildSignalRegistry: vi.fn().mockReturnValue([]),
  computeSaturationScore: vi.fn().mockReturnValue(0),
  computeConvergenceScore: vi.fn().mockReturnValue(0),
  detectCruxNodes: vi.fn().mockReturnValue([]),
  buildPhaseContext: vi.fn().mockReturnValue({ phase_progress: 0.3, rationale: 'test', approaching_transition: false }),
  buildSignalTelemetry: vi.fn().mockReturnValue({ round: 1, phase: 'confrontation', composite: { convergence_score: 0.1, saturation_score: 0.1 }, signals: {}, action: 'continue', reason: 'test', phase_progress: 0.3, predicate_ms: 0 }),
  initAdaptiveDiagnostics: vi.fn().mockImplementation(() => ({
    signal_telemetry: [], phases: [], regressions: [], gc_events: [],
    total_predicate_evaluations: 0, confidence_deferrals: 0, vetoes_fired: 0, forces_fired: 0, network_size_peak: 0,
  })),
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

vi.mock('../../../data/lineageCategories', () => ({
  getLineageMapping: vi.fn().mockReturnValue({}),
  getL2Categories: vi.fn().mockReturnValue([]),
  isLineageDataLoaded: vi.fn().mockReturnValue(false),
}));

vi.mock('@lib/debate/lookaheadGate', () => ({
  evaluateLookaheadPerClaim: vi.fn().mockReturnValue([]),
  buildClaimAnalysis: vi.fn().mockReturnValue({ claims: [] }),
}));

vi.mock('../../../utils/dolceCompliance', () => ({
  checkDolceCompliance: vi.fn().mockReturnValue([]),
}));

vi.mock('@lib/debate/vocabularyContext', () => ({
  formatVocabularyContext: vi.fn().mockReturnValue(''),
}));

// Defensive embedder stub (t/2354): the real renderer embedder (onnxruntime + MiniLM)
// is only reached via the real electron-bridge, which is mocked above — but stub it
// directly too so no code path can load the model (the CI "embed OOM" / "Embedding
// unavailable" flake) even if a future change imports it here. Deterministic, no model load.
vi.mock('../../../utils/localEmbedding', () => ({
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

import { useDebateStore } from '../../useDebateStore';
import { __resetRunLeasesForTests, __setRunLeaseTimingForTests } from '../shared/debateRunLease';

// ── Helpers ─────────────────────────────────────────────────

/** Reset the store to initial state between tests */
function resetStore(): void {
  useDebateStore.setState({
    sessions: [],
    sessionsLoading: false,
    activeDebateId: null,
    activeDebate: null,
    debateLoading: false,
    _loadInFlight: {},
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

// ── Shared per-test lifecycle ───────────────────────────────
// Registered at import time onto the importing test file's root suite.

beforeEach(() => {
  resetStore();
  // Run leases (t/3917) are module state: a lease leaked by one test would refuse the next
  // test's run. settleMs 0 keeps the cross-window settle window off the timer queue, so
  // fake-timer suites aren't blocked on it.
  __resetRunLeasesForTests();
  __setRunLeaseTimingForTests({ settleMs: 0 });
  idCounter = 0;
  vi.clearAllMocks();
  vi.mocked(generateId).mockImplementation(() => `test-id-${++idCounter}`);
  vi.mocked(nowISO).mockReturnValue('2026-05-01T00:00:00.000Z');
  mockApi.onGenerateTextProgress.mockReturnValue(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── Exports for split test files ────────────────────────────
//
// NOTE: do NOT re-export `useDebateStore` here — a re-export of a mock-dependent
// module through this harness resolves to `undefined` in the importing file
// (vitest cross-file hoisting). Split files must import the store DIRECTLY:
//   import { useDebateStore } from '../../useDebateStore';
// placed AFTER this harness import so the store resolves against the registered
// mocks. Both imports hit the same zustand singleton. Likewise, mocked module
// functions a block asserts on (e.g. runModeratorSelection) are imported directly
// from their own module in the split file, not re-exported here.

export {
  resetStore,
  makeSession,
  mockApi,
  mockTaxonomyState,
  mockPromptConfigState,
  localStorageMock,
  generateId,
  nowISO,
};

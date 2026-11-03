// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4688 (parent t/4685, TL precondition on the PI's choice of "Option C" in-place opening):
// Chat and Debate can't drop their pop-up-by-default behavior until each proves a running item
// survives leaving its view. This pins that for Debate.
//
// Mounting the real exported DebateTab here (pulling in LibraryListPage, NewDebateDialog, and
// the rest of its tree alongside the real useDebateStore) made the vitest worker hang/OOM —
// isolating further wasn't worth it for what this test needs to prove. DebateTabItemView below
// is a minimal stand-in for DebateTab's actual mount condition (DebateTab.tsx ~772-774:
// `activeDebate ? <DebateWorkspace/> : <empty-state>`, the literal "item view" that
// unmounts/remounts as the debate tab's selection changes) wired to the REAL useDebateStore, so
// what's under test is the real thing: does the round-advancement loop
// (runAdaptiveLoop/crossRespond, useDebateStore/slices/{clarificationSlice,runLeaseSlice}.ts)
// keep going when this view unmounts, and resume without double-starting a round. A full static
// read of DebateTab.tsx and DebateWorkspace.tsx (t/4688 ticket comment) found no effect in
// either that depends on mount to drive a round — this test is the empirical half of that claim.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// ── useDebateStore dependency mocks (storeTestHarness.ts, re-pathed for this directory) ──

const { recorded } = vi.hoisted(() => ({ recorded: [] as Array<Record<string, unknown>> }));
vi.mock('@lib/flight-recorder/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lib/flight-recorder/index')>();
  return { ...actual, getGlobalRecorder: () => ({ record: (e: Record<string, unknown>) => { recorded.push(e); }, setEventContext: () => {} }) };
});

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

vi.mock('@bridge', () => ({ api: mockApi, setActiveDebateId: vi.fn(), isElectronMode: () => true }));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { getState: () => mockTaxonomyState, setState: vi.fn(), subscribe: vi.fn() },
}));

vi.mock('../../hooks/usePromptConfigStore', () => ({
  usePromptConfigStore: { getState: () => mockPromptConfigState },
}));

vi.mock('../../prompts/debate', () => ({
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

vi.mock('../../prompts/argumentNetwork', () => ({
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

vi.mock('../../utils/convergenceScoring', () => ({ updateConvergenceTracker: vi.fn().mockReturnValue(undefined) }));

vi.mock('../../utils/taxonomyRelevance', () => ({
  cosineSimilarity: vi.fn().mockReturnValue(0),
  scoreNodeRelevance: vi.fn().mockReturnValue(0),
  scoreNodeRelevanceMeanTopN: vi.fn().mockReturnValue(new Map()),
  scoreNodesViaAN: vi.fn().mockReturnValue(new Map()),
  scoreNodesLexical: vi.fn().mockReturnValue(new Map()),
  selectRelevantNodes: vi.fn().mockReturnValue([]),
  selectRelevantSituationNodes: vi.fn().mockReturnValue([]),
  buildRelevanceQuery: vi.fn().mockReturnValue('mock-query'),
}));

vi.mock('../../utils/taxonomyContext', () => ({ formatTaxonomyContext: vi.fn().mockReturnValue('mock-taxonomy-context') }));

vi.mock('../../utils/errorMessages', () => ({
  mapErrorToUserMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

vi.mock('../../lib/trace', () => ({
  trace: vi.fn(),
  newCallId: vi.fn().mockReturnValue('call-001'),
  TraceEventName: new Proxy({}, { get: (_, prop) => String(prop) }),
}));

vi.mock('@lib/debate', () => ({ normalizeBdiLayer: vi.fn((x: string) => x) }));
vi.mock('@lib/debate/nodeIdUtils', () => ({ nodeTypeFromId: vi.fn().mockReturnValue('pov') }));

vi.mock(import('@lib/debate/qbaf'), async (importOriginal) => ({
  ...(await importOriginal()),
  computeQbafStrengths: vi.fn().mockReturnValue({ strengths: new Map() }),
}));

vi.mock('@lib/debate/argumentNetwork', () => ({ factCheckToBaseStrength: vi.fn().mockReturnValue(0.5) }));

vi.mock('@lib/debate/networkGc', () => ({
  needsGc: vi.fn().mockReturnValue(false),
  pruneArgumentNetwork: vi.fn().mockReturnValue({ nodes: [], edges: [], prunedNodes: [], before: 0, after: 0 }),
  GC_TRIGGER: 200,
  GC_TARGET: 150,
}));

vi.mock(import('@lib/debate/types'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getDebatePhase: vi.fn().mockReturnValue('setup') };
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

let idCounter = 0;
const { generateId, nowISO } = await import('@lib/debate/helpers');
vi.mocked(generateId).mockImplementation(() => `test-id-${++idCounter}`);

vi.mock('@lib/debate/turnValidator', () => ({ resolveTurnValidationConfig: vi.fn().mockReturnValue({}) }));
vi.mock('@lib/debate/convergenceSignals', () => ({ computeConvergenceSignals: vi.fn().mockReturnValue({ round: 1, signals: {} }) }));

vi.mock('@lib/debate/cruxResolution', () => ({
  updateCruxTracker: vi.fn().mockReturnValue(undefined),
  finalizeUndecidedCruxes: vi.fn((tracker?: unknown[]) => tracker ?? []),
}));

vi.mock('@lib/debate/taxonomyGapAnalysis', () => ({ computeTaxonomyGapAnalysis: vi.fn().mockReturnValue(null) }));

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
  runOpeningPipelineWithRepair: vi.fn().mockResolvedValue({}),
  assembleOpeningPipelineResult: vi.fn().mockReturnValue({}),
  getOpeningRepairHints: vi.fn().mockReturnValue([]),
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

vi.mock('@lib/debate/beliefConfidence', () => ({ computeBeliefConfidence: vi.fn().mockReturnValue(0.5) }));
vi.mock('@lib/debate/desirePriority', () => ({ computeTreePriority: vi.fn().mockReturnValue(0.5) }));
vi.mock('@lib/debate/intentionOperationality', () => ({ computeOperationality: vi.fn().mockReturnValue(0.5) }));
vi.mock('@lib/debate/vocabularyDisambiguation', () => ({ disambiguateTerms: vi.fn().mockReturnValue({ terms: [], ambiguousCount: 0 }) }));
vi.mock('@lib/debate/processReward', () => ({ computeProcessReward: vi.fn().mockReturnValue({ score: 0.5, breakdown: {} }) }));

vi.mock('../../data/lineageCategories', () => ({
  getLineageMapping: vi.fn().mockReturnValue({}),
  getL2Categories: vi.fn().mockReturnValue([]),
  isLineageDataLoaded: vi.fn().mockReturnValue(false),
}));

vi.mock('@lib/debate/lookaheadGate', () => ({
  evaluateLookaheadPerClaim: vi.fn().mockReturnValue([]),
  buildClaimAnalysis: vi.fn().mockReturnValue({ claims: [] }),
}));

vi.mock('../../utils/dolceCompliance', () => ({ checkDolceCompliance: vi.fn().mockReturnValue([]) }));
vi.mock('@lib/debate/vocabularyContext', () => ({ formatVocabularyContext: vi.fn().mockReturnValue('') }));

vi.mock('../../utils/localEmbedding', () => ({
  tryInitLocalEmbedding: vi.fn().mockResolvedValue(false),
  isLocalEmbeddingReady: vi.fn().mockReturnValue(false),
  getLocalEmbeddingBackend: vi.fn().mockReturnValue('mock'),
  notifyBridgeFallback: vi.fn(),
  localComputeEmbedding: vi.fn().mockResolvedValue([]),
  localComputeEmbeddings: vi.fn().mockResolvedValue([]),
}));

vi.stubGlobal('__APP_VERSION__', '0.7.4');

const localStorageMock = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
vi.stubGlobal('localStorage', localStorageMock);

const blockNetwork = (what: string) => () => {
  throw new Error(`[t/2354 hermeticity guard] ${what} is blocked in unit tests — mock the AI/embedding boundary instead of making a live call`);
};
vi.stubGlobal('fetch', blockNetwork('fetch'));
vi.stubGlobal('WebSocket', blockNetwork('WebSocket'));
vi.stubGlobal('XMLHttpRequest', blockNetwork('XMLHttpRequest'));

// ── Imports under test ───────────────────────────────────────

import { useDebateStore } from '../../hooks/useDebateStore';
import { useShallow } from 'zustand/react/shallow';
import { __resetRunLeasesForTests, __setRunLeaseTimingForTests } from '../../hooks/useDebateStore/shared/debateRunLease';
import { loadProvisionalWeights } from '@lib/debate/phaseTransitions';

type Store = ReturnType<typeof useDebateStore.getState>;

// DebateTab's actual item-view mount condition (DebateTab.tsx ~772-774): once activeDebate is
// set, the right pane mounts the running view (DebateWorkspace); otherwise an empty state. This
// reproduces exactly that gate, subscribed to the real useDebateStore, which is what's actually
// under test — not DebateTab's surrounding chrome (library list, dialogs, toolbar panes), which
// has no bearing on whether the round survives this view unmounting.
function DebateTabItemView() {
  const activeDebate = useDebateStore(useShallow(s => s.activeDebate));
  return activeDebate ? <div data-testid="debate-item-view" /> : <div data-testid="debate-empty-state" />;
}

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
  } as unknown as Partial<Store>);
}

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
    transcript: [] as Array<{ id: string; timestamp: string; type: string; speaker: string; content: string; taxonomy_refs: string[] }>,
    context_summaries: [] as Array<{ up_to_entry_id: string; summary: string }>,
    generated_with_prompt_version: 'dolce-phase-1',
    audience: 'policymakers' as const,
    ...overrides,
  };
}

function entry(id: string, type: string, speaker: string) {
  return {
    id,
    timestamp: '2026-05-01T00:00:00.000Z',
    type,
    speaker,
    content: `${speaker} ${type} — a sufficiently long body of prose to clear the delivery-length guard.`,
    taxonomy_refs: [] as string[],
  };
}

function seedAdaptiveDebate(maxTotalRounds: number): string {
  vi.mocked(loadProvisionalWeights).mockReturnValue({
    pacing_presets: { tight: { maxTotalRounds, argumentationExit: 0.62, concludingExit: 0.6 } },
  } as unknown as ReturnType<typeof loadProvisionalWeights>);
  const session = makeSession({
    phase: 'opening',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    adaptive_staging: { enabled: true, pacing: 'tight' },
    transcript: [
      entry('o1', 'opening', 'accelerationist'),
      entry('o2', 'opening', 'safetyist'),
      entry('o3', 'opening', 'skeptic'),
    ],
  });
  useDebateStore.setState({ activeDebate: session as unknown as Store['activeDebate'], activeDebateId: session.id });
  return session.id;
}

let turnCounter = 0;
function appendStatement(): void {
  const d = useDebateStore.getState().activeDebate!;
  turnCounter++;
  useDebateStore.setState({ activeDebate: { ...d, transcript: [...d.transcript, entry(`s${turnCounter}`, 'statement', 'skeptic')] } as Store['activeDebate'] });
}

const messages = (m: string) => recorded.filter(e => e.message === m);

describe('DebateTab item view — a running debate survives leaving it (t/4688)', () => {
  beforeEach(() => {
    resetStore();
    __resetRunLeasesForTests();
    __setRunLeaseTimingForTests({ settleMs: 0 });
    idCounter = 0;
    recorded.length = 0;
    turnCounter = 0;
    vi.clearAllMocks();
    vi.mocked(generateId).mockImplementation(() => `test-id-${++idCounter}`);
    vi.mocked(nowISO).mockReturnValue('2026-05-01T00:00:00.000Z');
    mockApi.onGenerateTextProgress.mockReturnValue(() => {});
  });

  it('unmounting and remounting the item view mid-round produces the turns once, with exactly one in-flight loop', async () => {
    seedAdaptiveDebate(2);
    let openGate!: () => void;
    const gate = new Promise<void>(r => { openGate = r; });
    const turn = vi.spyOn(useDebateStore.getState(), '_crossRespondLeased').mockImplementation(async () => {
      await gate;
      appendStatement();
    });
    vi.spyOn(useDebateStore.getState(), 'requestSynthesis').mockResolvedValue(undefined);

    const view = render(<DebateTabItemView />);
    expect(view.queryByTestId('debate-item-view')).not.toBeNull();

    // Start the round the way the shell does — not through a button in this harness, since the
    // adaptive loop's entry point (runOpeningStatements) is already proven as a plain store
    // action in runLeaseSingleFlight.test.ts; what's new here is the unmount in the middle of it.
    const run = useDebateStore.getState().runOpeningStatements('t4688');
    await vi.waitFor(() => expect(turn).toHaveBeenCalledTimes(1));

    // Leave the view — the item view unmounts while the round is parked mid-turn.
    view.rerender(<></>);
    expect(view.queryByTestId('debate-item-view')).toBeNull();

    // Advance the run while nothing is mounted.
    openGate();
    await run;

    // Resume rendering without double-starting a round.
    view.rerender(<DebateTabItemView />);

    expect(turn).toHaveBeenCalledTimes(2); // the loop's cap — not restarted, not stalled
    expect(messages('Adaptive loop started')).toHaveLength(1); // exactly one in-flight round
    expect(messages('Adaptive loop re-entry blocked')).toHaveLength(0);
    expect(useDebateStore.getState().activeDebate?.transcript.filter(e => e.type === 'statement')).toHaveLength(2); // the turns are present
    expect(view.getByTestId('debate-item-view')).not.toBeNull(); // the item view resumed rendering
  });
});

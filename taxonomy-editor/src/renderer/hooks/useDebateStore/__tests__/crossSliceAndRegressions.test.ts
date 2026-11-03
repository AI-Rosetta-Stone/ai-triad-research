// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// useDebateStore context-compression, cross-slice integration, and regression
// tests (lookahead WEAK-claim filtering, opening-statement failure halting, retry
// action tracking, daily token-limit stop). Split from useDebateStore.test.ts
// under the ADR-007 2000-LOC test budget (t/1690, epic t/1681). The shared mock
// harness lives in ./storeTestHarness and is imported FIRST so its hoisted mocks
// register before the store import below resolves. Blocks moved verbatim — no
// coverage change. (runOpeningPipelineWithRepair/assembleOpeningPipelineResult are pulled in
// via inline await import() inside their test bodies, as in the original.)
import { describe, it, expect, vi } from 'vitest';
import { mockApi, mockPromptConfigState, makeSession } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';
import { disambiguateTerms } from '@lib/debate/vocabularyDisambiguation';
import { evaluateLookaheadPerClaim } from '@lib/debate/lookaheadGate';
import { processExtractedClaims } from '../../../prompts/argumentNetwork';

// ── P5-7. Context Compression ──────────────────────────────

describe('Context compression: full flow', () => {
  it('compresses old entries and adds context summary', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: `e${i}`, timestamp: 't', type: 'statement', speaker: i % 2 === 0 ? 'accelerationist' : 'safetyist',
      content: `Entry ${i} content`, taxonomy_refs: [],
    }));
    useDebateStore.setState({ activeDebate: makeSession({ transcript: entries }) as any });
    mockApi.generateText.mockResolvedValue({ text: '{"summary":"Compressed summary of debate"}' });

    await useDebateStore.getState().compressOldTranscript();

    const debate = useDebateStore.getState().activeDebate!;
    expect(debate.context_summaries.length).toBeGreaterThan(0);
    expect(debate.context_summaries[0].summary).toContain('Compressed summary');
    expect(useDebateStore.getState().debateGenerating).toBeNull();
    expect(mockApi.saveDebateSession).toHaveBeenCalled();
  });

  it('handles non-JSON summary text gracefully', async () => {
    const entries = Array.from({ length: 15 }, (_, i) => ({
      id: `e${i}`, timestamp: 't', type: 'statement', speaker: 'accelerationist',
      content: `Entry ${i}`, taxonomy_refs: [],
    }));
    useDebateStore.setState({ activeDebate: makeSession({ transcript: entries }) as any });
    mockApi.generateText.mockResolvedValue({ text: 'Plain text summary without JSON' });

    await useDebateStore.getState().compressOldTranscript();

    const debate = useDebateStore.getState().activeDebate!;
    expect(debate.context_summaries.length).toBeGreaterThan(0);
    expect(debate.context_summaries[0].summary).toBe('Plain text summary without JSON');
  });
});

// ── P5-8. Cross-Slice State Dependencies ───────────────────

describe('Cross-slice: phase transitions', () => {
  it('proceedToOpening preserves existing openingOrder from setup screen', () => {
    useDebateStore.setState({
      activeDebate: makeSession() as any,
      openingOrder: ['skeptic', 'accelerationist', 'safetyist'],
    });

    useDebateStore.getState().proceedToOpening();

    expect(useDebateStore.getState().openingOrder).toEqual(['skeptic', 'accelerationist', 'safetyist']);
  });

  it('proceedToOpening persists opening_order on debate object', () => {
    useDebateStore.setState({
      activeDebate: makeSession() as any,
      openingOrder: ['safetyist', 'skeptic', 'accelerationist'],
    });

    useDebateStore.getState().proceedToOpening();

    const debate = useDebateStore.getState().activeDebate!;
    expect((debate as any).opening_order).toEqual(['safetyist', 'skeptic', 'accelerationist']);
  });

  it('closeDebate resets prompt config store', () => {
    useDebateStore.setState({
      activeDebateId: 'x',
      activeDebate: makeSession() as any,
    });

    useDebateStore.getState().closeDebate();

    expect(mockPromptConfigState.resetSession).toHaveBeenCalled();
  });
});

describe('Cross-slice: addTranscriptEntry vocabulary disambiguation', () => {
  it('applies vocabulary disambiguation to debater statements', () => {
    useDebateStore.setState({
      activeDebate: makeSession() as any,
      vocabularyTerms: {
        standardized: [{ term: 'alignment', definition: 'test' }],
        colloquial: [{ bare: 'align', canonical: 'alignment', camps: ['accelerationist'], confidence: 0.9 }],
      },
    });
    vi.mocked(disambiguateTerms).mockReturnValueOnce({
      terms: [{ bare: 'align', canonical: 'alignment', confidence: 0.9, offset: 5, ambiguous: false }],
      ambiguousCount: 0,
    });

    useDebateStore.getState().addTranscriptEntry({
      type: 'statement',
      speaker: 'accelerationist',
      content: 'The align approach works',
      taxonomy_refs: [],
    });

    const transcript = useDebateStore.getState().activeDebate!.transcript;
    const entry = transcript[0];
    expect(entry.metadata?.vocabulary_resolutions).toBeDefined();
    expect(entry.metadata.vocabulary_resolutions).toHaveLength(1);
    expect(entry.metadata.vocabulary_resolutions[0].canonical).toBe('alignment');
  });

  it('does not apply disambiguation to system or user entries', () => {
    useDebateStore.setState({
      activeDebate: makeSession() as any,
      vocabularyTerms: {
        standardized: [{ term: 'alignment', definition: 'test' }],
        colloquial: [{ bare: 'align', canonical: 'alignment', camps: ['accelerationist'], confidence: 0.9 }],
      },
    });

    useDebateStore.getState().addTranscriptEntry({
      type: 'system',
      speaker: 'system',
      content: 'System message about align',
      taxonomy_refs: [],
    });

    const transcript = useDebateStore.getState().activeDebate!.transcript;
    expect(transcript[0].metadata?.vocabulary_resolutions).toBeUndefined();
  });
});

describe('Cross-slice: deleteTranscriptEntries cleans up AN', () => {
  it('removes orphaned AN nodes and edges when entries are deleted', async () => {
    const session = makeSession({
      transcript: [
        { id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'X', taxonomy_refs: [] },
        { id: 'e2', timestamp: 't', type: 'statement', speaker: 'safetyist', content: 'Y', taxonomy_refs: [] },
      ],
      argument_network: {
        nodes: [
          { id: 'AN-1', text: 'Claim 1', speaker: 'accelerationist', source_entry_id: 'e1', taxonomy_refs: [], turn_number: 1 },
          { id: 'AN-2', text: 'Claim 2', speaker: 'safetyist', source_entry_id: 'e2', taxonomy_refs: [], turn_number: 2 },
        ],
        edges: [
          { source: 'AN-1', target: 'AN-2', type: 'attacks' },
        ],
      },
    });
    useDebateStore.setState({ activeDebate: session as any });

    await useDebateStore.getState().deleteTranscriptEntries(['e1']);

    const debate = useDebateStore.getState().activeDebate!;
    const an = (debate as any).argument_network;
    expect(an.nodes).toHaveLength(1);
    expect(an.nodes[0].id).toBe('AN-2');
    expect(an.edges).toHaveLength(0);
  });

  it('cleans up orphaned diagnostics entries', async () => {
    const session = makeSession({
      transcript: [
        { id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'X', taxonomy_refs: [] },
      ],
      diagnostics: {
        enabled: true,
        entries: { e1: { prompt: 'test', raw_response: 'test', model: 'test' } },
        overview: { total_ai_calls: 1, total_response_time_ms: 100, claims_accepted: 0, claims_rejected: 0, move_type_counts: {}, disagreement_type_counts: {} },
      },
    });
    useDebateStore.setState({ activeDebate: session as any });

    await useDebateStore.getState().deleteTranscriptEntries(['e1']);

    const diag = (useDebateStore.getState().activeDebate as any).diagnostics;
    expect(diag.entries.e1).toBeUndefined();
  });
});

describe('Cross-slice: setAudience propagates to activeDebate', () => {
  it('updates audience on both store state and activeDebate object', () => {
    useDebateStore.setState({ activeDebate: makeSession() as any });

    useDebateStore.getState().setAudience('researchers');

    expect(useDebateStore.getState().audience).toBe('researchers');
    expect(useDebateStore.getState().activeDebate!.audience).toBe('researchers');
  });
});

describe('Lookahead WEAK claim filtering (t/459)', () => {
  it('filters WEAK claims from a passing batch, keeping STRONG and PRESERVE', async () => {
    const threeNodes = [
      { id: 'tmp-1', text: 'Strong claim about governance', speaker: 'accelerationist', source_entry_id: 'entry-1', taxonomy_refs: [], turn_number: 1, base_strength: 0.7 },
      { id: 'tmp-2', text: 'Weak marginal claim', speaker: 'accelerationist', source_entry_id: 'entry-1', taxonomy_refs: [], turn_number: 1, base_strength: 0.3 },
      { id: 'tmp-3', text: 'Preserved concession claim', speaker: 'accelerationist', source_entry_id: 'entry-1', taxonomy_refs: [], turn_number: 1, base_strength: 0.5 },
    ];
    const threeEdges = [
      { id: 'te-1', source: 'tmp-1', target: 'AN-1', type: 'supports', weight: 0.5 },
      { id: 'te-2', source: 'tmp-2', target: 'AN-1', type: 'attacks', weight: 0.3 },
    ];

    vi.mocked(processExtractedClaims).mockReturnValueOnce({
      newNodes: [...threeNodes],
      newEdges: [...threeEdges],
      accepted: threeNodes.map(n => ({ id: n.id, text: n.text })),
      rejected: [],
      commitments: { asserted: [], conceded: [], challenged: [] },
      rejectionReasons: {},
      rejectedOverlapPcts: [],
      maxOverlapVsExisting: 0,
    } as any);

    vi.mocked(evaluateLookaheadPerClaim).mockReturnValueOnce({
      batchResult: {
        pass: true,
        utility_before: { position_strength: 0.5, attack_effectiveness: 0.3, crux_engagement: 0.2 },
        utility_after: { position_strength: 0.7, attack_effectiveness: 0.4, crux_engagement: 0.3 },
        utility_delta: 0.15,
        threshold: 0.05,
        tentative_claims: threeNodes.map(n => ({ text: n.text, strength: n.base_strength })),
        tentative_network_size: { nodes: 4, edges: 3 },
        concession_indices: [],
      },
      perClaim: [
        { index: 0, text: threeNodes[0].text, base_strength: 0.7, marginal_delta: 0.12, classification: 'STRONG' as const, dominant_component: 'position_strength' as const },
        { index: 1, text: threeNodes[1].text, base_strength: 0.3, marginal_delta: 0.01, classification: 'WEAK' as const, dominant_component: 'attack_effectiveness' as const },
        { index: 2, text: threeNodes[2].text, base_strength: 0.5, marginal_delta: 0.04, classification: 'PRESERVE' as const, dominant_component: 'crux_engagement' as const },
      ],
    });

    const claimsJson = JSON.stringify({
      claims: [
        { claim: 'Strong claim about governance', type: 'assertion', targets: [] },
        { claim: 'Weak marginal claim', type: 'assertion', targets: [] },
        { claim: 'Preserved concession claim', type: 'concession', targets: [] },
      ],
    });
    mockApi.generateText.mockResolvedValueOnce({ text: claimsJson });
    mockApi.computeQueryEmbedding.mockResolvedValue({ vector: [0.1, 0.2, 0.3] });

    const session = makeSession({
      phase: 'debate',
      transcript: [
        { id: 'entry-1', timestamp: '2026-05-01T00:00:00.000Z', type: 'statement', speaker: 'accelerationist', content: 'My argument about AI governance...', taxonomy_refs: [] },
      ],
      argument_network: { nodes: [{ id: 'AN-1', text: 'Prior claim', speaker: 'safetyist', source_entry_id: 'e0', taxonomy_refs: [], turn_number: 0, base_strength: 0.5 }], edges: [] },
      lookahead_filter_weak: true,
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().reExtractClaims('entry-1');

    const debate = useDebateStore.getState().activeDebate as any;
    const an = debate.argument_network;
    // Original AN-1 + 2 committed (STRONG + PRESERVE); WEAK filtered out
    expect(an.nodes).toHaveLength(3);
    const committedTexts = an.nodes.slice(1).map((n: any) => n.text);
    expect(committedTexts).toContain('Strong claim about governance');
    expect(committedTexts).toContain('Preserved concession claim');
    expect(committedTexts).not.toContain('Weak marginal claim');

    // Edge from WEAK claim (tmp-2 → AN-1) should be removed
    const edgeSources = an.edges.map((e: any) => e.source);
    expect(edgeSources).not.toContain(expect.stringContaining('tmp-2'));
  });

  it('does not filter when lookahead_filter_weak is false', async () => {
    const twoNodes = [
      { id: 'tmp-1', text: 'Strong claim', speaker: 'accelerationist', source_entry_id: 'entry-2', taxonomy_refs: [], turn_number: 1, base_strength: 0.7 },
      { id: 'tmp-2', text: 'Weak claim', speaker: 'accelerationist', source_entry_id: 'entry-2', taxonomy_refs: [], turn_number: 1, base_strength: 0.3 },
    ];

    vi.mocked(processExtractedClaims).mockReturnValueOnce({
      newNodes: [...twoNodes],
      newEdges: [],
      accepted: twoNodes.map(n => ({ id: n.id, text: n.text })),
      rejected: [],
      commitments: { asserted: [], conceded: [], challenged: [] },
      rejectionReasons: {},
      rejectedOverlapPcts: [],
      maxOverlapVsExisting: 0,
    } as any);

    vi.mocked(evaluateLookaheadPerClaim).mockReturnValueOnce({
      batchResult: {
        pass: true, utility_before: { position_strength: 0.5, attack_effectiveness: 0.3, crux_engagement: 0.2 },
        utility_after: { position_strength: 0.6, attack_effectiveness: 0.4, crux_engagement: 0.3 },
        utility_delta: 0.1, threshold: 0.05,
        tentative_claims: twoNodes.map(n => ({ text: n.text, strength: n.base_strength })),
        tentative_network_size: { nodes: 3, edges: 0 }, concession_indices: [],
      },
      perClaim: [
        { index: 0, text: 'Strong claim', base_strength: 0.7, marginal_delta: 0.08, classification: 'STRONG' as const, dominant_component: 'position_strength' as const },
        { index: 1, text: 'Weak claim', base_strength: 0.3, marginal_delta: 0.01, classification: 'WEAK' as const, dominant_component: 'attack_effectiveness' as const },
      ],
    });

    mockApi.generateText.mockResolvedValueOnce({ text: JSON.stringify({ claims: [{ claim: 'Strong claim', type: 'assertion', targets: [] }, { claim: 'Weak claim', type: 'assertion', targets: [] }] }) });
    mockApi.computeQueryEmbedding.mockResolvedValue({ vector: [0.1, 0.2, 0.3] });

    const session = makeSession({
      phase: 'debate',
      transcript: [
        { id: 'entry-2', timestamp: '2026-05-01T00:00:00.000Z', type: 'statement', speaker: 'accelerationist', content: 'Some argument', taxonomy_refs: [] },
      ],
      argument_network: { nodes: [{ id: 'AN-1', text: 'Prior', speaker: 'safetyist', source_entry_id: 'e0', taxonomy_refs: [], turn_number: 0, base_strength: 0.5 }], edges: [] },
      lookahead_filter_weak: false,
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().reExtractClaims('entry-2');

    const an = (useDebateStore.getState().activeDebate as any).argument_network;
    // All claims committed — WEAK not filtered because lookahead_filter_weak is false
    expect(an.nodes).toHaveLength(3);
    const committedTexts = an.nodes.slice(1).map((n: any) => n.text);
    expect(committedTexts).toContain('Strong claim');
    expect(committedTexts).toContain('Weak claim');
  });
});

// ── Opening Statement Failure Handling (t/920) ─────────────

describe('runOpeningStatements — failure halts flow (t/920)', () => {
  it('does not advance to debate phase when opening pipeline throws a fatal error', async () => {
    const { runOpeningPipelineWithRepair } = await import('@lib/debate/turnPipeline');
    const fatalError = Object.assign(new Error('Internal server error'), { httpStatus: 500 });
    vi.mocked(runOpeningPipelineWithRepair).mockRejectedValue(fatalError);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist', 'safetyist'],
      topic: { original: 'AI governance', refined: null, final: 'AI governance' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().runOpeningStatements();

    const state = useDebateStore.getState();
    expect(state.activeDebate?.phase).toBe('opening');
    expect(state.debateError).toBeTruthy();
    expect(state.debateError).toMatch(/Opening statements failed/);
    expect(state.debateGenerating).toBeNull();

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
  });

  it('sets debateError with speaker names on partial failure', async () => {
    const { runOpeningPipelineWithRepair, assembleOpeningPipelineResult } = await import('@lib/debate/turnPipeline');
    vi.mocked(runOpeningPipelineWithRepair)
      .mockResolvedValueOnce({ stage_diagnostics: [] })
      .mockRejectedValueOnce(Object.assign(new Error('Server error'), { httpStatus: 500 }));
    vi.mocked(assembleOpeningPipelineResult).mockReturnValueOnce({
      statement: 'A'.repeat(100),
      taxonomyRefs: [],
      meta: { key_assumptions: [], my_claims: [], turn_symbols: [], policy_refs: [] },
    } as any);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist', 'safetyist'],
      topic: { original: 'AI governance', refined: null, final: 'AI governance' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().runOpeningStatements();

    const state = useDebateStore.getState();
    expect(state.activeDebate?.phase).toBe('opening');
    expect(state.debateError).toMatch(/Safetyist/);
    expect(state.debateGenerating).toBeNull();

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
    vi.mocked(assembleOpeningPipelineResult).mockReturnValue({});
  });

  it('retries once on 429 rate-limit errors before halting', async () => {
    const { runOpeningPipelineWithRepair } = await import('@lib/debate/turnPipeline');
    const rateLimitError = Object.assign(
      new Error('Rate limit exceeded. Retry in 1s.'),
      { httpStatus: 429 },
    );
    vi.mocked(runOpeningPipelineWithRepair).mockRejectedValue(rateLimitError);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist'],
      topic: { original: 'Test', refined: null, final: 'Test topic' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().runOpeningStatements();

    // Pipeline was called twice: initial attempt + one retry
    expect(vi.mocked(runOpeningPipelineWithRepair).mock.calls.length).toBeGreaterThanOrEqual(2);
    const state = useDebateStore.getState();
    expect(state.activeDebate?.phase).toBe('opening');
    expect(state.debateError).toBeTruthy();

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
  });

  it('auto-retries on a transient TIMEOUT (no httpStatus), not just 429 (t/2492)', async () => {
    const { runOpeningPipelineWithRepair } = await import('@lib/debate/turnPipeline');
    // The PI case: a ~3-min timeout with no httpStatus. Pre-fix this got 1 attempt + manual banner.
    const timeoutError = Object.assign(new Error('Request timed out after 180s'), { name: 'AbortError' });
    vi.mocked(runOpeningPipelineWithRepair).mockRejectedValue(timeoutError);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist'],
      topic: { original: 'Test', refined: null, final: 'Test topic' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    // Fake timers so the transient backoff (5s expo) flushes instantly instead of stalling the test.
    vi.useFakeTimers();
    try {
      const run = useDebateStore.getState().runOpeningStatements();
      await vi.runAllTimersAsync();
      await run;
    } finally {
      vi.useRealTimers();
    }

    // Auto-retry engaged (initial + at least one retry) — the honest banner appears only after the cap.
    expect(vi.mocked(runOpeningPipelineWithRepair).mock.calls.length).toBeGreaterThanOrEqual(2);
    const state = useDebateStore.getState();
    expect(state.debateError).toBeTruthy();
    expect(state.debateGenerating).toBeNull();

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
  });

  it('does NOT retry a daily-limit error — immediate pause banner (t/2492)', async () => {
    const { runOpeningPipelineWithRepair } = await import('@lib/debate/turnPipeline');
    const dailyLimitError = Object.assign(
      new Error('Daily AI usage limit reached'),
      { httpStatus: 429, limitType: 'tokens_per_day' },
    );
    vi.mocked(runOpeningPipelineWithRepair).mockRejectedValue(dailyLimitError);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist'],
      topic: { original: 'Test', refined: null, final: 'Test topic' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().runOpeningStatements();

    // Exactly one attempt — daily-limit halts immediately, no auto-retry.
    expect(vi.mocked(runOpeningPipelineWithRepair).mock.calls.length).toBe(1);
    const state = useDebateStore.getState();
    expect(state.dailyLimitPaused).toBe(true);
    expect(state.debateError).toMatch(/Daily/i);

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
  });
});

// ── Retry Action Tracking (t/953) ──────────────────────────

describe('setErrorWithRetry — tracks retry action (t/953)', () => {
  it('sets debateRetryAction alongside debateError', () => {
    useDebateStore.getState().setErrorWithRetry('Synthesis failed: rate limited', 'synthesis');
    const state = useDebateStore.getState();
    expect(state.debateError).toBe('Synthesis failed: rate limited');
    expect(state.debateRetryAction).toBe('synthesis');
  });

  it('clears debateRetryAction when setError(null) is called', () => {
    useDebateStore.getState().setErrorWithRetry('Cross-respond failed', 'crossRespond');
    expect(useDebateStore.getState().debateRetryAction).toBe('crossRespond');

    useDebateStore.getState().setError(null);
    const state = useDebateStore.getState();
    expect(state.debateError).toBeNull();
    expect(state.debateRetryAction).toBeNull();
  });

  it('preserves debateRetryAction when setError sets a new error string', () => {
    useDebateStore.getState().setErrorWithRetry('First error', 'probing');
    useDebateStore.getState().setError('Second error');
    const state = useDebateStore.getState();
    expect(state.debateError).toBe('Second error');
    expect(state.debateRetryAction).toBe('probing');
  });
});

// ── Daily Token Limit Handling (t/963) ─────────────────────

describe('daily token limit stops debate gracefully (t/963)', () => {
  it('sets dailyLimitPaused and DAILY_LIMIT_MESSAGE on tokens_per_day 429 during synthesis', async () => {
    const dailyLimitError = Object.assign(
      new Error('Daily token limit exceeded'),
      { httpStatus: 429, limitType: 'tokens_per_day' },
    );
    mockApi.generateText.mockRejectedValueOnce(dailyLimitError);

    const session = makeSession({
      phase: 'debate',
      transcript: [
        { id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'Test', taxonomy_refs: [] },
      ],
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().requestSynthesis();

    const state = useDebateStore.getState();
    expect(state.dailyLimitPaused).toBe(true);
    expect(state.debateError).toContain('Daily');
    expect(state.debateRetryAction).toBeNull();
    expect(state.debateGenerating).toBeNull();
  });

  it('clears dailyLimitPaused when setError(null) is called', () => {
    useDebateStore.setState({ debateError: 'Daily limit', dailyLimitPaused: true });
    useDebateStore.getState().setError(null);
    const state = useDebateStore.getState();
    expect(state.dailyLimitPaused).toBe(false);
    expect(state.debateError).toBeNull();
  });
});

// ── Regressions: clarificationSlice CC refactor (t/4086) ───

describe('clarificationSlice CC-refactor regressions', () => {
  it('undefined statement from pipeline sets debateError without TypeError (t/4086)', async () => {
    // Regression: deliverOpeningResult crashed when assembleOpeningPipelineResult returned
    // statement: undefined — the error-message template called .trim() on undefined even
    // though the !statement guard short-circuited the condition.
    const { runOpeningPipelineWithRepair, assembleOpeningPipelineResult } = await import('@lib/debate/turnPipeline');
    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValueOnce({ stage_diagnostics: [] });
    vi.mocked(assembleOpeningPipelineResult).mockReturnValueOnce({
      statement: undefined as any,
      taxonomyRefs: [],
      meta: { key_assumptions: [], my_claims: [], turn_symbols: [], policy_refs: [] },
    } as any);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist'],
      topic: { original: 'Test', refined: null, final: 'Test topic' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    // Must not throw a TypeError — must resolve with a controlled debateError.
    // The "empty or too short" error propagates through generateSingleSpeakerOpening's
    // catch as a terminal_error; finalizeOpeningStatements sets "Opening statements failed".
    await expect(useDebateStore.getState().runOpeningStatements()).resolves.toBeUndefined();

    const state = useDebateStore.getState();
    expect(state.debateError).toBeTruthy();
    expect(state.debateError).toMatch(/Opening statements failed/);
    expect(state.debateGenerating).toBeNull();

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
    vi.mocked(assembleOpeningPipelineResult).mockReturnValue({} as any);
  });

  it('daily-limit during opening preserves DAILY_LIMIT_MESSAGE — not overwritten by finalizeOpeningStatements (t/4086)', async () => {
    // Regression: runOpeningRetryLoop returned 'non_retryable' for daily_limit, and
    // finalizeOpeningStatements would overwrite debateError with a generic failure message.
    // The guard (isStillValid() && !get().dailyLimitPaused) prevents that overwrite.
    const { runOpeningPipelineWithRepair } = await import('@lib/debate/turnPipeline');
    const dailyLimitError = Object.assign(
      new Error('Daily AI usage limit reached'),
      { httpStatus: 429, limitType: 'tokens_per_day' },
    );
    vi.mocked(runOpeningPipelineWithRepair).mockRejectedValue(dailyLimitError);

    const session = makeSession({
      phase: 'opening',
      active_povers: ['accelerationist', 'safetyist'],
      topic: { original: 'Test', refined: null, final: 'Test topic' },
    });
    useDebateStore.setState({ activeDebate: session as any, debateModel: 'gemini-2.0-flash' });

    await useDebateStore.getState().runOpeningStatements();

    const state = useDebateStore.getState();
    expect(state.dailyLimitPaused).toBe(true);
    // Must still contain "Daily" — must NOT be overwritten with "Opening statements failed for …"
    expect(state.debateError).toMatch(/Daily/i);
    expect(state.debateError).not.toMatch(/Opening statements failed/);

    vi.mocked(runOpeningPipelineWithRepair).mockResolvedValue({});
  });
});

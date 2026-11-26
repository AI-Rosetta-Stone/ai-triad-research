// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { runModeratorSelection, executeTurnWithRetry, parseDialecticalDiagnostic } from './orchestration.js';
import type {
  ModeratorSelectionInput,
  ModeratorSelectionCallbacks,
  TurnRetryInput,
  TurnRetryCallbacks,
} from './orchestration.js';
import type { TranscriptEntry, TurnPipelineResult, TaxonomyRef } from './types.js';
import type { TurnPipelineInput } from './turnPipeline.js';
import type { PoverResponseMeta } from './helpers.js';
import * as moderatorModule from './moderator.js';
const { initModeratorState } = moderatorModule;

// ── Shared helpers ──────────────────────────────────────

function makeTranscriptEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: `te-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    type: 'statement',
    speaker: 'accelerationist',
    content: 'Test statement content about AI governance.',
    taxonomy_refs: [],
    ...overrides,
  };
}

function makePoverInfo() {
  return {
    accelerationist: { label: 'Accelerationist', pov: 'acc' },
    safetyist: { label: 'Safetyist', pov: 'saf' },
    skeptic: { label: 'Skeptic', pov: 'skp' },
  };
}

function makeBaseModeratorInput(
  overrides: Partial<ModeratorSelectionInput> = {},
): ModeratorSelectionInput {
  return {
    round: 3,
    phase: 'argumentation',
    activePovers: ['accelerationist', 'safetyist', 'skeptic'],
    totalRounds: 10,
    model: 'test-model',
    transcript: [],
    poverInfo: makePoverInfo(),
    ...overrides,
  };
}

function makeBaseModeratorCallbacks(
  generateResponse: string = JSON.stringify({ responder: 'safetyist', focus_point: 'Test focus', addressing: 'accelerationist', agreement_detected: false }),
): ModeratorSelectionCallbacks {
  return {
    generate: vi.fn().mockResolvedValue(generateResponse),
    addEntry: vi.fn().mockReturnValue('entry-id-1'),
    progress: vi.fn(),
    warn: vi.fn(),
    formatEdgeContext: vi.fn().mockReturnValue({ text: '', edges_used: [] }),
  };
}

function makePipelineResult(overrides: Partial<TurnPipelineResult> = {}): TurnPipelineResult {
  return {
    brief: {
      situation_assessment: 'test situation',
      key_claims_to_address: [],
      opponent_commitments: [],
    },
    plan: {
      strategic_goal: 'test goal',
      planned_moves: [{ move: 'ASSERT', target: 'safetyist', detail: 'test' }],
      argument_sketch: 'test sketch',
      target_nodes: [],
    },
    draft: {
      statement: 'This is a substantive test statement with multiple sentences. It covers the core argument about AI governance and regulation. The approach requires careful analysis of evidence. We must consider all stakeholders in this debate.',
      claim_sketches: [{ claim: 'AI regulation requires balance', targets: ['safetyist'] }],
      move_types: [{ move: 'ASSERT', target: 'safetyist', detail: 'test' }],
      disagreement_type: 'EMPIRICAL',
    },
    cite: {
      taxonomy_refs: [{ node_id: 'acc-B-001', relevance: 'This node directly supports the governance argument by specifying accountability mechanisms.' }],
      policy_refs: [],
      grounding_confidence: 0.8,
    },
    stage_diagnostics: [
      { stage: 'brief', elapsed_ms: 100, prompt_chars: 500, response_chars: 200, raw_response: '' },
      { stage: 'plan', elapsed_ms: 150, prompt_chars: 600, response_chars: 250, raw_response: '' },
      { stage: 'draft', elapsed_ms: 200, prompt_chars: 700, response_chars: 300, raw_response: 'draft response' },
      { stage: 'cite', elapsed_ms: 100, prompt_chars: 400, response_chars: 150, raw_response: '' },
    ],
    total_time_ms: 550,
    ...overrides,
  };
}

function makeAssembledResult() {
  return {
    statement: 'This is a substantive test statement with multiple sentences. It covers the core argument about AI governance and regulation. The approach requires careful analysis of evidence. We must consider all stakeholders in this debate.',
    taxonomyRefs: [{ node_id: 'acc-B-001', relevance: 'This node directly supports the governance argument by specifying accountability mechanisms.' }] as TaxonomyRef[],
    meta: {
      move_types: [{ move: 'ASSERT', target: 'safetyist', detail: 'test' }],
      disagreement_type: 'EMPIRICAL',
      my_claims: [{ claim: 'AI regulation requires balance', targets: ['safetyist'] }],
    } as PoverResponseMeta,
  };
}

function makePassingJudge() {
  return vi.fn().mockResolvedValue(JSON.stringify({
    advances: true,
    advancement_reason: 'Makes a clear new argument',
    clarifies_taxonomy: [],
    weaknesses: [],
    quality_score: 0.85,
    recommend: 'pass',
  }));
}

function makeBasePipelineInput(): TurnPipelineInput {
  return {
    label: 'Accelerationist',
    pov: 'accelerationist',
    personality: 'Bold, technology-optimistic',
    topic: 'AI governance frameworks',
    taxonomyContext: '',
    commitmentContext: '',
    establishedPoints: '',
    edgeContext: '',
    concessionHint: '',
    recentTranscript: 'Safetyist: We need strict regulation of AI systems.',
    focusPoint: 'regulation approach',
    addressing: 'Safetyist',
    phase: 'argumentation',
    priorMoves: ['REBUT'],
    turnsSinceLastConcession: 3,
    priorRefs: [],
    availablePovNodeIds: [],
    model: 'test-model',
    skipPreCheck: true,
  };
}

function makeBaseTurnRetryInput(overrides: Partial<TurnRetryInput> = {}): TurnRetryInput {
  return {
    pipelineInput: makeBasePipelineInput(),
    model: 'test-model',
    speaker: 'accelerationist',
    round: 3,
    priorTurns: [],
    recentTurns: [],
    knownNodeIds: new Set(['acc-B-001', 'saf-D-002']),
    policyIds: new Set(['pol-001']),
    ...overrides,
  };
}

function makeBaseTurnRetryCallbacks(
  pipelineResult: TurnPipelineResult = makePipelineResult(),
  assembled = makeAssembledResult(),
): TurnRetryCallbacks {
  return {
    runPipeline: vi.fn().mockResolvedValue(pipelineResult),
    assembleResult: vi.fn().mockReturnValue(assembled),
    callJudge: makePassingJudge(),
  };
}

// ═══════════════════════════════════════════════════════════
// runModeratorSelection
// ═══════════════════════════════════════════════════════════

describe('runModeratorSelection', () => {
  it('normalizes complete Talmudic dialectical diagnostics', () => {
    expect(parseDialecticalDiagnostic({
      focused_crux: 'Whether oversight or capture caused the failure',
      disagreement_type: 'CAUSAL',
      premise_under_examination: 'More rules necessarily produce more safety',
      distinction_or_analogy_tested: 'Regulatory capture versus effective oversight',
      unresolved_outcome: 'Independent evidence about enforcement quality is needed',
    }, 'fallback')).toEqual({
      focused_crux: 'Whether oversight or capture caused the failure',
      disagreement_type: 'causal',
      premise_under_examination: 'More rules necessarily produce more safety',
      distinction_or_analogy_tested: 'Regulatory capture versus effective oversight',
      unresolved_outcome: 'Independent evidence about enforcement quality is needed',
    });
  });

  it('uses safe fallbacks for incomplete Talmudic diagnostics', () => {
    expect(parseDialecticalDiagnostic({ disagreement_type: 'invented-type' }, '  Fallback crux  ')).toEqual({
      focused_crux: 'Fallback crux',
      disagreement_type: 'unclear',
      premise_under_examination: null,
      distinction_or_analogy_tested: null,
      unresolved_outcome: null,
    });
  });

  it('returns parsed diagnostics from a Talmudic moderator selection', async () => {
    const input = makeBaseModeratorInput({
      moderatorMode: 'talmudic',
      transcript: [makeTranscriptEntry({ speaker: 'accelerationist' })],
    });
    const callbacks = makeBaseModeratorCallbacks(JSON.stringify({
      responder: 'safetyist',
      addressing: 'accelerationist',
      focus_point: 'Test the regulatory analogy',
      agreement_detected: false,
      dialectical_diagnostic: {
        focused_crux: 'Whether aviation regulation is analogous to AI regulation',
        disagreement_type: 'definitional',
        premise_under_examination: 'Both industries have comparable failure modes',
        distinction_or_analogy_tested: 'Aviation certification versus AI deployment review',
        unresolved_outcome: 'Comparable enforcement evidence is still needed',
      },
    }));

    const result = await runModeratorSelection(input, callbacks);

    expect(result.selectionResult.dialectical_diagnostic).toEqual({
      focused_crux: 'Whether aviation regulation is analogous to AI regulation',
      disagreement_type: 'definitional',
      premise_under_examination: 'Both industries have comparable failure modes',
      distinction_or_analogy_tested: 'Aviation certification versus AI deployment review',
      unresolved_outcome: 'Comparable enforcement evidence is still needed',
    });
  });

  it('returns valid result with modState and healthScore when AI returns valid JSON', async () => {
    // Give accelerationist the last statement so the fallback alternation won't pick it,
    // and the AI response for 'safetyist' will be honoured.
    const transcript = [
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'skeptic', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
    ];
    const input = makeBaseModeratorInput({ transcript });
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'safetyist', focus_point: 'Test focus', addressing: 'accelerationist', agreement_detected: false }),
    );

    const result = await runModeratorSelection(input, callbacks);

    expect(result.modState).toBeDefined();
    expect(result.healthScore).toBeDefined();
    expect(result.healthScore.value).toBeGreaterThanOrEqual(0);
    expect(result.healthScore.value).toBeLessThanOrEqual(1);
    // accelerationist spoke last — fallback alternation avoids it, so safetyist is valid
    expect(result.responder).toBe('safetyist');
    expect(result.focusPoint).toBe('Test focus');
    expect(result.addressing).toBe('accelerationist');
    expect(result.agreementDetected).toBe(false);
    expect(result.earlyReturn).toBe(false);
    expect(callbacks.generate).toHaveBeenCalledOnce();
  });

  it('falls back to least-recently-spoken speaker when AI returns unparseable response', async () => {
    const transcript = [
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'skeptic', type: 'statement' }),
    ];
    const input = makeBaseModeratorInput({ transcript });
    const callbacks = makeBaseModeratorCallbacks('this is not valid json at all!!!');

    const result = await runModeratorSelection(input, callbacks);

    expect(result.selectionParseError).toBeDefined();
    // Result should still be a valid active pover
    expect(['accelerationist', 'safetyist', 'skeptic']).toContain(result.responder);
    expect(result.earlyReturn).toBe(false);
    expect(callbacks.warn).toHaveBeenCalled();
  });

  it('skips AI call (deterministic) when phase is concluding and a synthesis target exists', async () => {
    // Set up a moderator state where no one has a COMMIT yet, so getConcludingResponder
    // returns the first pover in transcript order.
    const modState = initModeratorState(10, ['accelerationist', 'safetyist', 'skeptic']);
    modState.phase = 'concluding';
    modState.round = 8;
    // No COMMIT interventions recorded, so getConcludingResponder will return a target.

    const transcript = [
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
    ];

    const input = makeBaseModeratorInput({
      phase: 'concluding',
      round: 8,
      transcript,
      existingModState: modState,
    });

    // The generate callback should be called for the COMMIT intervention generation,
    // not the selection step — but we mock it to return a valid intervention text.
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ text: 'Please provide your final commitment on this matter.' }),
    );

    const result = await runModeratorSelection(input, callbacks);

    // The COMMIT path fires — responder is the synthesis target from getConcludingResponder
    expect(['accelerationist', 'safetyist', 'skeptic']).toContain(result.responder);
    // In the concluding+COMMIT path, the selection prompt is never built
    expect(result.diagnostics.selectionPrompt).toBe('');
  });

  it('computes correct turn counts from transcript entries', async () => {
    // Build a transcript where accelerationist has 3 turns, safetyist has 1, skeptic has 0
    const transcript: TranscriptEntry[] = [
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'moderator', type: 'intervention' }),  // should not count
      makeTranscriptEntry({ speaker: 'system', type: 'system' as 'statement' }),   // should not count
    ];

    const input = makeBaseModeratorInput({
      round: 5,
      transcript,
    });

    // The generate response picks 'skeptic' (fewest turns)
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'skeptic', focus_point: 'Address key claims', addressing: 'general', agreement_detected: false }),
    );

    const result = await runModeratorSelection(input, callbacks);

    // Skeptic has 0 turns (< threshold 1) — participation floor forces skeptic
    expect(result.responder).toBe('skeptic');
  });

  it('participation floor force-selects severely underrepresented speaker', async () => {
    // accelerationist: 6, skeptic: 1, safetyist: 5 → mean=4, threshold=max(1,floor(2))=2
    // skeptic (1) < threshold (2) → force-selected
    const transcript: TranscriptEntry[] = [
      ...Array.from({ length: 6 }, () => makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' })),
      makeTranscriptEntry({ speaker: 'skeptic', type: 'statement' }),
      ...Array.from({ length: 5 }, () => makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' })),
    ];

    const input = makeBaseModeratorInput({ round: 5, transcript });
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'accelerationist', focus_point: 'Continue analysis', addressing: 'general', agreement_detected: false }),
    );

    const result = await runModeratorSelection(input, callbacks);
    expect(result.responder).toBe('skeptic');
  });

  it('participation floor does not override when speakers are roughly balanced', async () => {
    // accelerationist: 4, skeptic: 3, safetyist: 5 → mean=4, threshold=max(1,floor(2))=2
    // skeptic (3) >= threshold (2) → no override, AI selection stands
    const transcript: TranscriptEntry[] = [
      ...Array.from({ length: 4 }, () => makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' })),
      ...Array.from({ length: 5 }, () => makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' })),
      ...Array.from({ length: 3 }, () => makeTranscriptEntry({ speaker: 'skeptic', type: 'statement' })),
    ];

    const input = makeBaseModeratorInput({ round: 5, transcript });
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'accelerationist', focus_point: 'Continue analysis', addressing: 'general', agreement_detected: false }),
    );

    const result = await runModeratorSelection(input, callbacks);
    // AI picked accelerationist, and no floor override fires — accelerationist selected
    expect(result.responder).toBe('accelerationist');
  });

  it('handles empty argument network and convergence signals without error', async () => {
    const input = makeBaseModeratorInput({
      argumentNetwork: undefined,
      convergenceSignals: undefined,
      unansweredLedger: undefined,
    });

    const callbacks = makeBaseModeratorCallbacks();

    const result = await runModeratorSelection(input, callbacks);

    expect(result).toBeDefined();
    expect(result.modState).toBeDefined();
    expect(result.healthScore).toBeDefined();
    expect(result.diagnostics.anContextLength).toBe(0);
    expect(result.diagnostics.qbafContextLength).toBe(0);
  });

  it('sets earlyReturn=true and adds system entry when agreement_detected passes all gates', async () => {
    // To pass all 4 agreement gates we need:
    // Gate 1: roundsCompleted >= 4 (need >= 4*3 = 12 statement entries for 3 povers)
    // Gate 2: phase === 'concluding'
    // Gate 3: >=2 debaters with concessions
    // Gate 4: no unanswered claims
    //
    // BUT: phase='concluding' triggers getConcludingResponder() which skips the
    // AI call unless all speakers already have COMMIT interventions. Seed modState
    // with COMMIT entries so getConcludingResponder returns null and the AI path runs.

    const statements: TranscriptEntry[] = Array.from({ length: 15 }, (_, i) => {
      const speakers = ['accelerationist', 'safetyist', 'skeptic'] as const;
      return makeTranscriptEntry({
        id: `te-${i}`,
        speaker: speakers[i % 3],
        type: 'statement',
      });
    });

    const modState = initModeratorState(10, ['accelerationist', 'safetyist', 'skeptic']);
    for (const s of ['accelerationist', 'safetyist', 'skeptic']) {
      modState.intervention_history.push({
        round: 5,
        move: 'COMMIT' as never,
        target: s,
        focus: 'Final commitment',
        text: 'commit text',
        reasoning: 'synthesis phase',
        family: 'synthesis' as never,
      });
    }

    const input = makeBaseModeratorInput({
      phase: 'concluding',
      round: 8,
      transcript: statements,
      existingModState: modState,
      commitments: {
        accelerationist: { asserted: ['claim-1'], conceded: ['point-1'], challenged: [] },
        safetyist: { asserted: ['claim-2'], conceded: ['point-2'], challenged: [] },
        skeptic: { asserted: ['claim-3'], conceded: [], challenged: [] },
      },
      unansweredLedger: [],
    });

    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({
        responder: 'safetyist',
        focus_point: 'Summarize areas of agreement',
        addressing: 'general',
        agreement_detected: true,
      }),
    );

    const result = await runModeratorSelection(input, callbacks);

    expect(result.agreementDetected).toBe(true);
    expect(result.earlyReturn).toBe(true);
    expect(callbacks.addEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', speaker: 'system' }),
    );
  });

  it('overrides agreement_detected when phase is not concluding (gate 2)', async () => {
    // Build enough statements to pass gate 1, but phase = 'argumentation'
    const statements: TranscriptEntry[] = Array.from({ length: 15 }, (_, i) => {
      const speakers = ['accelerationist', 'safetyist', 'skeptic'] as const;
      return makeTranscriptEntry({ id: `te-${i}`, speaker: speakers[i % 3], type: 'statement' });
    });

    const input = makeBaseModeratorInput({
      phase: 'argumentation',
      round: 5,
      transcript: statements,
      commitments: {
        accelerationist: { asserted: [], conceded: ['point-1'], challenged: [] },
        safetyist: { asserted: [], conceded: ['point-2'], challenged: [] },
        skeptic: { asserted: [], conceded: [], challenged: [] },
      },
    });

    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'safetyist', focus_point: 'Focus', addressing: 'general', agreement_detected: true }),
    );

    const result = await runModeratorSelection(input, callbacks);

    // Gate 2 rejects it — argumentation phase cannot detect agreement
    expect(result.agreementDetected).toBe(false);
    expect(result.earlyReturn).toBe(false);
  });

  it('passes through diagnostics fields (prompt, response, elapsed, context lengths)', async () => {
    const input = makeBaseModeratorInput({
      argumentNetwork: { nodes: [], edges: [] },
    });

    const callbacks = makeBaseModeratorCallbacks();

    const result = await runModeratorSelection(input, callbacks);

    expect(result.diagnostics).toBeDefined();
    expect(typeof result.diagnostics.selectionPrompt).toBe('string');
    expect(typeof result.diagnostics.selectionResponse).toBe('string');
    expect(typeof result.diagnostics.selectionElapsed).toBe('number');
    expect(typeof result.diagnostics.edgeContextLength).toBe('number');
    expect(typeof result.diagnostics.anContextLength).toBe('number');
    expect(typeof result.diagnostics.qbafContextLength).toBe('number');
    // Prompt must be non-empty (selection was called)
    expect(result.diagnostics.selectionPrompt.length).toBeGreaterThan(0);
  });

  it('enforces turn alternation — never returns the last speaker when alternatives exist', async () => {
    // Only accelerationist and safetyist; last statement was by safetyist
    const transcript = [
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
    ];
    const input = makeBaseModeratorInput({
      activePovers: ['accelerationist', 'safetyist'],
      transcript,
      poverInfo: {
        accelerationist: { label: 'Accelerationist', pov: 'acc' },
        safetyist: { label: 'Safetyist', pov: 'saf' },
      },
    });

    // Deliberately pick the last speaker
    const callbacks = makeBaseModeratorCallbacks(
      JSON.stringify({ responder: 'safetyist', focus_point: 'Elaborate on safety', addressing: 'accelerationist', agreement_detected: false }),
    );

    const result = await runModeratorSelection(input, callbacks);

    // Should alternate away from safetyist (the last speaker)
    expect(result.responder).toBe('accelerationist');
  });

  // ── CRUX_FOCUS catch parity (t/3778) ──────────────────────

  it('CRUX_FOCUS: round does not throw when intervention block throws — calls warn and degrades gracefully', async () => {
    // Arrange a crux tracker entry that will trigger detectCruxFocusTrigger:
    // state=engaged, identified_turn=3, round=5 → roundsEngaged=2 (≥ threshold).
    const cruxEntry = {
      id: 'crux-parity-test',
      description: 'Whether alignment scales with capability',
      identified_turn: 3,
      state: 'engaged',
      disagreement_type: 'empirical',
      attacking_claim_ids: [],
      speakers_involved: ['accelerationist', 'safetyist'] as ('accelerationist' | 'safetyist' | 'skeptic' | 'user')[],
    };
    const modState = initModeratorState(10, ['accelerationist', 'safetyist', 'skeptic']);
    modState.phase = 'argumentation';
    modState.rounds_since_last_intervention = 4;

    const input = makeBaseModeratorInput({
      round: 5,
      phase: 'argumentation',
      cruxTracker: [cruxEntry],
      existingModState: modState,
      transcript: [
        makeTranscriptEntry({ speaker: 'accelerationist' }),
        makeTranscriptEntry({ speaker: 'safetyist' }),
      ],
    });

    const callbacks = makeBaseModeratorCallbacks();
    // Spy on validateRecommendation to throw — exercises the catch path directly.
    const validateSpy = vi.spyOn(moderatorModule, 'validateRecommendation')
      .mockImplementationOnce(() => { throw new TypeError('Simulated CRUX_FOCUS failure'); });

    // Should not throw — catch block must degrade gracefully.
    await expect(runModeratorSelection(input, callbacks)).resolves.toBeDefined();

    validateSpy.mockRestore();

    // warn must have been called with the error (catch block fired).
    expect(callbacks.warn).toHaveBeenCalledWith(
      'Moderator CRUX_FOCUS generation',
      expect.any(TypeError),
      'Proceeding without CRUX_FOCUS intervention',
    );
  });

  // ── CRUX_FOCUS happy path (t/3779) ────────────────────────

  it('CRUX_FOCUS: intervention fires (addEntry called) when all validation checks pass', async () => {
    const cruxEntry = {
      id: 'crux-happy-test',
      description: 'Whether alignment scales with capability',
      identified_turn: 3,
      state: 'engaged',
      disagreement_type: 'empirical',
      attacking_claim_ids: [],
      speakers_involved: ['accelerationist', 'safetyist'] as ('accelerationist' | 'safetyist' | 'skeptic' | 'user')[],
    };
    const modState = initModeratorState(10, ['accelerationist', 'safetyist', 'skeptic']);
    modState.phase = 'argumentation';
    modState.rounds_since_last_intervention = 4;

    const input = makeBaseModeratorInput({
      round: 5,
      phase: 'argumentation',
      cruxTracker: [cruxEntry],
      existingModState: modState,
      transcript: [
        makeTranscriptEntry({ speaker: 'accelerationist' }),
        makeTranscriptEntry({ speaker: 'safetyist' }),
      ],
    });

    const callbacks = makeBaseModeratorCallbacks();

    await expect(runModeratorSelection(input, callbacks)).resolves.toBeDefined();

    // addEntry called → CRUX_FOCUS intervention actually fired (not suppressed).
    expect(callbacks.addEntry).toHaveBeenCalled();
    // warn must NOT have been called — no error path taken.
    expect(callbacks.warn).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// executeTurnWithRetry
// ═══════════════════════════════════════════════════════════

describe('executeTurnWithRetry', () => {
  it('returns result on first attempt when pipeline and validation succeed', async () => {
    const pipelineResult = makePipelineResult();
    const assembled = makeAssembledResult();
    const input = makeBaseTurnRetryInput();
    const callbacks = makeBaseTurnRetryCallbacks(pipelineResult, assembled);

    const result = await executeTurnWithRetry(input, callbacks);

    expect(result.aborted).toBe(false);
    expect(result.statement).toBe(assembled.statement);
    expect(result.taxonomyRefs).toEqual(assembled.taxonomyRefs);
    expect(result.validation).toBeDefined();
    expect(result.validation.outcome).not.toBe('skipped');
    expect(result.attempts).toHaveLength(1);
    expect(callbacks.runPipeline).toHaveBeenCalledOnce();
  });

  it('retries pipeline on failure and returns on next success', async () => {
    const pipelineResult = makePipelineResult();
    const assembled = makeAssembledResult();
    const input = makeBaseTurnRetryInput({
      validationConfig: { enabled: true, maxRetries: 2 },
    });

    // First pipeline call fails, second succeeds
    const runPipeline = vi.fn()
      .mockRejectedValueOnce(new Error('JSON parse failed: unexpected token'))
      .mockResolvedValue(pipelineResult);

    const callbacks: TurnRetryCallbacks = {
      runPipeline,
      assembleResult: vi.fn().mockReturnValue(assembled),
      callJudge: makePassingJudge(),
    };

    const result = await executeTurnWithRetry(input, callbacks);

    expect(result.aborted).toBe(false);
    expect(result.statement).toBe(assembled.statement);
    // runPipeline was called twice: once failed, once succeeded
    expect(runPipeline).toHaveBeenCalledTimes(2);
  });

  it('breaks retry immediately on tokens_per_day limit error', async () => {
    const input = makeBaseTurnRetryInput({
      validationConfig: { enabled: true, maxRetries: 3 },
    });

    const tokenLimitError = Object.assign(new Error('tokens_per_day limit reached'), {
      limitType: 'tokens_per_day',
    });

    const runPipeline = vi.fn().mockRejectedValue(tokenLimitError);

    const callbacks: TurnRetryCallbacks = {
      runPipeline,
      assembleResult: vi.fn(),
      callJudge: makePassingJudge(),
    };

    // Should throw (pipeline failed and no result to return)
    await expect(executeTurnWithRetry(input, callbacks)).rejects.toThrow();

    // Should have stopped after exactly 1 attempt (not exhausted all maxRetries)
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('returns immediately with aborted=true when isAborted() returns true after pipeline', async () => {
    const pipelineResult = makePipelineResult();
    const assembled = makeAssembledResult();
    const input = makeBaseTurnRetryInput();

    const callbacks: TurnRetryCallbacks = {
      runPipeline: vi.fn().mockResolvedValue(pipelineResult),
      assembleResult: vi.fn().mockReturnValue(assembled),
      callJudge: makePassingJudge(),
      isAborted: vi.fn().mockReturnValue(true),
    };

    const result = await executeTurnWithRetry(input, callbacks);

    expect(result.aborted).toBe(true);
    expect(result.validation.outcome).toBe('skipped');
    expect(result.attempts).toHaveLength(0);
    // Judge should never have been called
    expect(callbacks.callJudge).not.toHaveBeenCalled();
  });

  it('tracks best attempt by score and does not regress to worse score on retry', async () => {
    const input = makeBaseTurnRetryInput({
      validationConfig: { enabled: true, maxRetries: 1 },
    });

    const goodPipelineResult = makePipelineResult();
    const weakPipelineResult = makePipelineResult();

    const goodAssembled = makeAssembledResult();
    const weakAssembled = {
      ...makeAssembledResult(),
      statement: 'Weak statement.',
    };

    // runPipeline is called twice: initial (good), then retry (weak via repair hints path)
    const runPipeline = vi.fn()
      .mockResolvedValueOnce(goodPipelineResult)
      .mockResolvedValueOnce(weakPipelineResult);

    const assembleResult = vi.fn()
      .mockReturnValueOnce(goodAssembled)
      .mockReturnValueOnce(weakAssembled);

    // First judge call returns high score (pass), second returns low score triggering retry,
    // then third call returns even lower score.
    // Actually: to trigger a retry we need outcome='retry'. Use a low quality_score on attempt 0.
    const callJudge = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        advances: true,
        advancement_reason: 'good argument',
        clarifies_taxonomy: [],
        weaknesses: ['Needs more specificity'],
        quality_score: 0.45,
        recommend: 'retry',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        advances: true,
        advancement_reason: 'test',
        clarifies_taxonomy: [],
        weaknesses: [],
        quality_score: 0.35,
        recommend: 'retry',
      }));

    const callbacks: TurnRetryCallbacks = {
      runPipeline,
      assembleResult,
      callJudge,
    };

    const result = await executeTurnWithRetry(input, callbacks);

    // Best attempt (first, score 0.45) should win over the regressed retry (0.35)
    expect(result.aborted).toBe(false);
    // The best statement is from attempt 0
    expect(result.statement).toBe(goodAssembled.statement);
    expect(result.attempts.length).toBeGreaterThanOrEqual(1);
  });

  it('throws when pipeline fails on every attempt', async () => {
    const input = makeBaseTurnRetryInput({
      validationConfig: { enabled: true, maxRetries: 1 },
    });

    const callbacks: TurnRetryCallbacks = {
      runPipeline: vi.fn().mockRejectedValue(new Error('Persistent parse failure')),
      assembleResult: vi.fn(),
      callJudge: makePassingJudge(),
    };

    await expect(executeTurnWithRetry(input, callbacks)).rejects.toThrow('Persistent parse failure');
  });

  it('returns single attempt with full validation when validation outcome is accept', async () => {
    const pipelineResult = makePipelineResult();
    const assembled = makeAssembledResult();
    const input = makeBaseTurnRetryInput({
      validationConfig: { enabled: true, maxRetries: 2 },
    });

    const callJudge = vi.fn().mockResolvedValue(JSON.stringify({
      advances: true,
      advancement_reason: 'Solid argument',
      clarifies_taxonomy: [],
      weaknesses: [],
      quality_score: 0.90,
      recommend: 'pass',
    }));

    const callbacks: TurnRetryCallbacks = {
      runPipeline: vi.fn().mockResolvedValue(pipelineResult),
      assembleResult: vi.fn().mockReturnValue(assembled),
      callJudge,
    };

    const result = await executeTurnWithRetry(input, callbacks);

    expect(result.aborted).toBe(false);
    expect(result.attempts).toHaveLength(1);
    // Only one pipeline run — no retry needed
    expect(callbacks.runPipeline).toHaveBeenCalledOnce();
    expect(result.validation.outcome).not.toBe('retry');
  });

  it('returns pipelineResult reference from the best attempt', async () => {
    const pipelineResult = makePipelineResult();
    const assembled = makeAssembledResult();
    const input = makeBaseTurnRetryInput();
    const callbacks = makeBaseTurnRetryCallbacks(pipelineResult, assembled);

    const result = await executeTurnWithRetry(input, callbacks);

    expect(result.pipelineResult).toBeDefined();
    expect(result.pipelineResult.total_time_ms).toBe(550);
    expect(result.pipelineResult.stage_diagnostics).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// t/784: concluding-phase COMMIT does not repeat an earlier COMMIT's opening
// ═══════════════════════════════════════════════════════════

describe('runModeratorSelection concluding COMMIT (t/784)', () => {
  it("passes the earlier COMMIT's opening sentence into the next COMMIT prompt as not-to-reuse", async () => {
    const RECAP = 'This debate has focused on how artificial intelligence safety rules affect market fairness and public safety.';
    const transcript = [
      makeTranscriptEntry({ speaker: 'accelerationist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'safetyist', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'skeptic', type: 'statement' }),
      makeTranscriptEntry({ speaker: 'moderator', type: 'intervention', content: `${RECAP} The Accelerationist conceded X.`, intervention_metadata: { move: 'COMMIT' } as never }),
    ];
    const input = makeBaseModeratorInput({ phase: 'concluding', round: 15, transcript });
    const callbacks = makeBaseModeratorCallbacks(JSON.stringify({ text: 'Safetyist, state your final position now.' }));

    await runModeratorSelection(input, callbacks);

    const prompts = (callbacks.generate as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[0]));
    const commitPrompt = prompts.find(p => p.includes('Move: COMMIT'));
    expect(commitPrompt).toBeDefined();
    expect(commitPrompt).toContain('Do NOT reuse or paraphrase them');
    expect(commitPrompt).toContain(`- "${RECAP}"`);
  });
});

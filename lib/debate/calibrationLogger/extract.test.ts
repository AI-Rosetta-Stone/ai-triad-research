// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import type { DebateSession } from '../types.js';
import { extractCalibrationData } from './extract.js';
import type { CalibrationDataPoint } from './schema.js';
import { computeConvergenceWithCensoring, computeSituationAlignment, computeAifB5Metrics, AIF_B5_METRIC_DEF_VERSION } from './extract-metrics.js';
import type { ArgumentNetworkNode } from '../types.js';
import type { ConflictFile } from '../taxonomyLoader.js';
import type { ConvergenceSignals } from '../types/convergence.js';

// ── Minimal session factory ───────────────────────────────────────────────────

function makeSession(overrides: Record<string, unknown> = {}): DebateSession {
  return {
    id: 'test-debate',
    title: 'Test debate',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase: 'closed',
    topic: { original: 'AI policy', refined: null, final: 'AI policy' },
    source_type: 'topic',
    source_ref: '',
    source_content: '',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    user_is_pover: false,
    transcript: [],
    context_summaries: [],
    debate_model: 'gemini-2.5-flash',
    ...overrides,
  } as unknown as DebateSession;
}

function sessionWithPhase(
  exit_reason: string,
  force_active: boolean,
  transcriptEntries: { content: string }[] = [],
): DebateSession {
  return makeSession({
    transcript: transcriptEntries,
    adaptive_staging_diagnostics: {
      enabled: true,
      phases: [{ phase: 'synthesis', rounds: [1, 2, 3], exit_reason, force_active }],
      signal_telemetry: [],
      regressions: [],
      total_predicate_evaluations: 3,
      confidence_deferrals: 0,
      vetoes_fired: 0,
    },
  });
}

// ── Golden-set: termination_reason derivation (t/1671#8) ─────────────────────
//
// All real exit_reason strings from phaseTransitions.ts mapped to expected classification.
// Derived from force_active boolean stamped at source — not prose regex.

describe('extractCalibrationData termination_reason golden set', () => {
  it.each([
    // force_active=true → cap-forced
    ['Catastrophic health collapse (< 0.10)', true, 'situation_cap'],
    ['Sustained health decline (< 0.20 for 3 rounds)', true, 'situation_cap'],
    ['Network hard cap (500 >= 500)', true, 'situation_cap'],
    ['Max total rounds (10 >= 10)', true, 'max_iterations'],
    ['Max total rounds (15 >= 15)', true, 'max_iterations'],
    // t/4753: widened from /Max total rounds/i to /^Max /i — these three per-phase
    // hard-cap exits (phaseTransitions.ts:692/750/816) were misclassified as
    // situation_cap before the fix; real message format included for each.
    ['Max thesis turns (limit reached)', true, 'max_iterations'],
    ['Max thesis turns (2 rounds × 3 speakers)', true, 'max_iterations'],
    ['Max exploration turns (limit reached)', true, 'max_iterations'],
    ['Max exploration turns (2 rounds × 3 speakers)', true, 'max_iterations'],
    ['Max synthesis turns (limit reached)', true, 'max_iterations'],
    ['Max synthesis turns (1 rounds × 3 speakers)', true, 'max_iterations'],
    ['API soft budget hit (80%)', true, 'situation_cap'],
    ['Debate is dead (recycling > 0.8 AND fatigue > 0.8)', true, 'situation_cap'],
    ['Synthesis stall (2 rounds, delta < 0.05, recycling > 0.5)', true, 'situation_cap'],
    // force_active=false → natural decision-point
    ['Saturation score 0.75 >= threshold 0.70', false, 'natural_conclusion'],
    ['Convergence 0.85 >= threshold 0.80', false, 'natural_conclusion'],
  ] as [string, boolean, string][])(
    'exit_reason=%s, force_active=%s → %s',
    (exit_reason, force_active, expected) => {
      const session = sessionWithPhase(exit_reason, force_active);
      const dp = extractCalibrationData(session, 'local');
      expect(dp.termination_reason).toBe(expected);
    },
  );

  it('api_ceiling: transcript content overrides force_active', () => {
    // force_active=true but transcript contains the api-ceiling marker
    const session = sessionWithPhase(
      'API hard ceiling hit (1000 >= 1000)',
      true,
      [{ content: 'API hard ceiling hit — debate terminated.' }],
    );
    const dp = extractCalibrationData(session, 'local');
    expect(dp.termination_reason).toBe('api_ceiling');
  });

  it('first_round_exit: no adaptive_staging_diagnostics, rounds=0 → first_round_exit', () => {
    // makeSession() has no transcript entries — rounds=0, triggers first_round_exit (t/3502)
    const dp = extractCalibrationData(makeSession(), 'local');
    expect(dp.termination_reason).toBe('first_round_exit');
  });

  it('first_round_exit: no adaptive_staging_diagnostics, rounds=1 → first_round_exit', () => {
    const session = makeSession({
      transcript: [{ type: 'statement', content: 'Opening argument.', speaker: 'accelerationist', taxonomy_refs: [] }],
    });
    const dp = extractCalibrationData(session, 'local');
    expect(dp.termination_reason).toBe('first_round_exit');
  });

  it('unknown preserved: no asd, rounds=2 → unknown (not first_round_exit)', () => {
    const session = makeSession({
      transcript: [
        { type: 'statement', content: 'Round 1.', speaker: 'accelerationist', taxonomy_refs: [] },
        { type: 'statement', content: 'Round 2.', speaker: 'safetyist', taxonomy_refs: [] },
      ],
    });
    const dp = extractCalibrationData(session, 'local');
    expect(dp.termination_reason).toBe('unknown');
  });

  it('unknown: phases[] present but force_active absent (legacy row, rounds=8+) → unknown', () => {
    // Must have rounds>1 so the first_round_exit guard does not fire (t/3502).
    const transcript = Array.from({ length: 8 }, (_, i) => ({
      type: 'statement' as const, content: `Round ${i + 1}.`,
      speaker: 'accelerationist', taxonomy_refs: [],
    }));
    const session = makeSession({
      transcript,
      adaptive_staging_diagnostics: {
        enabled: true,
        // No force_active field — legacy shape
        phases: [{ phase: 'synthesis', rounds: [1, 2, 3, 4, 5, 6, 7, 8], exit_reason: 'Old reason format' }],
        signal_telemetry: [],
        regressions: [],
        total_predicate_evaluations: 8,
        confidence_deferrals: 0,
        vetoes_fired: 0,
      },
    });
    const dp = extractCalibrationData(session, 'local');
    expect(dp.termination_reason).toBe('unknown');
  });

  // TL-required assertion (t/1671#9): prove that the LAST phases[] entry determines
  // termination_reason, not an earlier cap-forced phase.
  it('real converged debate: last phase entry force_active=false → natural_conclusion', () => {
    const session = makeSession({
      adaptive_staging_diagnostics: {
        enabled: true,
        phases: [
          // Earlier phase ended via a cap — must NOT influence the result
          { phase: 'exploration', rounds: [1, 2], exit_reason: 'Max exploration turns (limit reached)', force_active: true },
          // Final phase ended naturally — this determines termination_reason
          { phase: 'synthesis', rounds: [3, 4, 5], exit_reason: 'Convergence 0.85 >= threshold 0.80', force_active: false },
        ],
        signal_telemetry: [],
        regressions: [],
        total_predicate_evaluations: 5,
        confidence_deferrals: 0,
        vetoes_fired: 0,
      },
    });
    const dp = extractCalibrationData(session, 'local');
    expect(dp.termination_reason).toBe('natural_conclusion');
  });
});

// ── computeConvergenceWithCensoring ──────────────────────────────────────────

function makeEntry(
  termination_reason: CalibrationDataPoint['termination_reason'],
  value: number | null,
): CalibrationDataPoint {
  return { termination_reason, convergence_score_at_termination: value } as CalibrationDataPoint;
}

describe('computeConvergenceWithCensoring', () => {
  it('all completed: rate=0, metric_over_completed = mean', () => {
    const result = computeConvergenceWithCensoring(
      [makeEntry('natural_conclusion', 0.8), makeEntry('natural_conclusion', 0.6)],
      e => e.convergence_score_at_termination ?? null,
    );
    expect(result.censoring_rate).toBe(0);
    expect(result.n_completed).toBe(2);
    expect(result.n_censored).toBe(0);
    expect(result.n_unknown).toBe(0);
    expect(result.metric_over_completed).toBeCloseTo(0.7);
    expect(result.metric_over_all).toBeCloseTo(0.7);
  });

  it('all censored: rate=1, metric_over_completed=null, metric_over_all has values', () => {
    const result = computeConvergenceWithCensoring(
      [makeEntry('max_iterations', 0.4), makeEntry('situation_cap', 0.3)],
      e => e.convergence_score_at_termination ?? null,
    );
    expect(result.censoring_rate).toBe(1);
    expect(result.n_completed).toBe(0);
    expect(result.n_censored).toBe(2);
    expect(result.metric_over_completed).toBeNull();
    expect(result.metric_over_all).toBeCloseTo(0.35);
  });

  it('mixed: censoring_rate = n_censored / (n_completed + n_censored)', () => {
    const result = computeConvergenceWithCensoring(
      [
        makeEntry('natural_conclusion', 0.9),
        makeEntry('max_iterations', 0.5),
        makeEntry('api_ceiling', 0.4),
      ],
      e => e.convergence_score_at_termination ?? null,
    );
    expect(result.censoring_rate).toBeCloseTo(2 / 3);
    expect(result.n_completed).toBe(1);
    expect(result.n_censored).toBe(2);
    expect(result.metric_over_completed).toBeCloseTo(0.9);
    expect(result.metric_over_all).toBeCloseTo((0.9 + 0.5 + 0.4) / 3);
  });

  it('all unknown: rate=0, all metrics null, n_unknown reported', () => {
    const result = computeConvergenceWithCensoring(
      [makeEntry('unknown', 0.5), makeEntry(undefined, 0.3)],
      e => e.convergence_score_at_termination ?? null,
    );
    expect(result.censoring_rate).toBe(0);
    expect(result.n_unknown).toBe(2);
    expect(result.n_completed).toBe(0);
    expect(result.n_censored).toBe(0);
    expect(result.metric_over_completed).toBeNull();
    expect(result.metric_over_all).toBeNull();
  });

  it('null metric values excluded from mean but rows still counted', () => {
    const result = computeConvergenceWithCensoring(
      [makeEntry('natural_conclusion', null), makeEntry('natural_conclusion', 0.8)],
      e => e.convergence_score_at_termination ?? null,
    );
    expect(result.n_completed).toBe(2);
    expect(result.metric_over_completed).toBeCloseTo(0.8);
  });

  it('boolean selector coerced to 0/1', () => {
    const entries = [makeEntry('natural_conclusion', 0.8), makeEntry('natural_conclusion', 0.2)];
    const result = computeConvergenceWithCensoring(
      entries,
      e => (e.convergence_score_at_termination ?? 0) > 0.5,
    );
    expect(result.metric_over_completed).toBeCloseTo(0.5);
  });

  it('empty input: zero rate, all nulls', () => {
    const result = computeConvergenceWithCensoring([], () => null);
    expect(result.censoring_rate).toBe(0);
    expect(result.n_completed).toBe(0);
    expect(result.n_censored).toBe(0);
    expect(result.n_unknown).toBe(0);
    expect(result.metric_over_completed).toBeNull();
    expect(result.metric_over_all).toBeNull();
  });

  it('unknown rows excluded from denominator even when mixed with known rows', () => {
    const result = computeConvergenceWithCensoring(
      [
        makeEntry('natural_conclusion', 0.9),
        makeEntry('unknown', 0.5),  // should not affect rate
        makeEntry('max_iterations', 0.4),
      ],
      e => e.convergence_score_at_termination ?? null,
    );
    // denominator = 1 completed + 1 censored = 2 (unknown excluded)
    expect(result.censoring_rate).toBeCloseTo(1 / 2);
    expect(result.n_unknown).toBe(1);
  });
});

// ── computeSituationAlignment (t/2168) ───────────────────────────────────────

function makeTranscriptEntry(opts: {
  situationNodeIds?: string[];
  taxonomyRefs?: { node_id: string }[];
}): unknown {
  return {
    type: 'statement',
    speaker: 'accelerationist',
    content: 'test',
    taxonomy_refs: opts.taxonomyRefs ?? [],
    metadata: opts.situationNodeIds
      ? { injection_manifest: { situationNodeIds: opts.situationNodeIds } }
      : {},
  };
}

describe('computeSituationAlignment', () => {
  it('multi-turn repeated reference of same sit- ID counts as 1 — rate never exceeds 1', () => {
    // sit-001 injected once; referenced in 3 separate turns
    const session = makeSession({
      transcript: [
        makeTranscriptEntry({ situationNodeIds: ['sit-001'], taxonomyRefs: [{ node_id: 'sit-001' }] }),
        makeTranscriptEntry({ taxonomyRefs: [{ node_id: 'sit-001' }] }),
        makeTranscriptEntry({ taxonomyRefs: [{ node_id: 'sit-001' }] }),
      ],
    });
    const result = computeSituationAlignment(session, undefined);
    expect(result.sitNodesInjected).toBe(1);
    expect(result.sitNodesReferenced).toBe(1);  // distinct, not per-occurrence
    // rate = 1/1 = 1.0, not 3.0
  });

  it('non-injected sit- ref does not inflate sitNodesReferenced', () => {
    // sit-001 injected; sit-999 referenced but never injected
    const session = makeSession({
      transcript: [
        makeTranscriptEntry({ situationNodeIds: ['sit-001'] }),
        makeTranscriptEntry({ taxonomyRefs: [{ node_id: 'sit-999' }, { node_id: 'sit-001' }] }),
      ],
    });
    const result = computeSituationAlignment(session, undefined);
    expect(result.sitNodesInjected).toBe(1);
    expect(result.sitNodesReferenced).toBe(1);  // sit-999 excluded, sit-001 counted once
  });

  it('zero injected → sitNodesReferenced is 0 and cruxAlignment is null', () => {
    const session = makeSession({
      transcript: [makeTranscriptEntry({ taxonomyRefs: [{ node_id: 'sit-001' }] })],
    });
    const result = computeSituationAlignment(session, undefined);
    expect(result.sitNodesInjected).toBe(0);
    expect(result.sitNodesReferenced).toBe(0);
    expect(result.sitCruxAlignment).toBeNull();
  });

  it('two injected, one referenced → rate 0.5', () => {
    const session = makeSession({
      transcript: [
        makeTranscriptEntry({ situationNodeIds: ['sit-001', 'sit-002'] }),
        makeTranscriptEntry({ taxonomyRefs: [{ node_id: 'sit-001' }] }),
      ],
    });
    const result = computeSituationAlignment(session, undefined);
    expect(result.sitNodesInjected).toBe(2);
    expect(result.sitNodesReferenced).toBe(1);
  });
});

// ── computeAifB5Metrics (t/3715) ─────────────────────────────────────────────

function makeAnNode(id: string, speaker: string, round: number, ref: string): ArgumentNetworkNode {
  return {
    id,
    speaker,
    turn_number: round,
    claim_taxonomy_attribution: { primary_ref: ref },
  } as unknown as ArgumentNetworkNode;
}

function makeConflict(claimId: string, nodeA: string, nodeB: string): ConflictFile {
  return {
    claim_id: claimId,
    linked_taxonomy_nodes: [nodeA, nodeB],
  } as unknown as ConflictFile;
}

function makeSignal(outcome: 'taken' | 'missed' | 'none'): ConvergenceSignals {
  return {
    concession_opportunity: { strong_attacks_faced: 1, concession_used: outcome === 'taken', outcome },
  } as unknown as ConvergenceSignals;
}

describe('computeAifB5Metrics', () => {
  it('carries AIF_B5_METRIC_DEF_VERSION', () => {
    const result = computeAifB5Metrics([], [], undefined);
    expect(result.metric_def_version).toBe(AIF_B5_METRIC_DEF_VERSION);
  });

  it('zero nodes → crux_count 0, crux_set empty', () => {
    const result = computeAifB5Metrics([], [], undefined);
    expect(result.crux_count).toBe(0);
    expect(result.crux_set).toEqual([]);
  });

  it('total_turns = 0 (empty array) → convergence_score null, never NaN', () => {
    const result = computeAifB5Metrics([], [], []);
    expect(result.convergence_score).toBeNull();
  });

  it('total_turns = 0 (undefined signals) → convergence_score null', () => {
    const result = computeAifB5Metrics([], [], undefined);
    expect(result.convergence_score).toBeNull();
  });

  it('opposition spanning only 1 round → not a crux', () => {
    const nodes = [
      makeAnNode('n1', 'accelerationist', 2, 'acc-bel-001'),
      makeAnNode('n2', 'safetyist', 2, 'saf-bel-001'),
    ];
    const conflicts = [makeConflict('c1', 'acc-bel-001', 'saf-bel-001')];
    const result = computeAifB5Metrics(nodes, conflicts, []);
    expect(result.crux_count).toBe(0);
    expect(result.crux_set).toEqual([]);
  });

  it('opposition spanning ≥2 rounds → crux detected', () => {
    const nodes = [
      makeAnNode('n1', 'accelerationist', 1, 'acc-bel-001'),
      makeAnNode('n2', 'safetyist', 2, 'saf-bel-001'),
    ];
    const conflicts = [makeConflict('c1', 'acc-bel-001', 'saf-bel-001')];
    const result = computeAifB5Metrics(nodes, conflicts, []);
    expect(result.crux_count).toBe(1);
    expect(result.crux_set).toEqual(['c1']);
  });

  it('convergence_score: all taken → 1.0', () => {
    // Signal A = 2/2 = 1.0, Signal B = 1 - 0/2 = 1.0 → 0.5*1 + 0.5*1 = 1.0
    const signals = [makeSignal('taken'), makeSignal('taken')];
    const result = computeAifB5Metrics([], [], signals);
    expect(result.convergence_score).toBe(1.0);
  });

  it('convergence_score: all missed → 0', () => {
    // Signal A = 0/2 = 0, Signal B = 1 - 2/2 = 0 → 0
    const signals = [makeSignal('missed'), makeSignal('missed')];
    const result = computeAifB5Metrics([], [], signals);
    expect(result.convergence_score).toBe(0);
  });

  it('convergence_score: mixed signals → 0.5', () => {
    // 1 taken, 1 missed, 2 none (total 4)
    // Signal A = 1/4 = 0.25, Signal B = 1 - 1/4 = 0.75 → 0.5*0.25 + 0.5*0.75 = 0.5
    const signals = [makeSignal('taken'), makeSignal('missed'), makeSignal('none'), makeSignal('none')];
    const result = computeAifB5Metrics([], [], signals);
    expect(result.convergence_score).toBe(0.5);
  });
});

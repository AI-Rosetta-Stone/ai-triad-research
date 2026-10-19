// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Tests for the deterministic unsupported-figure post-check in synthesizeInquiry (t/4303).
 * Covers: positive fixture (check fires), negative arm (transcript supplies figure), and
 * question-token allowance (figure in question is allowed in result).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeInquiry } from './inquirySynthesis.js';
import type { AIAdapter } from './aiAdapter.js';
import type { DebateSession } from './types/session.js';
import type {
  GroundingEnvelope,
  ResolvedDerivation,
  StoredInquiryRequest,
  CalibrationEntry,
} from '../inquiry/schema.js';

// ── Mock flight recorder ──────────────────────────────────────────────────────

vi.mock('../flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn(),
}));

import { getGlobalRecorder } from '../flight-recorder/index.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeAdapter(responseJson: object): AIAdapter {
  return {
    generateText: vi.fn().mockResolvedValue(JSON.stringify(responseJson)),
  };
}

function makeSession(transcriptContent: string[] = []): DebateSession {
  return {
    id: 'test-session',
    title: 'Test Debate',
    created_at: '2026-10-19T00:00:00Z',
    updated_at: '2026-10-19T00:00:00Z',
    phase: 'closed',
    topic: { original: 'test', refined: null, final: 'test topic' },
    source_type: 'topic',
    source_ref: '',
    source_content: '',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    user_is_pover: false,
    transcript: transcriptContent.map((content, i) => ({
      id: `turn-${i}`,
      timestamp: '2026-10-19T00:00:00Z',
      type: 'statement' as const,
      speaker: 'accelerationist' as const,
      content,
      taxonomy_refs: [],
    })),
    context_summaries: [],
    argument_network: { nodes: [], edges: [] },
  } as unknown as DebateSession;
}

function makeGrounding(): GroundingEnvelope {
  return {
    anchorSituationId: 'sit-001',
    nodesByCamp: {
      acc: [{ nodeId: 'acc-beliefs-001', label: 'Acceleration risk node', camp: 'acc' }],
      saf: [{ nodeId: 'saf-beliefs-001', label: 'Safety alignment node', camp: 'saf' }],
    },
  };
}

function makeCalibration(): CalibrationEntry[] {
  return [{ metric: 'convergence_score', value: 0.6, trust: { verdict: 'trust', reason: 'natural conclusion' } }];
}

function makeDerivation(overrides: Partial<ResolvedDerivation> = {}): ResolvedDerivation {
  return {
    fidelity: 'standard',
    models: { debaters: 'model-a', evaluator: 'model-b' },
    rounds: 4,
    callBudget: 60,
    ...overrides,
  };
}

/** Base LLM response with no figures — used as a baseline and modified per test. */
function baseLlmResponse(headline?: string) {
  return {
    campVerdicts: [
      { camp: 'acc', verdict: 'Acceleration is broadly safe.', nodeIds: ['acc-beliefs-001'] },
      { camp: 'saf', verdict: 'Safety measures are paramount.', nodeIds: ['saf-beliefs-001'] },
    ],
    convergences: [
      { claim: 'Alignment work matters to both camps.', nodeIds: ['acc-beliefs-001'] },
    ],
    evidenceLayers: [
      { title: 'Empirical', role: 'Data grounding', solves: 'Factual disputes', sources: ['Source A'] },
    ],
    unresolvedGaps: [
      { description: 'Long-term societal impact remains unclear.', confidence: 'high' },
    ],
    singleRunCaveat: 'Single run result.',
    ...(headline !== undefined ? { synthesizedHeadline: headline } : {}),
  };
}

// ── Figure-check WARN filtering helper ───────────────────────────────────────

/** Collect every record() call for component 'inquiry-synthesis' at level 'warn'. */
function figureMisses(recordFn: ReturnType<typeof vi.fn>) {
  return (recordFn.mock.calls as Array<[{ type: string; component: string; level: string; message: string }]>)
    .map(([e]) => e)
    .filter(e => e.component === 'inquiry-synthesis' && e.level === 'warn');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('synthesizeInquiry — figure post-check (t/4303)', () => {
  let recordFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);
  });

  it('fires a WARN when headline contains a magnitude phrase not in transcript', async () => {
    // Positive fixture: "hundreds of thousands … annually" in headline,
    // no such token in the empty transcript or question.
    const question = 'What are the mortality risks of unaligned AI systems?';
    const headline = 'The debate reveals hundreds of thousands of deaths annually according to projections.';

    await synthesizeInquiry(
      makeSession([]), // empty transcript — no magnitude tokens
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse(headline)),
    );

    const misses = figureMisses(recordFn);
    expect(misses.length).toBeGreaterThan(0);
    // Both "hundreds" and "thousands" should each fire a miss
    const messages = misses.map(m => m.message);
    expect(messages.some(m => m.includes('synthesizedHeadline'))).toBe(true);
    expect(messages.some(m => m.includes('hundreds') || m.includes('thousands'))).toBe(true);
  });

  it('does NOT fire when the transcript supplies the figure cited in the headline', async () => {
    // Negative arm: transcript contains "700,000 deaths a year"; headline cites it.
    const question = 'What are the mortality risks of unaligned AI systems?';
    const headline = 'The Safetyist cited 700,000 deaths a year as the projected toll.';

    await synthesizeInquiry(
      makeSession(['The Safetyist argued that 700,000 deaths a year are plausible under current trajectories.']),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse(headline)),
    );

    const misses = figureMisses(recordFn);
    // 700000 (normalised) is in the corpus → no miss for that token
    expect(misses.filter(m => m.message.includes('700000') || m.message.includes('700,000'))).toHaveLength(0);
  });

  it('does NOT fire when the figure appears in the question', async () => {
    // Question-token allowance: "1,000" in question → "1000" in corpus → no WARN.
    const question = 'Is 1,000 AI-related deaths a year a reasonable policy threshold?';
    const headline = 'Camps diverge on whether 1,000 deaths constitutes a meaningful threshold.';

    await synthesizeInquiry(
      makeSession([]), // empty transcript
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse(headline)),
    );

    const misses = figureMisses(recordFn);
    expect(misses.filter(m => m.message.includes('1000') || m.message.includes('1,000'))).toHaveLength(0);
  });
});

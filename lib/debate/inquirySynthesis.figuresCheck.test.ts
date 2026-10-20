// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Tests for the deterministic unsupported-figure post-check in synthesizeInquiry (t/4303).
 * Covers: compound magnitude phrases (t/4303 fix), node-ID citation stripping (t/4303 fix),
 * negative arm (transcript supplies figure), and question-token allowance.
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
function baseLlmResponse(overrides: {
  headline?: string;
  verdict?: string;
} = {}) {
  return {
    campVerdicts: [
      {
        camp: 'acc',
        verdict: overrides.verdict ?? 'Acceleration is broadly safe.',
        nodeIds: ['acc-beliefs-001'],
      },
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
    ...(overrides.headline !== undefined ? { synthesizedHeadline: overrides.headline } : {}),
  };
}

// ── Figure-check WARN filtering helper ───────────────────────────────────────

/** Collect every record() call for component 'inquiry-synthesis' at level 'warn'. */
function figureMisses(recordFn: ReturnType<typeof vi.fn>) {
  return (recordFn.mock.calls as Array<[{ type: string; component: string; level: string; message: string; data?: unknown }]>)
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

  it('fires for compound phrase even when individual words appear in transcript', async () => {
    // Key correctness test: transcript has "thousands" and "hundreds" separately,
    // but NOT as the compound "hundreds of thousands". Headline uses the compound.
    // The check MUST fire — individual transcript words do not cancel a compound phrase.
    const question = 'What are the mortality risks of unaligned AI systems?';
    const headline = 'The debate reveals hundreds of thousands of deaths annually according to projections.';

    await synthesizeInquiry(
      makeSession([
        'There are thousands of AI models currently deployed.',
        'Hundreds of researchers have flagged alignment risks.',
      ]),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse({ headline })),
    );

    const misses = figureMisses(recordFn);
    expect(misses.length).toBeGreaterThan(0);
    const messages = misses.map(m => m.message);
    // The compound is extracted as "hundreds-of-thousands", not the individual words.
    expect(messages.some(m => m.includes('synthesizedHeadline'))).toBe(true);
    expect(messages.some(m => m.includes('hundreds-of-thousands'))).toBe(true);
  });

  it('does NOT fire when the compound phrase appears in the transcript', async () => {
    // Negative arm for compound: transcript contains "hundreds of thousands" → no warn.
    const question = 'What are the mortality risks of unaligned AI systems?';
    const headline = 'The debate reveals hundreds of thousands of deaths annually.';

    await synthesizeInquiry(
      makeSession(['Safetyists estimated hundreds of thousands of lives at risk.']),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse({ headline })),
    );

    const misses = figureMisses(recordFn);
    expect(misses.filter(m => m.message.includes('hundreds-of-thousands'))).toHaveLength(0);
  });

  it('does NOT fire when a verdict cites a node ID like [saf-beliefs-206]', async () => {
    // Node-ID citations: "206" in [saf-beliefs-206] must be stripped before extraction.
    // Otherwise every grounded result would false-warn for the node-ID digit.
    const question = 'Does AI pose systemic risk?';
    const verdict = 'Safety concerns [saf-beliefs-206] dominate the discussion on systemic risk.';

    await synthesizeInquiry(
      makeSession([]), // empty transcript
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse({ verdict })),
    );

    const misses = figureMisses(recordFn);
    // "206" came from [saf-beliefs-206] and must NOT appear as an unsupported token.
    expect(misses.filter(m => m.message.includes('206'))).toHaveLength(0);
  });

  it('does NOT fire when the transcript supplies the digit figure cited in the headline', async () => {
    // Negative arm: transcript contains "700,000 deaths a year"; headline cites it.
    const question = 'What are the mortality risks of unaligned AI systems?';
    const headline = 'The Safetyist cited 700,000 deaths a year as the projected toll.';

    await synthesizeInquiry(
      makeSession(['The Safetyist argued that 700,000 deaths a year are plausible under current trajectories.']),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      { question, fidelity: 'standard' } satisfies StoredInquiryRequest,
      makeAdapter(baseLlmResponse({ headline })),
    );

    const misses = figureMisses(recordFn);
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
      makeAdapter(baseLlmResponse({ headline })),
    );

    const misses = figureMisses(recordFn);
    expect(misses.filter(m => m.message.includes('1000') || m.message.includes('1,000'))).toHaveLength(0);
  });
});

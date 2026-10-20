// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4304: Tests for the broken-injection signature detector in runInquiryPipeline.
 *
 * Covers the two signatures detected by `warnBrokenInjection`:
 *   Sig 1 — 100% unattributed claims with ≥N total claims.
 *   Sig 2 — every debate turn used lexical scoring while embeddings exist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInquiryPipeline } from './inquiryPipeline.js';
import type { InquiryPipelineDeps } from './inquiryPipeline.js';
import type { InquiryRequest } from '../inquiry/schema.js';
import type { DebateSession } from './types/session.js';
import type { DebateConfig } from './debateEngine/internals.js';
import type { InquiryResult } from '../inquiry/schema.js';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('./inquiryConfig.js', () => ({
  deriveDebateConfig: vi.fn(),
}));
vi.mock('./inquiryGrounding.js', () => ({
  buildGroundingEnvelope: vi.fn(),
}));
vi.mock('./calibrationLogger/trustProjection.js', () => ({
  getRawMetrics: vi.fn(),
  projectTrust: vi.fn(),
}));
vi.mock('./inquirySynthesis.js', () => ({
  synthesizeInquiry: vi.fn(),
}));
vi.mock('../flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn(),
}));

import { deriveDebateConfig } from './inquiryConfig.js';
import { buildGroundingEnvelope } from './inquiryGrounding.js';
import { getRawMetrics, projectTrust } from './calibrationLogger/trustProjection.js';
import { synthesizeInquiry } from './inquirySynthesis.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeRequest(): InquiryRequest {
  return { question: 'What are the risks?', fidelity: 'standard' };
}

function makeSession(
  overrides: {
    extraction_summary?: Partial<DebateSession['extraction_summary']>;
    diagnostics_overview?: {
      lexical_turn_count?: number;
      embedding_turn_count?: number;
    };
  } = {},
): DebateSession {
  const base = {
    id: 'sess-bi-001',
    title: 'Broken Injection Test',
    created_at: '2026-10-19T00:00:00Z',
    updated_at: '2026-10-19T00:00:00Z',
    phase: 'closed',
    topic: { original: 'test', refined: null, final: 'test topic' },
    source_type: 'topic',
    source_ref: '',
    source_content: '',
    active_povers: ['accelerationist', 'safetyist', 'skeptic'],
    user_is_pover: false,
    transcript: [],
    context_summaries: [],
    argument_network: { nodes: [], edges: [] },
  } as unknown as DebateSession;

  if (overrides.extraction_summary) {
    (base as unknown as Record<string, unknown>).extraction_summary = overrides.extraction_summary;
  }

  if (overrides.diagnostics_overview) {
    (base as unknown as Record<string, unknown>).diagnostics = {
      enabled: true,
      entries: {},
      overview: {
        total_ai_calls: 0,
        total_response_time_ms: 0,
        claims_accepted: 0,
        claims_rejected: 0,
        move_type_counts: {},
        disagreement_type_counts: {},
        ...overrides.diagnostics_overview,
      },
    };
  }

  return base;
}

function makeConfig(): DebateConfig {
  return { topic: 'test', rounds: 4 } as unknown as DebateConfig;
}

function makeGrounding() {
  return { nodesByCamp: { acc: [{ nodeId: 'acc-001', label: 'Node A', camp: 'acc' }] } };
}

function makeCalibration() {
  return [{ metric: 'convergence_score', value: 0.7, trust: { verdict: 'trust', reason: 'natural conclusion run' } }];
}

function makeResult(): InquiryResult {
  return {
    schemaVersion: 1,
    request: makeRequest(),
    campVerdicts: [],
    convergences: [],
    evidenceLayers: [],
    unresolvedGaps: [],
    singleRunCaveat: 'Single run.',
    calibration: makeCalibration(),
    derivation: { fidelity: 'standard', models: { debaters: 'model-a' }, rounds: 4, callBudget: 60 },
    grounding: makeGrounding(),
  } as unknown as InquiryResult;
}

function makeDeps(
  overrides: Partial<InquiryPipelineDeps> & { embeddings?: Record<string, unknown> } = {},
): InquiryPipelineDeps {
  const { embeddings = {}, ...rest } = overrides;
  return {
    registry: { models: [], debateTiers: {} } as never,
    taxonomy: { povNodes: [], situationNodes: [], nodeEmbeddings: embeddings } as never,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    runDebate: vi.fn().mockResolvedValue({ session: makeSession() }),
    adapter: { generateText: vi.fn() },
    ...rest,
  };
}

// ── Setup: wire default mock implementations ──────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(deriveDebateConfig).mockReturnValue({
    config: makeConfig(),
    derivation: { fidelity: 'standard', models: { debaters: 'model-a' }, rounds: 4, callBudget: 60 },
  });
  vi.mocked(buildGroundingEnvelope).mockResolvedValue({ envelope: makeGrounding() });
  vi.mocked(getRawMetrics).mockReturnValue([{ metric: 'convergence_score', value: 0.7 }]);
  vi.mocked(projectTrust).mockReturnValue(makeCalibration());
  vi.mocked(synthesizeInquiry).mockResolvedValue(makeResult());

  // Default: no flight recorder
  vi.mocked(getGlobalRecorder).mockReturnValue(undefined);
});

// ── Signature 1: 100% unattributed claims ────────────────────────────────────

describe('warnBrokenInjection — signature 1 (all claims unattributed)', () => {
  it('fires when unattributed_claim_ratio = 1.0 and total claims ≥ 5', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      extraction_summary: {
        unattributed_claim_ratio: 1.0,
        attribution_attributed: 0,
        attribution_unattributed: 7,
      },
    });
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });

    await runInquiryPipeline(makeRequest(), deps);

    expect(recordFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.error',
        component: 'inquiryPipeline',
        level: 'error',
        data: expect.objectContaining({
          signature: 'all_claims_unattributed',
          total_claims: 7,
          unattributed_claim_ratio: 1.0,
        }),
      }),
    );
  });

  it('does NOT fire when unattributed_claim_ratio < 1.0', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      extraction_summary: {
        unattributed_claim_ratio: 0.5,
        attribution_attributed: 3,
        attribution_unattributed: 3,
      },
    });
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });

    await runInquiryPipeline(makeRequest(), deps);

    const sig1Calls = recordFn.mock.calls.filter(
      (call) => call[0]?.data?.signature === 'all_claims_unattributed',
    );
    expect(sig1Calls).toHaveLength(0);
  });

  it('does NOT fire when total claims < 5 even if ratio = 1.0', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      extraction_summary: {
        unattributed_claim_ratio: 1.0,
        attribution_attributed: 0,
        attribution_unattributed: 4,
      },
    });
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });

    await runInquiryPipeline(makeRequest(), deps);

    const sig1Calls = recordFn.mock.calls.filter(
      (call) => call[0]?.data?.signature === 'all_claims_unattributed',
    );
    expect(sig1Calls).toHaveLength(0);
  });

  it('fires at exactly 5 total claims (boundary)', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      extraction_summary: {
        unattributed_claim_ratio: 1.0,
        attribution_attributed: 0,
        attribution_unattributed: 5,
      },
    });
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });

    await runInquiryPipeline(makeRequest(), deps);

    const sig1Calls = recordFn.mock.calls.filter(
      (call) => call[0]?.data?.signature === 'all_claims_unattributed',
    );
    expect(sig1Calls).toHaveLength(1);
  });
});

// ── Signature 2: all turns lexical while embeddings exist ────────────────────

describe('warnBrokenInjection — signature 2 (all turns lexical with embeddings)', () => {
  const fakeEmbeddings = { 'acc-001': { vector: [0.1, 0.2] }, 'saf-001': { vector: [0.3, 0.4] } };

  it('fires when all turns were lexical and embeddings are present', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      diagnostics_overview: { lexical_turn_count: 3, embedding_turn_count: 0 },
    });
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session }),
      embeddings: fakeEmbeddings,
    });

    await runInquiryPipeline(makeRequest(), deps);

    expect(recordFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.error',
        component: 'inquiryPipeline',
        level: 'error',
        data: expect.objectContaining({
          signature: 'all_turns_lexical_with_embeddings',
          lexical_turn_count: 3,
          embedding_turn_count: 0,
          taxonomy_embedding_count: 2,
        }),
      }),
    );
  });

  it('does NOT fire when embedding_turn_count > 0', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      diagnostics_overview: { lexical_turn_count: 1, embedding_turn_count: 2 },
    });
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session }),
      embeddings: fakeEmbeddings,
    });

    await runInquiryPipeline(makeRequest(), deps);

    const sig2Calls = recordFn.mock.calls.filter(
      (call) => call[0]?.data?.signature === 'all_turns_lexical_with_embeddings',
    );
    expect(sig2Calls).toHaveLength(0);
  });

  it('does NOT fire when no embeddings are in the taxonomy', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      diagnostics_overview: { lexical_turn_count: 3, embedding_turn_count: 0 },
    });
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session }),
      embeddings: {},
    });

    await runInquiryPipeline(makeRequest(), deps);

    const sig2Calls = recordFn.mock.calls.filter(
      (call) => call[0]?.data?.signature === 'all_turns_lexical_with_embeddings',
    );
    expect(sig2Calls).toHaveLength(0);
  });
});

// ── Healthy run: neither signature fires ─────────────────────────────────────

describe('warnBrokenInjection — healthy run', () => {
  it('fires no broken-injection events on a healthy session', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const session = makeSession({
      extraction_summary: {
        unattributed_claim_ratio: 0.2,
        attribution_attributed: 8,
        attribution_unattributed: 2,
      },
      diagnostics_overview: { lexical_turn_count: 0, embedding_turn_count: 5 },
    });
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session }),
      embeddings: { 'acc-001': { vector: [0.1] } },
    });

    await runInquiryPipeline(makeRequest(), deps);

    const brokenInjectionCalls = recordFn.mock.calls.filter(
      (call) =>
        call[0]?.data?.signature === 'all_claims_unattributed' ||
        call[0]?.data?.signature === 'all_turns_lexical_with_embeddings',
    );
    expect(brokenInjectionCalls).toHaveLength(0);
  });

  it('fires no events when session has no extraction_summary and no diagnostics', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const deps = makeDeps({ embeddings: { 'acc-001': { vector: [0.1] } } });

    await runInquiryPipeline(makeRequest(), deps);

    const brokenInjectionCalls = recordFn.mock.calls.filter(
      (call) =>
        call[0]?.data?.signature === 'all_claims_unattributed' ||
        call[0]?.data?.signature === 'all_turns_lexical_with_embeddings',
    );
    expect(brokenInjectionCalls).toHaveLength(0);
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runInquiryPipeline } from './inquiryPipeline.js';
import type { InquiryPipelineDeps, InquiryStage } from './inquiryPipeline.js';
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

function makeRequest(overrides: Partial<InquiryRequest> = {}): InquiryRequest {
  return { question: 'What are the risks?', fidelity: 'standard', ...overrides };
}

function makeSession(id = 'sess-001'): DebateSession {
  return {
    id,
    title: 'Test Debate',
    created_at: '2026-09-23T00:00:00Z',
    updated_at: '2026-09-23T00:00:00Z',
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

function makeRawMetrics() {
  return [{ metric: 'convergence_score', value: 0.7 }];
}

function makeDeps(overrides: Partial<InquiryPipelineDeps> = {}): InquiryPipelineDeps {
  return {
    registry: { models: [], debateTiers: {} } as never,
    taxonomy: { povNodes: [], situationNodes: [], nodeEmbeddings: {} } as never,
    embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    runDebate: vi.fn().mockResolvedValue({ session: makeSession() }),
    adapter: { generateText: vi.fn() },
    ...overrides,
  };
}

// ── Setup: wire default mock implementations ──────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  const deriveMock = vi.mocked(deriveDebateConfig);
  deriveMock.mockReturnValue({
    config: makeConfig(),
    derivation: { fidelity: 'standard', models: { debaters: 'model-a' }, rounds: 4, callBudget: 60 },
  });

  vi.mocked(buildGroundingEnvelope).mockResolvedValue({ envelope: makeGrounding() });
  vi.mocked(getRawMetrics).mockReturnValue(makeRawMetrics());
  vi.mocked(projectTrust).mockReturnValue(makeCalibration());
  vi.mocked(synthesizeInquiry).mockResolvedValue(makeResult());

  // Default: no flight recorder
  vi.mocked(getGlobalRecorder).mockReturnValue(undefined);
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('runInquiryPipeline — happy path', () => {
  it('returns the InquiryResult from synthesizeInquiry', async () => {
    const result = await runInquiryPipeline(makeRequest(), makeDeps());
    expect(result.schemaVersion).toBe(1);
  });

  it('calls all five stages in order', async () => {
    const order: string[] = [];
    vi.mocked(deriveDebateConfig).mockImplementation((..._args) => {
      order.push('deriving');
      return { config: makeConfig(), derivation: { fidelity: 'standard', models: { debaters: 'm' }, rounds: 4, callBudget: 60 } };
    });
    vi.mocked(buildGroundingEnvelope).mockImplementation(async (..._args) => {
      order.push('grounding');
      return { envelope: makeGrounding() };
    });
    const deps = makeDeps({
      runDebate: vi.fn().mockImplementation(async () => {
        order.push('debating');
        return { session: makeSession() };
      }),
    });
    vi.mocked(getRawMetrics).mockImplementation((..._args) => {
      order.push('projecting');
      return makeRawMetrics();
    });
    vi.mocked(synthesizeInquiry).mockImplementation(async (..._args) => {
      order.push('synthesizing');
      return makeResult();
    });

    await runInquiryPipeline(makeRequest(), deps);
    expect(order).toEqual(['deriving', 'grounding', 'debating', 'projecting', 'synthesizing']);
  });

  it('fires onStage callbacks with all five stage labels in sequence', async () => {
    const stages: InquiryStage[] = [];
    const deps = makeDeps({ onStage: (s) => stages.push(s) });
    await runInquiryPipeline(makeRequest(), deps);
    expect(stages).toEqual(['deriving', 'grounding', 'debating', 'projecting', 'synthesizing']);
  });

  it('passes the derived config and question to runDebate', async () => {
    const deps = makeDeps();
    await runInquiryPipeline(makeRequest({ question: 'Specific question?' }), deps);
    expect(deps.runDebate).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'test' }),
      'Specific question?',
      undefined, // t/4711: onProgress is undefined when deps.onDebateProgress isn't supplied
    );
  });

  it('passes a tracked onProgress to runDebate when onDebateProgress is supplied (t/4711)', async () => {
    const deps = makeDeps({ onDebateProgress: vi.fn() });
    await runInquiryPipeline(makeRequest(), deps);
    expect(deps.runDebate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('passes session from runDebate to getRawMetrics', async () => {
    const session = makeSession('session-xyz');
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });
    await runInquiryPipeline(makeRequest(), deps);
    expect(vi.mocked(getRawMetrics)).toHaveBeenCalledWith(session);
  });

  it('passes terminationReason from runDebate to projectTrust', async () => {
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session: makeSession(), terminationReason: 'api_ceiling' }),
    });
    await runInquiryPipeline(makeRequest(), deps);
    expect(vi.mocked(projectTrust)).toHaveBeenCalledWith(makeRawMetrics(), 'api_ceiling');
  });

  it('passes undefined terminationReason to projectTrust when runDebate omits it', async () => {
    await runInquiryPipeline(makeRequest(), makeDeps());
    expect(vi.mocked(projectTrust)).toHaveBeenCalledWith(makeRawMetrics(), undefined);
  });
});

// ── Truncated run (budget/termination) ───────────────────────────────────────

describe('runInquiryPipeline — truncated run', () => {
  it('returns a valid result (does not throw) when terminationReason is api_ceiling', async () => {
    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session: makeSession(), terminationReason: 'api_ceiling' }),
    });
    // synthesizeInquiry still called — result always returned, never thrown
    await expect(runInquiryPipeline(makeRequest(), deps)).resolves.toBeDefined();
  });

  it('passes censored calibration from projectTrust into synthesizeInquiry', async () => {
    const censoredCalibration = [
      { metric: 'convergence_score', value: 0.4, trust: { verdict: 'censored', reason: 'truncated' } },
    ];
    vi.mocked(projectTrust).mockReturnValue(censoredCalibration);

    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session: makeSession(), terminationReason: 'max_iterations' }),
    });
    await runInquiryPipeline(makeRequest(), deps);
    expect(vi.mocked(synthesizeInquiry)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      censoredCalibration,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'sess-001',
    );
  });
});

// ── Grounding ADR-001 empty path ─────────────────────────────────────────────

describe('runInquiryPipeline — empty grounding (ADR-001)', () => {
  it('continues and passes empty grounding to synthesizeInquiry', async () => {
    const emptyGrounding = { nodesByCamp: {} };
    vi.mocked(buildGroundingEnvelope).mockResolvedValue({ envelope: emptyGrounding });

    await runInquiryPipeline(makeRequest(), makeDeps());

    expect(vi.mocked(synthesizeInquiry)).toHaveBeenCalledWith(
      expect.anything(),
      emptyGrounding,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'sess-001',
    );
  });
});

// ── Zero calibration WARN (TL t/3585#2 change 3) ─────────────────────────────

describe('runInquiryPipeline — empty getRawMetrics → WARN assertion', () => {
  it('emits a flight recorder WARN when getRawMetrics returns empty', async () => {
    vi.mocked(getRawMetrics).mockReturnValue([]);
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    const deps = makeDeps({
      runDebate: vi.fn().mockResolvedValue({ session: makeSession('sess-empty'), terminationReason: 'first_round_exit' }),
    });

    await runInquiryPipeline(makeRequest(), deps);

    expect(recordFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.error',
        component: 'inquiryPipeline',
        level: 'warn',
        message: expect.stringContaining('empty calibration'),
      }),
    );
  });

  it('still returns a result (does not throw) when getRawMetrics returns empty', async () => {
    vi.mocked(getRawMetrics).mockReturnValue([]);
    vi.mocked(projectTrust).mockReturnValue([]);

    await expect(runInquiryPipeline(makeRequest(), makeDeps())).resolves.toBeDefined();
  });

  it('does not emit WARN when getRawMetrics returns non-empty', async () => {
    const recordFn = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record: recordFn } as never);

    await runInquiryPipeline(makeRequest(), makeDeps());

    expect(recordFn).not.toHaveBeenCalled();
  });
});

// ── synthesizeInquiry fault propagates ───────────────────────────────────────

describe('runInquiryPipeline — synthesizeInquiry fault propagates', () => {
  it('rethrows an ActionableError from synthesizeInquiry', async () => {
    const err = Object.assign(new Error('LLM JSON failed'), { goal: 'Synthesize', problem: 'bad JSON' });
    vi.mocked(synthesizeInquiry).mockRejectedValue(err);

    await expect(runInquiryPipeline(makeRequest(), makeDeps())).rejects.toMatchObject({
      problem: 'bad JSON',
    });
  });
});

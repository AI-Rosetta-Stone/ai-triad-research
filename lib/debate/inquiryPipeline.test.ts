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
    topic: { original: 'test', refined: null, final: 'What are the risks?' },
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

// Mirrors deriveDebateConfig: topic is the request question, and the inquiry turns the reframe off (t/284).
function makeConfig(question = 'What are the risks?'): DebateConfig {
  return { topic: question, rounds: 4, wisdomAutoReframe: false } as unknown as DebateConfig;
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
  deriveMock.mockImplementation((req: InquiryRequest) => ({
    config: makeConfig(req.question),
    derivation: { fidelity: 'standard', models: { debaters: 'model-a' }, rounds: 4, callBudget: 60 },
  }));

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
    // The debate runs on the question it was given, so topic.final echoes it (t/284 item 1).
    const deps = makeDeps({
      runDebate: vi.fn().mockImplementation(async (_config: unknown, question: string) => ({
        session: { ...makeSession(), topic: { original: question, refined: null, final: question } },
      })),
    });
    await runInquiryPipeline(makeRequest({ question: 'Specific question?' }), deps);
    expect(deps.runDebate).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'Specific question?' }),
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

describe('runInquiryPipeline — pre-flight topic check (t/284 item 1)', () => {
  it('refuses before grounding or the debate when the config would reframe the question', async () => {
    vi.mocked(deriveDebateConfig).mockReturnValueOnce({
      config: { ...makeConfig(), wisdomAutoReframe: true },
      derivation: { fidelity: 'standard', models: { debaters: 'model-a' }, rounds: 4, callBudget: 60 },
    });
    const deps = makeDeps();
    await expect(runInquiryPipeline(makeRequest({ question: 'What are the risks?' }), deps)).rejects.toMatchObject({
      problem: expect.stringContaining('wisdomAutoReframe=true'),
    });
    expect(deps.runDebate).not.toHaveBeenCalled();
    expect(buildGroundingEnvelope).not.toHaveBeenCalled();
  });
});

describe('runInquiryPipeline — question relevance (t/284 item 5)', () => {
  const debaterSession = (): DebateSession => ({
    ...makeSession(),
    topic: { original: 'What are the risks?', refined: null, final: 'What are the risks?' },
    transcript: [
      { id: 'e1', timestamp: '', type: 'statement', speaker: 'accelerationist', content: 'Risks are small.', taxonomy_refs: [] },
      { id: 'e2', timestamp: '', type: 'statement', speaker: 'safetyist', content: 'Risks are large.', taxonomy_refs: [] },
    ],
  } as unknown as DebateSession);

  it('stores per-turn similarity to the question on the session', async () => {
    const embed = vi.fn().mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const deps = makeDeps({
      embed,
      runDebate: vi.fn().mockResolvedValue({ session: debaterSession() }),
    });
    const session = debaterSession();
    deps.runDebate = vi.fn().mockResolvedValue({ session });
    await runInquiryPipeline(makeRequest({ question: 'What are the risks?' }), deps);
    expect(session.relevance?.question_similarity.map(t => t.entry_id)).toEqual(['e1', 'e2']);
    expect(session.relevance?.mean).toBeCloseTo(0.5);
  });

  it('records the metric as unavailable and WARNs when embedding fails (no fake value)', async () => {
    const deps = makeDeps({
      embed: vi.fn().mockRejectedValue(new Error('embedder down')),
    });
    const session = debaterSession();
    deps.runDebate = vi.fn().mockResolvedValue({ session });
    await runInquiryPipeline(makeRequest({ question: 'What are the risks?' }), deps);
    expect(session.relevance?.mean).toBeNull();
    expect(session.relevance?.unavailable_reason).toContain('embedder down');
  });
});

// t/284 (TL p/32#134): the inquiry entry point must treat a multi-line question as one question.
describe('runInquiryPipeline — a multi-line question stays one question (t/284)', () => {
  const MULTI_LINE_QUESTION = 'A large frontier developer shall retain records pertaining to:\n(i) A catastrophic risk;\n(ii) A critical safety incident; or\n(iii) The developer\u2019s compliance with this law.';

  it('runs exactly one debate, on the whole question, and scores relevance against the whole question', async () => {
    const session = {
      ...makeSession(),
      transcript: [{ id: 'e1', timestamp: '', type: 'statement', speaker: 'safetyist', content: 'Records matter.', taxonomy_refs: [] }],
    } as unknown as DebateSession;
    const runDebate = vi.fn().mockResolvedValue({ session });
    const embed = vi.fn().mockResolvedValue([[1, 0], [1, 0]]);
    const deps = makeDeps({ runDebate, embed });

    await runInquiryPipeline(makeRequest({ question: MULTI_LINE_QUESTION }), deps);

    expect(runDebate).toHaveBeenCalledTimes(1);
    const [config, question] = runDebate.mock.calls[0];
    expect(config.topic).toBe(MULTI_LINE_QUESTION);
    expect(question).toBe(MULTI_LINE_QUESTION);
    expect(embed.mock.calls.some(c => c[0][0] === MULTI_LINE_QUESTION)).toBe(true);
    expect(vi.mocked(deriveDebateConfig).mock.calls.every(c => c[0].question === MULTI_LINE_QUESTION)).toBe(true);
    expect(vi.mocked(deriveDebateConfig)).toHaveBeenCalledTimes(1);
  });
});

describe('runInquiryPipeline — persistSession (t/284 item 5, t/476)', () => {
  it('is called once, after relevance is recorded, with the session that carries it', async () => {
    const session = makeSession();
    let relevanceAtSave: unknown = 'not called';
    const persistSession = vi.fn(async (s: DebateSession) => { relevanceAtSave = s.relevance; });
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }), persistSession });
    await runInquiryPipeline(makeRequest(), deps);
    expect(persistSession).toHaveBeenCalledTimes(1);
    expect(persistSession.mock.calls[0][0]).toBe(session);
    expect(relevanceAtSave).toBeDefined();
    expect(relevanceAtSave).toBe(session.relevance);
  });

  it('returns the same result with and without the dep', async () => {
    const without = await runInquiryPipeline(makeRequest(), makeDeps());
    const withDep = await runInquiryPipeline(makeRequest(), makeDeps({ persistSession: vi.fn().mockResolvedValue(undefined) }));
    expect(withDep).toEqual(without);
  });

  it('records a WARN and still returns the answer when the save rejects', async () => {
    const record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    try {
      const deps = makeDeps({ persistSession: vi.fn().mockRejectedValue(new Error('disk full')) });
      await expect(runInquiryPipeline(makeRequest(), deps)).resolves.toBeDefined();
    } finally {
      vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never);
    }
    const saveWarns = record.mock.calls.map(c => c[0]).filter(e => String(e.message).includes('inquiry session save failed'));
    expect(saveWarns).toHaveLength(1);
    expect(saveWarns[0]).toMatchObject({ type: 'system.error', component: 'inquiryPipeline', level: 'warn' });
    expect(saveWarns[0].message).toContain('disk full');
  });

  it('records no save WARN when the save succeeds', async () => {
    const record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    try {
      await runInquiryPipeline(makeRequest(), makeDeps({ persistSession: vi.fn().mockResolvedValue(undefined) }));
    } finally {
      vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never);
    }
    expect(record.mock.calls.filter(c => String(c[0].message).includes('inquiry session save failed'))).toHaveLength(0);
  });

  it('is not called when the debate throws', async () => {
    const persistSession = vi.fn();
    const deps = makeDeps({ runDebate: vi.fn().mockRejectedValue(new Error('debate failed')), persistSession });
    await expect(runInquiryPipeline(makeRequest(), deps)).rejects.toThrow('debate failed');
    expect(persistSession).not.toHaveBeenCalled();
  });
});

describe('runInquiryPipeline — residual similarity is recorded for study only (t/496)', () => {
  const twoTurns = (): DebateSession => ({
    ...makeSession(),
    transcript: [
      { id: 'e1', timestamp: '', type: 'statement', speaker: 'accelerationist', content: 'Risks are small.', taxonomy_refs: [] },
      { id: 'e2', timestamp: '', type: 'statement', speaker: 'safetyist', content: 'Risks are large.', taxonomy_refs: [] },
    ],
  } as unknown as DebateSession);
  // Question [10, 1]; turns [10, 1] and [10, -1]; the field centroid from the taxonomy is [10, 0].
  const embed = () => vi.fn().mockResolvedValue([[10, 1], [10, 1], [10, -1]]);
  const taxonomy = { povNodes: [], situationNodes: [], nodeEmbeddings: { a: { pov: 'acc', vector: [9, 0] }, b: { pov: 'saf', vector: [11, 0] } } } as never;

  it('stores per-turn residual similarity and its mean beside the plain similarity', async () => {
    const session = twoTurns();
    await runInquiryPipeline(makeRequest(), makeDeps({ embed: embed(), taxonomy, runDebate: vi.fn().mockResolvedValue({ session }) }));
    expect(session.relevance?.residual_similarity?.map(t => t.entry_id)).toEqual(['e1', 'e2']);
    expect(session.relevance?.residual_similarity?.[0].similarity).toBeCloseTo(1);
    expect(session.relevance?.residual_similarity?.[1].similarity).toBeCloseTo(-1);
    expect(session.relevance?.residual_mean).toBeCloseTo(0);
  });

  it('changes nothing else: the plain similarity, mean and drift flag are the same with and without taxonomy vectors', async () => {
    const withTax = twoTurns(), without = twoTurns();
    await runInquiryPipeline(makeRequest(), makeDeps({ embed: embed(), taxonomy, runDebate: vi.fn().mockResolvedValue({ session: withTax }) }));
    await runInquiryPipeline(makeRequest(), makeDeps({ embed: embed(), runDebate: vi.fn().mockResolvedValue({ session: without }) }));
    const { residual_similarity: _r, residual_mean: _m, ...rest } = withTax.relevance!;
    expect(rest).toEqual(without.relevance);
    // A low residual mean raises no flag: the drift flag here comes from the plain similarity only.
    expect(withTax.relevance?.drift_warning).toBe(false);
  });

  it('leaves the fields off and records a WARN when the host has no taxonomy vectors', async () => {
    const record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    const session = twoTurns();
    try {
      await runInquiryPipeline(makeRequest(), makeDeps({ embed: embed(), runDebate: vi.fn().mockResolvedValue({ session }) }));
    } finally {
      vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never);
    }
    expect(session.relevance && 'residual_similarity' in session.relevance).toBe(false);
    const warns = record.mock.calls.map(c => c[0]).filter(e => String(e.message).includes('residual similarity not recorded'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({ level: 'warn', component: 'inquiryPipeline' });
  });
});

describe('runInquiryPipeline — empty transcript relevance (t/284 item 5, CL note 2)', () => {
  it('stores unavailable with a reason, never a clean no-drift reading', async () => {
    const session = { ...makeSession(), transcript: [] } as unknown as DebateSession;
    const deps = makeDeps({ runDebate: vi.fn().mockResolvedValue({ session }) });
    await runInquiryPipeline(makeRequest({ question: 'What are the risks?' }), deps);
    expect(session.relevance?.unavailable_reason).toBe('no debater turns');
    expect(session.relevance?.mean).toBeNull();
  });
});

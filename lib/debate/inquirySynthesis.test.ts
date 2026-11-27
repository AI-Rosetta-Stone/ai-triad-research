// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { synthesizeInquiry, describeResponseShape } from './inquirySynthesis.js';
import { SINGLE_RUN_CAVEAT } from './prompts/inquiry.js';
import type { AIAdapter } from './aiAdapter.js';
import type { DebateSession } from './types/session.js';
import type {
  GroundingEnvelope,
  ResolvedDerivation,
  StoredInquiryRequest,
  CalibrationEntry,
} from '../inquiry/schema.js';

// ── Fixture helpers ──────────────────────────────────────────────────────────

function makeAdapter(responseJson: object): AIAdapter {
  return {
    generateText: vi.fn().mockResolvedValue(JSON.stringify(responseJson)),
  };
}

function makeFailAdapter(rawText: string): AIAdapter {
  return {
    generateText: vi.fn().mockResolvedValue(rawText),
  };
}

function makeSession(overrides: Partial<DebateSession> = {}): DebateSession {
  return {
    id: 'test-session',
    title: 'Test Debate',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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
    ...overrides,
  } as unknown as DebateSession;
}

function makeGrounding(): GroundingEnvelope {
  return {
    anchorSituationId: 'sit-001',
    nodesByCamp: {
      acc: [{ nodeId: 'acc-beliefs-001', label: 'Acc Node A', camp: 'acc' }],
      saf: [{ nodeId: 'saf-beliefs-001', label: 'Saf Node S', camp: 'saf' }],
    },
  };
}

function makeCalibration(): CalibrationEntry[] {
  return [
    {
      metric: 'convergence_score',
      value: 0.7,
      trust: { verdict: 'trust', reason: 'natural conclusion' },
    },
  ];
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

function makeRequest(): StoredInquiryRequest {
  return { question: 'What are the risks?', fidelity: 'standard' };
}

function validLlmResponse() {
  return {
    campVerdicts: [
      { camp: 'acc', verdict: 'Acceleration is safe.', nodeIds: ['acc-beliefs-001'] },
      { camp: 'saf', verdict: 'Safety is paramount.', nodeIds: ['saf-beliefs-001'] },
    ],
    convergences: [
      { claim: 'Alignment matters.', nodeIds: ['acc-beliefs-001', 'saf-beliefs-001'] },
    ],
    evidenceLayers: [
      { title: 'Empirical', role: 'Data grounding', solves: 'Factual disputes', sources: ['Source A'] },
    ],
    unresolvedGaps: [
      { description: 'Long-term impact unknown.', confidence: 'high' },
    ],
    singleRunCaveat: 'Single run result.',
  };
}

// ── Core happy path ──────────────────────────────────────────────────────────

describe('synthesizeInquiry — happy path', () => {
  it('returns a validated InquiryResult with schemaVersion 1', async () => {
    const result = await synthesizeInquiry(
      makeSession(),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      makeRequest(),
      makeAdapter(validLlmResponse()),
    );
    expect(result.schemaVersion).toBe(1);
  });

  it('resolves nodeIds to NodeRef objects from grounding snapshot', async () => {
    const result = await synthesizeInquiry(
      makeSession(),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      makeRequest(),
      makeAdapter(validLlmResponse()),
    );
    const accVerdict = result.campVerdicts.find((v) => v.camp === 'acc');
    expect(accVerdict?.nodes[0]?.nodeId).toBe('acc-beliefs-001');
    expect(accVerdict?.nodes[0]?.label).toBe('Acc Node A');
  });

  it('embeds request, derivation, calibration, and grounding unchanged', async () => {
    const derivation = makeDerivation();
    const calibration = makeCalibration();
    const grounding = makeGrounding();
    const request = makeRequest();
    const result = await synthesizeInquiry(
      makeSession(), grounding, calibration, derivation, request, makeAdapter(validLlmResponse()),
    );
    expect(result.request).toMatchObject(request);
    expect(result.derivation).toMatchObject(derivation);
    expect(result.calibration).toStrictEqual(calibration);
    expect(result.grounding).toMatchObject(grounding);
  });

  it('passes convergence nodeIds through to NodeRef snapshots', async () => {
    const result = await synthesizeInquiry(
      makeSession(),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      makeRequest(),
      makeAdapter(validLlmResponse()),
    );
    expect(result.convergences[0]?.nodes).toHaveLength(2);
    expect(result.convergences[0]?.nodes[0]?.nodeId).toBe('acc-beliefs-001');
  });

  it('passes evidenceLayers and unresolvedGaps through unchanged', async () => {
    const result = await synthesizeInquiry(
      makeSession(),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      makeRequest(),
      makeAdapter(validLlmResponse()),
    );
    expect(result.evidenceLayers[0]?.title).toBe('Empirical');
    expect(result.unresolvedGaps[0]?.description).toBe('Long-term impact unknown.');
  });

  it('uses LLM-provided singleRunCaveat when present', async () => {
    const result = await synthesizeInquiry(
      makeSession(),
      makeGrounding(),
      makeCalibration(),
      makeDerivation(),
      makeRequest(),
      makeAdapter(validLlmResponse()),
    );
    expect(result.singleRunCaveat).toBe('Single run result.');
  });
});

// ── evaluatorModel selection ─────────────────────────────────────────────────

describe('synthesizeInquiry — evaluatorModel (TL t/3580#3 note 1)', () => {
  it('calls generateText with derivation.models[evaluator]', async () => {
    const adapter = makeAdapter(validLlmResponse());
    await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation({ models: { debaters: 'debater-m', evaluator: 'eval-m' } }),
      makeRequest(), adapter,
    );
    expect(adapter.generateText).toHaveBeenCalledWith(
      expect.any(String),
      'eval-m',
    );
  });

  it('falls back to derivation.models[debaters] when no evaluator key', async () => {
    const adapter = makeAdapter(validLlmResponse());
    await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation({ models: { debaters: 'debater-only' } }),
      makeRequest(), adapter,
    );
    expect(adapter.generateText).toHaveBeenCalledWith(
      expect.any(String),
      'debater-only',
    );
  });
});

// ── singleRunCaveat fallback ─────────────────────────────────────────────────

describe('synthesizeInquiry — singleRunCaveat fallback (TL t/3580#3 note 2)', () => {
  it('uses SINGLE_RUN_CAVEAT export when LLM omits the field', async () => {
    const { singleRunCaveat: _omitted, ...noFallback } = validLlmResponse();
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(), makeAdapter(noFallback),
    );
    expect(result.singleRunCaveat).toBe(SINGLE_RUN_CAVEAT);
  });

  it('uses SINGLE_RUN_CAVEAT when LLM returns empty string for caveat', async () => {
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(),
      makeAdapter({ ...validLlmResponse(), singleRunCaveat: '' }),
    );
    expect(result.singleRunCaveat).toBe(SINGLE_RUN_CAVEAT);
  });
});

// ── t/1626 parse failure ──────────────────────────────────────────────────────

describe('synthesizeInquiry — parse failure (t/1626)', () => {
  it('throws ActionableError when LLM returns non-JSON', async () => {
    await expect(
      synthesizeInquiry(
        makeSession(), makeGrounding(), makeCalibration(),
        makeDerivation(), makeRequest(), makeFailAdapter('not json at all'),
      ),
    ).rejects.toMatchObject({
      goal: expect.stringContaining('Synthesize'),
      problem: expect.stringContaining('parsed as JSON'),
    });
  });

  it('throws ActionableError when LLM returns empty string', async () => {
    await expect(
      synthesizeInquiry(
        makeSession(), makeGrounding(), makeCalibration(),
        makeDerivation(), makeRequest(), makeFailAdapter(''),
      ),
    ).rejects.toMatchObject({
      problem: expect.stringContaining('JSON'),
    });
  });
});

// ── t/820 one retry on a response that doesn't parse ───────────────

describe('describeResponseShape (t/820)', () => {
  it('describes a truncated JSON answer without quoting it', () => {
    const shape = describeResponseShape('{"directAnswer":{"text":"SECRET-USER-WORDS","agreement":"split"},"campVerdicts":[{"camp":"acc","verdict":"cut off here');
    expect(shape).toMatchObject({ first: '{', last: 'letter', fenced: false, balanced: false, namesDirectAnswer: true, namesCampVerdicts: true });
    expect(JSON.stringify(shape)).not.toContain('SECRET');
  });
  it('tells prose, a fenced answer and an empty response apart', () => {
    expect(describeResponseShape('I cannot help with that.')).toMatchObject({ first: 'letter', last: 'other', balanced: false, namesDirectAnswer: false });
    expect(describeResponseShape('```json\n{"a":1}\n```')).toMatchObject({ first: 'fence', last: 'fence', fenced: true, balanced: true });
    expect(describeResponseShape('')).toMatchObject({ length: 0, first: 'empty', last: 'empty', balanced: false });
  });
});

describe('synthesizeInquiry — one retry on a null parse (t/820)', () => {
  const run = (adapter: AIAdapter) => synthesizeInquiry(
    makeSession(), makeGrounding(), makeCalibration(), makeDerivation(), makeRequest(), adapter,
  );

  it('a good first response makes exactly one call', async () => {
    const adapter = makeAdapter(validLlmResponse());
    await run(adapter);
    expect(adapter.generateText).toHaveBeenCalledTimes(1);
  });

  it('succeeds when the second attempt parses, after one call more, with the same model and prompt', async () => {
    const generateText = vi.fn()
      .mockResolvedValueOnce('I am sorry, I cannot do that.')
      .mockResolvedValueOnce(JSON.stringify(validLlmResponse()));
    const result = await run({ generateText });
    expect(result.campVerdicts.length).toBeGreaterThan(0);
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1]).toEqual(generateText.mock.calls[0]);
  });

  it('logs the response structure, never its text, on each failed parse', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await run({ generateText: vi.fn().mockResolvedValue('USER-TEXT-IN-REPLY, not json') }).catch(() => undefined);
      const lines = spy.mock.calls.map(c => String(c[0])).filter(l => l.includes('[inquiry-synthesis]'));
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('attempt 1 of 2');
      expect(lines.join('')).not.toContain('USER-TEXT');
    } finally {
      spy.mockRestore();
    }
  });

  it('fails with the same error when the second attempt also fails to parse, after exactly two calls', async () => {
    const generateText = vi.fn().mockResolvedValue('still not json');
    await expect(run({ generateText })).rejects.toMatchObject({
      goal: expect.stringContaining('Synthesize'),
      problem: expect.stringContaining('parsed as JSON'),
    });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('does not retry a response that parses but fails validation', async () => {
    const generateText = vi.fn().mockResolvedValue(JSON.stringify({ campVerdicts: 'not an array' }));
    await run({ generateText }).catch(() => undefined);
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});

// ── Node resolution ───────────────────────────────────────────────────────────

describe('synthesizeInquiry — node resolution', () => {
  it('drops nodeIds that are not in the grounding snapshot (hallucinated IDs)', async () => {
    const llmResponse = {
      ...validLlmResponse(),
      campVerdicts: [
        { camp: 'acc', verdict: 'Verdict.', nodeIds: ['acc-beliefs-001', 'FAKE-id-999'] },
      ],
    };
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(), makeAdapter(llmResponse),
    );
    const accVerdict = result.campVerdicts.find((v) => v.camp === 'acc');
    // Only the real node should survive
    expect(accVerdict?.nodes).toHaveLength(1);
    expect(accVerdict?.nodes[0]?.nodeId).toBe('acc-beliefs-001');
  });

  it('returns empty nodes array when grounding is empty', async () => {
    const emptyGrounding: GroundingEnvelope = { nodesByCamp: {} };
    const result = await synthesizeInquiry(
      makeSession(), emptyGrounding, makeCalibration(),
      makeDerivation(), makeRequest(), makeAdapter(validLlmResponse()),
    );
    // All nodeIds are unresolvable, so all nodes arrays should be empty
    for (const cv of result.campVerdicts) {
      expect(cv.nodes).toHaveLength(0);
    }
  });
});

// ── synthesizedHeadline — t/3735 bound-check ────────────────────────────────

describe('synthesizeInquiry — synthesizedHeadline (t/3735)', () => {
  it('includes synthesizedHeadline when within the 400-char bound', async () => {
    const headline = 'Acc and Saf diverge on timeline; Skp questions both.';
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(),
      makeAdapter({ ...validLlmResponse(), synthesizedHeadline: headline }),
    );
    expect(result.synthesizedHeadline).toBe(headline);
  });

  it('includes synthesizedHeadline at exactly 400 chars', async () => {
    const headline = 'x'.repeat(400);
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(),
      makeAdapter({ ...validLlmResponse(), synthesizedHeadline: headline }),
    );
    expect(result.synthesizedHeadline).toBe(headline);
  });

  it('omits synthesizedHeadline when over the 400-char bound', async () => {
    const headline = 'x'.repeat(401);
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(),
      makeAdapter({ ...validLlmResponse(), synthesizedHeadline: headline }),
    );
    expect(result.synthesizedHeadline).toBeUndefined();
  });

  it('omits synthesizedHeadline when LLM omits the field', async () => {
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(), makeAdapter(validLlmResponse()),
    );
    expect(result.synthesizedHeadline).toBeUndefined();
  });

  it('omits synthesizedHeadline when LLM returns null (not a string)', async () => {
    const result = await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(),
      makeAdapter({ ...validLlmResponse(), synthesizedHeadline: null }),
    );
    expect(result.synthesizedHeadline).toBeUndefined();
  });
});

// ── Prompt includes question and grounding context ───────────────────────────

describe('synthesizeInquiry — prompt construction', () => {
  it('includes the question in the generated prompt', async () => {
    const adapter = makeAdapter(validLlmResponse());
    await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), { ...makeRequest(), question: 'Unique test question ABC?' }, adapter,
    );
    const [promptArg] = (adapter.generateText as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(promptArg).toContain('Unique test question ABC?');
  });

  it('includes grounding node labels in the prompt', async () => {
    const adapter = makeAdapter(validLlmResponse());
    await synthesizeInquiry(
      makeSession(), makeGrounding(), makeCalibration(),
      makeDerivation(), makeRequest(), adapter,
    );
    const [promptArg] = (adapter.generateText as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(promptArg).toContain('acc-beliefs-001');
    expect(promptArg).toContain('Acc Node A');
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/775: runSynthesisPhases, which both the engine pipeline and the app's requestSynthesis call,
// returns the lists normalised and in relevance order. Before this, only SynthesisPipeline ordered
// them, so app syntheses showed the model's order.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runSynthesisPhases } from './synthesisPhases.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

const ALL = ['accelerationist', 'safetyist', 'skeptic'];
const extract = JSON.stringify({
  areas_of_agreement: [
    { point: 'Supporting point', povers: ['safetyist'], answers_question: false },
    { point: 'The answer', povers: ['skeptic'], answers_question: true },
  ],
  areas_of_disagreement: [
    { point: 'd-model-first', decisive: false, positions: ALL.map(p => ({ pover: p })) },
    { point: 'd-decisive', decisive: true, positions: [{ pover: 'skeptic' }] },
  ],
  cruxes: [{ question: 'c-model-first', decisive: false }, { question: 'c-decisive', decisive: true }],
  unresolved_questions: [],
});
const points = (xs: unknown) => (xs as Record<string, unknown>[]).map(x => x.point ?? x.question);

describe('runSynthesisPhases returns relevance-ordered lists (t/775)', () => {
  afterEach(() => clearGlobalRecorder());

  it.each([1, 2, 3])('maxPhase %i: agreements, disagreements and cruxes in relevance order', async (maxPhase) => {
    const generate = vi.fn(async (_prompt: string, label: string) => (/Extract/.test(label) ? extract : '{}'));
    const { data } = await runSynthesisPhases({ topic: 'Q?', transcript: 't' }, generate, undefined, undefined, undefined, maxPhase);
    expect(points(data.areas_of_agreement)).toEqual(['The answer', 'Supporting point']);
    expect(points(data.areas_of_disagreement)).toEqual(['d-decisive', 'd-model-first']);
    expect(points(data.cruxes)).toEqual(['c-decisive', 'c-model-first']);
  });

  it('normalises the flags once, with the debate id on the WARN', async () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    const noFlags = JSON.stringify({ areas_of_agreement: [{ point: 'a', povers: ALL }], areas_of_disagreement: [], cruxes: [], unresolved_questions: [] });
    await runSynthesisPhases({ topic: 'Q?', transcript: 't', debateId: 'd-123' }, async (_p, label) => (/Extract/.test(label) ? noFlags : '{}'), undefined, undefined, undefined, 1);
    const warns = record.mock.calls.map(c => c[0]).filter(e => /answers_question missing/.test(e.message ?? ''));
    expect(warns).toHaveLength(1);
    expect(warns[0].debate_id).toBe('d-123');
  });
});

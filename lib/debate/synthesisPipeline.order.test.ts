// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/769, t/775: SynthesisPipeline.runSynthesis stores and renders the lists in relevance order, and
// WARNs when agreements lack answers_question. Drives the real synthesis phases (only the model is
// stubbed), so it pins the order wherever it is applied (since t/775, inside runSynthesisPhases).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { SynthesisPipeline, type SynthesisContext } from './synthesisPipeline.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';

function run(data: Record<string, unknown>) {
  // Phase 1 (Extract) returns the lists in model order; phases 2 and 3 return nothing.
  const extract = JSON.stringify({ unresolved_questions: [], ...data });
  const generate = vi.fn(async (_prompt: string, label: string) => (/Extract/.test(label) ? extract : '{}'));
  const record = vi.fn<(e: RecordInput) => void>();
  setGlobalRecorder({ record } as unknown as FlightRecorder);
  const added: { content: string; metadata?: { synthesis?: Record<string, unknown> } }[] = [];
  const ctx = {
    session: { id: 'd1', topic: { final: 'Should AI agents get legal personhood?' }, transcript: [] },
    config: { model: 'm' },
    taxonomy: { policyRegistry: [] },
    generate, generateWithEvaluator: vi.fn(),
    addEntry: vi.fn((e) => { added.push(e as never); return { ...e, id: 'c1', timestamp: 't' }; }),
    recordDiagnostic: vi.fn(), progress: vi.fn(), warn: vi.fn(), checkAborted: vi.fn(),
  } as unknown as SynthesisContext;
  return { pipeline: new SynthesisPipeline(ctx), added, record };
}

describe('SynthesisPipeline.runSynthesis ordering (t/769)', () => {
  afterEach(() => clearGlobalRecorder());

  it('puts the answering agreement first in both the stored data and the markdown the card reads', async () => {
    const { pipeline, added, record } = run({
      topic_resolution: { what_would_resolve_it: 'Whether courts can assign liability' },
      areas_of_agreement: [
        { point: 'Supporting point one', povers: ['safetyist'], answers_question: false },
        { point: 'Supporting point two', povers: ['skeptic'], answers_question: false },
        { point: 'AI agents should not get legal personhood now', povers: ['accelerationist', 'safetyist', 'skeptic'], answers_question: true },
      ],
    });
    await pipeline.runSynthesis();
    const entry = added[0];
    expect((entry.metadata?.synthesis?.areas_of_agreement as { point: string }[])[0].point).toBe('AI agents should not get legal personhood now');
    const firstBullet = entry.content.split('**Areas of Agreement:**')[1].split('\n').find(l => l.startsWith('- '));
    expect(firstBullet).toMatch(/^- AI agents should not get legal personhood now/);
    expect(record.mock.calls.some(c => /answers_question/.test(c[0].message ?? ''))).toBe(false);
  });

  it('WARNs once when agreements lack answers_question, and still orders them', async () => {
    const { pipeline, added, record } = run({
      areas_of_agreement: [{ point: 'two', povers: ['skeptic'] }, { point: 'three', povers: ['accelerationist', 'safetyist', 'skeptic'] }, { point: 'bad', povers: ['skeptic'], answers_question: 'yes' }],
    });
    await pipeline.runSynthesis();
    const warns = record.mock.calls.map(c => c[0]).filter(e => /answers_question/.test(e.message ?? ''));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/missing on 2, invalid on 1/);
    // t/775 (Quality, #5603): the pipeline passes the session id through to the WARN.
    expect(warns[0].debate_id).toBe('d1');
    expect((added[0].metadata?.synthesis?.areas_of_agreement as { point: string }[]).map(a => a.point)).toEqual(['three', 'two', 'bad']);
  });
});

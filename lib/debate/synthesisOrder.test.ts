// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/769, t/770: relevance order for the synthesis lists (Design rules).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { orderAgreements, orderDisagreements, orderCruxes, orderSynthesisLists, normaliseAnswersQuestion, normaliseFlag, prepareSynthesisLists } from './synthesisOrder.js';
import { setGlobalRecorder, clearGlobalRecorder, type FlightRecorder, type RecordInput } from '../flight-recorder/index.js';
import { synthExtractPrompt, debateSynthesisPrompt } from './prompts.js';

const ALL = ['accelerationist', 'safetyist', 'skeptic'];
const points = (xs: Record<string, unknown>[]) => xs.map(x => x.point ?? x.question);

describe('orderAgreements', () => {
  it('answers_question first, then all three camps, then converged/conceded, then model order', () => {
    const out = orderAgreements([
      { point: 'plain two-camp', povers: ['accelerationist', 'safetyist'] },
      { point: 'conceded', povers: ['safetyist', 'skeptic'], conceded_by: 'skeptic' },
      { point: 'all three', povers: ALL },
      { point: 'answers', povers: ['accelerationist', 'skeptic'], answers_question: true },
      { point: 'converged', povers: ['accelerationist', 'safetyist'], converged: true },
    ]);
    expect(points(out)).toEqual(['answers', 'all three', 'conceded', 'converged', 'plain two-camp']);
  });

  it('keeps model order on ties', () => {
    const items = [{ point: 'a', povers: ALL }, { point: 'b', povers: ALL }, { point: 'c', povers: ALL }];
    expect(points(orderAgreements(items))).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing or non-boolean answers_question as false (old shape still orders)', () => {
    const out = orderAgreements([{ point: 'old', povers: ['skeptic'] }, { point: 'string true', povers: ['skeptic'], answers_question: 'true' }, { point: 'yes', povers: ['skeptic'], answers_question: true }]);
    expect(points(out)).toEqual(['yes', 'old', 'string true']);
  });
});

describe('orderDisagreements', () => {
  it('decisive flag first, then more camps, then model order (no resolution-type ranking)', () => {
    const out = orderDisagreements([
      { point: 'two camps, evidence', positions: [{ pover: 'safetyist' }, { pover: 'skeptic' }], resolvability: 'resolvable_by_evidence' },
      { point: 'three camps, terms', positions: ALL.map(p => ({ pover: p })), resolvability: 'requires_term_clarification' },
      { point: 'flagged, one camp', positions: [{ pover: 'skeptic' }], decisive: true },
      { point: 'three camps, tradeoffs', positions: ALL.map(p => ({ pover: p })), resolvability: 'negotiable_via_tradeoffs' },
    ]);
    expect(points(out)).toEqual(['flagged, one camp', 'three camps, terms', 'three camps, tradeoffs', 'two camps, evidence']);
  });

  it('without a flag (old shape), orders by camp count only and keeps ties in model order', () => {
    const out = orderDisagreements([
      { point: 'x', positions: [{ pover: 'skeptic' }] },
      { point: 'y', positions: ALL.map(p => ({ pover: p })) },
      { point: 'z', positions: [{ pover: 'safetyist' }] },
    ]);
    expect(points(out)).toEqual(['y', 'x', 'z']);
  });
});

describe('orderCruxes', () => {
  it('moves the decisive crux to the front and otherwise keeps model order', () => {
    const out = orderCruxes([{ question: 'q1' }, { question: 'q2' }, { question: 'q3', decisive: true }]);
    expect(points(out)).toEqual(['q3', 'q1', 'q2']);
  });

  it('keeps model order when nothing is flagged, and ignores a non-boolean flag', () => {
    expect(points(orderCruxes([{ question: 'q1' }, { question: 'q2', decisive: 'true' }]))).toEqual(['q1', 'q2']);
  });
});

describe('normaliseFlag / prepareSynthesisLists decisive (t/770)', () => {
  afterEach(() => clearGlobalRecorder());

  it('keeps only the first decisive in model order and counts the extras', () => {
    const items: Record<string, unknown>[] = [{ question: 'a', decisive: false }, { question: 'b', decisive: true }, { question: 'c', decisive: true }, { question: 'd', decisive: 'yes' }, { question: 'e' }];
    expect(normaliseFlag(items, 'decisive', true)).toEqual({ missing: 1, invalid: 1, extra: 1 });
    expect(items.map(i => i.decisive)).toEqual([false, true, false, undefined, undefined]);
  });

  it('prepareSynthesisLists: two decisive disagreements -> first stays true, second set false, WARN reports 1 extra (Quality, #5602)', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    const out = prepareSynthesisLists({
      areas_of_agreement: [{ point: 'a', povers: ALL, answers_question: true }],
      areas_of_disagreement: [{ point: 'd1', decisive: true, positions: [] }, { point: 'd2', decisive: true, positions: ALL.map(p => ({ pover: p })) }],
      cruxes: [{ question: 'c1', decisive: true }],
    });
    const dis = out.areas_of_disagreement as Record<string, unknown>[];
    expect(dis.map(d => [d.point, d.decisive])).toEqual([['d1', true], ['d2', false]]);
    const msgs = record.mock.calls.map(c => c[0].message ?? '');
    expect(msgs).toEqual([expect.stringMatching(/Synthesis disagreements: decisive missing on 0, invalid on 0; 1 extra true value\(s\) set to false \(first kept\)/)]);
  });

  it('prepareSynthesisLists: several decisive cruxes -> first kept on top, one WARN naming the extra', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    const out = prepareSynthesisLists({
      areas_of_agreement: [{ point: 'a', povers: ALL, answers_question: true }],
      areas_of_disagreement: [{ point: 'd1', decisive: false, positions: [] }, { point: 'd2', decisive: true, positions: [] }],
      cruxes: [{ question: 'c1', decisive: false }, { question: 'c2', decisive: true }, { question: 'c3', decisive: true }],
    });
    expect(points(out.areas_of_disagreement as Record<string, unknown>[])).toEqual(['d2', 'd1']);
    expect(points(out.cruxes as Record<string, unknown>[])).toEqual(['c2', 'c1', 'c3']);
    const msgs = record.mock.calls.map(c => c[0].message ?? '');
    expect(msgs).toEqual([expect.stringMatching(/Synthesis cruxes: decisive missing on 0, invalid on 0; 1 extra true value\(s\) set to false \(first kept\)/)]);
  });

  it('prepareSynthesisLists: a missing decisive flag WARNs once per list', () => {
    const record = vi.fn<(e: RecordInput) => void>();
    setGlobalRecorder({ record } as unknown as FlightRecorder);
    prepareSynthesisLists({ areas_of_agreement: [], areas_of_disagreement: [{ point: 'd', positions: [] }], cruxes: [{ question: 'c' }] });
    const msgs = record.mock.calls.map(c => c[0].message ?? '');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatch(/Synthesis disagreements: decisive missing on 1/);
    expect(msgs[1]).toMatch(/Synthesis cruxes: decisive missing on 1/);
  });
});

describe('camp-neutral guard (Design, t/769): swapping camp labels never changes the order', () => {
  const swap: Record<string, string> = { accelerationist: 'skeptic', skeptic: 'safetyist', safetyist: 'accelerationist' };
  const relabel = (x: Record<string, unknown>) => ({
    ...x,
    ...(Array.isArray(x.povers) ? { povers: (x.povers as string[]).map(p => swap[p]) } : {}),
    ...(Array.isArray(x.positions) ? { positions: (x.positions as { pover: string }[]).map(p => ({ ...p, pover: swap[p.pover] })) } : {}),
    ...(typeof x.conceded_by === 'string' ? { conceded_by: swap[x.conceded_by] ?? x.conceded_by } : {}),
  });
  it.each([0, 1, 2])('rotation %i', (times) => {
    const synth = {
      areas_of_agreement: [
        { point: 'a1', povers: ['accelerationist'] },
        { point: 'a2', povers: ['safetyist', 'skeptic'], conceded_by: 'skeptic' },
        { point: 'a3', povers: ALL },
        { point: 'a4', povers: ['skeptic'], answers_question: true },
      ],
      areas_of_disagreement: [
        { point: 'd1', positions: [{ pover: 'accelerationist' }] },
        { point: 'd2', positions: [{ pover: 'safetyist' }, { pover: 'skeptic' }] },
        { point: 'flagged', positions: [{ pover: 'skeptic' }], decisive: true },
      ],
      cruxes: [{ question: 'c1' }, { question: 'Do audits catch deployment failures?', decisive: true }],
    };
    let relabelled = synth as Record<string, unknown>;
    for (let i = 0; i < times; i++) {
      relabelled = { ...relabelled, areas_of_agreement: (relabelled.areas_of_agreement as Record<string, unknown>[]).map(relabel), areas_of_disagreement: (relabelled.areas_of_disagreement as Record<string, unknown>[]).map(relabel) };
    }
    const a = orderSynthesisLists(synth);
    const b = orderSynthesisLists(relabelled);
    for (const key of ['areas_of_agreement', 'areas_of_disagreement', 'cruxes'] as const) {
      expect(points(b[key] as Record<string, unknown>[])).toEqual(points(a[key] as Record<string, unknown>[]));
    }
  });
});

describe('orderSynthesisLists', () => {
  it('orders all three lists, leaves other fields alone, and is idempotent', () => {
    const synth = {
      summary: 's',
      areas_of_agreement: [{ point: 'x', povers: ['skeptic'] }, { point: 'y', povers: ['skeptic'], answers_question: true }],
      areas_of_disagreement: [{ point: 'p', positions: [{ pover: 'skeptic' }] }, { point: 'q', positions: ALL.map(p => ({ pover: p })) }],
      cruxes: [{ question: 'c1' }, { question: 'Do audits catch deployment failures?', decisive: true }],
    };
    const once = orderSynthesisLists(synth);
    expect(points(once.areas_of_agreement)).toEqual(['y', 'x']);
    expect(points(once.areas_of_disagreement)).toEqual(['q', 'p']);
    expect(points(once.cruxes)).toEqual(['Do audits catch deployment failures?', 'c1']);
    expect(once.summary).toBe('s');
    expect(orderSynthesisLists(once)).toEqual(once);
    expect(points(synth.areas_of_agreement)).toEqual(['x', 'y']);
  });

  it('leaves absent lists absent', () => {
    expect(orderSynthesisLists({ summary: 's' })).toEqual({ summary: 's' });
  });
});

describe('normaliseAnswersQuestion', () => {
  it('counts missing and invalid, and drops non-boolean values', () => {
    const items: Record<string, unknown>[] = [{ point: 'a' }, { point: 'b', answers_question: 'yes' }, { point: 'c', answers_question: true }];
    expect(normaliseAnswersQuestion(items)).toEqual({ missing: 1, invalid: 1 });
    expect('answers_question' in items[1]).toBe(false);
    expect(items[2].answers_question).toBe(true);
  });
});

describe('synthesis prompts (t/769)', () => {
  it.each([
    ['synthExtractPrompt', synthExtractPrompt('topic', 'transcript')],
    ['debateSynthesisPrompt', debateSynthesisPrompt('topic', 'transcript')],
  ])('%s asks for importance order and answers_question', (_n, p) => {
    expect(p).toContain('by importance to the debate question, most important first');
    expect(p).toContain('"answers_question": false');
    expect(p).toContain('Set "decisive": true on exactly one disagreement and exactly one crux');
    expect(p.split('"decisive": false').length - 1).toBe(2);
  });
});

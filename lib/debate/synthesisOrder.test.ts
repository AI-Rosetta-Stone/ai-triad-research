// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/769: relevance order for the synthesis lists (Design rules, t/769).

import { describe, it, expect } from 'vitest';
import { orderAgreements, orderDisagreements, orderCruxes, orderSynthesisLists, normaliseAnswersQuestion, decisiveIndex } from './synthesisOrder.js';
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
  const decisive = 'Whether liability law can assign responsibility for autonomous agent harms';
  it('decisive crux match first, then more camps, then model order (no resolution-type ranking)', () => {
    const out = orderDisagreements([
      { point: 'two camps, evidence', positions: [{ pover: 'safetyist' }, { pover: 'skeptic' }], resolvability: 'resolvable_by_evidence' },
      { point: 'three camps, terms', positions: ALL.map(p => ({ pover: p })), resolvability: 'requires_term_clarification' },
      { point: 'Who carries liability for harms caused by autonomous agents', positions: [{ pover: 'skeptic' }] },
      { point: 'three camps, tradeoffs', positions: ALL.map(p => ({ pover: p })), resolvability: 'negotiable_via_tradeoffs' },
    ], decisive);
    expect(points(out)).toEqual(['Who carries liability for harms caused by autonomous agents', 'three camps, terms', 'three camps, tradeoffs', 'two camps, evidence']);
  });

  it('without a decisive crux, orders by camp count only and keeps ties in model order', () => {
    const out = orderDisagreements([
      { point: 'x', positions: [{ pover: 'skeptic' }] },
      { point: 'y', positions: ALL.map(p => ({ pover: p })) },
      { point: 'z', positions: [{ pover: 'safetyist' }] },
    ], undefined);
    expect(points(out)).toEqual(['y', 'x', 'z']);
  });
});

describe('orderCruxes', () => {
  it('moves the decisive crux to the front and otherwise keeps model order', () => {
    const out = orderCruxes([{ question: 'q1 about compute' }, { question: 'q2 about funding' }, { question: 'Does open-weight release raise misuse risk measurably?' }], 'Whether open-weight release measurably raises misuse risk');
    expect(points(out)).toEqual(['Does open-weight release raise misuse risk measurably?', 'q1 about compute', 'q2 about funding']);
  });

  it('promotes nothing when no crux matches well enough', () => {
    expect(decisiveIndex(['about compute budgets', 'about funding'], 'Whether courts recognise agent personhood')).toBe(-1);
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
      topic_resolution: { what_would_resolve_it: 'Whether audits catch deployment failures' },
      areas_of_agreement: [
        { point: 'a1', povers: ['accelerationist'] },
        { point: 'a2', povers: ['safetyist', 'skeptic'], conceded_by: 'skeptic' },
        { point: 'a3', povers: ALL },
        { point: 'a4', povers: ['skeptic'], answers_question: true },
      ],
      areas_of_disagreement: [
        { point: 'd1', positions: [{ pover: 'accelerationist' }] },
        { point: 'd2', positions: [{ pover: 'safetyist' }, { pover: 'skeptic' }] },
        { point: 'Audits catch deployment failures', positions: [{ pover: 'skeptic' }] },
      ],
      cruxes: [{ question: 'c1' }, { question: 'Do audits catch deployment failures?' }],
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
      topic_resolution: { what_would_resolve_it: 'Whether audits catch deployment failures' },
      areas_of_agreement: [{ point: 'x', povers: ['skeptic'] }, { point: 'y', povers: ['skeptic'], answers_question: true }],
      areas_of_disagreement: [{ point: 'p', positions: [{ pover: 'skeptic' }] }, { point: 'q', positions: ALL.map(p => ({ pover: p })) }],
      cruxes: [{ question: 'c1' }, { question: 'Do audits catch deployment failures?' }],
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
  });
});

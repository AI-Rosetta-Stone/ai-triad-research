// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: attack anchors. The default-off prompt block, the engine's anchor check, the object-form
// conversion, and what later stages are given.

import { describe, it, expect, vi } from 'vitest';

// Only getGlobalRecorder is replaced, so the WARN tests can read what was recorded.
vi.mock('../../flight-recorder/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../flight-recorder/index.js')>()),
  getGlobalRecorder: vi.fn(),
}));

import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { planClaimAnchors, verifyAttackAnchors } from './attackAnchors.js';
import { applyPlanSteelmanRefs, planForLaterStages } from './steelmanRefs.js';
import { toPromptJson } from './runTurn-stages.js';
import { planOpeningStagePrompt } from '../prompts/opening.js';
import type { OpeningPlanWorkProduct } from '../types/pipeline.js';
import { POVER_INFO } from '../types.js';

const plan = (challenges: unknown[], anchors: string[] = ['saf-beliefs-203', 'saf-desires-010']): OpeningPlanWorkProduct => ({
  strategic_goal: 'g', core_thesis: 't', framing_choices: [],
  argument_structure: anchors.map(a => ({ point: 'p', evidence: 'e', taxonomy_anchor: a })),
  anticipated_challenges: challenges,
}) as unknown as OpeningPlanWorkProduct;

function withRecorder(run: () => void): { message: string; data?: Record<string, unknown> }[] {
  const record = vi.fn();
  vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
  try { run(); } finally { vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never); }
  return record.mock.calls.map(c => c[0]);
}

describe('verifyAttackAnchors (t/388)', () => {
  it('keeps a phrase whose anchor is one of the plan’s own claim anchors', () => {
    const p = plan(['ATTACK: audits miss it targeting node saf-beliefs-203']);
    const events = withRecorder(() => verifyAttackAnchors(p));
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it targeting node saf-beliefs-203']);
    expect(events).toHaveLength(0);
  });

  it('removes a phrase whose anchor is not one of the plan’s claims, and the WARN names it', () => {
    const p = plan(['ATTACK: audits miss it targeting node acc-intentions-099']);
    const events = withRecorder(() => verifyAttackAnchors(p));
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it']);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('acc-intentions-099');
    expect(events[0].data?.plan_anchors).toEqual(['saf-beliefs-203', 'saf-desires-010']);
  });

  it('accepts trailing punctuation on a valid anchor and writes the phrase in the form the card reads', () => {
    const p = plan(['ATTACK: audits miss it targeting node saf-beliefs-203.']);
    verifyAttackAnchors(p);
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it targeting node saf-beliefs-203']);
  });

  it('leaves a challenge with no phrase, or with the words mid-sentence, alone', () => {
    const items = ['ATTACK: plain objection', 'ATTACK: critics targeting node operators will object', 'ASSUMPTION: a premise'];
    const p = plan([...items]);
    const events = withRecorder(() => verifyAttackAnchors(p));
    expect(p.anticipated_challenges).toEqual(items);
    expect(events).toHaveLength(0);
  });

  it('removes every phrase when the plan has no claim anchors', () => {
    const p = plan(['ATTACK: x targeting node saf-beliefs-203'], []);
    verifyAttackAnchors(p);
    expect(p.anticipated_challenges).toEqual(['ATTACK: x']);
    expect(planClaimAnchors(p).size).toBe(0);
  });
});

describe('applyPlanSteelmanRefs with attack anchors (t/388)', () => {
  it('keeps a steelman tag and a valid anchor on the same attack', () => {
    const p = plan(['ATTACK [AN-3]: the objection targeting node saf-beliefs-203']);
    applyPlanSteelmanRefs(p, ['AN-3'], undefined, true);
    expect(p.anticipated_challenges).toEqual(['ATTACK [AN-3]: the objection targeting node saf-beliefs-203']);
  });

  it('with the flag on, runs the anchor check even when nothing was offered', () => {
    const p = plan(['ATTACK: the objection targeting node skp-beliefs-001']);
    applyPlanSteelmanRefs(p, [], undefined, true);
    expect(p.anticipated_challenges).toEqual(['ATTACK: the objection']);
  });

  it('object form: a target that is one of the plan’s claim anchors becomes the anchor phrase', () => {
    const p = plan([{ type: 'ATTACK', target: 'saf-beliefs-203', description: 'audits miss it' }]);
    applyPlanSteelmanRefs(p, ['AN-3'], undefined, true);
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it targeting node saf-beliefs-203']);
  });

  it('object form: a taxonomy target that is not one of the plan’s claims never becomes an anchor phrase', () => {
    const p = plan([{ type: 'ATTACK', target: 'acc-intentions-099', description: 'audits miss it' }]);
    applyPlanSteelmanRefs(p, ['AN-3'], undefined, true);
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it (target: acc-intentions-099)']);
  });

  it('object form: an ASSUMPTION never gets an anchor phrase', () => {
    const p = plan([{ type: 'ASSUMPTION', target: 'saf-beliefs-203', description: 'a premise' }]);
    applyPlanSteelmanRefs(p, [], undefined, true);
    expect(p.anticipated_challenges).toEqual(['ASSUMPTION: a premise (target: saf-beliefs-203)']);
  });
});

describe('planForLaterStages with attack anchors (t/388)', () => {
  it('gives later stages the attack without the tag and without the anchor phrase; the stored plan keeps both', () => {
    const p = plan(['ATTACK [AN-3]: the objection targeting node saf-beliefs-203', 'ASSUMPTION: a premise']);
    applyPlanSteelmanRefs(p, ['AN-3'], undefined, true);
    expect(planForLaterStages(p, true).anticipated_challenges).toEqual(['ATTACK: the objection', 'ASSUMPTION: a premise']);
    expect(p.anticipated_challenges[0]).toBe('ATTACK [AN-3]: the objection targeting node saf-beliefs-203');
  });

  it('passes a plan with no tag and no phrase on unchanged', () => {
    const before = toPromptJson(plan(['ATTACK: x', 'ASSUMPTION: y']));
    const p = plan(['ATTACK: x', 'ASSUMPTION: y']);
    applyPlanSteelmanRefs(p, []);
    const { steelman_refs_offered: _o, ...stored } = p;
    expect(toPromptJson(planForLaterStages(p))).toBe(before);
    expect(toPromptJson(stored)).toBe(before);
  });
});

describe('flag off: anchors are not looked at and no plan is changed (TL condition p/32#134)', () => {
  // Phrases a model might write unprompted: a valid anchor, an anchor of another camp, trailing
  // punctuation, and the words mid-sentence.
  const items = [
    'ATTACK: audits miss it targeting node saf-beliefs-203',
    'ATTACK: the objection targeting node acc-intentions-099',
    'ATTACK [AN-3]: tagged targeting node saf-beliefs-203.',
    'ASSUMPTION: a premise targeting node skp-beliefs-001',
    'ATTACK: critics targeting node operators will object',
  ];

  it('stores every challenge exactly as written, with no WARN, whether the flag is absent or false', () => {
    for (const flag of [undefined, false]) {
      const p = plan([...items]);
      const events = withRecorder(() => applyPlanSteelmanRefs(p, ['AN-3'], undefined, flag));
      expect(p.anticipated_challenges).toEqual(items);
      expect(events).toHaveLength(0);
    }
  });

  it('does not reject or alter a plan whose anchors match none of its claims', () => {
    const p = plan(['ATTACK: x targeting node nowhere-000'], []);
    expect(() => applyPlanSteelmanRefs(p, [])).not.toThrow();
    expect(p.anticipated_challenges).toEqual(['ATTACK: x targeting node nowhere-000']);
  });

  it('gives later stages the phrase untouched; only the steelman tag is removed, as before', () => {
    const p = plan([...items]);
    applyPlanSteelmanRefs(p, ['AN-3']);
    expect(planForLaterStages(p).anticipated_challenges).toEqual([
      items[0], items[1], 'ATTACK: tagged targeting node saf-beliefs-203.', items[3], items[4],
    ]);
  });

  it('object form: a target that is a claim anchor keeps the t/485 text and gets no anchor phrase', () => {
    const p = plan([{ type: 'ATTACK', target: 'saf-beliefs-203', description: 'audits miss it' }]);
    applyPlanSteelmanRefs(p, []);
    expect(p.anticipated_challenges).toEqual(['ATTACK: audits miss it (target: saf-beliefs-203)']);
  });
});

describe('plan prompt attack-anchor block (t/388)', () => {
  const base = {
    label: 'Sentinel', pov: 'safetyist', soul: POVER_INFO['safetyist'], personality: 'test', topic: 'topic',
    taxonomyContext: '', priorStatements: '', isFirst: true,
  } as never;

  it('is byte-identical when the flag is absent or false', () => {
    const absent = planOpeningStagePrompt(base, '{}');
    const off = planOpeningStagePrompt({ ...(base as object), attackAnchors: false } as never, '{}');
    expect(off).toBe(absent);
    expect(absent).not.toContain('ATTACK ANCHORS');
    expect(absent).not.toContain('targeting node');
  });

  it('adds the instruction when the flag is on, after the steelman block', () => {
    const out = planOpeningStagePrompt({ ...(base as object), attackAnchors: true, steelmanRefsOffered: [{ id: 'AN-2', steelman_of: 'skeptic', text: 's' }] } as never, '{}');
    expect(out).toContain('=== ATTACK ANCHORS ===');
    expect(out).toContain('"targeting node <taxonomy_anchor>"');
    // CL review t/485#5: the phrase is conditional, never "every ATTACK".
    expect(out).toContain('When an ATTACK hits one of YOUR OWN argument_structure claims');
    expect(out).toContain('If the attack hits none of your claims, omit the phrase.');
    expect(out).not.toContain('End every ATTACK');
    expect(out.indexOf('=== STEELMAN REFERENCES ===')).toBeLessThan(out.indexOf('=== ATTACK ANCHORS ==='));
    expect(out.indexOf('=== ATTACK ANCHORS ===')).toBeLessThan(out.indexOf('Respond ONLY with a JSON object'));
  });
});

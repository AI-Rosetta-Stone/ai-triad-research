// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: plan-level steelman references. Offer selection, plan tag handling, and the prompt block.

import { describe, it, expect, vi } from 'vitest';

// Only getGlobalRecorder is replaced, so the WARN tests can read what was recorded.
vi.mock('../flight-recorder/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../flight-recorder/index.js')>()),
  getGlobalRecorder: vi.fn(),
}));

import { getGlobalRecorder } from '../flight-recorder/index.js';
import { offeredSteelmanRefs } from './steelman.js';
import { applyPlanSteelmanRefs, planForLaterStages, stripSteelmanIdsFromStatement } from './turnPipeline/steelmanRefs.js';
import { toPromptJson } from './turnPipeline/runTurn-stages.js';
import { planOpeningStagePrompt, draftOpeningStagePrompt } from './prompts/opening.js';
import type { ArgumentNetworkNode } from './types/argumentNetwork.js';
import type { OpeningPlanWorkProduct } from './types/pipeline.js';
import { POVER_INFO } from './types.js';

const an = (id: string, steelman_of: string | undefined, source_entry_id: string, text = `text of ${id}`): ArgumentNetworkNode =>
  ({ id, text, steelman_of, source_entry_id, speaker: 'safetyist', taxonomy_refs: [], turn_number: 1 }) as unknown as ArgumentNetworkNode;

describe('offeredSteelmanRefs (t/388)', () => {
  it('offers steelmen from earlier entries that target another camp, most recent first', () => {
    const nodes = [
      an('AN-1', 'accelerationist', 'e1'),
      an('AN-2', 'skeptic', 'e2'),
      an('AN-3', 'safetyist', 'e3'),
    ];
    const out = offeredSteelmanRefs(nodes, 'safetyist');
    expect(out.map(r => r.id)).toEqual(['AN-2', 'AN-1']);
  });

  it('never offers a non-steelman node or a node with no source entry', () => {
    const nodes = [an('AN-1', 'accelerationist', ''), an('AN-2', undefined, 'e1')];
    expect(offeredSteelmanRefs(nodes, 'safetyist')).toEqual([]);
  });

  it('caps the list', () => {
    const nodes = ['e1', 'e2', 'e3'].map((e, i) => an(`AN-${i}`, 'accelerationist', e));
    expect(offeredSteelmanRefs(nodes, 'safetyist', 2)).toHaveLength(2);
  });
});

describe('applyPlanSteelmanRefs (t/388)', () => {
  const plan = (challenges: string[]): OpeningPlanWorkProduct =>
    ({ strategic_goal: 'g', core_thesis: 't', argument_structure: [], framing_choices: [], anticipated_challenges: challenges }) as OpeningPlanWorkProduct;

  it('keeps a tag whose id was offered and records the offered ids', () => {
    const p = plan(['ATTACK [AN-2]: the strongest objection']);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges[0]).toBe('ATTACK [AN-2]: the strongest objection');
    expect(p.steelman_refs_offered).toEqual(['AN-2']);
  });

  it('strips a tag that was not offered and leaves a plain ATTACK alone', () => {
    const p = plan(['ATTACK [AN-9]: invented id', 'ATTACK: plain objection']);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges).toEqual(['ATTACK: invented id', 'ATTACK: plain objection']);
  });

  it('records an empty offered list when nothing was offered', () => {
    const p = plan(['ATTACK: x']);
    applyPlanSteelmanRefs(p, []);
    expect(p.steelman_refs_offered).toEqual([]);
  });
});

describe('plan to statement path (t/388, CL review t/388#11)', () => {
  const plan = (challenges: string[]): OpeningPlanWorkProduct =>
    ({ strategic_goal: 'g', core_thesis: 't', argument_structure: [], framing_choices: [], anticipated_challenges: challenges }) as OpeningPlanWorkProduct;

  it('gives later stages the plan with no tag and no offered list, and leaves the stored plan tagged', () => {
    const p = plan(['ATTACK [AN-2]: the strongest objection', 'ASSUMPTION: a premise']);
    applyPlanSteelmanRefs(p, ['AN-2']);
    const later = planForLaterStages(p);
    expect(later.anticipated_challenges).toEqual(['ATTACK: the strongest objection', 'ASSUMPTION: a premise']);
    expect(toPromptJson(later)).not.toContain('AN-2');
    expect(p.anticipated_challenges[0]).toBe('ATTACK [AN-2]: the strongest objection');
    expect(p.steelman_refs_offered).toEqual(['AN-2']);
  });

  it('gives later stages the same JSON as before when nothing was offered', () => {
    const before = toPromptJson(plan(['ATTACK: x']));
    const p = plan(['ATTACK: x']);
    applyPlanSteelmanRefs(p, []);
    expect(toPromptJson(planForLaterStages(p))).toBe(before);
  });

  it('removes any argument id that reached the statement, offered or not, and leaves other brackets alone (widened by t/487)', () => {
    const s = 'They will object [AN-2] that costs rise. See note [1] and [AN-9].';
    const cleaned = 'They will object that costs rise. See note [1] and.';
    expect(stripSteelmanIdsFromStatement(s, ['AN-2'])).toBe(cleaned);
    expect(stripSteelmanIdsFromStatement(s, [])).toBe(cleaned);
  });
});

describe('plan prompt steelman block (t/388)', () => {
  const base = {
    label: 'Sentinel', pov: 'safetyist', soul: POVER_INFO['safetyist'], personality: 'test', topic: 'topic',
    taxonomyContext: '', priorStatements: '', isFirst: true,
  } as never;

  it('is byte-identical when no references are offered, absent or empty', () => {
    const absent = planOpeningStagePrompt(base, '{}');
    const empty = planOpeningStagePrompt({ ...(base as object), steelmanRefsOffered: [] } as never, '{}');
    expect(empty).toBe(absent);
    expect(absent).not.toContain('STEELMAN REFERENCES');
  });

  it('lists the offered ids and the tag rule when references are offered', () => {
    const out = planOpeningStagePrompt({ ...(base as object), steelmanRefsOffered: [{ id: 'AN-2', steelman_of: 'skeptic', text: 'the skeptic case' }] } as never, '{}');
    expect(out).toContain('=== STEELMAN REFERENCES ===');
    expect(out).toContain('[AN-2] (steelman of skeptic): the skeptic case');
    expect(out).toContain('"ATTACK [<id>]: ..."');
  });
});

describe('inquiry opening with both the question and steelman references (t/284 item 3 + t/388, CL note t/284#62)', () => {
  const both = {
    label: 'Sentinel', pov: 'safetyist', soul: POVER_INFO['safetyist'], personality: 'test', topic: 'topic',
    taxonomyContext: '', priorStatements: '', isFirst: false,
    anchorQuestion: 'Does regulation slow AI progress?',
    steelmanRefsOffered: [{ id: 'AN-2', steelman_of: 'skeptic', text: 'the skeptic case' }],
  } as never;

  it('puts the steelman block in the plan prompt only, and the question block in the draft prompt only', () => {
    const plan = { strategic_goal: 'g', core_thesis: 't', argument_structure: [], framing_choices: [], anticipated_challenges: ['ATTACK [AN-2]: the strongest objection'] } as OpeningPlanWorkProduct;
    applyPlanSteelmanRefs(plan, ['AN-2']);

    const planPrompt = planOpeningStagePrompt(both, '{}');
    expect(planPrompt).toContain('=== STEELMAN REFERENCES ===');
    expect(planPrompt).not.toContain('=== THE QUESTION ===');

    const draftPrompt = draftOpeningStagePrompt(both, '{}', toPromptJson(planForLaterStages(plan)));
    expect(draftPrompt).toContain('=== THE QUESTION ===');
    expect(draftPrompt).toContain('Does regulation slow AI progress?');
    expect(draftPrompt).not.toContain('STEELMAN REFERENCES');
    expect(draftPrompt).not.toContain('AN-2');
    expect(draftPrompt).toContain('ATTACK: the strongest objection');
  });
});

describe('anticipated challenges returned as objects (t/485)', () => {
  const plan = (challenges: unknown[]): OpeningPlanWorkProduct =>
    ({ strategic_goal: 'g', core_thesis: 't', argument_structure: [], framing_choices: [], anticipated_challenges: challenges }) as unknown as OpeningPlanWorkProduct;

  it('an ATTACK object whose target is an offered steelman id becomes a tagged string', () => {
    const p = plan([{ type: 'ATTACK', target: 'AN-2', description: 'the strongest objection' }]);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges).toEqual(['ATTACK [AN-2]: the strongest objection']);
    expect(toPromptJson(planForLaterStages(p))).not.toContain('AN-2');
  });

  it('an AN id that was not offered is dropped: plain ATTACK, description kept, id nowhere in the plan or later prompts', () => {
    const record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    const p = plan([{ type: 'ATTACK', target: 'AN-7', description: 'invented id' }]);
    try {
      applyPlanSteelmanRefs(p, ['AN-2']);
    } finally {
      vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never);
    }
    expect(p.anticipated_challenges).toEqual(['ATTACK: invented id']);
    expect(toPromptJson(planForLaterStages(p))).not.toContain('AN-7');
    const warn = record.mock.calls.map(c => c[0]).find(e => String(e.message).includes('t/485'));
    expect(warn.message).toContain('target AN-7 is not in steelman_refs_offered and was dropped');
    expect(warn.data.dropped_target).toBe('AN-7');
  });

  it('an unoffered AN id is dropped even when the item has no usable text', () => {
    const p = plan([{ type: 'ATTACK', target: 'AN-7' }]);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges).toEqual(['ATTACK: {"type":"ATTACK"}']);
  });

  it('keeps the type label the model wrote, and uses OTHER when there is none', () => {
    const p = plan([{ type: 'risk', description: 'a risk' }, { description: 'untyped' }, { type: '{bad}', description: 'odd' }]);
    applyPlanSteelmanRefs(p, []);
    expect(p.anticipated_challenges).toEqual(['RISK: a risk', 'OTHER: untyped', 'OTHER: odd']);
  });

  it('a taxonomy node id as target never matches the steelman list, even with a non-empty offer', () => {
    // The live case from session 26b17ef3: target is a taxonomy node id, not an AN id.
    const p = plan([
      { type: 'ATTACK', target: 'acc-intentions-099', description: 'Strict liability fails to capture diffuse harms.' },
      { type: 'ASSUMPTION', target: 'acc-intentions-078', description: 'Auditors have the capacity.' },
    ]);
    applyPlanSteelmanRefs(p, ['AN-9', 'AN-3']);
    expect(p.anticipated_challenges).toEqual([
      'ATTACK: Strict liability fails to capture diffuse harms. (target: acc-intentions-099)',
      'ASSUMPTION: Auditors have the capacity. (target: acc-intentions-078)',
    ]);
    expect(p.anticipated_challenges.some(c => /^ATTACK \[/.test(c))).toBe(false);
    expect(p.steelman_refs_offered).toEqual(['AN-9', 'AN-3']);
  });

  it('an ASSUMPTION object is never tagged, even when its target is an offered id', () => {
    const p = plan([{ type: 'assumption', target: 'AN-2', description: 'a premise' }]);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges).toEqual(['ASSUMPTION: a premise (target: AN-2)']);
  });

  it('leaves string items exactly as they were, mixed with objects', () => {
    const p = plan(['ATTACK [AN-2]: kept', 'ASSUMPTION: plain', { type: 'ATTACK', description: 'no target' }]);
    applyPlanSteelmanRefs(p, ['AN-2']);
    expect(p.anticipated_challenges).toEqual(['ATTACK [AN-2]: kept', 'ASSUMPTION: plain', 'ATTACK: no target']);
  });

  it('keeps an item with no usable text as its JSON, so nothing is dropped', () => {
    const p = plan([{ type: 'ATTACK', target: 'acc-intentions-099' }, 42]);
    applyPlanSteelmanRefs(p, []);
    // The kept JSON already shows the target, so it is not appended a second time (t/485#4, t/487).
    expect(p.anticipated_challenges).toEqual(['ATTACK: {"type":"ATTACK","target":"acc-intentions-099"}', 'OTHER: 42']);
  });

  it('records one WARN per converted object, with the original, and none for strings', () => {
    const record = vi.fn();
    vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
    try {
      const p = plan(['ATTACK: plain', { type: 'ATTACK', target: 'acc-intentions-099', description: 'd1' }, { type: 'ASSUMPTION', description: 'd2' }]);
      applyPlanSteelmanRefs(p, ['AN-2']);
    } finally {
      vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never);
    }
    const warns = record.mock.calls.map(c => c[0]).filter(e => String(e.message).includes('t/485'));
    expect(warns).toHaveLength(2);
    expect(warns[0]).toMatchObject({ level: 'warn', component: 'turn-pipeline' });
    expect(warns[0].data.original).toContain('acc-intentions-099');
  });
});

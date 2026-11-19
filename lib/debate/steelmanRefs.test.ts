// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/388: plan-level steelman references. Offer selection, plan tag handling, and the prompt block.

import { describe, it, expect } from 'vitest';
import { offeredSteelmanRefs } from './steelman.js';
import { applyPlanSteelmanRefs } from './turnPipeline/steelmanRefs.js';
import { planOpeningStagePrompt } from './prompts/opening.js';
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
    const out = offeredSteelmanRefs(nodes, 'safetyist', 'e4');
    expect(out.map(r => r.id)).toEqual(['AN-2', 'AN-1']);
  });

  it('never offers the current entry or a non-steelman node', () => {
    const nodes = [an('AN-1', 'accelerationist', 'e4'), an('AN-2', undefined, 'e1')];
    expect(offeredSteelmanRefs(nodes, 'safetyist', 'e4')).toEqual([]);
  });

  it('caps the list', () => {
    const nodes = ['e1', 'e2', 'e3'].map((e, i) => an(`AN-${i}`, 'accelerationist', e));
    expect(offeredSteelmanRefs(nodes, 'safetyist', 'e9', 2)).toHaveLength(2);
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

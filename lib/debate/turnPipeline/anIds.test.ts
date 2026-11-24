// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/487: argument-network ids in prose. The stored plan keeps what the model wrote and gets a WARN;
// later stages and the statement never get an AN id.

import { describe, it, expect, vi } from 'vitest';

// Only getGlobalRecorder is replaced, so the WARN tests can read what was recorded.
vi.mock('../../flight-recorder/index.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../flight-recorder/index.js')>()),
  getGlobalRecorder: vi.fn(),
}));

import { getGlobalRecorder } from '../../flight-recorder/index.js';
import { maskAnIds, AN_ID_WORDS } from './anIds.js';
import { applyPlanSteelmanRefs, planForLaterStages, stripSteelmanIdsFromStatement } from './steelmanRefs.js';
import { toPromptJson } from './runTurn-stages.js';
import type { OpeningPlanWorkProduct } from '../types/pipeline.js';

const plan = (challenges: string[]): OpeningPlanWorkProduct =>
  ({ strategic_goal: 'g', core_thesis: 't', argument_structure: [], framing_choices: [], anticipated_challenges: challenges }) as OpeningPlanWorkProduct;

function withRecorder(run: () => void): { message: string; data?: Record<string, unknown> }[] {
  const record = vi.fn();
  vi.mocked(getGlobalRecorder).mockReturnValue({ record } as never);
  try { run(); } finally { vi.mocked(getGlobalRecorder).mockReturnValue(undefined as never); }
  return record.mock.calls.map(c => c[0]);
}

describe('maskAnIds (t/487)', () => {
  it('removes a bracketed or parenthesised id with its brackets and one leading space', () => {
    expect(maskAnIds('They object [AN-7] that costs rise (AN-12).').text).toBe('They object that costs rise.');
  });

  it('replaces a bare id with words, so the sentence survives', () => {
    expect(maskAnIds("This answers AN-7's point about audits.").text).toBe(`This answers ${AN_ID_WORDS}'s point about audits.`);
  });

  it('matches whole ids only: CAN-7, AN-7b and SCAN-12 are untouched, and AN-70 is its own id', () => {
    const s = 'CAN-7 and SCAN-12 and AN-7b stay; AN-70 goes.';
    const r = maskAnIds(s);
    expect(r.text).toBe(`CAN-7 and SCAN-12 and AN-7b stay; ${AN_ID_WORDS} goes.`);
    expect(r.masked).toEqual(['AN-70']);
  });

  it('keeps the ids it is told to keep', () => {
    const r = maskAnIds('See AN-2 and AN-9.', new Set(['AN-2']));
    expect(r.text).toBe(`See AN-2 and ${AN_ID_WORDS}.`);
    expect(r.masked).toEqual(['AN-9']);
  });

  it('returns text with no AN id unchanged, the same string', () => {
    const s = 'Audits [1] miss dual-use risk (see note 3).';
    const r = maskAnIds(s);
    expect(r.text).toBe(s);
    expect(r.masked).toEqual([]);
  });
});

describe('stored plan: an unoffered AN id in prose is reported, not changed (t/487, CL ruling p/183#60)', () => {
  it('keeps the challenge exactly as the model wrote it and records one WARN naming the id', () => {
    const items = ["ATTACK: this answers AN-7's point about audits", 'ATTACK [AN-2]: tagged, and it also cites (AN-9) and AN-2', 'ASSUMPTION: plain'];
    const p = plan([...items]);
    const events = withRecorder(() => applyPlanSteelmanRefs(p, ['AN-2']));
    expect(p.anticipated_challenges).toEqual(items);
    const warns = events.filter(e => e.message.includes('t/487'));
    expect(warns).toHaveLength(2);
    expect(warns[0].data?.unoffered_ids).toEqual(['AN-7']);
    // The offered id in the tag and in the prose is not reported; the unoffered AN-9 is.
    expect(warns[1].data?.unoffered_ids).toEqual(['AN-9']);
  });

  it('records nothing when the only AN id is the offered tag', () => {
    const p = plan(['ATTACK [AN-2]: the strongest objection']);
    const events = withRecorder(() => applyPlanSteelmanRefs(p, ['AN-2']));
    expect(events.filter(e => e.message.includes('t/487'))).toHaveLength(0);
  });
});

describe('later stages: no AN id in a challenge, offered or not (t/487)', () => {
  it('masks ids in prose and removes the tag, without a WARN', () => {
    const p = plan(["ATTACK: this answers AN-7's point about audits", 'ATTACK [AN-2]: tagged, and it also cites (AN-9) and AN-2']);
    applyPlanSteelmanRefs(p, ['AN-2']);
    let later: OpeningPlanWorkProduct | undefined;
    const events = withRecorder(() => { later = planForLaterStages(p); });
    expect(later!.anticipated_challenges).toEqual([
      `ATTACK: this answers ${AN_ID_WORDS}'s point about audits`,
      `ATTACK: tagged, and it also cites and ${AN_ID_WORDS}`,
    ]);
    expect(toPromptJson(later)).not.toMatch(/\bAN-\d+\b/);
    expect(events).toHaveLength(0);
  });

  it('passes a plan with no AN id on byte for byte', () => {
    const before = toPromptJson(plan(['ATTACK: x [1]', 'ASSUMPTION: y (see CAN-7)']));
    const p = plan(['ATTACK: x [1]', 'ASSUMPTION: y (see CAN-7)']);
    applyPlanSteelmanRefs(p, []);
    expect(toPromptJson(planForLaterStages(p))).toBe(before);
  });
});

describe('statement guard: any AN id is masked, bracketed or bare, offered or not (t/487)', () => {
  it('masks an offered id, an unoffered id and a bare id, with one WARN and a count', () => {
    const s = "They will object [AN-2] that costs rise. See note [1] and [AN-9]. AN-4's reply fails.";
    let out = '';
    const events = withRecorder(() => { out = stripSteelmanIdsFromStatement(s, ['AN-2']); });
    expect(out).toBe(`They will object that costs rise. See note [1] and. ${AN_ID_WORDS}'s reply fails.`);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('statement carried 3 argument id(s)');
    expect(events[0].data).toMatchObject({ masked_ids: ['AN-2', 'AN-9', 'AN-4'], offered: ['AN-2'] });
  });

  it('works when nothing was offered', () => {
    expect(stripSteelmanIdsFromStatement('As AN-3 shows, audits fail.', [])).toBe(`As ${AN_ID_WORDS} shows, audits fail.`);
  });

  it('returns a statement with no AN id unchanged, with no WARN', () => {
    const s = 'Labs must publish results [1]. CAN-7 is a bus standard.';
    let out = '';
    const events = withRecorder(() => { out = stripSteelmanIdsFromStatement(s, ['AN-2']); });
    expect(out).toBe(s);
    expect(events).toHaveLength(0);
  });
});

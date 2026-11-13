// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285: directAnswer, per-camp answeredLiteralQuestion and questionDrift are additive optional fields.
// Old results must still load, and the rules from the TL's t/285#3 review must hold.

import { describe, it, expect } from 'vitest';
import { InquiryResultSchema, DirectAnswerSchema, QuestionDriftSchema } from './schema.js';
import { makeValidResult, makeOnQuestionResult, makeDriftedResult } from './__fixtures__/validResult.js';

describe('t/285 question drift schema', () => {
  it('an old v1 result without the new fields still loads unchanged', () => {
    const parsed = InquiryResultSchema.safeParse(makeValidResult());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.directAnswer).toBeUndefined();
    expect(parsed.success && parsed.data.questionDrift).toBeUndefined();
  });

  it('an on-question result loads with its direct answer and no drift warning', () => {
    const parsed = InquiryResultSchema.safeParse(makeOnQuestionResult());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.directAnswer?.agreement).toBe('consensus');
    expect(parsed.success && parsed.data.questionDrift?.warning).toBe(false);
  });

  it('a drifted result loads with the warning, the debated topic and the per-camp flag', () => {
    const parsed = InquiryResultSchema.safeParse(makeDriftedResult());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.questionDrift?.warning).toBe(true);
    expect(parsed.success && parsed.data.questionDrift?.debatedTopic).toContain('regulation');
    expect(parsed.success && parsed.data.campVerdicts[0].answeredLiteralQuestion).toBe(false);
  });

  it('questionDrift requires a warning boolean when the block is present (TL t/285#3 item 4)', () => {
    expect(QuestionDriftSchema.safeParse({ debatedTopic: 'x' }).success).toBe(false);
    expect(QuestionDriftSchema.safeParse({ warning: true }).success).toBe(true);
  });

  it('directAnswer.agreement is consensus or split only (TL t/285#3 item 6)', () => {
    expect(DirectAnswerSchema.safeParse({ text: 'Yes.', agreement: 'consensus' }).success).toBe(true);
    expect(DirectAnswerSchema.safeParse({ text: 'Yes.', agreement: 'maybe' }).success).toBe(false);
    expect(DirectAnswerSchema.safeParse({ text: 'Yes.', consensus: 'consensus' }).success).toBe(false);
  });

  it('answerNote is capped at 300 characters (TL t/285#3 item 7)', () => {
    const base = makeValidResult();
    const withNote = (note: string) => ({
      ...base,
      campVerdicts: [{ ...(base.campVerdicts as object[])[0], answerNote: note }],
    });
    expect(InquiryResultSchema.safeParse(withNote('a'.repeat(300))).success).toBe(true);
    expect(InquiryResultSchema.safeParse(withNote('a'.repeat(301))).success).toBe(false);
  });

  it('the drift score is bounded to 0–1 and the debated topic is spelled debatedTopic (TL item 3)', () => {
    expect(QuestionDriftSchema.safeParse({ warning: false, driftScore: 1.2 }).success).toBe(false);
    expect(QuestionDriftSchema.safeParse({ warning: false, driftScore: 0.5 }).success).toBe(true);
    expect(QuestionDriftSchema.shape).toHaveProperty('debatedTopic');
    expect(QuestionDriftSchema.shape).not.toHaveProperty('debtedTopic');
    expect(QuestionDriftSchema.shape).not.toHaveProperty('userQuestion');
  });
});

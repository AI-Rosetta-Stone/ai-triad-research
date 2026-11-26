// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285: the synthesis answers the question as asked, and flags when the debate drifted from it.

import { describe, it, expect } from 'vitest';
import {
  buildDirectAnswerField,
  buildQuestionDrift,
  campAnswerFields,
  debatedTopicOf,
} from './inquirySynthesis.js';
import { inquirySynthesisPrompt } from './prompts/inquiry.js';
import { QuestionDriftSchema } from '../inquiry/schema.js';

describe('t/285 directAnswer', () => {
  it('keeps a valid answer', () => {
    expect(buildDirectAnswerField({ text: 'Yes.', agreement: 'consensus' })).toEqual({
      directAnswer: { text: 'Yes.', agreement: 'consensus' },
    });
  });

  it('omits a missing answer rather than fabricating one', () => {
    expect(buildDirectAnswerField(undefined)).toEqual({});
  });

  it('omits an answer that fails the schema, e.g. an unknown agreement value', () => {
    expect(buildDirectAnswerField({ text: 'Yes.', agreement: 'maybe' })).toEqual({});
  });
});

describe('t/285 debated topic', () => {
  it('is absent when the debate ran on the question as asked (case and spacing ignored)', () => {
    expect(debatedTopicOf('What is harm?', '  what is harm?  ')).toBeUndefined();
  });

  it('is the session topic when the debate ran on a rewritten topic', () => {
    expect(debatedTopicOf('What is harm?', 'How should harm be defined in policy?')).toBe(
      'How should harm be defined in policy?',
    );
  });

  it('omits an over-long topic rather than truncating it or failing the result (TL t/285#50 item 3)', () => {
    expect(debatedTopicOf('What is harm?', 'a'.repeat(300))).toBe('a'.repeat(300));
    expect(debatedTopicOf('What is harm?', 'a'.repeat(301))).toBeUndefined();
    const drift = buildQuestionDrift({ debatedTopic: debatedTopicOf('What is harm?', 'a'.repeat(301)) });
    expect(drift).not.toHaveProperty('debatedTopic');
    expect(QuestionDriftSchema.safeParse(drift).success).toBe(true);
  });

  it('omits an over-long direct answer rather than failing the result (TL t/285#50 item 3)', () => {
    expect(buildDirectAnswerField({ text: 'a'.repeat(1001), agreement: 'consensus' })).toEqual({});
  });

  it('is absent when the session has no final topic', () => {
    expect(debatedTopicOf('What is harm?', undefined)).toBeUndefined();
  });
});

describe('t/285 per-camp answer flags', () => {
  it('keeps the flag and a note within 300 characters', () => {
    expect(campAnswerFields({ camp: 'acc', verdict: 'v', answeredLiteralQuestion: false, answerNote: 'Focused on X.' })).toEqual({
      answeredLiteralQuestion: false,
      answerNote: 'Focused on X.',
    });
  });

  it('omits an over-long note rather than truncating it', () => {
    const out = campAnswerFields({ camp: 'acc', verdict: 'v', answerNote: 'a'.repeat(301) });
    expect(out).not.toHaveProperty('answerNote');
  });

  it('leaves the flag absent when the model did not say, so unknown does not warn', () => {
    expect(campAnswerFields({ camp: 'acc', verdict: 'v' })).toEqual({});
  });
});

describe('t/285 question drift block', () => {
  it('never carries a warning: a camp flag cannot raise one (TL t/285#53, t/496)', () => {
    // The builder takes no camp flags at all; a caller that passes them anyway still gets no warning.
    const withFlags = { debatedTopic: 'Other topic', campVerdicts: [{ answeredLiteralQuestion: false }] };
    expect(buildQuestionDrift(withFlags)).not.toHaveProperty('warning');
    expect(buildQuestionDrift({})).not.toHaveProperty('warning');
    expect(buildQuestionDrift({ driftScore: 0.9 })).not.toHaveProperty('warning');
  });

  it('carries the debated topic and score through when present, and is always a block', () => {
    expect(buildQuestionDrift({ debatedTopic: 'Other topic' })).toEqual({ debatedTopic: 'Other topic' });
    expect(buildQuestionDrift({ driftScore: 0.4 })).toEqual({ driftScore: 0.4 });
    expect(buildQuestionDrift({})).toEqual({});
  });
});

describe('t/285 synthesis prompt', () => {
  it('shows the question as asked and the debated topic side by side when they differ', () => {
    const p = inquirySynthesisPrompt('What is harm?', 'h', 's', 'g', 'How should harm be defined?');
    expect(p).toContain('QUESTION (as asked): "What is harm?"');
    expect(p).toContain('TOPIC THE DEBATE ADDRESSED (rewritten from the question): "How should harm be defined?"');
  });

  it('keeps the single QUESTION line when the debate ran on the question as asked', () => {
    const p = inquirySynthesisPrompt('What is harm?', 'h', 's', 'g');
    expect(p).toContain('QUESTION: "What is harm?"');
    expect(p).not.toContain('TOPIC THE DEBATE ADDRESSED');
  });

  it('asks for the direct answer first and the per-camp answer flags', () => {
    const p = inquirySynthesisPrompt('What is harm?', 'h', 's', 'g');
    expect(p).toContain('DIRECT ANSWER (produce this first');
    expect(p).toContain('answeredLiteralQuestion');
    expect(p.indexOf('DIRECT ANSWER')).toBeLessThan(p.indexOf('1. campVerdicts'));
  });
});

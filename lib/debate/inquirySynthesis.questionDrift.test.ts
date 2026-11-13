// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285: the synthesis answers the question as asked, and flags when the debate drifted from it.

import { describe, it, expect } from 'vitest';
import {
  buildDirectAnswerField,
  buildQuestionDrift,
  campAnswerFields,
  debatedTopicOf,
  DRIFT_WARN_THRESHOLD,
} from './inquirySynthesis.js';
import { inquirySynthesisPrompt } from './prompts/inquiry.js';

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

describe('t/285 question drift warning (post-check)', () => {
  it('is raised when any camp did not answer the question', () => {
    const drift = buildQuestionDrift({
      campVerdicts: [{ answeredLiteralQuestion: true }, { answeredLiteralQuestion: false }],
    });
    expect(drift.warning).toBe(true);
  });

  it('is not raised when every camp answered, or the flags are unknown', () => {
    expect(buildQuestionDrift({ campVerdicts: [{ answeredLiteralQuestion: true }] }).warning).toBe(false);
    expect(buildQuestionDrift({ campVerdicts: [{}] }).warning).toBe(false);
  });

  it('is raised at or over the drift threshold, and not below it', () => {
    expect(DRIFT_WARN_THRESHOLD).toBe(0.3);
    expect(buildQuestionDrift({ campVerdicts: [], driftScore: 0.3 }).warning).toBe(true);
    expect(buildQuestionDrift({ campVerdicts: [], driftScore: 0.29 }).warning).toBe(false);
  });

  it('carries the debated topic and score through when present, and is always a block', () => {
    expect(buildQuestionDrift({ debatedTopic: 'Other topic', campVerdicts: [] })).toEqual({
      debatedTopic: 'Other topic',
      warning: false,
    });
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

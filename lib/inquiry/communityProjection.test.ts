// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285 (TL p/35#87): the community projection drops the gated warning, and gates directAnswer on degraded runs.

import { describe, it, expect } from 'vitest';
import type { InquiryResult } from './schema.js';
import { toCommunityInquiryResult } from './communityProjection.js';
import { exportableResult } from './inquiryExport.js';
import { toPublicInquiryShare } from './publicShare.js';
import { makeOnQuestionResult, makeDriftedResult } from './__fixtures__/validResult.js';

const asResult = (r: Record<string, unknown>) => r as unknown as InquiryResult;

const censored = [{ metric: 'convergence', value: 0, trust: { verdict: 'censored', reason: 'ceiling', terminationReason: 'api_ceiling' } }];

describe('t/285 community projection: questionDrift', () => {
  it('drops questionDrift.warning, keeps debatedTopic and driftScore (no user data)', () => {
    const result = asResult({
      ...makeDriftedResult(),
      questionDrift: { debatedTopic: 'How should AI regulation be designed?', driftScore: 0.4, warning: true },
    });
    const out = toCommunityInquiryResult(result);
    expect(out.questionDrift).toEqual({ debatedTopic: 'How should AI regulation be designed?', driftScore: 0.4 });
    expect(out.questionDrift).not.toHaveProperty('warning');
  });

  it('drops the warning even when it is false, and the block survives as its other fields', () => {
    const out = toCommunityInquiryResult(asResult(makeOnQuestionResult()));
    expect(out.questionDrift).toEqual({});
  });

  it('does not mutate the stored result', () => {
    const result = asResult(makeDriftedResult());
    toCommunityInquiryResult(result);
    expect((result as { questionDrift?: { warning?: boolean } }).questionDrift?.warning).toBe(true);
  });
});

describe('t/285 community projection: per-camp answer flags (TL t/285#53)', () => {
  it('drops each camp’s answeredLiteralQuestion and answerNote, and keeps the verdict', () => {
    const result = asResult(makeDriftedResult());
    expect(JSON.stringify(result)).toContain('answerNote'); // the fixture does carry them
    const out = toCommunityInquiryResult(result);
    expect(out.campVerdicts.length).toBe(result.campVerdicts.length);
    for (const cv of out.campVerdicts) {
      expect(cv).not.toHaveProperty('answeredLiteralQuestion');
      expect(cv).not.toHaveProperty('answerNote');
      expect(cv).toHaveProperty('verdict');
    }
    // The stored result keeps them for the validation sample.
    expect(result.campVerdicts[0]).toHaveProperty('answeredLiteralQuestion', false);
  });
});

describe('t/285 projections copy named fields only (Quality t/285#54, TL t/285#55)', () => {
  // The stored objects are passthrough, so a stored result can carry a key no surface has classified.
  const withStrays = (): InquiryResult => {
    const base = makeOnQuestionResult() as Record<string, any>;
    return asResult({
      ...base,
      directAnswer: { ...base.directAnswer, strayAnswerKey: 'leak-a' },
      questionDrift: { debatedTopic: 'Other topic', strayDriftKey: 'leak-d' },
      campVerdicts: base.campVerdicts.map((cv: object) => ({ ...cv, strayCampKey: 'leak-c' })),
    });
  };

  it('the community projection drops unknown keys on directAnswer, questionDrift and each camp verdict', () => {
    const out = toCommunityInquiryResult(withStrays());
    expect(out.directAnswer).toEqual({ text: expect.any(String), agreement: 'consensus' });
    expect(out.questionDrift).toEqual({ debatedTopic: 'Other topic' });
    expect(JSON.stringify(out)).not.toMatch(/leak-[adc]/);
  });

  it('the export projection drops them too', () => {
    const out = exportableResult(withStrays());
    expect(out.directAnswer).toEqual({ text: expect.any(String), agreement: 'consensus' });
    expect(JSON.stringify(out)).not.toMatch(/leak-[adc]/);
  });

  it('the public share drops them too', () => {
    const base = withStrays();
    const healthy = asResult({ ...base, calibration: [{ metric: 'convergence', value: 1, trust: { verdict: 'trust', reason: 'natural', terminationReason: 'natural' } }] });
    const share = toPublicInquiryShare(healthy);
    expect(share.directAnswer).toEqual({ text: expect.any(String), agreement: 'consensus' });
    expect(JSON.stringify(share)).not.toMatch(/leak-[adc]/);
  });
});

describe('t/285 community projection: directAnswer Condition A', () => {
  it('keeps directAnswer on a healthy run', () => {
    const out = toCommunityInquiryResult(asResult(makeOnQuestionResult()));
    expect(out.directAnswer).toEqual({ text: 'Yes: any foreseeable downstream effect counts as harm.', agreement: 'consensus' });
  });

  it('omits directAnswer on a censored run, using the same predicate as the public share', () => {
    const degraded = asResult({ ...makeOnQuestionResult(), calibration: censored });
    const out = toCommunityInquiryResult(degraded);
    expect(out).not.toHaveProperty('directAnswer');
  });

  it('keeps the rest of the result on a degraded run (only the answer is gated)', () => {
    const degraded = asResult({ ...makeOnQuestionResult(), calibration: censored });
    const out = toCommunityInquiryResult(degraded);
    // The camp verdicts survive, minus the gated per-camp flags (TL t/285#53).
    expect(out.campVerdicts).toEqual(
      degraded.campVerdicts.map((cv) => ({ camp: cv.camp, verdict: cv.verdict, nodes: cv.nodes })),
    );
    expect(out.singleRunCaveat).toBe(degraded.singleRunCaveat);
  });
});

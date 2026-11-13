// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285 (TL p/35#87): the community projection drops the gated warning, and gates directAnswer on degraded runs.

import { describe, it, expect } from 'vitest';
import type { InquiryResult } from './schema.js';
import { toCommunityInquiryResult } from './communityProjection.js';
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
    expect(out.campVerdicts).toEqual(degraded.campVerdicts);
    expect(out.singleRunCaveat).toBe(degraded.singleRunCaveat);
  });
});

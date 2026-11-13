// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { toPublicInquiryShare } from '../publicShare.js';
import type { InquiryResult, CalibrationEntry } from '../schema.js';

function makeCalibration(trust: CalibrationEntry['trust']): CalibrationEntry[] {
  return [{ metric: 'convergence', value: 0.7, trust }];
}

function makeResult(overrides: Partial<InquiryResult> = {}): InquiryResult {
  return {
    schemaVersion: 1,
    request: { question: 'Test?', fidelity: 'quick' },
    campVerdicts: [],
    convergences: [],
    evidenceLayers: [],
    unresolvedGaps: [],
    calibration: makeCalibration({ verdict: 'trust', reason: 'sufficient rounds' }),
    derivation: { fidelity: 'quick', models: { debater: 'model-a' }, rounds: 3, callBudget: 10 },
    grounding: { nodesByCamp: {} },
    singleRunCaveat: 'Single run — results may vary.',
    ...overrides,
  } as InquiryResult;
}

describe('toPublicInquiryShare — synthesizedHeadline Condition A', () => {
  it('includes synthesizedHeadline on a healthy run (natural termination, trust verdict)', () => {
    const result = makeResult({
      synthesizedHeadline: 'Three camps split on timing.',
      calibration: makeCalibration({ verdict: 'trust', reason: 'natural', terminationReason: 'natural' }),
    });
    expect(toPublicInquiryShare(result).synthesizedHeadline).toBe('Three camps split on timing.');
  });

  it('suppresses synthesizedHeadline when verdict is censored', () => {
    const result = makeResult({
      synthesizedHeadline: 'Should not appear.',
      calibration: makeCalibration({ verdict: 'censored', reason: 'api_ceiling reached', terminationReason: 'api_ceiling' }),
    });
    expect(toPublicInquiryShare(result).synthesizedHeadline).toBeUndefined();
  });

  it.each(['max_iterations', 'situation_cap', 'api_ceiling'] as const)(
    'suppresses synthesizedHeadline when terminationReason is %s (trust verdict passes, run is truncated)',
    (terminationReason) => {
      const result = makeResult({
        synthesizedHeadline: 'Should not appear.',
        calibration: makeCalibration({ verdict: 'trust', reason: 'truncated', terminationReason }),
      });
      expect(toPublicInquiryShare(result).synthesizedHeadline).toBeUndefined();
    },
  );

  it('omits synthesizedHeadline when undefined (generator did not produce one)', () => {
    const result = makeResult({ synthesizedHeadline: undefined });
    expect(toPublicInquiryShare(result).synthesizedHeadline).toBeUndefined();
  });
});

describe('toPublicInquiryShare — t/285 directAnswer Condition A and questionDrift', () => {
  it('includes directAnswer and questionDrift on a healthy run', () => {
    const result = makeResult({
      directAnswer: { text: 'Yes.', agreement: 'consensus' },
      questionDrift: { debatedTopic: 'Other topic', warning: true },
      calibration: makeCalibration({ verdict: 'trust', reason: 'natural', terminationReason: 'natural' }),
    });
    const share = toPublicInquiryShare(result);
    expect(share.directAnswer).toEqual({ text: 'Yes.', agreement: 'consensus' });
    // The warning is gated (t/285#7): the public share carries the topic, never the warning.
    expect(share.questionDrift).toEqual({ debatedTopic: 'Other topic' });
  });

  it('suppresses directAnswer on a censored run, as for the headline, but keeps questionDrift', () => {
    const result = makeResult({
      directAnswer: { text: 'Should not appear.', agreement: 'consensus' },
      questionDrift: { debatedTopic: 'Other topic', warning: true },
      calibration: makeCalibration({ verdict: 'censored', reason: 'api_ceiling reached', terminationReason: 'api_ceiling' }),
    });
    const share = toPublicInquiryShare(result);
    expect(share.directAnswer).toBeUndefined();
    expect(share.questionDrift).toEqual({ debatedTopic: 'Other topic' });
    expect(share).not.toHaveProperty('questionDrift.warning');
  });

  it('carries the per-camp answer flag and note on a healthy run', () => {
    const base = makeResult({
      calibration: makeCalibration({ verdict: 'trust', reason: 'natural', terminationReason: 'natural' }),
    });
    const node = { nodeId: 'skp-beliefs-029', label: 'Precaution', camp: 'skp' as const };
    const withFlag = {
      ...base,
      campVerdicts: [{ camp: 'acc' as const, verdict: 'v', nodes: [node], answeredLiteralQuestion: false, answerNote: 'Focused on X.' }],
    } as InquiryResult;
    const cv = toPublicInquiryShare(withFlag).campVerdicts[0];
    expect(cv.answeredLiteralQuestion).toBe(false);
    expect(cv.answerNote).toBe('Focused on X.');
  });
});

describe('toPublicInquiryShare — synthesizedHeadline Condition B', () => {
  it('suppresses synthesizedHeadline when over HEADLINE_MAX_CHARS (400 chars)', () => {
    const result = makeResult({ synthesizedHeadline: 'x'.repeat(401) });
    expect(toPublicInquiryShare(result).synthesizedHeadline).toBeUndefined();
  });

  it('includes synthesizedHeadline at exactly HEADLINE_MAX_CHARS', () => {
    const headline = 'x'.repeat(400);
    const result = makeResult({ synthesizedHeadline: headline });
    expect(toPublicInquiryShare(result).synthesizedHeadline).toBe(headline);
  });
});

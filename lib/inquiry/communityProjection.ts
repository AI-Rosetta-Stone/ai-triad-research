// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285 (TL p/35#87): the community projection of an InquiryResult, applied before the result leaves for the
// community draft endpoint. Two rules:
//  1. questionDrift.warning is dropped. It is gated (CL t/285#7, notes 1 and 3) until a validation rate is reported.
//     debatedTopic and driftScore stay: they carry no user data.
//  2. directAnswer is omitted on a degraded run, using the same predicate as the public share (Condition A).
// Everything else passes through, as the community column of fieldClassification.ts includes it.

import type { InquiryResult, QuestionDrift } from './schema.js';
import { isRunDegraded } from './publicShare.js';

export type CommunityInquiryResult = Omit<InquiryResult, 'directAnswer' | 'questionDrift'> & {
  directAnswer?: InquiryResult['directAnswer'];
  questionDrift?: Omit<QuestionDrift, 'warning'>;
};

export function toCommunityInquiryResult(result: InquiryResult): CommunityInquiryResult {
  const { directAnswer, questionDrift, ...rest } = result;
  return {
    ...rest,
    ...(directAnswer !== undefined && !isRunDegraded(result) ? { directAnswer } : {}),
    ...(questionDrift !== undefined ? { questionDrift: withoutWarning(questionDrift) } : {}),
  };
}

function withoutWarning(drift: QuestionDrift): Omit<QuestionDrift, 'warning'> {
  const { warning: _gated, ...rest } = drift;
  return rest;
}

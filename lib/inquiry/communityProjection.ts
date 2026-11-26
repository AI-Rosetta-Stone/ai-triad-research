// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285 (TL p/35#87, t/285#53): the community projection of an InquiryResult, applied before the result leaves
// for the community draft endpoint. Three rules:
//  1. questionDrift carries debatedTopic and driftScore only. The warning is gated (CL t/285#7, notes 1 and 3)
//     until a validation rate is reported, and an unknown key never leaves (Quality t/285#54).
//  2. directAnswer is omitted on a degraded run, using the same predicate as the public share (Condition A).
//     When present it carries text and agreement only.
//  3. Each camp's answeredLiteralQuestion and answerNote are dropped: stored, not shown (TL t/285#53).
// Everything else passes through, as the community column of fieldClassification.ts includes it.

import type { InquiryResult } from './schema.js';
import { isRunDegraded } from './publicShare.js';
import {
  shownDirectAnswer, shownQuestionDrift, withoutGatedCampFields,
  type ShownCampVerdict, type ShownDirectAnswer, type ShownQuestionDrift,
} from './gatedFields.js';

export type CommunityInquiryResult = Omit<InquiryResult, 'directAnswer' | 'questionDrift' | 'campVerdicts'> & {
  campVerdicts: ShownCampVerdict[];
  directAnswer?: ShownDirectAnswer;
  questionDrift?: ShownQuestionDrift;
};

export function toCommunityInquiryResult(result: InquiryResult): CommunityInquiryResult {
  const { directAnswer, questionDrift, campVerdicts, ...rest } = result;
  return {
    ...rest,
    campVerdicts: campVerdicts.map(withoutGatedCampFields),
    ...(directAnswer !== undefined && !isRunDegraded(result) ? { directAnswer: shownDirectAnswer(directAnswer) } : {}),
    ...(questionDrift !== undefined ? { questionDrift: shownQuestionDrift(questionDrift) } : {}),
  };
}

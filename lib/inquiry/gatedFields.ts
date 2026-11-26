// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285 (TL t/285#53): the leaves of an InquiryResult that are stored but not shown on any surface.
// All three are the model's unvalidated self-report of whether a camp answered the question:
//   - campVerdicts[].answeredLiteralQuestion
//   - campVerdicts[].answerNote
//   - questionDrift.warning
// They stay in the stored result so the Comp-Linguist validation sample has data. The export and community
// projections strip them here; the public share names its fields one by one and never names these.
// fieldClassification.ts holds the per-surface decision; this file is the one place that removes them.

import type { CampVerdict, QuestionDrift } from './schema.js';

export type ShownCampVerdict = Omit<CampVerdict, 'answeredLiteralQuestion' | 'answerNote'>;
export type ShownQuestionDrift = Omit<QuestionDrift, 'warning'>;

/** A camp verdict without the gated answer flag and note. Does not mutate its input. */
export function withoutGatedCampFields(cv: CampVerdict): ShownCampVerdict {
  const { answeredLiteralQuestion: _flag, answerNote: _note, ...rest } = cv;
  return rest;
}

/** A question-drift block without the gated warning. Does not mutate its input. */
export function withoutGatedWarning(drift: QuestionDrift): ShownQuestionDrift {
  const { warning: _gated, ...rest } = drift;
  return rest;
}

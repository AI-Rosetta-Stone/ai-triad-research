// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/285: what of the direct answer, the question-drift block and a camp verdict may leave the stored result.
//
// Stored, not shown on any surface (TL t/285#53). All three are the model's unvalidated self-report of
// whether a camp answered the question, kept so the Comp-Linguist validation sample has data:
//   - campVerdicts[].answeredLiteralQuestion
//   - campVerdicts[].answerNote
//   - questionDrift.warning
//
// DirectAnswerSchema and QuestionDriftSchema are passthrough so an older build round-trips a later field
// (TL t/285#50). That tolerance is for storage only. A projection must NAME the fields it lets out, or an
// unknown key (a later gated field, or a stray key the model returned) would reach a reader unclassified
// (Quality t/285#54). So these helpers build each shown object field by field; nothing is spread.
// fieldClassification.ts holds the per-surface decision; this file is the one place that applies it to
// these three objects. The public share names its own fields and uses the same helpers.

import type { CampVerdict, DirectAnswer, QuestionDrift } from './schema.js';

export type ShownCampVerdict = Omit<CampVerdict, 'answeredLiteralQuestion' | 'answerNote'>;
export interface ShownDirectAnswer {
  text: string;
  agreement: DirectAnswer['agreement'];
}
export interface ShownQuestionDrift {
  debatedTopic?: string;
  driftScore?: number;
}

/** A camp verdict's shown fields: camp, verdict and nodes. Never the gated flag or note, never an unknown key. */
export function withoutGatedCampFields(cv: CampVerdict): ShownCampVerdict {
  return { camp: cv.camp, verdict: cv.verdict, nodes: cv.nodes };
}

/** The direct answer's two declared fields, and nothing else the stored object may carry. */
export function shownDirectAnswer(answer: DirectAnswer): ShownDirectAnswer {
  return { text: answer.text, agreement: answer.agreement };
}

/** The drift block's shown fields: the debated topic and the score. Never the warning, never an unknown key. */
export function shownQuestionDrift(drift: QuestionDrift): ShownQuestionDrift {
  return {
    ...(drift.debatedTopic !== undefined ? { debatedTopic: drift.debatedTopic } : {}),
    ...(drift.driftScore !== undefined ? { driftScore: drift.driftScore } : {}),
  };
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';
import { CampVerdictSchema, DirectAnswerSchema, InquiryResultSchema, QuestionDriftSchema } from './schema.js';

// HTTP/HTTPS URL validation — rejects javascript:, data:, and other non-web protocols.
// Zod's .url() is insufficient; it allows javascript: and data: URIs.
export const HttpUrlSchema = z.string().refine(
  (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid HTTP or HTTPS URL' }
);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A copy of `obj` without `keys`. */
function without(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k)));
}

/**
 * Remove the three gated leaves from an upload body before the strict check (TL t/285#55): `questionDrift.warning`
 * and each camp's `answeredLiteralQuestion` and `answerNote`. They are stored, not shown (t/285#53), and every new
 * result carries them, so the schema drops them itself: no caller can forget a projection, and a caller that
 * uploads the schema's output uploads none of them. Only these three named keys are removed. Any other unknown key
 * still reaches the strict check and is refused. Input of the wrong shape is returned as it is, for the check to refuse.
 */
export function stripGatedUploadKeys(input: unknown): unknown {
  if (!isRecord(input) || !isRecord(input.result)) return input;
  const { questionDrift, campVerdicts } = input.result;
  return {
    ...input,
    result: {
      ...input.result,
      ...(isRecord(questionDrift) ? { questionDrift: without(questionDrift, ['warning']) } : {}),
      ...(Array.isArray(campVerdicts)
        ? { campVerdicts: campVerdicts.map((cv: unknown) => (isRecord(cv) ? without(cv, ['answeredLiteralQuestion', 'answerNote']) : cv)) }
        : {}),
    },
  };
}

// The community upload shape (t/285, TL p/35#89 and t/285#53): the gated `questionDrift.warning` and each camp's
// gated `answeredLiteralQuestion` and `answerNote` are absent. The shapes are strict, so nothing unknown passes.
const CommunityQuestionDriftSchema = QuestionDriftSchema.omit({ warning: true }).strict();
const CommunityCampVerdictSchema = CampVerdictSchema.omit({ answeredLiteralQuestion: true, answerNote: true }).strict();
export const CommunityInquiryResultSchema = InquiryResultSchema.extend({
  campVerdicts: z.array(CommunityCampVerdictSchema),
  // Strict: the stored direct answer is passthrough, the upload is not (Quality t/285#54).
  directAnswer: DirectAnswerSchema.strict().optional(),
  questionDrift: CommunityQuestionDriftSchema.optional(),
}).strict();

// Desktop Ask upload payload schema — single-source contract for server, IPC, and desktop client.
// The result is validated against the community projection (CommunityInquiryResultSchema), which is the trust
// boundary (t/4743): schema must validate the result, not assume it was validated upstream.
// `note` defaults to empty string (user can skip adding a note at upload time).
// The gated leaves are stripped first (stripGatedUploadKeys), so the parsed OUTPUT never carries them. A caller
// must upload or store the output of `parse`, not the object it passed in.
export const inquiryPayloadSchema = z.preprocess(
  stripGatedUploadKeys,
  z.object({
    result: CommunityInquiryResultSchema,
    note: z.string().max(5000).default(''),
  }).strict(),
);

export type InquiryPayload = z.infer<typeof inquiryPayloadSchema>;

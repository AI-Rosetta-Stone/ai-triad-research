// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';
import { InquiryResultSchema, QuestionDriftSchema } from './schema.js';

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

// The community projection of questionDrift (t/285, TL p/35#89): the gated `warning` is absent. It is strict, so a
// result that still carries the warning is refused here, not uploaded. The full InquiryResultSchema still requires
// `warning` for the public and export surfaces.
const CommunityQuestionDriftSchema = QuestionDriftSchema.omit({ warning: true }).strict();
export const CommunityInquiryResultSchema = InquiryResultSchema.extend({
  questionDrift: CommunityQuestionDriftSchema.optional(),
}).strict();

// Desktop Ask upload payload schema — single-source contract for server, IPC, and desktop client.
// The result is validated against the community projection (CommunityInquiryResultSchema), which is the trust
// boundary (t/4743): schema must validate the result, not assume it was validated upstream.
// `note` defaults to empty string (user can skip adding a note at upload time).
export const inquiryPayloadSchema = z.object({
  result: CommunityInquiryResultSchema,
  note: z.string().max(5000).default(''),
}).strict();

export type InquiryPayload = z.infer<typeof inquiryPayloadSchema>;

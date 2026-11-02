// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';
import { InquiryResultSchema } from './schema.js';

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

// Desktop Ask upload payload schema — single-source contract for server, IPC, and desktop client.
// InquiryResultSchema.strict() is the trust boundary (t/4743): schema must validate the result,
// not assume it was validated upstream.
export const inquiryPayloadSchema = z.object({
  result: InquiryResultSchema.strict(),
  note: z.string().max(5000),
}).strict();

export type InquiryPayload = z.infer<typeof inquiryPayloadSchema>;

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';

/**
 * Runtime validation for the `POST /api/models/refresh` body (t/4162; TL t/4031#1/#2; SO e/297#4).
 *
 * Mirrors `src/main/ipc/refreshModelsRequestSchema.ts` (the Electron IPC side, t/4161) field-for-field
 * — the two can't share a module because the server never imports from `src/main/` (process boundary).
 * Keep them in sync: both validate the same renderer bridge contract (`renderer/bridge/types.ts`
 * `RefreshModelsRequest`) and the same `Proposal`/`ProposedChange` shapes
 * (`lib/electron-shared/refreshPolicy.ts`).
 *
 * `.strict()` at every object level rejects an unknown key rather than silently ignoring it — a client
 * sending a `principal` field (trying to set the host-set identity itself) gets a 400, not a silent
 * drop. `proposal`'s own fields are validated by shape; its CONTENT is re-checked by the lib's hash
 * recompute (refuses `proposal-changed` on a mismatch) — this schema only guards the wire shape.
 */

const proposedChangeSchema = z.object({
  slot: z.string().min(1),
  from: z.union([z.string(), z.array(z.string())]),
  to: z.union([z.string(), z.array(z.string()), z.null()]),
  family: z.union([z.string(), z.null()]).optional(),
  reason: z.literal('vendor-absent').optional(),
}).strict();

const proposalSchema = z.object({
  catalogFingerprint: z.string().min(1),
  hash: z.string().min(1),
  changes: z.array(proposedChangeSchema),
}).strict();

// Length caps are a wire-sanity bound, not a UX limit — generous enough that no real
// reviewer note or display name is ever truncated.
const APPROVED_BY_MAX = 200;
const REASON_MAX = 2000;

export const refreshModelsRequestSchema = z.object({
  dryRun: z.boolean().optional(),
  accept: z.object({
    proposal: proposalSchema,
    approvedBy: z.string().min(1).max(APPROVED_BY_MAX),
    reason: z.string().min(1).max(REASON_MAX),
  }).strict().optional(),
}).strict();

export type RefreshModelsRequestInput = z.infer<typeof refreshModelsRequestSchema>;

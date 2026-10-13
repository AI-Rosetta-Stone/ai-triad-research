// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { z } from 'zod';

/**
 * Runtime validation for the `refresh-ai-models` IPC payload (t/4161; TL t/4031#1/#2).
 *
 * Extracted from aiHandlers so it's testable WITHOUT importing electron, mirroring
 * communitySubmitSchema.ts. This is the RUNTIME gate for the renderer bridge contract
 * (renderer/bridge/types.ts `RefreshModelsRequest`) — it MUST stay in sync with it and
 * with the shared `Proposal`/`ProposedChange` shapes (lib/electron-shared/refreshPolicy.ts).
 *
 * `.strict()` at every object level rejects an unknown key rather than silently ignoring
 * it (TL adjustment 4) — a renderer typo or a stale client must fail loudly, not succeed
 * against a field nobody is reading. `proposal`'s own fields are validated by shape, but
 * its CONTENT is re-checked by the lib's hash recompute (refuses `proposal-changed` on a
 * mismatch) — this schema only guards the wire shape, never a substitute for that check.
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

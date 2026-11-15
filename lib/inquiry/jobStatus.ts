// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Inquiry job-status vocabulary + truncation derivation — the pure, host-agnostic core hoisted out
// of server/inquiryJobs.ts (t/3609). These are derivations over the shared InquiryResult contract
// (t/3574) and a status-label vocabulary; nothing here is server-specific. Both hosts consume the
// SAME symbols from here: the server (inquiryJobs.ts re-exports them), Electron main
// (inquiryHandlers.ts), and the renderer bridge contract (InquiryStatusResponse.status).
//
// What stays host-local (NOT here): the in-memory job Map, TTL sweep, per-user concurrency cap,
// idempotency, persistence, and the injected-pipeline seam — all genuinely per-host.

import type { InquiryResult } from './schema.js';

// termination_reason values that mean the run was cut short by a binding budget/ceiling (HLD /
// calibrationLogger censor set). Anything else (e.g. 'natural') is a clean conclusion.
export const TRUNCATION_REASONS: ReadonlySet<string> = new Set(['max_iterations', 'situation_cap', 'api_ceiling']);

/** Pipeline stages the injected runner reports progress through (Ground → Debate → Judge → Synthesize).
 *  Trust projection folds into synthesis; it is not a separately-surfaced job stage. */
export type InquiryPipelineStage = 'grounding' | 'debating' | 'judging' | 'synthesizing';

/** Every job status. Terminal = done | done_truncated | failed (see isTerminalStatus). Each host's
 *  `Record<InquiryJobStatus, number>` PROGRESS map forces every status to be accounted for. */
export type InquiryJobStatus = 'queued' | InquiryPipelineStage | 'done' | 'done_truncated' | 'failed';

/** Exhaustive terminal-status classifier. The `assertNever` default makes adding a new status
 *  without classifying it a COMPILE error — the fail-closed guarantee TL asked for (t/3578#6).
 *  This is the single canonical predicate (t/3609): it supersedes the former host-local copies
 *  `isTerminal` (Electron main) and `isInquiryTerminal` (renderer bridge), which classified the
 *  same three statuses as terminal but lacked this exhaustiveness guard. */
export function isTerminalStatus(status: InquiryJobStatus): boolean {
  switch (status) {
    case 'queued': case 'grounding': case 'debating': case 'judging': case 'synthesizing':
      return false;
    case 'done': case 'done_truncated': case 'failed':
      return true;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

/** Derive whether an InquiryResult was cut short by a binding budget/ceiling. Truncation is NOT a
 *  top-level field on InquiryResult (t/3574 contract) — it lives per-metric in the calibration
 *  trust states, where a censored verdict / a budget-binding terminationReason marks a cut-short
 *  run (TL confirmed the source is "the InquiryResult trust/derivation", t/3578#6). */
export function deriveTruncation(result: InquiryResult): { truncated: boolean; terminationReason?: string } {
  for (const entry of result.calibration) {
    const tr = entry.trust.terminationReason;
    if (entry.trust.verdict === 'censored' || (tr !== undefined && TRUNCATION_REASONS.has(tr))) {
      return { truncated: true, terminationReason: tr };
    }
  }
  return { truncated: false };
}

/** Millisecond timestamps marking when each inquiry stage started and ended (t/325). */
export interface InquiryStageTiming {
  /** Unix timestamp (ms) when the stage started; undefined if never entered. */
  startedAt?: number;
  /** Unix timestamp (ms) when the stage ended; undefined if still running or never entered. */
  endedAt?: number;
}

/** Collection of stage timings for all inquiry pipeline stages (t/325). */
export interface InquiryStageTimings {
  grounding: InquiryStageTiming;
  debating: InquiryStageTiming;
  judging: InquiryStageTiming;
  synthesizing: InquiryStageTiming;
}

/** Advance stage timings when transitioning from one stage to the next. Records the end time of the
 *  previous stage and the start time of the next stage.
 *  @param timings - mutable stage timings to update
 *  @param prev - the previous stage name (or undefined if starting from queued)
 *  @param next - the new stage name
 *  @param now - Unix timestamp (ms) for both the end of prev and start of next
 *  @returns the updated timings object
 */
export function advanceStageTimings(
  timings: InquiryStageTimings,
  prev: InquiryPipelineStage | undefined,
  next: InquiryPipelineStage,
  now: number,
): InquiryStageTimings {
  if (prev !== undefined) {
    timings[prev].endedAt = now;
  }
  timings[next].startedAt = now;
  return timings;
}

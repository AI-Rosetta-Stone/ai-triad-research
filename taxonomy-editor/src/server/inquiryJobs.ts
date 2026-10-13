// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Replica-safe (t/4177): the in-memory Map is the fast path. A GET that misses it falls back to the
// persisted InquiryResult (tier-2), then to the durable job record in inquiryJobStore (tier-3), which
// is written at creation, on a heartbeat while running, and on failure. Both live in the shared
// user-content backend (Azure Blob in prod), so any replica can answer any poll.
//
// Inquiry async job runner + registry (t/3578, t/3571 arc). Mirrors briefExportJobs.ts:
// POST → 202 { jobId }, GET polls the evolving state, per-user concurrency cap, TTL sweep,
// idempotency window, progress percentage. Durable truth is the persisted InquiryResult
// (inquiryResultStore, keyed by jobId); the in-memory job is an ephemeral progress view.
//
// TWO DELIBERATE IMPROVEMENTS on the brief precedent (TL t/3578#6):
//  1. The pipeline is INJECTED, not imported. briefExportJobs imports runBriefPipeline directly,
//     which means its bookkeeping can't be tested without running a real debate. Here the runner
//     takes a single typed `runPipeline` function (one production wiring at the route, t/3581;
//     a fake in tests). Kept permanently — not switched to a direct import when t/3585 lands.
//  2. Truncation is a DISTINCT TERMINAL STATE (`done_truncated`), not a boolean on `done`. A client
//     switching on `done` doesn't match a truncated run, so it surfaces as unhandled (fails CLOSED,
//     visibly) rather than rendering a truncated run as clean success (fails open, silently). The
//     status union is exhaustiveness-checked by tsc (see assertNever in isTerminalStatus).

import { randomUUID } from 'crypto';

/** Unique id for this process boot — forensic only per SO e/221#2. Must NOT gate the tier-3
 *  transition (that job is done by `lastHeartbeatAt` staleness, not boot identity — `bootId`
 *  misfires during deploy overlap where the old replica is still healthy).
 *  Must be process-generated (a UUID), never derived from `CONTAINER_APP_REVISION` or any env
 *  var: a revision id is stable across scale-to-zero restarts within a revision, so a
 *  revision-derived id would silently disable tier-3 in the dominant restart mode (SO condition 2).
 *  Coordinate with t/3724: `server.started` must emit this same id for unified boot forensics. */
export const INQUIRY_BOOT_ID: string = randomUUID();
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { errorMessage } from '../../../lib/debate/errors.js';
import { log } from './logger.js';
import type { InquiryRequest, InquiryResult } from '../../../lib/inquiry/index.js';
import { saveInquiryResult, type InquiryResultSummary } from './storage/inquiryResultStore.js';
import {
  saveInquiryJobRecord, deleteInquiryJobRecord,
  INQUIRY_HEARTBEAT_INTERVAL_MS, type InquiryJobRecord,
} from './storage/inquiryJobStore.js';
export { markJobFailedIfStale, type InquiryTier3Result } from './storage/inquiryJobStore.js';

// Status vocabulary + truncation derivation hoisted to lib/inquiry (t/3609). Imported here for this
// module's own internal use (isTerminalStatus in the concurrency/sweep checks, deriveTruncation in
// startInquiryJob, the types in PROGRESS / InquiryJob) AND re-exported below so existing consumers —
// routes/inquiry.ts, inquiryPipelineDeps.ts, inquiryJobs.test.ts, inquiryRoutes.test.ts — keep
// importing them from '../inquiryJobs.js' with zero churn.
import { isTerminalStatus, deriveTruncation } from '../../../lib/inquiry/index.js';
import type { InquiryJobStatus, InquiryPipelineStage } from '../../../lib/inquiry/index.js';
export { isTerminalStatus, deriveTruncation } from '../../../lib/inquiry/index.js';
export type { InquiryJobStatus, InquiryPipelineStage } from '../../../lib/inquiry/index.js';

export const MAX_CONCURRENT_INQUIRY_JOBS = 1;        // per user — an inquiry is heavier than an export (pilot: 54 turns + 16 QBAF, minutes, real spend). TL t/3578#6.
export const INQUIRY_JOB_TTL_MS = 30 * 60_000;       // 30 min — poll + idempotency window; > export's 10 min because an inquiry runs minutes. TL-confirmed t/3578#6.

// TRUNCATION_REASONS, InquiryPipelineStage, InquiryJobStatus, isTerminalStatus, and deriveTruncation
// were hoisted to lib/inquiry (t/3609) — imported + re-exported above. PROGRESS stays host-local (not
// hoisted to lib): it is this server's display concern, not shared vocabulary (Electron main keeps its
// own copy). It IS shared within the host because all three GET tiers render through buildPollView.
const PROGRESS: Record<InquiryJobStatus, number> = {
  queued: 0, grounding: 10, debating: 40, judging: 70, synthesizing: 90,
  done: 100, done_truncated: 100, failed: 100,
};

/** Fields each GET tier constructs independently — the shared contract for buildPollView (e/221#13/14).
 *  Having each tier construct this type ensures identical response shape at the type level. */
export interface InquiryPollProjection {
  jobId: string;
  status: InquiryJobStatus;
  resultId: string | null;
  error: string | null;
  debateId: string | null;
  terminationReason: string | null;
}

/** Build a poll-response record from a shared projection, deriving progressPct from PROGRESS.
 *  All three GET tiers route through this — "identical shape" is a type-level fact (e/221#13/14).
 *  Note: tier-3 live path derives progress from the durable record's status, which may lag the
 *  in-memory value (transition writes are fire-and-forget) — lagging bar, never backward (e/221#16). */
export function buildPollView(p: InquiryPollProjection): Record<string, unknown> {
  return {
    jobId: p.jobId, status: p.status,
    progressPct: PROGRESS[p.status],
    terminationReason: p.terminationReason,
    resultId: p.resultId, error: p.error, debateId: p.debateId,
  };
}

export interface InquiryJob {
  jobId: string;
  userId: string;
  idempotencyKey?: string;
  status: InquiryJobStatus;
  progressPct: number;
  /** Set on `done_truncated` — the binding termination reason (e.g. `api_ceiling`), for the UI
   *  to render (t/3583 must not re-derive it). Undefined on a clean `done`. */
  terminationReason?: string;
  /** The persisted result's id (== jobId) once stored; the cross-restart fallback loads by it. */
  resultId: string | null;
  error: string | null;
  /** The source debate's id (`session.id`), normalized to `null` when absent — see readDebateRef.
   *  The `resultId` opens the persisted answer; this opens the underlying debate run (t/3617). */
  debateId: string | null;
  startedAt: number;
}

const jobs = new Map<string, InquiryJob>();

function setStatus(job: InquiryJob, status: InquiryJobStatus): void {
  job.status = status;
  job.progressPct = PROGRESS[status];
}

// ── Registry helpers (mirror briefExportJobs) ──

/** The caller's own job, or null if absent / owned by another user. */
export function getInquiryJob(jobId: string, userId: string): InquiryJob | null {
  const job = jobs.get(jobId);
  return job && job.userId === userId ? job : null;
}

/** Raw membership (any user) — lets the GET handler distinguish "not in this process's Map at all"
 *  (cross-restart fallback signal → load persisted result / job record) from "present but wrong user". */
export function hasInquiryJob(jobId: string): boolean {
  return jobs.has(jobId);
}

export function countRunningInquiryJobs(userId: string): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.userId === userId && !isTerminalStatus(j.status)) n++;
  }
  return n;
}

/** Idempotency: an in-window job for the same (userId, key) returns its jobId. */
export function findIdempotentInquiryJob(userId: string, key: string | undefined): InquiryJob | null {
  if (!key) return null;
  for (const j of jobs.values()) {
    if (j.userId === userId && j.idempotencyKey === key) return j;
  }
  return null;
}

/** Drop terminal jobs past the TTL. NEVER touches a non-terminal job — `deep` fidelity can run
 *  ~45 min, longer than the 30-min TTL, and sweeping a running job would make deep inquiries vanish
 *  mid-run (TL guard t/3578#6). The TTL clock restarts at the terminal state (see finally, below). */
export function sweepInquiryJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (isTerminalStatus(j.status) && now - j.startedAt > INQUIRY_JOB_TTL_MS) jobs.delete(id);
  }
}

/** The single normalizer for the result's debate reference (t/3641/t/3647). `InquiryResultSchema`
 *  declares `debateId: z.string().optional()` (so the type is `string | undefined`); the pipeline
 *  stamps `session.id`. Absent (old pre-t/3641 records) or empty → `null`. No other consumer reads
 *  `result.debateId` directly — normalize here so `job.debateId`/`InquiryResultSummary.debateId` are
 *  the single source of a debate link. */
function readDebateRef(result: InquiryResult): string | null {
  const v = result.debateId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ── Injected pipeline seam (the single typed function; one prod wiring at t/3581) ──

export interface InquiryPipelineContext {
  onStage: (stage: InquiryPipelineStage) => void;
  signal?: AbortSignal;
}
/** The one injected dependency. The route (t/3581) wires the real `runInquiryPipeline` (t/3585,
 *  lib/debate) closing over its deps; tests pass a fake. Kept injected permanently (TL t/3578#6). */
export type InquiryPipelineRunner = (request: InquiryRequest, ctx: InquiryPipelineContext) => Promise<InquiryResult>;

// ── Job creation + async runner ──

export interface CreateInquiryJobArgs {
  userId: string;
  request: InquiryRequest;
  idempotencyKey?: string;
  /** The single injected pipeline function (see InquiryPipelineRunner). */
  runPipeline: InquiryPipelineRunner;
}

/** Snapshot the current job state into a durable record shape. */
function buildRecord(job: InquiryJob, userId: string): InquiryJobRecord {
  return {
    jobId: job.jobId,
    userId,
    bootId: INQUIRY_BOOT_ID,
    status: job.status,
    lastHeartbeatAt: new Date().toISOString(),
    resultId: job.resultId,
    error: null,
    debateId: job.debateId,
    startedAt: job.startedAt,
  };
}

/** Create a queued job, persist the creation record (awaited — SO condition 3), and kick off the
 *  async pipeline. The route returns 202 { jobId } immediately; GET polls the evolving state.
 *  Concurrency + idempotency are the caller's pre-check (mirrors briefExportJobs — the route uses
 *  countRunningInquiryJobs / findIdempotentInquiryJob before calling this). */
export async function startInquiryJob(args: CreateInquiryJobArgs): Promise<InquiryJob> {
  const job: InquiryJob = {
    jobId: randomUUID(),
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
    status: 'queued',
    progressPct: PROGRESS['queued'],
    resultId: null,
    error: null,
    debateId: null,
    startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  // Await the creation write (SO condition 3 — a lost creation write silently disables tier-3 recovery).
  await saveInquiryJobRecord(buildRecord(job, args.userId));
  void runInquiryJob(job, args);
  return job;
}

async function runInquiryJob(job: InquiryJob, args: CreateInquiryJobArgs): Promise<void> {
  // Heartbeat loop — runs concurrently inside the same AsyncLocalStorage context (Promise-based
  // setTimeout preserves ALS; setInterval would not). Fire-and-forget: we don't await the loop;
  // it exits as soon as the job reaches a terminal state.
  void (async () => {
    while (!isTerminalStatus(job.status)) {
      await new Promise<void>(resolve => setTimeout(resolve, INQUIRY_HEARTBEAT_INTERVAL_MS));
      if (isTerminalStatus(job.status)) break;
      void saveInquiryJobRecord(buildRecord(job, args.userId)).catch((err) => {
        log.server.warn({ err, jobId: job.jobId }, 'Heartbeat write failed (best-effort)');
      });
    }
  })();

  try {
    const result = await args.runPipeline(args.request, {
      onStage: (stage) => setStatus(job, stage),
    });

    job.debateId = readDebateRef(result);
    const { truncated, terminationReason } = deriveTruncation(result);
    if (truncated) job.terminationReason = terminationReason;

    const summary: InquiryResultSummary = {
      jobId: job.jobId,
      question: args.request.question,
      debateId: job.debateId,
      truncated,
      terminationReason,
      createdAt: new Date().toISOString(),
    };
    // Persist BEFORE flipping to a terminal state, so a poll that observes `done`/`done_truncated`
    // is guaranteed the result is loadable (the cross-restart fallback can't race ahead of the write).
    await saveInquiryResult(job.jobId, result, summary);
    job.resultId = job.jobId;
    setStatus(job, truncated ? 'done_truncated' : 'done');
    // Delete the durable job record after the await saveInquiryResult() resolves (retention
    // mechanism 1 — e/221#12: "after the await resolves" is critical; parallelising these writes
    // would create a window where the record is gone but the result is not yet readable → 404 on a
    // *successful* run, which t/3723's client treats as terminal).
    void deleteInquiryJobRecord(job.jobId).catch((err) => {
      log.server.warn({ err, jobId: job.jobId }, 'Job record delete after completion failed (best-effort)');
    });
  } catch (err) {
    job.error = errorMessage(err);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'inquiry', level: 'error',
      message: `Inquiry job failed at ${job.status}`,
      error: { name: (err as Error).name ?? 'Error', message: job.error, stack: (err as Error).stack },
    });
    log.server.error({ component: 'inquiry', jobId: job.jobId, stage: job.status, err }, 'Inquiry job failed');
    setStatus(job, 'failed');
    // On failure: write the durable record as failed (t/4177). With more than one replica, a poll
    // can reach tier-3 on another replica while this job's heartbeat is still fresh; without this
    // write it would read as still running, then as a misleading "server restarted". The message is
    // a fixed, bounded descriptor (SO condition 6: never raw error text in the record).
    void saveInquiryJobRecord({
      ...buildRecord(job, args.userId),
      error: { code: 'pipeline_failed', message: 'This inquiry failed. Try running it again.' },
    }).catch((werr) => {
      log.server.warn({ err: werr, jobId: job.jobId }, 'Failed-state job record write failed (best-effort)');
    });
  } finally {
    job.startedAt = Date.now(); // restart the TTL clock from the terminal state
  }
}

/** Test-only: clear the in-memory registry (simulates a fresh process / replica restart). */
export function _resetInquiryJobsForTest(): void {
  jobs.clear();
}

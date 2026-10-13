// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Replica-safe (t/4177): the in-memory Map is the fast path; every job's poll view is also written
// to the durable briefExportJobStore (creation, a heartbeat while running, and the terminal state),
// and a GET that misses the Map falls back to it. (This replaces the in-memory job-store marker
// that Test-InMemoryJobStoreScaleGuard.ps1 used to block maxReplicas > 1.)
// Brief Export async job runner + registry (t/2804, T6). Mirrors the oped run-registry
// pattern (in-memory Map, per-user concurrency cap, TTL sweep) but exposes the
// POST-202-jobId + GET-poll shape (not SSE). Durable truth is the exports list +
// stored manifest; the in-memory job is an ephemeral progress view (per-replica —
// a "job not found" GET falls back to GET /api/debates/{id}/exports, TL t/2804#2 #3).

import { randomUUID } from 'crypto';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError, errorMessage } from '../../../lib/debate/errors.js';
import { runBriefPipeline, type BriefArtifact } from '../../../lib/brief/pipeline.js';
import { codeForHardFailures } from '../../../lib/brief/errorMapping.js';
import type { DebateSession } from '../../../lib/debate/types.js';
import type { BriefPreset, ModelSource, ExportJobState, ExportErrorCode } from '../../../lib/brief/types.js';
import { BRIEF_ARTIFACTS } from '../../../lib/brief/types.js';
import type { AIAdapter } from '../../../lib/debate/aiAdapter.js';
import { saveBriefExport, type BriefExportRecord, type ArtifactBlob } from './storage/briefExportStore.js';
import { loadTemplateBytes } from './storage/templateStore.js';
import { log } from './logger.js';
import {
  saveBriefExportJobRecord, isTerminalExportStatus, BRIEF_EXPORT_HEARTBEAT_INTERVAL_MS,
  type BriefExportJobRecord,
} from './storage/briefExportJobStore.js';
export { resolveBriefExportJobPoll } from './storage/briefExportJobStore.js';

export const MAX_CONCURRENT_EXPORT_JOBS = 1;      // per user — export is billable + heavy
export const EXPORT_JOB_TTL_MS = 10 * 60_000;     // 10 min (mirrors oped; also the idempotency window)

/** Resolved model pair handed to the runner (resolution + entitlement already done at POST). */
export interface ResolvedModels {
  modelId: string; modelSource: ModelSource;
  checkerModelId?: string; checkerModelSource?: ModelSource;
}
export interface ExportJobRequest {
  preset: BriefPreset;
  skipNarration: boolean;
  template?: Uint8Array;
  /** Server-stored template to use; resolved to bytes before the pipeline runs (t/2853). */
  templateId?: string;
  /** When false, removes the framing_meta slide from classroom exports (t/2838). */
  framingMeta?: boolean;
  /** When true, export a non-closed (in-progress) debate as a watermarked snapshot
   *  (t/2851 / t/2816). Passed through to extractDeckSpec; a closed debate ignores it. */
  allowOpen?: boolean;
}
export interface ExportJob {
  jobId: string;
  userId: string;
  debateId: string;
  idempotencyKey?: string;
  status: ExportJobState;
  progressPct: number;
  warnings: string[];
  error: string | null;
  errorCode?: ExportErrorCode;
  exportId: string | null;
  startedAt: number;
}

const jobs = new Map<string, ExportJob>();

const PROGRESS: Record<ExportJobState, number> = {
  queued: 0, extracting: 10, narrating: 30, checking: 50,
  rendering: 70, verifying: 90, done: 100, failed: 100,
};

function setState(job: ExportJob, status: ExportJobState): void {
  job.status = status;
  job.progressPct = PROGRESS[status];
}

// ── Registry helpers ──

export function getExportJob(jobId: string, userId: string): ExportJob | null {
  const job = jobs.get(jobId);
  return job && job.userId === userId ? job : null;
}

/** Raw registry membership (any user) — lets the GET handler distinguish "not in this
 *  process's Map at all" (the cross-replica-404 signal, t/2887) from "present but wrong
 *  user" (an auth/scoping issue). Does NOT leak the job; boolean only. */
export function hasExportJob(jobId: string): boolean {
  return jobs.has(jobId);
}

export function countRunningExportJobs(userId: string): number {
  let n = 0;
  for (const j of jobs.values()) {
    if (j.userId === userId && j.status !== 'done' && j.status !== 'failed') n++;
  }
  return n;
}

/** Idempotency: an in-window job for the same (userId, debateId, key) returns its jobId. */
export function findIdempotentJob(userId: string, debateId: string, key: string | undefined): ExportJob | null {
  if (!key) return null;
  for (const j of jobs.values()) {
    if (j.userId === userId && j.debateId === debateId && j.idempotencyKey === key) return j;
  }
  return null;
}

export function sweepExportJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if ((j.status === 'done' || j.status === 'failed') && now - j.startedAt > EXPORT_JOB_TTL_MS) jobs.delete(id);
  }
}

// ── Error mapping (verify hardFailures + stage throws → stable ExportErrorCode) ──

// codeForHardFailures now lives in lib/brief/errorMapping.ts (t/2858 / t/2840) — one copy
// shared by T6, the CLI, and the Electron handler. codeForThrow stays caller-local (below):
// it maps a *stage throw* to a code, which is a T6-shell concern the shared pipeline doesn't own.
function codeForThrow(err: unknown, stage: ExportJobState): ExportErrorCode {
  const msg = errorMessage(err).toLowerCase();
  if (msg.includes('not closed') || msg.includes('closed')) return 'DebateNotClosed';
  if (stage === 'narrating' || stage === 'checking') return 'ModelUnavailable';
  if (stage === 'rendering') return 'RenderFailure';
  return 'RenderFailure';
}

// ── Job creation + async runner ──

export interface CreateJobArgs {
  userId: string;
  session: DebateSession;   // already loaded + closed-gated by the route
  debateId: string;
  models: ResolvedModels;
  request: ExportJobRequest;
  toolVersions: Record<string, string>;
  timestamp: string;        // caller-supplied (Date.* is unavailable in some contexts; route provides)
  idempotencyKey?: string;
  adapter: AIAdapter;
}

/** Snapshot the job's poll view into the durable record shape (t/4177). */
function toRecord(job: ExportJob): BriefExportJobRecord {
  return {
    jobId: job.jobId, userId: job.userId, debateId: job.debateId,
    status: job.status, progressPct: job.progressPct, warnings: [...job.warnings],
    error: job.error, errorCode: job.errorCode ?? null, exportId: job.exportId,
    startedAt: job.startedAt, lastHeartbeatAt: new Date().toISOString(),
  };
}

function writeRecordBestEffort(job: ExportJob, what: string): Promise<void> {
  return saveBriefExportJobRecord(toRecord(job)).catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'brief-export', level: 'warn',
      message: `Brief export job record ${what} write failed (best-effort)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ err, jobId: job.jobId }, `brief-export job record ${what} write failed (best-effort)`);
  });
}

/** Create a queued job, persist its record (awaited, so another replica can answer the very first
 *  poll), and kick off the async pipeline (fire-and-forget). The route returns 202 { jobId }
 *  immediately; GET polls the evolving state. */
export async function startExportJob(args: CreateJobArgs): Promise<ExportJob> {
  const job: ExportJob = {
    jobId: randomUUID(),
    userId: args.userId,
    debateId: args.debateId,
    idempotencyKey: args.idempotencyKey,
    status: 'queued',
    progressPct: 0,
    warnings: [],
    error: null,
    exportId: null,
    startedAt: Date.now(),
  };
  // Persist BEFORE registering: if the creation write throws, nothing is left in the Map holding the
  // user's concurrency slot as a 'queued' job that never runs (it would 429 every later POST).
  await saveBriefExportJobRecord(toRecord(job));
  jobs.set(job.jobId, job);
  void runExportJob(job, args);
  return job;
}

async function runExportJob(job: ExportJob, args: CreateJobArgs): Promise<void> {
  // Heartbeat (t/4177): keeps the durable record's poll view fresh while the job runs, so another
  // replica serves live progress, and a crashed owner is detected by staleness. Promise-based
  // setTimeout preserves the request's AsyncLocalStorage user context (setInterval would not).
  // `inFlight` serialises record writes: a heartbeat still in flight when the job ends must not land
  // AFTER the terminal write and overwrite `done` with a non-terminal status (which would then go
  // stale and read as failed). The terminal write awaits it first.
  let inFlight: Promise<void> = Promise.resolve();
  void (async () => {
    while (!isTerminalExportStatus(job.status)) {
      await new Promise<void>(resolve => setTimeout(resolve, BRIEF_EXPORT_HEARTBEAT_INTERVAL_MS));
      if (isTerminalExportStatus(job.status)) break;
      inFlight = writeRecordBestEffort(job, 'heartbeat');
    }
  })();
  try {
    await runExportPipeline(job, args);
  } finally {
    // Terminal state (startedAt was just reset to the terminal time, which starts the retention clock).
    await inFlight;
    await writeRecordBestEffort(job, 'terminal');
  }
}

async function runExportPipeline(job: ExportJob, args: CreateJobArgs): Promise<void> {
  const exportId = randomUUID();
  const { session, models, request } = args;
  const artifacts: ArtifactBlob[] = [];
  let traceCoveragePct = 0;
  let title = args.debateId;   // fallback until extract yields the real deck title
  let stage: ExportJobState = 'extracting';
  try {
    // Resolve templateId → bytes if provided (t/2853). Inline bytes (request.template) take
    // precedence; templateId is the server-storage path (web build).
    let resolvedTemplate = request.template;
    if (!resolvedTemplate && request.templateId) {
      const buf = await loadTemplateBytes(request.templateId);
      if (buf) resolvedTemplate = new Uint8Array(buf);
    }

    // ── run the shared 4-stage pipeline (t/2858 — retires the inlined copy). onStage drives
    //    job state + the local `stage` (so a throw still maps via codeForThrow); onArtifact
    //    captures each artifact the moment it's produced, so a later-stage throw still
    //    partial-persists the earlier ones. The sink emits the SAME objects the pipeline
    //    returns on success, so `artifacts` is byte-identical to the old inlined path.
    const result = await runBriefPipeline(
      {
        session,
        preset: request.preset,
        skipNarration: request.skipNarration,
        modelId: models.modelId,
        modelSource: models.modelSource,
        checkerModelId: models.checkerModelId,
        checkerModelSource: models.checkerModelSource,
        template: resolvedTemplate,
        framingMeta: request.framingMeta,
        allowOpen: request.allowOpen,
        toolVersions: args.toolVersions,
        timestamp: args.timestamp,
      },
      args.adapter,
      (s) => { setState(job, s); stage = s; },
      (a: BriefArtifact) => { artifacts.push(a); },
    );

    title = result.spec.meta.title;
    // Maturity warning (t/2851): a live-snapshot export is a partial, watermarked snapshot,
    // never a final export. This is a T6-shell concern — the shared pipeline doesn't emit it.
    // Keyed on the actual meta.snapshot flag (a closed debate + allowOpen still extracts normally).
    if (result.spec.meta.snapshot) {
      job.warnings.push(
        'in_progress_snapshot: exported from a non-closed debate — this is a partial, watermarked live snapshot (meta.snapshot=true), not a final export.',
      );
    }
    // `result.warnings` = render warnings ∪ manifest warnings (same set the inlined path pushed).
    job.warnings.push(...result.warnings);
    traceCoveragePct = result.manifest.trace_coverage_pct;

    const hardFailures = result.hardFailures;
    const status: 'done' | 'failed' = hardFailures.length > 0 ? 'failed' : 'done';
    const errorCode = hardFailures.length > 0 ? codeForHardFailures(hardFailures) : undefined;

    await persist(job, args, exportId, status, artifacts, {
      narrator: models, traceCoveragePct, warnings: job.warnings, errorCode,
      reason: status === 'failed' ? `Export verify gate failed: ${hardFailures.join('; ')}` : undefined,
      title,
    });

    if (status === 'failed') {
      job.error = `Export verify gate failed: ${hardFailures.join('; ')}`;
      job.errorCode = errorCode;
      setState(job, 'failed');
    } else {
      job.exportId = exportId;
      setState(job, 'done');
    }
  } catch (err) {
    // A stage threw (extract/narrate/render). Persist whatever artifacts + manifest we have
    // so the failure is diagnosable, then mark failed with the mapped code.
    const errorCode = codeForThrow(err, stage);
    job.error = errorMessage(err);
    job.errorCode = errorCode;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'brief-export', level: 'error',
      message: `Brief export failed at ${stage}`,
      error: { name: (err as Error).name ?? 'Error', message: job.error, stack: (err as Error).stack },
    });
    try {
      await persist(job, args, exportId, 'failed', artifacts, {
        narrator: models, traceCoveragePct, warnings: job.warnings, errorCode,
        reason: job.error, // the thrown-stage message (set above)
        title,
      });
    } catch (perr) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'brief-export', level: 'error',
        message: 'Brief export failure-record persist also failed',
        error: { name: (perr as Error).name ?? 'Error', message: errorMessage(perr) },
      });
    }
    setState(job, 'failed');
  } finally {
    job.startedAt = Date.now(); // restart the TTL clock from the terminal state
  }
}

async function persist(
  job: ExportJob, args: CreateJobArgs, exportId: string,
  status: 'done' | 'failed', artifacts: ArtifactBlob[],
  extra: { narrator: ResolvedModels; traceCoveragePct: number; warnings: string[]; errorCode?: ExportErrorCode; reason?: string; title: string },
): Promise<void> {
  const rec: BriefExportRecord = {
    exportId,
    debateId: args.debateId,
    title: extra.title,
    preset: args.request.preset,
    status,
    errorCode: extra.errorCode,
    reason: extra.reason,
    narratorModel: extra.narrator.modelId,
    narratorModelSource: extra.narrator.modelSource,
    checkerModel: extra.narrator.checkerModelId ?? null,
    formats: [
      ...(artifacts.some(a => a.name === BRIEF_ARTIFACTS.pptx) ? ['pptx'] : []),
      ...(artifacts.some(a => a.name === BRIEF_ARTIFACTS.htmlDoc) ? ['html'] : []),
    ],
    artifacts: artifacts.map(a => a.name),
    traceCoveragePct: extra.traceCoveragePct,
    warnings: extra.warnings,
    createdAt: args.timestamp,
  };
  if (status === 'done') job.exportId = exportId;
  await saveBriefExport(rec, artifacts);
}

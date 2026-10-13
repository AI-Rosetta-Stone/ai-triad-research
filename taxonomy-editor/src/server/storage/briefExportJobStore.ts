// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Brief export job record store (t/4177). A durable copy of each export job's poll view, so a
// GET /api/export-jobs/:jobId that lands on a replica without the job in its in-memory Map can
// still answer (tier-3). Mirrors inquiryJobStore.ts (t/3728): file per job, heartbeat while
// non-terminal, a stale heartbeat reads as failed, read-time retention window.
//
// Differences from inquiryJobStore, all deliberate:
//  - The record carries the full poll view (progress, warnings, exportId). Export results are
//    keyed by exportId, not jobId, so there is no tier-2 result lookup by jobId to fall back on.
//  - Terminal records are KEPT (not deleted on completion) until the retention window passes,
//    because the record is the only cross-replica source of the terminal poll view.
//
// Persisted shape: `brief-export-jobs/job-<jobId>.json`, user-scoped. Brief export POST requires
// an authenticated identity, so anonymous callers never reach this store (no-op guard anyway).

import path from 'path';
import { resolveDataPath } from '../config.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { getBriefExportBackend, assertSafeId } from './fileIO.js';
import type { ExportJobState, ExportErrorCode } from '../../../../lib/brief/types.js';

// Same invariant as inquiryJobStore: STALE_MS ≥ WORST_SYNC_BLOCK_MS + 2 × INTERVAL_MS. The export
// pipeline's synchronous blocks (PPTX render) are shorter than a deep inquiry's QBAF block, so the
// inquiry values are a safe upper bound. Enforced by briefExportJobStore.test.ts.
export const BRIEF_EXPORT_HEARTBEAT_WORST_SYNC_BLOCK_MS = 8_000;
export const BRIEF_EXPORT_HEARTBEAT_INTERVAL_MS = 5_000;
export const BRIEF_EXPORT_HEARTBEAT_STALE_MS = 30_000;
/** Terminal records are deleted on read past this window (measured from startedAt). */
export const BRIEF_EXPORT_JOB_RECORD_WINDOW_MS = 24 * 60 * 60_000;

export interface BriefExportJobRecord {
  jobId: string;
  userId: string;
  debateId: string;
  status: ExportJobState;
  progressPct: number;
  warnings: string[];
  error: string | null;
  errorCode: ExportErrorCode | null;
  exportId: string | null;
  /** Unix ms — job creation time; the retention window measures from here. */
  startedAt: number;
  /** ISO timestamp of the last write by the owning process; gates the staleness check. */
  lastHeartbeatAt: string;
}

export const isTerminalExportStatus = (s: ExportJobState): boolean => s === 'done' || s === 'failed';

function getJobFile(jobId: string): string {
  const uid = getStorageUserId();
  const dir = uid === '_local' ? resolveDataPath('brief-export-jobs') : resolveDataPath(`users/${uid}/brief-export-jobs`);
  return path.join(dir, `job-${jobId}.json`);
}

/** Persist a job record (create or full overwrite). The creation write MUST be awaited; later
 *  heartbeat/transition writes may be fire-and-forget. Anonymous: no-op. */
export async function saveBriefExportJobRecord(record: BriefExportJobRecord): Promise<void> {
  if (isAnonymousUser()) return;
  assertSafeId(record.jobId, 'brief export job id');
  await getBriefExportBackend().writeFile(getJobFile(record.jobId), JSON.stringify(record, null, 2));
}

/** Load a job record for the current user; null if absent, anonymous, or unparseable. */
export async function loadBriefExportJobRecord(jobId: string): Promise<BriefExportJobRecord | null> {
  assertSafeId(jobId, 'brief export job id');
  if (isAnonymousUser()) return null;
  const raw = await getBriefExportBackend().readFile(getJobFile(jobId));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as BriefExportJobRecord;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'brief-export', level: 'warn',
      message: `Stored brief export job record for ${jobId} is not valid JSON — treating as absent`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ err, jobId, cause: 'brief-export-job-record-unparseable' },
      'Stored brief export job record is not valid JSON — treating as absent (t/4177)');
    return null;
  }
}

async function deleteBriefExportJobRecord(jobId: string): Promise<void> {
  await getBriefExportBackend().deleteFile(getJobFile(jobId)).catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'brief-export', level: 'warn',
      message: `Brief export job record delete failed for ${jobId} (best-effort)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.warn({ err, jobId }, 'brief-export-job record delete failed (best-effort)');
  });
}

export const STALE_EXPORT_ERROR = 'The server running this export stopped before it finished. Start the export again.';

/** Tier-3 poll view for a job not in this process's Map. Returns the record to serve, or null (→ 404).
 *  - terminal, within the retention window → served as-is;
 *  - terminal, past the window → deleted (best-effort), null;
 *  - non-terminal, fresh heartbeat → served (the job is live on another replica);
 *  - non-terminal, stale heartbeat → its owner is gone: served as failed, and that failed state is
 *    written back (fire-and-forget, identical content under any interleaving) so later polls agree. */
export async function resolveBriefExportJobPoll(jobId: string): Promise<BriefExportJobRecord | null> {
  const record = await loadBriefExportJobRecord(jobId);
  if (!record) return null;
  if (isTerminalExportStatus(record.status)) {
    if (Date.now() - record.startedAt <= BRIEF_EXPORT_JOB_RECORD_WINDOW_MS) return record;
    void deleteBriefExportJobRecord(jobId);
    return null;
  }
  const lastBeat = Date.parse(record.lastHeartbeatAt) || 0;
  if (Date.now() - lastBeat < BRIEF_EXPORT_HEARTBEAT_STALE_MS) return record;
  const failed: BriefExportJobRecord = { ...record, status: 'failed', progressPct: 100, error: STALE_EXPORT_ERROR, errorCode: 'RenderFailure' };
  void saveBriefExportJobRecord(failed).catch((err) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'brief-export', level: 'warn',
      message: `resolveBriefExportJobPoll: stale-to-failed write failed for ${jobId} (responding anyway)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  });
  return failed;
}

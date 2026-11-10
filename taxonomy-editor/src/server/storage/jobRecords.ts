// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Per-user listing of durable job records (t/4216, t/181) — the shared, cross-replica view that
// per-user job caps and idempotency checks read (t/182), instead of one replica's in-memory Map.
//
// Built on StorageBackend.listDirectory + readFile, so it works on every backend. Records are read
// through the same backend their store writes with: inquiry → user-content, brief-export →
// brief-export backend.
//
// Records come back RAW: no staleness, retention or terminal filtering. What counts as "running"
// is the caller's decision (isTerminalExportStatus / inquiry status, lastHeartbeatAt against the
// *_HEARTBEAT_STALE_MS constants).
//
// Failure is loud: any list or read failure throws JOB_RECORD_LIST_FAILED, so a caller can fail
// closed for a cap. Exception: GitHubAPIBackend.listDirectory can return a degraded [] (WARN-logged
// by the backend) when its tree is unavailable; hosted job records live on Blob, which throws.

import path from 'path';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getUserContentBackend, getBriefExportBackend } from './fileIO.js';
import { getInquiryJobsDir, type InquiryJobRecord } from './inquiryJobStore.js';
import { getBriefExportJobsDir, type BriefExportJobRecord } from './briefExportJobStore.js';
import type { StorageBackend } from './storageBackend.js';
import { GitHubAPIBackend } from './githubAPIBackend.js';

export type JobRecordKind = 'inquiry' | 'brief-export';
export type JobRecordOf<K extends JobRecordKind> = K extends 'inquiry' ? InquiryJobRecord : BriefExportJobRecord;

const JOB_FILE_RE = /^job-[a-zA-Z0-9_-]+\.json$/;

function listFailed(kind: JobRecordKind, dir: string, err: unknown): ActionableError {
  return new ActionableError({
    goal: `List ${kind} job records`,
    problem: `The storage backend failed while listing or reading ${dir}: ${String(err)}`,
    location: 'storage/jobRecords.ts listUserJobRecords',
    nextSteps: ['Treat the job count as unknown (fail closed for caps)', 'Check storage backend health and retry'],
    httpStatus: 503,
    code: 'JOB_RECORD_LIST_FAILED',
    innerError: err,
  });
}

/** The userId becomes a path segment. Storage ids are sanitized upstream (deriveStorageUserId) but
 *  may contain characters assertSafeId rejects (e.g. '+'), so only refuse what could escape. */
function assertUserSegment(userId: string): void {
  if (!userId || userId === '.' || userId === '..' || /[/\\\0]/.test(userId)) {
    throw new ActionableError({
      goal: 'List job records for a user',
      problem: `Invalid storage user id for a path segment: ${JSON.stringify(userId)}`,
      location: 'storage/jobRecords.ts listUserJobRecords',
      nextSteps: ['Pass getStorageUserId() for the current request'],
      httpStatus: 400,
    });
  }
}

function target(userId: string, kind: JobRecordKind): { backend: StorageBackend; dir: string } {
  return kind === 'inquiry'
    ? { backend: getUserContentBackend(), dir: getInquiryJobsDir(userId) }
    : { backend: getBriefExportBackend(), dir: getBriefExportJobsDir(userId) };
}

/** Parses one record; a wrong-shape or other-user record is skipped with a WARN (null). */
function parseRecord(kind: JobRecordKind, userId: string, name: string, raw: string): InquiryJobRecord | BriefExportJobRecord | null {
  let rec: { jobId?: unknown; userId?: unknown; status?: unknown };
  try {
    rec = JSON.parse(raw) as typeof rec;
  } catch (err) {
    log.server.warn({ err, kind, userId, name, cause: 'job-record-unparseable' },
      'job record is not valid JSON — skipped from the listing (t/181)');
    return null;
  }
  if (typeof rec !== 'object' || rec === null || typeof rec.jobId !== 'string' || typeof rec.status !== 'string') {
    log.server.warn({ kind, userId, name, cause: 'job-record-wrong-shape' }, 'job record lacks jobId/status — skipped from the listing (t/181)');
    return null;
  }
  if (rec.userId !== userId) {
    log.server.warn({ kind, userId, name, recordUserId: rec.userId, cause: 'job-record-wrong-user' },
      'job record belongs to another user — skipped from the listing (t/181)');
    return null;
  }
  return rec as unknown as InquiryJobRecord | BriefExportJobRecord;
}

/**
 * t/268 (item 5): Validate that a GitHub listDirectory [] is genuine, not degraded.
 * On degraded [] (circuit breaker / transient), throws with JOB_RECORD_LIST_FAILED.
 */
async function validateGitHubListDirectoryResult(backend: StorageBackend, dir: string, kind: JobRecordKind): Promise<void> {
  if (backend instanceof GitHubAPIBackend) {
    try {
      await backend.listDirectoryStrict(dir);
    } catch (err: unknown) {
      if ((err as { kind?: string }).kind === 'transient') {
        // Circuit breaker or transient API failure. Fail closed.
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'job-records', level: 'error', message: `listUserJobRecords: GitHub transient failure, rejecting degraded [] as "unknown cap": ${dir}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw listFailed(kind, dir, new Error('GitHub backend returned degraded [] — cannot confirm job count (transient failure). Failing closed.'));
      }
      // Non-transient error (config/creds) — re-throw as is.
      throw err;
    }
  }
}

/**
 * Every persisted job record of `kind` for `userId` (explicit, not getStorageUserId(), so a check
 * can name the user it counts). A missing directory → []. Unparseable, wrong-shape or other-user
 * records are skipped with a WARN. A record deleted between the listing and its read is skipped.
 * Any backend failure throws ActionableError `JOB_RECORD_LIST_FAILED` (503).
 */
export async function listUserJobRecords<K extends JobRecordKind>(userId: string, kind: K): Promise<JobRecordOf<K>[]> {
  assertUserSegment(userId);
  const { backend, dir } = target(userId, kind);
  let names: string[];
  try {
    names = await backend.listDirectory(dir);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'job-records', level: 'error', message: `listUserJobRecords: listing failed: ${dir}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw listFailed(kind, dir, err);
  }

  if (names.length === 0) await validateGitHubListDirectoryResult(backend, dir, kind);

  const records: JobRecordOf<K>[] = [];
  for (const name of names.filter(n => JOB_FILE_RE.test(n))) {
    let raw: string | null;
    try {
      raw = await backend.readFile(path.join(dir, name));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'job-records', level: 'error', message: `listUserJobRecords: read failed: ${name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw listFailed(kind, dir, err);
    }
    if (raw === null) continue; // deleted between list and read (completion / retention sweep)
    const rec = parseRecord(kind, userId, name, raw);
    if (rec) records.push(rec as JobRecordOf<K>);
  }
  return records;
}

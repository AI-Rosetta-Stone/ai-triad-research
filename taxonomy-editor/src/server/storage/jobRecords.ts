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

/** How many job records listUserJobRecords reads at once (t/268 item 6). */
export const JOB_RECORD_READ_CONCURRENCY = 8;

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
      code: 'INVALID_STORAGE_USER_ID',
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
    if (backend instanceof GitHubAPIBackend) {
      // t/268 (item 5): a degraded [] must not read as "no records", or a job cap fails open.
      const listing = await backend.listDirectoryDetailed(dir);
      if (listing.degraded) {
        log.storage.warn({ dir, degraded: listing.degraded, kind }, 'listUserJobRecords: degraded GitHub listing — job cap fails closed (JOB_RECORD_LIST_FAILED, 503) (t/268)');
        throw new ActionableError({
          goal: 'Count job records for a job cap',
          problem: `GitHub listing degraded (${listing.degraded}); cannot confirm the record count`,
          location: 'jobRecords.listUserJobRecords',
          nextSteps: ['Retry once the GitHub backend is reachable; the cap fails closed until then'],
        });
      }
      names = listing.names;
    } else {
      names = await backend.listDirectory(dir);
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'job-records', level: 'error', message: `listUserJobRecords: listing failed: ${dir}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw listFailed(kind, dir, err);
  }

  // t/268 (item 6): read the records with bounded concurrency. One at a time made a cap check wait on N
  // sequential backend reads; all at once would put N requests on the backend for one user's listing.
  const recordNames = names.filter(n => JOB_FILE_RE.test(n));
  const raws = new Array<string | null>(recordNames.length).fill(null);
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= recordNames.length) return;
      const name = recordNames[i];
      try {
        raws[i] = await backend.readFile(path.join(dir, name));
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'job-records', level: 'error', message: `listUserJobRecords: read failed: ${name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        if (!failed) { failed = true; failure = err; }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOB_RECORD_READ_CONCURRENCY, recordNames.length) }, () => worker()));
  // A read failure is never a silently shorter list: a cap that counted it would fail open.
  if (failed) throw listFailed(kind, dir, failure);

  const records: JobRecordOf<K>[] = [];
  recordNames.forEach((name, i) => {
    const raw = raws[i];
    if (raw === null) return; // deleted between list and read (completion / retention sweep)
    const rec = parseRecord(kind, userId, name, raw);
    if (rec) records.push(rec as JobRecordOf<K>);
  });
  return records;
}

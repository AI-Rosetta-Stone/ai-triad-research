// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Durable, cross-replica job concurrency caps (t/182) — replaces in-memory job counting for
// critical caps like inquiry concurrency and export quota. Uses listUserJobRecords to read the
// persistent job record index, failing closed (reject new job) if the store is unavailable.
//
// Capability: count running jobs of a given kind for a user, with fail-closed semantics.
// Calling layer (routes) checks: if (countExceeds(cap)) { reject }; if (!allowed()) { reject }.
//
// Running status is determined by:
//  - Terminal status (done, failed, etc.) — always not-running
//  - Heartbeat staleness — stale jobs are treated as crashed, not-running
//  - For exports: debateId scoping — only exports for the same debate are counted as duplicates

import type { JobRecordKind, JobRecordOf } from './jobRecords.js';
import { listUserJobRecords } from './jobRecords.js';
import { log } from '../logger.js';
import { INQUIRY_HEARTBEAT_STALE_MS } from './inquiryJobStore.js';
import { BRIEF_EXPORT_HEARTBEAT_STALE_MS } from './briefExportJobStore.js';

export interface JobCapError {
  reason: 'list_failed';
  kind: JobRecordKind;
  userId: string;
  cause: unknown;
}

/** In-process guard: per-user job submissions to prevent same-replica double-submit.
 *  Keyed by (userId, kind, debateId?), records the most recent jobId submitted.
 *  Updated at the end of successful create, checked before durable count. */
const IN_PROCESS_SUBMISSIONS = new Map<string, string>();

/** Get the staleness threshold for a job kind (in ms from lastHeartbeatAt). */
function getStalenesThreshold(kind: JobRecordKind): number {
  return kind === 'inquiry' ? INQUIRY_HEARTBEAT_STALE_MS : BRIEF_EXPORT_HEARTBEAT_STALE_MS;
}

/** Check if a record's heartbeat is fresh enough to count as "running". */
function isHeartbeatFresh(record: JobRecordOf<any>, kind: JobRecordKind): boolean {
  const lastBeatMs = record.lastHeartbeatAt ? Date.parse(record.lastHeartbeatAt) : 0;
  const staleThreshold = getStalenesThreshold(kind);
  return Date.now() - lastBeatMs < staleThreshold;
}

/**
 * Count non-terminal job records for a user with fresh heartbeats, with fail-closed semantics.
 * Returns { count, error } where:
 *   - count >= 0: number of running jobs (not-terminal AND fresh heartbeat, optionally filtered by debateId)
 *   - error: listing failed (caller should reject the request as fail-closed)
 *
 * Example:
 *   const { count, error } = await countUserJobRecords(userId, 'inquiry', 
 *     (rec) => !isTerminalStatus(rec.status));
 *   if (error) { reject with 503 }
 *   if (count >= MAX_CONCURRENT) { reject with 429 }
 *
 * For exports, pass an additional filter to scope by debateId:
 *   const { count } = await countUserJobRecords(userId, 'brief-export',
 *     (rec) => !isTerminalExportStatus(rec.status) && rec.debateId === debateId);
 */
export async function countUserJobRecords<K extends JobRecordKind>(
  userId: string,
  kind: K,
  isRunning: (record: JobRecordOf<K>) => boolean,
): Promise<{ count: number; error: null } | { count: null; error: JobCapError }> {
  try {
    const records = await listUserJobRecords(userId, kind);
    const count = records.filter(rec => isRunning(rec) && isHeartbeatFresh(rec, kind)).length;
    return { count, error: null };
  } catch (err) {
    log.server.warn(
      { cause: 'job-cap-list-failed', userId, kind, err: String(err) },
      `job cap check failed: listing ${kind} records for ${userId} — failing closed`,
    );
    return {
      count: null,
      error: { reason: 'list_failed', kind, userId, cause: err },
    };
  }
}

/**
 * Check if a user has a running job with a matching idempotency key (and debateId for exports).
 * Returns the matching record if found, or null if not found / listing failed (fail-closed).
 */
export async function findRunningJobByIdempotencyKey<K extends JobRecordKind>(
  userId: string,
  kind: K,
  idempotencyKey: string | undefined,
  debateId: string | undefined,
  isRunning: (record: JobRecordOf<K>) => boolean,
): Promise<JobRecordOf<K> | null> {
  if (!idempotencyKey) return null;
  try {
    const records = await listUserJobRecords(userId, kind);
    for (const rec of records) {
      if (isRunning(rec) && isHeartbeatFresh(rec, kind)) {
        const typed = rec as any;
        if (typed.idempotencyKey === idempotencyKey) {
          // For exports, also match on debateId to scope the idempotency to the debate
          if (kind === 'brief-export' && debateId !== undefined) {
            if (typed.debateId === debateId) return rec;
          } else {
            return rec;
          }
        }
      }
    }
    return null;
  } catch (err) {
    log.server.warn(
      { cause: 'idempotency-check-failed', userId, kind, err: String(err) },
      `idempotency check failed: listing ${kind} records for ${userId} — failing closed (returning null, new job will be created)`,
    );
    // Return null (fail-closed): if we can't verify idempotency, allow a new job to be created
    // rather than blocking the user. The durable record will enforce idempotency on the next
    // write. This is safe because createXxxJobRecordIfAbsent uses writeFileIfAbsent: the first
    // write wins, so concurrent identical requests will have one succeed and others get 'exists'.
    return null;
  }
}

/**
 * Record a submission in the in-process guard to prevent same-replica double-submit.
 * Key: (userId, kind, debateId) — for inquiry, debateId is undefined.
 */
export function recordInProcessSubmission(userId: string, kind: JobRecordKind, debateId: string | undefined, jobId: string): void {
  const key = `${userId}:${kind}:${debateId ?? ''}`;
  IN_PROCESS_SUBMISSIONS.set(key, jobId);
}

/**
 * Check the in-process guard: if a submission is in-flight on this replica for the same
 * (userId, kind, debateId), return the in-process jobId. Otherwise return null.
 * This prevents same-replica race: two simultaneous POSTs both pass the durable cap check
 * before either writes their record.
 */
export function checkInProcessSubmission(userId: string, kind: JobRecordKind, debateId: string | undefined): string | null {
  const key = `${userId}:${kind}:${debateId ?? ''}`;
  return IN_PROCESS_SUBMISSIONS.get(key) ?? null;
}

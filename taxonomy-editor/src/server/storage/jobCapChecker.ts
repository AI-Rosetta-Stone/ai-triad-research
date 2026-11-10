// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Durable, cross-replica job concurrency caps (t/182) — replaces in-memory job counting for
// critical caps like inquiry concurrency and export quota. Uses listUserJobRecords to read the
// persistent job record index, failing closed (reject new job) if the store is unavailable.
//
// Capability: count running jobs of a given kind for a user, with fail-closed semantics.
// Calling layer (routes) checks: if (countExceeds(cap)) { reject }; if (!allowed()) { reject }.
//
// Running status is determined by the caller (isTerminalInquiryStatus / isTerminalExportStatus),
// since this module is backend-agnostic and doesn't know inquiry vs export semantics.

import type { JobRecordKind, JobRecordOf } from './jobRecords.js';
import { listUserJobRecords, type JobRecordOf as JobRecordType } from './jobRecords.js';
import { log } from '../logger.js';

export interface JobCapError {
  reason: 'list_failed';
  kind: JobRecordKind;
  userId: string;
  cause: unknown;
}

/**
 * Count non-terminal job records for a user, with fail-closed semantics.
 * Returns { count, error } where:
 *   - count >= 0: number of running jobs (caller determines terminal vs running via checker fn)
 *   - error: listing failed (caller should reject the request as fail-closed)
 *
 * Example:
 *   const { count, error } = await countUserJobRecords(userId, 'inquiry', rec => !isTerminalStatus(rec.status));
 *   if (error) { reject with 503 }
 *   if (count >= MAX_CONCURRENT) { reject with 429 }
 */
export async function countUserJobRecords<K extends JobRecordKind>(
  userId: string,
  kind: K,
  isRunning: (record: JobRecordOf<K>) => boolean,
): Promise<{ count: number; error: null } | { count: null; error: JobCapError }> {
  try {
    const records = await listUserJobRecords(userId, kind);
    const count = records.filter(isRunning).length;
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
 * Check if a user has a running job with a matching idempotency key.
 * Returns the matching record if found, or null if not found / listing failed (fail-closed).
 */
export async function findRunningJobByIdempotencyKey<K extends JobRecordKind>(
  userId: string,
  kind: K,
  idempotencyKey: string | undefined,
  isRunning: (record: JobRecordOf<K>) => boolean,
): Promise<JobRecordOf<K> | null> {
  if (!idempotencyKey) return null;
  try {
    const records = await listUserJobRecords(userId, kind);
    for (const rec of records) {
      if (isRunning(rec)) {
        const typed = rec as unknown as { idempotencyKey?: string };
        if (typed.idempotencyKey === idempotencyKey) return rec;
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

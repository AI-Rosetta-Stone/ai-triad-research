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

/** Tail of the per-(user, kind) submission queue. Same-replica only; cross-replica races are
 *  bounded by the durable records, which each admitted request writes before the lock is released. */
const SUBMISSION_TAILS = new Map<string, Promise<void>>();

/**
 * Run `fn` (check idempotency + cap, then create the durable record) exclusively per (user, kind).
 * Concurrent callers QUEUE rather than reject, so N concurrent POSTs under the cap are all
 * admitted, and each later caller counts the records its predecessors already wrote.
 * `fn` must write its durable record before returning.
 */
export async function withSubmissionLock<T>(userId: string, kind: JobRecordKind, fn: () => Promise<T>): Promise<T> {
  const key = `${userId}:${kind}`;
  const prev = SUBMISSION_TAILS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const tail = prev.then(() => mine);
  SUBMISSION_TAILS.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (SUBMISSION_TAILS.get(key) === tail) SUBMISSION_TAILS.delete(key);
  }
}

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
      `idempotency check failed: listing ${kind} records for ${userId} — treating as no match`,
    );
    // The caller's cap check reads the same listing and fails closed (503) on the same error, so
    // a store outage never admits a job; this null only lets that check report it.
    return null;
  }
}


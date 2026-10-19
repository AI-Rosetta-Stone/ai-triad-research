// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4258/t/4276 (C4): the SIGTERM overlay flush, extracted from server.ts's shutdown() to keep
// it under the file's line budget (ADR-007).
//
// Azure Container Apps gives a 60s termination grace after SIGTERM (terminationGrace-
// PeriodSeconds, main.bicep:799) before SIGKILL. The overlay flush gets a ~40s budget here;
// server.ts's force-exit timeout is raised from 10s to 45s so the flush has room to run (or
// hit its own deadline and WARN) before the process is killed anyway, leaving ~15s headroom
// under the platform's hard 60s cutoff for the final exit itself.
//
// SO re-confirmation (e/311#2, e/315#2) found three gaps, all fixed here:
// (1) flushing only `fileIO.ts`'s debounced-commit pending map misses a user whose overlay was
//     never scheduled, is mid-retry-backoff, or exhausted its retries — this sweeps
//     `GitHubAPIBackend.getUncommittedOverlaySummary()`'s ACTUAL overlay contents instead and
//     calls `commitOverlay()` directly per user, capped at 4 concurrent (also closes the AC1
//     "cap ~4" deviation).
// (2) the deadline WARN must be based on the same overlay-contents re-check, not scheduler
//     status, or a dirty overlay with no scheduler entry would silently produce no WARN.
// (3) a single snapshot-and-sweep, taken alongside `server.close()`, misses a request that
//     writes AFTER that snapshot but before its connection actually drains — this now waits for
//     `closeDone` (bounded by whatever deadline remains) and sweeps once more, skipping users
//     who already failed the first pass rather than retrying them.

import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import type { GitHubAPIBackend } from './storage/githubAPIBackend.js';
import { sessionBranchNameFor } from './storage/sessionBranchManager.js';

export const OVERLAY_FLUSH_DEADLINE_MS = 40_000;
export const FORCE_EXIT_TIMEOUT_MS = 45_000;
const OVERLAY_FLUSH_CONCURRENCY = 4;

/** Run `worker` for each item in `items`, at most `concurrency` in flight at once. */
async function runWithConcurrencyCap<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => lane()));
}

/**
 * Sweep every user with a non-empty overlay and commit it directly, capped at
 * `OVERLAY_FLUSH_CONCURRENCY` concurrent commits, racing the whole sweep against the deadline
 * budget still remaining. A user whose commit throws is recorded in `failedUserIds` so a later
 * sweep (the late-write pass below) skips them rather than retrying. A user whose commit
 * succeeds is recorded in `committedUserIds` (t/4302) — keyed off the real outcome, not a
 * pre-flush snapshot, so a late-write-pass success is captured too.
 */
async function sweepOnce(
  backend: GitHubAPIBackend, budgetMs: number, failedUserIds: Set<string>, committedUserIds: Set<string>,
): Promise<boolean> {
  const userIds = backend.getUncommittedOverlaySummary().map(s => s.userId).filter(id => !failedUserIds.has(id));
  if (userIds.length === 0) return false;
  let timedOut = false;
  const sweep = runWithConcurrencyCap(userIds, OVERLAY_FLUSH_CONCURRENCY, async (userId) => {
    try {
      // C3a (t/4277): an explicit branchName is required outside request scope — the SIGTERM
      // handler has no AsyncLocalStorage context for getEffectiveRef() to resolve.
      await backend.commitOverlay(userId, undefined, { branchName: sessionBranchNameFor(userId) });
      committedUserIds.add(userId);
    } catch {
      failedUserIds.add(userId);
      /* telemetry — silent by design; already logged + flight-recorded by commitOverlayGuarded, don't double-log, and don't let one user's failure abort the other lanes' sweep */
    }
  });
  await Promise.race([
    sweep,
    new Promise<void>((resolve) => { setTimeout(() => { timedOut = true; resolve(); }, Math.max(0, budgetMs)); }),
  ]);
  return timedOut;
}

/**
 * Sweep every dirty overlay and commit it directly (see `sweepOnce`), then — bounded by
 * whatever deadline remains — wait for `closeDone` (server.close()'s callback, i.e. every
 * in-flight request has finished) and sweep ONE more time. The first sweep's user list is a
 * snapshot taken alongside `server.close()`; a request that writes after that snapshot but
 * before its connection drains is only caught by this second pass (t/4276, SO e/315#2). Users
 * who already failed the first sweep are skipped on the second, not retried. Finally, re-check
 * the overlay contents (not any scheduler bookkeeping) and WARN naming whoever is still dirty.
 *
 * t/4302: Azure's staging kill test found the SIGTERM commit couldn't be attributed to this
 * flush rather than the 2s debounce timer firing during the grace period. One INFO summary line
 * (committed/still-dirty/duration) closes that gap — logged whenever there was anything dirty to
 * report, silent on a true no-op shutdown (matching the existing no-dirty-overlay tests).
 */
export async function flushOverlaysWithDeadline(backend: GitHubAPIBackend | null, closeDone: Promise<void>): Promise<void> {
  if (!backend) return; // filesystem/Electron mode — no overlay semantics
  const startedAt = Date.now();
  const deadlineAt = startedAt + OVERLAY_FLUSH_DEADLINE_MS;
  const remainingMs = (): number => deadlineAt - Date.now();
  const failedUserIds = new Set<string>();
  const committedUserIds = new Set<string>();

  let timedOut = await sweepOnce(backend, remainingMs(), failedUserIds, committedUserIds);

  if (!timedOut && remainingMs() > 0) {
    await Promise.race([
      closeDone,
      new Promise<void>((resolve) => { setTimeout(resolve, remainingMs()); }),
    ]);
    if (remainingMs() > 0) timedOut = await sweepOnce(backend, remainingMs(), failedUserIds, committedUserIds);
    else timedOut = true;
  }

  const stillDirty = backend.getUncommittedOverlaySummary();
  const durationMs = Date.now() - startedAt;

  if (committedUserIds.size > 0 || stillDirty.length > 0) {
    log.server.info(
      { committedUsers: [...committedUserIds], stillDirtyUsers: stillDirty, durationMs, timedOut },
      `shutdown flush: committed ${committedUserIds.size} user(s) in ${durationMs}ms`,
    );
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'server', level: 'info',
      message: `shutdown flush: committed ${committedUserIds.size} user(s) in ${durationMs}ms`,
      data: { committedUsers: [...committedUserIds], stillDirtyUsers: stillDirty, durationMs, timedOut },
    });
  }

  if (stillDirty.length > 0) {
    const totalEntries = stillDirty.reduce((sum, s) => sum + s.entryCount, 0);
    const message = `${totalEntries} uncommitted overlay entries across ${stillDirty.length} user(s) still dirty after the shutdown flush${timedOut ? ' (flush deadline hit)' : ''} (t/4258) — will be lost`;
    log.server.error({ timedOut, users: stillDirty }, message);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'warn', message, data: { timedOut, users: stillDirty },
    });
  }
}

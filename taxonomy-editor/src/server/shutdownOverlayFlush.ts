// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4258/t/4276 (C4): the SIGTERM overlay flush, extracted from server.ts's shutdown() to
// keep it under the file's line budget (ADR-007).
//
// Azure Container Apps gives a 60s termination grace after SIGTERM (terminationGrace-
// PeriodSeconds, main.bicep:799) before SIGKILL. The overlay flush gets a ~40s budget here;
// server.ts's force-exit timeout is raised from 10s to 45s so the flush has room to run (or
// hit its own deadline and WARN) before the process is killed anyway, leaving ~15s headroom
// under the platform's hard 60s cutoff for the final exit itself.

import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import type { SessionBranchManager } from './storage/sessionBranchManager.js';
import { flushPendingOverlayCommits, getOverlayCommitStatus } from './storage/overlayCommitScheduler.js';

export const OVERLAY_FLUSH_DEADLINE_MS = 40_000;
export const FORCE_EXIT_TIMEOUT_MS = 45_000;

/**
 * Race the debounced-overlay-commit flush (t/4277 C3's `flushPendingOverlayCommits`) against
 * a deadline, then WARN naming any user whose overlay is still not committed — makes t/4258's
 * shutdown observability (the immediate snapshot in `GitHubAPIBackend.shutdown()`) load-bearing
 * at the point that actually matters: after the flush had its chance to run.
 *
 * `sessionManager.getActiveBranches()` is used as the user set to re-check rather than only
 * the scheduler's internal pending map, because a commit retry's backoff timer (overlay-
 * CommitScheduler.ts) isn't tracked in that map — checking every active-branch user's status
 * instead of just the ones `flushPendingOverlayCommits()` saw catches that gap too.
 */
export async function flushOverlaysWithDeadline(sessionManager: SessionBranchManager | null): Promise<void> {
  const activeUserIds = sessionManager ? sessionManager.getActiveBranches().map(b => b.userId) : [];
  let timedOut = false;
  await Promise.race([
    flushPendingOverlayCommits(),
    new Promise<void>((resolve) => { setTimeout(() => { timedOut = true; resolve(); }, OVERLAY_FLUSH_DEADLINE_MS); }),
  ]);
  const stillUncommitted = activeUserIds
    .map((userId) => ({ userId, status: getOverlayCommitStatus(userId) }))
    .filter((entry): entry is { userId: string; status: NonNullable<ReturnType<typeof getOverlayCommitStatus>> } =>
      entry.status !== undefined && entry.status.state !== 'committed');
  if (stillUncommitted.length > 0) {
    const message = `${stillUncommitted.length} user(s) still have an uncommitted overlay at shutdown${timedOut ? ' (flush deadline hit)' : ''} (t/4258) — will be lost`;
    log.server.error({ timedOut, users: stillUncommitted }, message);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'warn', message, data: { timedOut, users: stillUncommitted },
    });
  }
}

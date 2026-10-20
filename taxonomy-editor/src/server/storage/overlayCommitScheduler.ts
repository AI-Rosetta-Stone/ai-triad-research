// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Overlay commit scheduling (t/4258/t/4277 C3) — extracted from fileIO.ts
 * (ADR-007, same pattern as debateStore.ts/calibrationStore.ts/urlFetch.ts:
 * re-exported from fileIO.ts, so the public surface is unchanged).
 *
 * Writes outside taxonomyDataSlice.save() (edges status/swap/bulk, conflicts,
 * cruxes evidence) land in the GitHub-backend session overlay but have no
 * following commit — any restart/deploy/scale-to-zero drops them (t/4258).
 * scheduleOverlayCommit() debounces a commit after such a write instead of
 * awaiting one inside the request: the response still returns right after
 * the overlay write, as today. No-op on backends without overlay semantics
 * (filesystem/Electron mode) or once no session user is active.
 */

import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import type { StorageBackend } from './storageBackend.js';
import { sessionBranchNameFor } from './sessionBranchManager.js';
import { getBackend } from './fileIO.js';

interface OverlayCommittable {
  commitOverlay(
    userId: string, message?: string, opts?: { branchName?: string },
  ): Promise<{ commitSha: string; filesCommitted: number; conflictedPaths?: string[] } | null>;
}
function supportsOverlayCommit(b: StorageBackend): b is StorageBackend & OverlayCommittable {
  return typeof (b as unknown as { commitOverlay?: unknown }).commitOverlay === 'function';
}

const OVERLAY_COMMIT_DEBOUNCE_MS = 2_000;
const OVERLAY_COMMIT_MAX_WAIT_MS = 10_000;
const OVERLAY_COMMIT_MAX_RETRIES = 2;

// t/4312 (SO F1, TL p/538#94): ships gated — either together with Rosetta's
// conflict banner (t/4313) or behind this flag, OFF by default. The base-sha
// fence itself (never silently overwrite) is always on regardless; this flag
// only controls whether a conflict surfaces as a distinct, non-retried
// 'conflict' state or is treated like any other retryable failure (today's
// pre-t/4312 behavior, which just keeps retrying the same stale content
// until it exhausts its retries and shows 'failed').
const CONFLICT_STATE_ENABLED = process.env.OVERLAY_CONFLICT_STATE_ENABLED === '1';

export type OverlayCommitStatus = { state: 'pending' | 'committed' | 'failed' | 'conflict'; at: number; error?: string; conflictedPaths?: string[] };
// @INMEMORY_CACHE_SINGLE_REPLICA (t/4181, Server Storage ruling t/4181#9): these per-user pending-commit
// maps are process-local. With >1 replica and no affinity a read on another replica is up to ~10s stale,
// and concurrent same-file commits lose an update on retry. Remove only once this state is replica-safe.
const overlayCommitStatus = new Map<string, OverlayCommitStatus>();
const pendingOverlayCommits = new Map<string, { debounceTimer: ReturnType<typeof setTimeout>; maxWaitTimer: ReturnType<typeof setTimeout> }>();
// A user whose commit just failed and is waiting out its retry backoff is in
// neither map above (clearPendingOverlayCommit already ran) — tracked here so
// flushPendingOverlayCommits() can find them too, not just freshly-debounced
// writes (ServerAPI, p/541#71/#69).
const retryingOverlayCommits = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>();

// t/4258/t/4281 (TL, e/310#2): a sustained-burst user doing out-of-save()
// writes can drive ~6 scheduled commits/min (~4 GitHub calls each) — measure
// it before it becomes a real budget problem, rather than finding out from
// the shared App's rate limit. Per-user timestamps, pruned to the trailing
// hour on each successful commit (self-bounding; no separate cleanup pass).
const ONE_HOUR_MS = 60 * 60 * 1000;
const recentCommitTimestamps = new Map<string, number[]>();

function recordCommitRate(userId: string): number {
  const now = Date.now();
  const recent = (recentCommitTimestamps.get(userId) ?? []).filter((t) => t > now - ONE_HOUR_MS);
  recent.push(now);
  recentCommitTimestamps.set(userId, recent);
  return recent.length;
}

/** Surfaced by the sync-status route so the UI can show "not yet saved to GitHub". */
export function getOverlayCommitStatus(userId: string): OverlayCommitStatus | undefined {
  return overlayCommitStatus.get(userId);
}

function clearPendingOverlayCommit(userId: string): void {
  const pending = pendingOverlayCommits.get(userId);
  if (!pending) return;
  clearTimeout(pending.debounceTimer);
  clearTimeout(pending.maxWaitTimer);
  pendingOverlayCommits.delete(userId);
}

async function runScheduledOverlayCommit(userId: string, attempt = 0): Promise<void> {
  clearPendingOverlayCommit(userId);
  retryingOverlayCommits.delete(userId); // this invocation IS the retry firing (or the first attempt — a no-op delete either way)
  const backend = getBackend();
  if (!supportsOverlayCommit(backend)) return;
  try {
    // t/4258/t/4277 (C3a): pass the branch explicitly — this runs from a
    // setTimeout, outside any request's AsyncLocalStorage scope, so
    // GitHubAPIBackend.getEffectiveRef() would otherwise fall back to
    // baseBranch and commitOverlayImpl would throw on every scheduled commit.
    const result = await backend.commitOverlay(userId, undefined, { branchName: sessionBranchNameFor(userId) });
    const hasConflict = (result?.conflictedPaths?.length ?? 0) > 0;
    if (hasConflict) {
      if (CONFLICT_STATE_ENABLED) {
        // t/4312 SO F1: a conflict-only batch never resolves itself by
        // retrying — same stale content, same base, same mismatch every
        // time. Stop and wait for "Use theirs"/"Keep mine" instead.
        overlayCommitStatus.set(userId, { state: 'conflict', at: Date.now(), conflictedPaths: result!.conflictedPaths });
        return;
      }
      // Flag off: nothing committed, so this must NOT report 'committed' —
      // throw into the existing retry/backoff path below, same as any other
      // retryable failure, matching pre-t/4312 behavior exactly.
      throw new ActionableError({
        goal: 'Commit the overlay',
        problem: `${result!.conflictedPaths!.length} path(s) conflicted, nothing committed`,
        location: 'overlayCommitScheduler.runScheduledOverlayCommit',
        nextSteps: ['Enable OVERLAY_CONFLICT_STATE_ENABLED for the resolution flow', 'Retry once the other actor\'s change is known'],
      });
    }
    overlayCommitStatus.set(userId, { state: 'committed', at: Date.now() });
    const commitsInLastHour = recordCommitRate(userId);
    getGlobalRecorder()?.record({
      type: 'overlay.commit.rate',
      component: 'file-io',
      level: 'info',
      message: `Scheduled overlay commit for ${userId}: ${commitsInLastHour} commit(s) in the last hour`,
      data: { userId, commitsInLastHour },
    });
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    const warnMsg = `Scheduled overlay commit failed for ${userId} (attempt ${attempt + 1}) — will retry (t/4258)`;
    log.storage.warn({ userId, attempt }, warnMsg);
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'warn',
      message: warnMsg,
      error: { name: (err as Error).name ?? 'Error', message, stack: (err as Error).stack },
    });
    overlayCommitStatus.set(userId, { state: 'failed', at: Date.now(), error: message });
    if (attempt < OVERLAY_COMMIT_MAX_RETRIES) {
      const backoffMs = 1_000 * 2 ** attempt;
      const nextAttempt = attempt + 1;
      const timer = setTimeout(() => { void runScheduledOverlayCommit(userId, nextAttempt); }, backoffMs);
      retryingOverlayCommits.set(userId, { timer, attempt: nextAttempt });
    }
  }
}

/**
 * Schedule a debounced commit of `userId`'s overlay. Call after any overlay
 * write made outside `taxonomyDataSlice.save()` (which already calls
 * `syncCommit()` itself right after its PUT, t/4258). A trailing debounce
 * (`OVERLAY_COMMIT_DEBOUNCE_MS`) coalesces a burst of writes into one commit;
 * `OVERLAY_COMMIT_MAX_WAIT_MS` caps how long a sustained burst can keep
 * pushing the commit out.
 */
export function scheduleOverlayCommit(userId: string): void {
  if (!supportsOverlayCommit(getBackend())) return;
  overlayCommitStatus.set(userId, { state: 'pending', at: Date.now() });

  const existing = pendingOverlayCommits.get(userId);
  if (existing) {
    clearTimeout(existing.debounceTimer);
    existing.debounceTimer = setTimeout(() => { void runScheduledOverlayCommit(userId); }, OVERLAY_COMMIT_DEBOUNCE_MS);
    return;
  }
  pendingOverlayCommits.set(userId, {
    debounceTimer: setTimeout(() => { void runScheduledOverlayCommit(userId); }, OVERLAY_COMMIT_DEBOUNCE_MS),
    maxWaitTimer: setTimeout(() => { void runScheduledOverlayCommit(userId); }, OVERLAY_COMMIT_MAX_WAIT_MS),
  });
}

/**
 * t/4258/t/4277 (C3c): immediately run (not wait out the debounce for) every
 * currently-scheduled overlay commit, and wait for them all to settle. For
 * t/4276's SIGTERM flush — called once per non-empty overlay at shutdown
 * instead of relying on the debounce timer to fire before the process exits.
 * Users with no pending scheduled commit (nothing written since the last
 * commit, or committed via an explicit save already) are untouched.
 *
 * Also covers a user currently waiting out a retry backoff after a failed
 * attempt (ServerAPI, p/541#71): that user isn't in the debounce/max-wait map
 * above — clearPendingOverlayCommit already ran when the failure happened —
 * so without this they'd be invisible to flush entirely, not just absent
 * from its return. Their backoff timer is cancelled and the retry runs now,
 * at its original attempt number (not reset to 0, so a flush can't push a
 * user past OVERLAY_COMMIT_MAX_RETRIES).
 *
 * Returns each flushed user's terminal status so the SIGTERM deadline WARN
 * (t/4276 AC2) can name who/what stayed uncommitted — runScheduledOverlayCommit
 * always sets 'committed' or 'failed' before resolving, never leaves 'pending'.
 */
export function flushPendingOverlayCommits(): Promise<{ userId: string; status: OverlayCommitStatus }[]> {
  const userIds = new Set([...pendingOverlayCommits.keys(), ...retryingOverlayCommits.keys()]);
  return Promise.all([...userIds].map(async (userId) => {
    const retrying = retryingOverlayCommits.get(userId);
    if (retrying) {
      clearTimeout(retrying.timer);
      retryingOverlayCommits.delete(userId);
    }
    clearPendingOverlayCommit(userId);
    await runScheduledOverlayCommit(userId, retrying?.attempt ?? 0);
    return { userId, status: overlayCommitStatus.get(userId)! };
  }));
}

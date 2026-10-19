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
import type { StorageBackend } from './storageBackend.js';
import { sessionBranchNameFor } from './sessionBranchManager.js';
import { getBackend } from './fileIO.js';

interface OverlayCommittable {
  commitOverlay(
    userId: string, message?: string, opts?: { branchName?: string },
  ): Promise<{ commitSha: string; filesCommitted: number } | null>;
}
function supportsOverlayCommit(b: StorageBackend): b is StorageBackend & OverlayCommittable {
  return typeof (b as unknown as { commitOverlay?: unknown }).commitOverlay === 'function';
}

const OVERLAY_COMMIT_DEBOUNCE_MS = 2_000;
const OVERLAY_COMMIT_MAX_WAIT_MS = 10_000;
const OVERLAY_COMMIT_MAX_RETRIES = 2;

export type OverlayCommitStatus = { state: 'pending' | 'committed' | 'failed'; at: number; error?: string };
const overlayCommitStatus = new Map<string, OverlayCommitStatus>();
const pendingOverlayCommits = new Map<string, { debounceTimer: ReturnType<typeof setTimeout>; maxWaitTimer: ReturnType<typeof setTimeout> }>();

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
  const backend = getBackend();
  if (!supportsOverlayCommit(backend)) return;
  try {
    // t/4258/t/4277 (C3a): pass the branch explicitly — this runs from a
    // setTimeout, outside any request's AsyncLocalStorage scope, so
    // GitHubAPIBackend.getEffectiveRef() would otherwise fall back to
    // baseBranch and commitOverlayImpl would throw on every scheduled commit.
    await backend.commitOverlay(userId, undefined, { branchName: sessionBranchNameFor(userId) });
    overlayCommitStatus.set(userId, { state: 'committed', at: Date.now() });
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
      setTimeout(() => { void runScheduledOverlayCommit(userId, attempt + 1); }, backoffMs);
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
 */
export function flushPendingOverlayCommits(): Promise<void[]> {
  const userIds = [...pendingOverlayCommits.keys()];
  return Promise.all(userIds.map((userId) => {
    clearPendingOverlayCommit(userId);
    return runScheduledOverlayCommit(userId);
  }));
}

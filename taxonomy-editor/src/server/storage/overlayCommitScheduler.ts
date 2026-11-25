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

/** What `commitOverlay` returns today: the commit, or null when there was nothing to commit. */
export type OverlayCommitResult = { commitSha: string; filesCommitted: number; conflictedPaths?: string[] };

/** t/549 (t/503 PR 1, type only): the outcome once the cross-replica commit lease exists (t/550). 'busy'
 *  means another replica holds this user's commit lease: nothing was committed and nothing failed, so the
 *  scheduler re-arms without counting a retry. Not returned by anything yet. */
export type OverlayCommitOutcome = OverlayCommitResult | { kind: 'busy' } | null;

interface OverlayCommittable {
  commitOverlay(
    userId: string, message?: string, opts?: { branchName?: string },
  ): Promise<OverlayCommitResult | null>;
}
/** t/551: a backend that can share the commit status across replicas (GitHubAPIBackend with shared state). */
interface SharedCommitStatusBackend {
  publishSharedCommitStatus(userId: string, status: unknown): Promise<void>;
  readSharedCommitStatus(userId: string): Promise<{ status: unknown; staged: boolean } | null>;
}
function supportsSharedCommitStatus(b: StorageBackend): b is StorageBackend & SharedCommitStatusBackend {
  const c = b as unknown as Partial<SharedCommitStatusBackend>;
  return typeof c.publishSharedCommitStatus === 'function' && typeof c.readSharedCommitStatus === 'function';
}
function supportsOverlayCommit(b: StorageBackend): b is StorageBackend & OverlayCommittable {
  return typeof (b as unknown as { commitOverlay?: unknown }).commitOverlay === 'function';
}

const OVERLAY_COMMIT_DEBOUNCE_MS = 2_000;
const OVERLAY_COMMIT_MAX_WAIT_MS = 10_000;
const OVERLAY_COMMIT_MAX_RETRIES = 2;
/** t/550: when another replica holds this user's commit lease ('busy'), try again after this long, without counting a
 *  retry. The holder commits the same entries from the shared store, so the retry usually finds nothing left; a dead
 *  holder's lease lapses within its duration (60 s), never more than maxHold (300 s) after it was taken (ruling 8). */
export const OVERLAY_COMMIT_BUSY_RETRY_MS = 5_000;

/** t/550: the backend signals 'busy' (the OverlayCommitOutcome of t/549) as an error with this code, so commitOverlay's
 *  return type, and its other callers, stay unchanged. */
function isCommitBusy(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'OVERLAY_COMMIT_BUSY';
}

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

/** t/551: record a status locally and publish it to the shared store (a no-op when shared state is off). The publish
 *  is fire-and-forget and never throws; readers on other replicas fall back to their own value if it fails. */
function setStatus(userId: string, status: OverlayCommitStatus): void {
  overlayCommitStatus.set(userId, status);
  const backend = getBackend();
  if (supportsSharedCommitStatus(backend)) void backend.publishSharedCommitStatus(userId, status);
}

/** t/551 (TaxonomyServer t/503#7, ruling 5): the shared read is cached per process for this long. The renderer polls
 *  /api/sync/status every 45 s, and only while the tab is visible (useSyncStatus SYNC_POLL_MS, gatedInterval), so the
 *  cache mostly absorbs bursts (several tabs, a route that reads twice), not the steady poll. */
export const SHARED_STATUS_TTL_MS = 2_000;
/** t/551: the shared read never holds the polled route longer than this; on a timeout the local value is returned. */
export const SHARED_STATUS_READ_TIMEOUT_MS = 1_500;
const sharedStatusCache = new Map<string, { at: number; value: OverlayCommitStatus | undefined }>();

function isOverlayCommitStatus(v: unknown): v is OverlayCommitStatus {
  const s = v as { state?: unknown; at?: unknown } | null;
  return !!s && typeof s.at === 'number' && (s.state === 'pending' || s.state === 'committed' || s.state === 'failed' || s.state === 'conflict');
}

/** The shared answer: the published status, except that entries still in the store mean 'pending' unless the last
 *  status is a conflict or a failure (which need the user, or a retry, not a wait). */
function sharedAnswer(shared: { status: unknown; staged: boolean }, local: OverlayCommitStatus | undefined): OverlayCommitStatus | undefined {
  const published = isOverlayCommitStatus(shared.status) ? shared.status : local;
  if (shared.staged && published?.state !== 'conflict' && published?.state !== 'failed') {
    return { state: 'pending', at: published?.at ?? Date.now() };
  }
  return published;
}

async function readSharedStatusBounded(backend: SharedCommitStatusBackend, userId: string): Promise<{ status: unknown; staged: boolean } | null | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), SHARED_STATUS_READ_TIMEOUT_MS); });
  try {
    return await Promise.race([backend.readSharedCommitStatus(userId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── t/552: the DRAINING rollback's commit loop ──

/** A backend that can report what is left in the shared store (GitHubAPIBackend with shared state). */
interface DrainableBackend {
  getSharedOverlayDrainStatus(): Promise<{ draining: boolean; usersWithEntries: string[]; stagedEntries: number } | null>;
}
function supportsDrain(b: StorageBackend): b is StorageBackend & DrainableBackend & OverlayCommittable {
  return supportsOverlayCommit(b) && typeof (b as unknown as Partial<DrainableBackend>).getSharedOverlayDrainStatus === 'function';
}

/** t/552: one drain round. Commits every user who still has staged entries (each under its commit lease; 'busy' is
 *  left for the next round), then reports what is left. A user whose batch conflicts stays until "Use theirs" or
 *  "Keep mine" resolves it, and is listed in `remainingUsers`. Never throws. */
export async function drainSharedOverlayOnce(): Promise<{ committed: number; busy: number; failed: number; remainingEntries: number; remainingUsers: string[] } | null> {
  const backend = getBackend();
  if (!supportsDrain(backend)) return null;
  let status: Awaited<ReturnType<DrainableBackend['getSharedOverlayDrainStatus']>>;
  try {
    status = await backend.getSharedOverlayDrainStatus();
  } catch (err) {
    log.storage.warn({ err: String(err) }, 'drain: could not read the shared store; next round retries (t/552)');
    return null;
  }
  if (!status) return null;
  const { committed, busy, failed } = await commitEachDrainUser(backend, status.usersWithEntries);
  const after = await readDrainStatusOr(backend, status);
  const remainingEntries = after.stagedEntries;
  const remainingUsers = after.usersWithEntries;
  if (remainingEntries === 0) {
    log.storage.info('shared overlay DRAINED: the store is empty; the flag can be turned off (t/552)');
  } else {
    log.storage.info({ committed, busy, failed, remainingEntries, remainingUsers: remainingUsers.length }, 'drain round done (t/552)');
  }
  return { committed, busy, failed, remainingEntries, remainingUsers };
}

async function commitEachDrainUser(backend: OverlayCommittable, userIds: string[]): Promise<{ committed: number; busy: number; failed: number }> {
  let committed = 0, busy = 0, failed = 0;
  for (const userId of userIds) {
    try {
      const result = await backend.commitOverlay(userId, undefined, { branchName: sessionBranchNameFor(userId) });
      if (result && !(result.conflictedPaths?.length)) committed++;
    } catch (err) {
      log.storage.warn({ userId, busy: isCommitBusy(err), err: String(err) }, 'drain: a user\'s commit did not complete; next round retries (t/552)');
      if (isCommitBusy(err)) busy++; else failed++;
    }
  }
  return { committed, busy, failed };
}

async function readDrainStatusOr(
  backend: DrainableBackend, fallback: { usersWithEntries: string[]; stagedEntries: number },
): Promise<{ usersWithEntries: string[]; stagedEntries: number }> {
  try {
    return (await backend.getSharedOverlayDrainStatus()) ?? fallback;
  } catch (err) {
    log.storage.warn({ err: String(err) }, 'drain: could not re-read the shared store after the round; reporting the pre-round view (t/552)');
    return fallback;
  }
}

/** t/552: run drain rounds on a timer while DRAINING is on (server.ts wires it; TaxonomyServer). Returns a stop. */
export function startSharedOverlayDrain(intervalMs = 30_000): () => void {
  const timer = setInterval(() => { void drainSharedOverlayOnce(); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Surfaced by the sync-status route so the UI can show "not yet saved to GitHub". */
export function getOverlayCommitStatus(userId: string): OverlayCommitStatus | undefined {
  return overlayCommitStatus.get(userId);
}

/** t/549, t/551: the commit status any replica can answer. With shared state on, it reads the per-user status blob
 *  and whether entries are still staged, cached for SHARED_STATUS_TTL_MS and bounded by SHARED_STATUS_READ_TIMEOUT_MS.
 *  On a timeout or a storage error it returns the local value with a WARN, and never throws (TaxonomyServer t/503#7).
 *  With shared state off it is the local value, as getOverlayCommitStatus. routes/sync.ts moves to it in t/553. */
export async function getOverlayCommitStatusShared(userId: string): Promise<OverlayCommitStatus | undefined> {
  const local = overlayCommitStatus.get(userId);
  const backend = getBackend();
  if (!supportsSharedCommitStatus(backend)) return local;
  const cached = sharedStatusCache.get(userId);
  if (cached && Date.now() - cached.at < SHARED_STATUS_TTL_MS) return cached.value;
  try {
    const shared = await readSharedStatusBounded(backend, userId);
    if (shared === null) return local; // shared state is off for this backend
    if (shared === 'timeout') {
      log.storage.warn({ userId, timeoutMs: SHARED_STATUS_READ_TIMEOUT_MS }, 'shared overlay commit status read timed out; returning the local value (t/551)');
      return local;
    }
    const value = sharedAnswer(shared, local);
    sharedStatusCache.set(userId, { at: Date.now(), value });
    return value;
  } catch (err) {
    log.storage.warn({ userId, err: String(err) }, 'shared overlay commit status read failed; returning the local value (t/551)');
    return local;
  }
}

/** Test-only: forget the shared-status cache. */
export function resetSharedCommitStatusCacheForTests(): void {
  sharedStatusCache.clear();
}

function clearPendingOverlayCommit(userId: string): void {
  const pending = pendingOverlayCommits.get(userId);
  if (!pending) return;
  clearTimeout(pending.debounceTimer);
  clearTimeout(pending.maxWaitTimer);
  pendingOverlayCommits.delete(userId);
}

/** A conflict-only batch (t/4312). With the conflict state on, records 'conflict' and returns true (stop: retrying never
 *  resolves it; wait for "Use theirs"/"Keep mine"). With it off, throws into the caller's retry/backoff path, matching
 *  pre-t/4312 behaviour; nothing committed, so it must not report 'committed'. Extracted for the complexity budget (t/550). */
function stopOnConflict(userId: string, result: OverlayCommitResult | null): boolean {
  const conflictedPaths = result?.conflictedPaths ?? [];
  if (conflictedPaths.length === 0) return false;
  if (CONFLICT_STATE_ENABLED) {
    setStatus(userId, { state: 'conflict', at: Date.now(), conflictedPaths });
    return true;
  }
  throw new ActionableError({
    goal: 'Commit the overlay',
    problem: `${conflictedPaths.length} path(s) conflicted, nothing committed`,
    location: 'overlayCommitScheduler.runScheduledOverlayCommit',
    nextSteps: ['Enable OVERLAY_CONFLICT_STATE_ENABLED for the resolution flow', 'Retry once the other actor\'s change is known'],
  });
}

/** TL t/503#22 N3: a lease held longer than its own duration (60 s, 12 busy rounds) means the holder is stuck or a
 *  lease was stranded. Busy stays uncounted as a retry, but this streak is worth one WARN. */
export const OVERLAY_COMMIT_BUSY_WARN_ROUNDS = 12;
const consecutiveBusyRounds = new Map<string, number>();

/** t/550: nothing committed and nothing failed; the status stays 'pending' and the attempt is not counted. */
function rearmAfterBusy(userId: string, attempt: number): void {
  const rounds = (consecutiveBusyRounds.get(userId) ?? 0) + 1;
  consecutiveBusyRounds.set(userId, rounds);
  if (rounds === OVERLAY_COMMIT_BUSY_WARN_ROUNDS) {
    log.storage.warn({ userId, rounds, waitedMs: rounds * OVERLAY_COMMIT_BUSY_RETRY_MS },
      'Scheduled overlay commit: busy for longer than the commit lease lasts; the holder may be stuck or the lease stranded (t/503 N3)');
  } else {
    log.storage.info({ userId, attempt, rounds, retryInMs: OVERLAY_COMMIT_BUSY_RETRY_MS },
      'Scheduled overlay commit: another replica holds the commit lease; trying again (t/550)');
  }
  const timer = setTimeout(() => { void runScheduledOverlayCommit(userId, attempt); }, OVERLAY_COMMIT_BUSY_RETRY_MS);
  retryingOverlayCommits.set(userId, { timer, attempt });
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
    consecutiveBusyRounds.delete(userId);
    if (stopOnConflict(userId, result)) return;
    setStatus(userId, { state: 'committed', at: Date.now() });
    const commitsInLastHour = recordCommitRate(userId);
    getGlobalRecorder()?.record({
      type: 'overlay.commit.rate',
      component: 'file-io',
      level: 'info',
      message: `Scheduled overlay commit for ${userId}: ${commitsInLastHour} commit(s) in the last hour`,
      data: { userId, commitsInLastHour },
    });
  } catch (err) {
    if (isCommitBusy(err)) {
      rearmAfterBusy(userId, attempt);
      return;
    }
    consecutiveBusyRounds.delete(userId);
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
    setStatus(userId, { state: 'failed', at: Date.now(), error: message });
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
  setStatus(userId, { state: 'pending', at: Date.now() });

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

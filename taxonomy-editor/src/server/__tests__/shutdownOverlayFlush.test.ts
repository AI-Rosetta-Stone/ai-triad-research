// @vitest-environment node
//
// t/4258/t/4276 (C4) — flushOverlaysWithDeadline sweeps the backend's ACTUAL non-empty overlays
// (GitHubAPIBackend.getUncommittedOverlaySummary) and commits each directly, capped at 4
// concurrent, racing the sweep against a deadline. The WARN after is based on the same
// overlay-contents re-check, not any fileIO.ts scheduler bookkeeping — this is the SO's exact
// fix shape (e/311#2) after an earlier version of this file only flushed the scheduler's pending
// map and missed a user mid-retry-backoff, who exhausted retries, or who was never scheduled.
//
// C5 (e/308, e/312#2): the real-backend/real-scheduler flush test and the retry-backoff fault
// arm live in this file (gate the merge); the staging SIGTERM/SIGKILL check is recorded
// separately on t/4258 (gates the TL's prod-hold lift, not this merge).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitHubAPIBackend } from '../storage/githubAPIBackend.js';

const { warnMock, recordMock } = vi.hoisted(() => ({ warnMock: vi.fn(), recordMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: warnMock, info: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../config.js', () => ({ getMaxReplicas: () => 1 }));

import { flushOverlaysWithDeadline, OVERLAY_FLUSH_DEADLINE_MS } from '../shutdownOverlayFlush.js';

type OverlaySummaryEntry = { userId: string; entryCount: number; paths: string[] };

/** A fake GitHubAPIBackend exposing only what flushOverlaysWithDeadline uses, backed by a real
 *  in-memory overlay map so getUncommittedOverlaySummary() reflects what commitOverlay() actually
 *  clears — not independent mock state that could drift from the real contract. */
function fakeBackend(opts: {
  overlays: Record<string, number>; // userId -> entry count
  commitOverlayImpl?: (userId: string) => Promise<void>;
}): GitHubAPIBackend {
  const overlays = new Map(Object.entries(opts.overlays));
  const commitOverlay = vi.fn(async (userId: string) => {
    if (opts.commitOverlayImpl) await opts.commitOverlayImpl(userId); // may throw
    overlays.delete(userId);
    return { commitSha: 'sha', filesCommitted: 1 };
  });
  const getUncommittedOverlaySummary = vi.fn((): OverlaySummaryEntry[] =>
    [...overlays.entries()].map(([userId, entryCount]) => ({ userId, entryCount, paths: [`${userId}/path.json`] })));
  return { commitOverlay, getUncommittedOverlaySummary } as unknown as GitHubAPIBackend;
}

beforeEach(() => { warnMock.mockReset(); recordMock.mockReset(); });

describe('flushOverlaysWithDeadline (t/4276 C4)', () => {
  it('no-ops when backend is null (filesystem/Electron mode)', async () => {
    await flushOverlaysWithDeadline(null);
    expect(warnMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('no-ops with no WARN when no overlay is dirty', async () => {
    const backend = fakeBackend({ overlays: {} });
    await flushOverlaysWithDeadline(backend);
    expect(backend.commitOverlay).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('commits every dirty user and does not WARN once the sweep empties all overlays', async () => {
    const backend = fakeBackend({ overlays: { alice: 2, bob: 1 } });
    await flushOverlaysWithDeadline(backend);
    expect(backend.commitOverlay).toHaveBeenCalledWith('alice', undefined, { branchName: expect.stringContaining('alice') });
    expect(backend.commitOverlay).toHaveBeenCalledWith('bob', undefined, { branchName: expect.stringContaining('bob') });
    expect(backend.getUncommittedOverlaySummary()).toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('WARNs naming whoever is still dirty after a commit failure — based on overlay contents, not scheduler status', async () => {
    const backend = fakeBackend({
      overlays: { alice: 3, bob: 1 },
      commitOverlayImpl: async (userId) => { if (userId === 'alice') throw new Error('GitHub 500'); },
    });
    await flushOverlaysWithDeadline(backend);
    expect(backend.getUncommittedOverlaySummary()).toEqual([{ userId: 'alice', entryCount: 3, paths: ['alice/path.json'] }]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      data: expect.objectContaining({ timedOut: false, users: [{ userId: 'alice', entryCount: 3, paths: ['alice/path.json'] }] }),
    }));
  });

  it('caps concurrency at 4 — a 6-user sweep never runs more than 4 commits at once', async () => {
    const overlays: Record<string, number> = {};
    for (let i = 0; i < 6; i++) overlays[`user-${i}`] = 1;
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const backend = fakeBackend({
      overlays,
      commitOverlayImpl: () => new Promise<void>((resolve) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        releases.push(() => { inFlight--; resolve(); });
      }),
    });

    const done = flushOverlaysWithDeadline(backend);
    // Let the first lane batch start (microtask flush), then release in pairs to let more in.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(peak).toBeLessThanOrEqual(4);
    while (releases.length > 0) {
      const batch = releases.splice(0, releases.length);
      batch.forEach((r) => r());
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    await done;
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently, not accidentally serialized
  });

  it('WARNs with the deadline-hit flag when the sweep does not settle in time', async () => {
    vi.useFakeTimers();
    try {
      const backend = fakeBackend({
        overlays: { alice: 1 },
        commitOverlayImpl: () => new Promise(() => { /* never resolves */ }),
      });
      const p = flushOverlaysWithDeadline(backend);
      await vi.advanceTimersByTimeAsync(OVERLAY_FLUSH_DEADLINE_MS + 1);
      await p;
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('flush deadline hit') }));
    } finally {
      vi.useRealTimers();
    }
  });

  // C5 (SO, e/312#2): real backend + real scheduler, retry-backoff fault arm. A write scheduled
  // via the REAL overlayCommitScheduler.ts fails its first commit attempt and enters retry
  // backoff — at that moment it is NOT in the scheduler's pending-commit map (confirmed by
  // reading overlayCommitScheduler.ts: a failed attempt's retry is a bare setTimeout, not
  // re-registered in pendingOverlayCommits). The OLD design (flushing only
  // flushPendingOverlayCommits()'s pending map) would have found nothing to flush for this user
  // and WARNed them as lost. This flush sweeps the backend's actual overlay contents instead, so
  // it's independent of the scheduler's retry bookkeeping and still commits the user.
  describe('retry-backoff fault arm — real scheduler (t/4258 C5)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); vi.resetModules(); });

    it('flushes a user mid-retry-backoff, which the scheduler-pending-map approach would miss', async () => {
      let attempt = 0;
      const backend = fakeBackend({
        overlays: { alice: 1 },
        commitOverlayImpl: async () => {
          attempt++;
          if (attempt === 1) throw new Error('transient GitHub 503'); // scheduler's first attempt fails → retry backoff
        },
      });

      vi.doMock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: warnMock, info: vi.fn() }, storage: { warn: vi.fn() } } }));
      vi.doMock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
      vi.doMock('../config.js', () => ({ getMaxReplicas: () => 1 }));
      vi.doMock('../security/userContext.js', () => ({ getCurrentUserId: () => 'alice' }));
      // getBackend() is imported by overlayCommitScheduler.ts from fileIO.js — stub it to our fake
      // so the REAL scheduler's debounced commit runs against the same backend the flush sweeps.
      vi.doMock('../storage/fileIO.js', () => ({ getBackend: () => backend }));
      vi.resetModules();
      const { scheduleOverlayCommit } = await import('../storage/overlayCommitScheduler.js');
      const { flushOverlaysWithDeadline: flush } = await import('../shutdownOverlayFlush.js');

      scheduleOverlayCommit('alice');
      await vi.advanceTimersByTimeAsync(2_001); // debounce fires → first (failing) attempt runs
      expect(attempt).toBe(1);
      expect(backend.getUncommittedOverlaySummary()).toHaveLength(1); // still dirty — confirms the fault arm's premise

      // SIGTERM lands here: the user is in retry backoff (a bare setTimeout, not the pending map).
      await flush(backend);

      expect(attempt).toBeGreaterThanOrEqual(2); // the sweep's own commitOverlay call is attempt #2, which succeeds
      expect(backend.getUncommittedOverlaySummary()).toEqual([]); // flushed despite the scheduler's own retry state
    });
  });
});

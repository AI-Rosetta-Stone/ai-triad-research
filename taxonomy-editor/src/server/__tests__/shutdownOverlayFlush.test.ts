// @vitest-environment node
//
// t/4258/t/4276 (C4) — flushOverlaysWithDeadline sweeps the backend's ACTUAL non-empty overlays
// (GitHubAPIBackend.getUncommittedOverlaySummary) and commits each directly, capped at 4
// concurrent, racing the sweep against a deadline, then waits for closeDone (bounded by whatever
// deadline remains) and sweeps once more to catch a late write. The WARN after is based on the
// same overlay-contents re-check, not any fileIO.ts scheduler bookkeeping. This is the SO's exact
// fix shape (e/311#2, e/315#2) after earlier versions of this file (1) only flushed the
// scheduler's pending map, missing a user mid-retry-backoff/who exhausted retries/who was never
// scheduled, (2) WARNed from scheduler status instead of overlay contents, and (3) took a single
// snapshot-and-sweep alongside server.close(), missing a write that landed after that snapshot.
//
// The real-backend/real-scheduler C5 tests (write → flush before debounce → committed tree;
// retry-backoff fault arm vs. this flush's safe arm) live in
// shutdownOverlayFlushRealBackend.test.ts, using the githubApiOverlayCommitSafety harness per
// the SO's ask (a fake backend never exercises the real commit path). The staging SIGTERM/SIGKILL
// check is recorded separately on t/4258 (gates the TL's prod-hold lift, not this merge).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitHubAPIBackend } from '../storage/githubAPIBackend.js';

const { warnMock, recordMock } = vi.hoisted(() => ({ warnMock: vi.fn(), recordMock: vi.fn() }));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: warnMock, info: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../config.js', () => ({ getMaxReplicas: () => 1 }));

import { flushOverlaysWithDeadline, OVERLAY_FLUSH_DEADLINE_MS } from '../shutdownOverlayFlush.js';

type OverlaySummaryEntry = { userId: string; entryCount: number; paths: string[] };

/** A fake GitHubAPIBackend exposing only what flushOverlaysWithDeadline uses, backed by a real
 *  in-memory overlay map so getUncommittedOverlaySummary() reflects what commitOverlay() actually
 *  clears — not independent mock state that could drift from the real contract. `lateWrite` lets
 *  a test inject a new dirty entry partway through, simulating a request that writes after the
 *  first sweep's snapshot. */
function fakeBackend(opts: {
  overlays: Record<string, number>; // userId -> entry count
  commitOverlayImpl?: (userId: string) => Promise<void>;
}) {
  const overlays = new Map(Object.entries(opts.overlays));
  const commitOverlay = vi.fn(async (userId: string) => {
    if (opts.commitOverlayImpl) await opts.commitOverlayImpl(userId); // may throw
    overlays.delete(userId);
    return { commitSha: 'sha', filesCommitted: 1 };
  });
  const getUncommittedOverlaySummary = vi.fn((): OverlaySummaryEntry[] =>
    [...overlays.entries()].map(([userId, entryCount]) => ({ userId, entryCount, paths: [`${userId}/path.json`] })));
  return {
    commitOverlay, getUncommittedOverlaySummary,
    writeOverlay: (userId: string, entryCount = 1) => overlays.set(userId, entryCount),
  } as unknown as GitHubAPIBackend & { writeOverlay: (userId: string, entryCount?: number) => void };
}

beforeEach(() => { warnMock.mockReset(); recordMock.mockReset(); });

describe('flushOverlaysWithDeadline (t/4276 C4)', () => {
  it('no-ops when backend is null (filesystem/Electron mode)', async () => {
    await flushOverlaysWithDeadline(null, Promise.resolve());
    expect(warnMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('no-ops with no WARN when no overlay is dirty', async () => {
    const backend = fakeBackend({ overlays: {} });
    await flushOverlaysWithDeadline(backend, Promise.resolve());
    expect(backend.commitOverlay).not.toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('commits every dirty user and does not WARN once the sweep empties all overlays', async () => {
    const backend = fakeBackend({ overlays: { alice: 2, bob: 1 } });
    await flushOverlaysWithDeadline(backend, Promise.resolve());
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
    await flushOverlaysWithDeadline(backend, Promise.resolve());
    expect(backend.getUncommittedOverlaySummary()).toEqual([{ userId: 'alice', entryCount: 3, paths: ['alice/path.json'] }]);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      data: expect.objectContaining({ timedOut: false, users: [{ userId: 'alice', entryCount: 3, paths: ['alice/path.json'] }] }),
    }));
  });

  it('skips a user who already failed the first sweep, rather than retrying them, on the late-write pass', async () => {
    let aliceAttempts = 0;
    const backend = fakeBackend({
      overlays: { alice: 1, bob: 1 },
      commitOverlayImpl: async (userId) => {
        if (userId === 'alice') { aliceAttempts++; throw new Error('persistent failure'); }
      },
    });
    await flushOverlaysWithDeadline(backend, Promise.resolve()); // closeDone resolves immediately → late-write pass runs
    expect(aliceAttempts).toBe(1); // not retried on the second pass
    expect(backend.getUncommittedOverlaySummary()).toEqual([{ userId: 'alice', entryCount: 1, paths: ['alice/path.json'] }]);
  });

  it('a write landing after the first snapshot but before closeDone resolves is still caught by the second sweep (SO e/315#2)', async () => {
    const backend = fakeBackend({ overlays: { alice: 1 } });
    let resolveCloseDone!: () => void;
    const closeDone = new Promise<void>((resolve) => { resolveCloseDone = resolve; });

    const done = flushOverlaysWithDeadline(backend, closeDone);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); // let the first sweep (alice) settle

    // A request's write lands here — after the first snapshot, before the connection drains.
    backend.writeOverlay('carol', 1);
    resolveCloseDone();
    await done;

    expect(backend.commitOverlay).toHaveBeenCalledWith('carol', undefined, { branchName: expect.stringContaining('carol') });
    expect(backend.getUncommittedOverlaySummary()).toEqual([]);
    expect(warnMock).not.toHaveBeenCalled();
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

    const done = flushOverlaysWithDeadline(backend, Promise.resolve());
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
      const p = flushOverlaysWithDeadline(backend, new Promise<void>(() => { /* never resolves — not relevant to this test */ }));
      await vi.advanceTimersByTimeAsync(OVERLAY_FLUSH_DEADLINE_MS + 1);
      await p;
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('flush deadline hit') }));
    } finally {
      vi.useRealTimers();
    }
  });
});

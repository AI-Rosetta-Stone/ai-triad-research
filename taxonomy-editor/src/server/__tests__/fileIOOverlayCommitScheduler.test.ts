// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4258/t/4277 (C3b, SO e/308#7): the fileIO.ts debounce/retry/flush scheduler
 * itself, independent of GitHubAPIBackend — a fake StorageBackend with a
 * `commitOverlay` stub, driven with fake timers, so these run without the
 * undici-major-skew constructor gate the githubApi*.test.ts files need.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StorageBackend } from '../storage/storageBackend.js';
import * as fileIO from '../storage/fileIO.js';

const recordedEvents: { type: string; data?: Record<string, unknown> }[] = [];
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({
    record: (e: { type: string; data?: Record<string, unknown> }) => recordedEvents.push(e),
  }),
}));

class FakeOverlayBackend implements StorageBackend {
  commitCalls: { userId: string; branchName?: string }[] = [];
  commitImpl: (userId: string) => Promise<{ commitSha: string; filesCommitted: number } | null> =
    async () => ({ commitSha: 'sha', filesCommitted: 1 });

  async readFile(): Promise<string | null> { return null; }
  async writeFile(): Promise<{ version: string }> { return { version: '' }; }
  async listDirectory(): Promise<string[]> { return []; }
  async deleteFile(): Promise<void> { /* stub */ }
  async fileExists(): Promise<boolean> { return false; }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }

  async commitOverlay(
    userId: string, _message?: string, opts?: { branchName?: string },
  ): Promise<{ commitSha: string; filesCommitted: number } | null> {
    this.commitCalls.push({ userId, branchName: opts?.branchName });
    return this.commitImpl(userId);
  }
}

class NoOverlayBackend implements StorageBackend {
  async readFile(): Promise<string | null> { return null; }
  async writeFile(): Promise<{ version: string }> { return { version: '' }; }
  async listDirectory(): Promise<string[]> { return []; }
  async deleteFile(): Promise<void> { /* stub */ }
  async fileExists(): Promise<boolean> { return false; }
  async readBinaryFile(): Promise<Buffer | null> { return null; }
  async writeBinaryFile(): Promise<void> { /* stub */ }
}

describe('fileIO overlay commit scheduler (t/4258/t/4277 C3b)', () => {
  let backend: FakeOverlayBackend;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = new FakeOverlayBackend();
    fileIO.setBackend(backend);
    recordedEvents.length = 0;
  });
  afterEach(async () => {
    // pendingOverlayCommits/overlayCommitStatus are module-level singletons —
    // drain anything a test left scheduled so it can't leak into the next one.
    // A single flush can leave a user re-queued for another retry attempt
    // (a persistently-failing commitImpl reschedules on every attempt), so
    // flush repeatedly — bounded by the retry ceiling, since each call either
    // finishes a user or advances their attempt count strictly closer to it.
    for (let i = 0; i <= 3; i++) {
      await fileIO.flushPendingOverlayCommits();
    }
    vi.useRealTimers();
  });

  it('resolves the branch explicitly rather than through ALS (t/4258 C3a)', async () => {
    fileIO.scheduleOverlayCommit('alice');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.commitCalls).toEqual([{ userId: 'alice', branchName: 'api-session/alice' }]);
  });

  it('debounces a burst of triggers into exactly one commit', async () => {
    fileIO.scheduleOverlayCommit('alice');
    await vi.advanceTimersByTimeAsync(500);
    fileIO.scheduleOverlayCommit('alice'); // resets the debounce
    await vi.advanceTimersByTimeAsync(500);
    fileIO.scheduleOverlayCommit('alice');
    await vi.advanceTimersByTimeAsync(2_500); // past the 2s debounce from the last trigger

    expect(backend.commitCalls.length).toBe(1);
  });

  it('commits at the max-wait ceiling under a sustained burst that keeps resetting the debounce', async () => {
    fileIO.scheduleOverlayCommit('bob');
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(1_500); // < 2s debounce, so it never fires on its own
      fileIO.scheduleOverlayCommit('bob');
    }
    // The 10s max-wait ceiling fires partway through, independent of the debounce resets.
    expect(backend.commitCalls.length).toBe(1);
  });

  it('getOverlayCommitStatus reflects pending → committed', async () => {
    fileIO.scheduleOverlayCommit('carol');
    expect(fileIO.getOverlayCommitStatus('carol')?.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fileIO.getOverlayCommitStatus('carol')?.state).toBe('committed');
  });

  it('records a commits-per-user-per-hour rate metric on each successful commit (t/4258/t/4281)', async () => {
    fileIO.scheduleOverlayCommit('judy');
    await vi.advanceTimersByTimeAsync(2_000);
    fileIO.scheduleOverlayCommit('judy');
    await vi.advanceTimersByTimeAsync(2_000);

    const rateEvents = recordedEvents.filter((e) => e.type === 'overlay.commit.rate' && e.data?.userId === 'judy');
    expect(rateEvents.map((e) => e.data?.commitsInLastHour)).toEqual([1, 2]);
  });

  // t/550 (TL ruling 8): 'busy' (another replica holds the commit lease) is neither a commit nor a failure. The status
  // stays 'pending', the attempt isn't counted, and the scheduler keeps trying until the lease is free.
  it('busy is not counted as a failed attempt: more busy rounds than the retry ceiling still end in a commit', async () => {
    let calls = 0;
    backend.commitImpl = async () => {
      calls++;
      if (calls <= 5) throw Object.assign(new Error('another replica holds the commit lease'), { code: 'OVERLAY_COMMIT_BUSY' });
      return { commitSha: 'sha', filesCommitted: 1 };
    };
    fileIO.scheduleOverlayCommit('olga');
    await vi.advanceTimersByTimeAsync(2_000); // debounce fires; busy
    expect(calls).toBe(1);
    expect(fileIO.getOverlayCommitStatus('olga')?.state).toBe('pending');
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(6); // 5 busy rounds, more than OVERLAY_COMMIT_MAX_RETRIES (2), then the commit
    expect(fileIO.getOverlayCommitStatus('olga')?.state).toBe('committed');
  });

  // TL t/503#22 N3: busy for longer than the lease lasts (12 rounds, 60 s) is worth one WARN, still without a retry count.
  it('N3: one WARN after OVERLAY_COMMIT_BUSY_WARN_ROUNDS busy rounds in a row, not before, and the commit still lands', async () => {
    const { log } = await import('../logger.js');
    const { OVERLAY_COMMIT_BUSY_WARN_ROUNDS } = await import('../storage/overlayCommitScheduler.js');
    const warn = vi.spyOn(log.storage, 'warn');
    const busyWarns = () => warn.mock.calls.filter(c => String(c[1] ?? '').includes('t/503 N3')).length;
    let calls = 0;
    backend.commitImpl = async () => {
      calls++;
      if (calls <= OVERLAY_COMMIT_BUSY_WARN_ROUNDS + 1) throw Object.assign(new Error('another replica holds the commit lease'), { code: 'OVERLAY_COMMIT_BUSY' });
      return { commitSha: 'sha', filesCommitted: 1 };
    };
    fileIO.scheduleOverlayCommit('nina');
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 1; i < OVERLAY_COMMIT_BUSY_WARN_ROUNDS - 1; i++) await vi.advanceTimersByTimeAsync(5_000);
    expect(busyWarns()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000); // the 12th busy round
    expect(busyWarns()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000); // a 13th busy round: no second WARN
    await vi.advanceTimersByTimeAsync(5_000); // then the commit
    expect(busyWarns()).toBe(1);
    expect(fileIO.getOverlayCommitStatus('nina')?.state).toBe('committed');
    warn.mockRestore();
  });

  it('retries with backoff on failure, surfaces failed status, then commits on the retry', async () => {
    let calls = 0;
    backend.commitImpl = async () => {
      calls++;
      if (calls === 1) throw new Error('simulated GitHub failure');
      return { commitSha: 'sha', filesCommitted: 1 };
    };
    fileIO.scheduleOverlayCommit('dave');
    await vi.advanceTimersByTimeAsync(2_000); // debounce fires; first attempt fails
    expect(fileIO.getOverlayCommitStatus('dave')?.state).toBe('failed');
    await vi.advanceTimersByTimeAsync(1_000); // first backoff (1s)
    expect(calls).toBe(2);
    expect(fileIO.getOverlayCommitStatus('dave')?.state).toBe('committed');
  });

  it('flushPendingOverlayCommits finds and accelerates a user mid retry-backoff (ServerAPI, p/541#71)', async () => {
    let calls = 0;
    backend.commitImpl = async () => {
      calls++;
      if (calls === 1) throw new Error('simulated GitHub failure');
      return { commitSha: 'sha', filesCommitted: 1 };
    };
    fileIO.scheduleOverlayCommit('ivan');
    await vi.advanceTimersByTimeAsync(2_000); // debounce fires; first attempt fails, 1s backoff scheduled
    expect(fileIO.getOverlayCommitStatus('ivan')?.state).toBe('failed');

    // Not in the debounce/max-wait map anymore — flush must still find 'ivan'
    // via the retry-backoff tracking, cancel the 1s wait, and run attempt 2 now.
    const results = await fileIO.flushPendingOverlayCommits();

    expect(calls).toBe(2); // exactly the retry, not a reset-to-0 extra attempt
    expect(results).toEqual([{ userId: 'ivan', status: { state: 'committed', at: expect.any(Number) } }]);

    // The backoff timer was actually cancelled, not left to also fire later.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
  });

  it('flushPendingOverlayCommits runs all pending commits immediately, bypassing the debounce', async () => {
    fileIO.scheduleOverlayCommit('erin');
    fileIO.scheduleOverlayCommit('frank');
    const results = await fileIO.flushPendingOverlayCommits();
    expect(backend.commitCalls.map((c) => c.userId).sort()).toEqual(['erin', 'frank']);

    // t/4276 AC2: the SIGTERM deadline WARN needs to name who stayed
    // uncommitted — flush must report each user's terminal status.
    expect(results.sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: 'erin', status: { state: 'committed', at: expect.any(Number) } },
      { userId: 'frank', status: { state: 'committed', at: expect.any(Number) } },
    ]);
  });

  it('flushPendingOverlayCommits reports a failed status for a user whose commit errors', async () => {
    backend.commitImpl = async () => { throw new Error('simulated GitHub failure'); };
    fileIO.scheduleOverlayCommit('heidi');
    const results = await fileIO.flushPendingOverlayCommits();
    expect(results).toEqual([
      { userId: 'heidi', status: { state: 'failed', at: expect.any(Number), error: 'simulated GitHub failure' } },
    ]);
  });

  it('is a no-op on a backend without overlay semantics (filesystem/Electron mode)', async () => {
    fileIO.setBackend(new NoOverlayBackend());
    fileIO.scheduleOverlayCommit('grace');
    expect(fileIO.getOverlayCommitStatus('grace')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fileIO.getOverlayCommitStatus('grace')).toBeUndefined();
    await expect(fileIO.flushPendingOverlayCommits()).resolves.toEqual([]);
  });
});

// t/551 (TaxonomyServer t/503#7, ruling 5): the commit status any replica can answer.
describe('getOverlayCommitStatusShared (t/551)', () => {
  class SharedStatusBackend extends FakeOverlayBackend {
    published: Array<{ userId: string; status: unknown }> = [];
    readCalls = 0;
    readImpl: () => Promise<{ status: unknown; staged: boolean } | null> = async () => null;
    async publishSharedCommitStatus(userId: string, status: unknown): Promise<void> { this.published.push({ userId, status }); }
    async readSharedCommitStatus(): Promise<{ status: unknown; staged: boolean } | null> { this.readCalls++; return this.readImpl(); }
  }
  let backend: SharedStatusBackend;

  beforeEach(async () => {
    vi.useFakeTimers();
    backend = new SharedStatusBackend();
    fileIO.setBackend(backend);
    const scheduler = await import('../storage/overlayCommitScheduler.js');
    scheduler.resetSharedCommitStatusCacheForTests();
  });
  afterEach(async () => {
    for (let i = 0; i <= 3; i++) await fileIO.flushPendingOverlayCommits();
    vi.useRealTimers();
  });

  it('every status change is published to the shared store', async () => {
    fileIO.scheduleOverlayCommit('pat');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(backend.published.map(p => (p.status as { state: string }).state)).toEqual(['pending', 'committed']);
  });

  it('reads the published status; entries still staged mean pending (written on another replica)', async () => {
    const { getOverlayCommitStatusShared } = await import('../storage/overlayCommitScheduler.js');
    backend.readImpl = async () => ({ status: { state: 'committed', at: 100 }, staged: true });
    await expect(getOverlayCommitStatusShared('quinn')).resolves.toEqual({ state: 'pending', at: 100 });
    backend.readImpl = async () => ({ status: { state: 'committed', at: 200 }, staged: false });
    vi.advanceTimersByTime(2_001);
    await expect(getOverlayCommitStatusShared('quinn')).resolves.toEqual({ state: 'committed', at: 200 });
  });

  it('a conflict stays a conflict even with entries staged', async () => {
    const { getOverlayCommitStatusShared } = await import('../storage/overlayCommitScheduler.js');
    backend.readImpl = async () => ({ status: { state: 'conflict', at: 5, conflictedPaths: ['a.json'] }, staged: true });
    await expect(getOverlayCommitStatusShared('rae')).resolves.toMatchObject({ state: 'conflict' });
  });

  it('a read that hangs returns the local value after 1.5 s, without throwing', async () => {
    const { getOverlayCommitStatusShared } = await import('../storage/overlayCommitScheduler.js');
    fileIO.scheduleOverlayCommit('sam'); // local: pending
    backend.readImpl = () => new Promise(() => { /* never settles */ });
    const p = getOverlayCommitStatusShared('sam');
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(p).resolves.toMatchObject({ state: 'pending' });
  });

  it('a read that fails returns the local value, without throwing', async () => {
    const { getOverlayCommitStatusShared } = await import('../storage/overlayCommitScheduler.js');
    fileIO.scheduleOverlayCommit('tess');
    backend.readImpl = async () => { throw new Error('store down'); };
    await expect(getOverlayCommitStatusShared('tess')).resolves.toMatchObject({ state: 'pending' });
  });

  it('is cached for 2 s per process: a second call inside the TTL does not read again', async () => {
    const { getOverlayCommitStatusShared } = await import('../storage/overlayCommitScheduler.js');
    backend.readImpl = async () => ({ status: { state: 'committed', at: 1 }, staged: false });
    await getOverlayCommitStatusShared('uma');
    await getOverlayCommitStatusShared('uma');
    expect(backend.readCalls).toBe(1);
    vi.advanceTimersByTime(2_001);
    await getOverlayCommitStatusShared('uma');
    expect(backend.readCalls).toBe(2);
  });
});

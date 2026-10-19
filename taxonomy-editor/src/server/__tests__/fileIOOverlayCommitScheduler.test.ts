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
  });
  afterEach(async () => {
    // pendingOverlayCommits/overlayCommitStatus are module-level singletons —
    // drain anything a test left scheduled so it can't leak into the next one.
    await fileIO.flushPendingOverlayCommits();
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

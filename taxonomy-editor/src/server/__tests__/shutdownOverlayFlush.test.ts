// @vitest-environment node
//
// t/4258/t/4276 (C4) — flushOverlaysWithDeadline races flushPendingOverlayCommits() against a
// deadline, then WARNs naming any active-branch user whose overlay is still not committed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionBranchManager } from '../storage/sessionBranchManager.js';

const { flushPendingOverlayCommitsMock, getOverlayCommitStatusMock, warnMock, recordMock } = vi.hoisted(() => ({
  flushPendingOverlayCommitsMock: vi.fn(),
  getOverlayCommitStatusMock: vi.fn(),
  warnMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('../storage/overlayCommitScheduler.js', () => ({
  flushPendingOverlayCommits: flushPendingOverlayCommitsMock,
  getOverlayCommitStatus: getOverlayCommitStatusMock,
}));
vi.mock('../logger.js', () => ({ log: { server: { warn: vi.fn(), error: warnMock, info: vi.fn() } } }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));

import { flushOverlaysWithDeadline, OVERLAY_FLUSH_DEADLINE_MS } from '../shutdownOverlayFlush.js';

function fakeSessionManager(userIds: string[]): SessionBranchManager {
  return {
    getActiveBranches: () => userIds.map(userId => ({ userId, branch: `api-session/${userId}`, lastCommitAt: 0, prNumber: null })),
  } as unknown as SessionBranchManager;
}

beforeEach(() => {
  flushPendingOverlayCommitsMock.mockReset();
  getOverlayCommitStatusMock.mockReset();
  warnMock.mockReset();
  recordMock.mockReset();
  flushPendingOverlayCommitsMock.mockResolvedValue([]);
});

describe('flushOverlaysWithDeadline (t/4276 C4)', () => {
  it('no-ops with no active branches (filesystem mode / nothing to flush)', async () => {
    await flushOverlaysWithDeadline(null);
    expect(flushPendingOverlayCommitsMock).toHaveBeenCalled();
    expect(warnMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('WARNs with the user list when an active-branch user is still uncommitted after the flush', async () => {
    getOverlayCommitStatusMock.mockImplementation((userId: string) =>
      userId === 'alice' ? { state: 'failed', at: 123, error: 'network error' } : { state: 'committed', at: 456 });

    await flushOverlaysWithDeadline(fakeSessionManager(['alice', 'bob']));

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      level: 'warn',
      data: expect.objectContaining({ users: [{ userId: 'alice', status: { state: 'failed', at: 123, error: 'network error' } }] }),
    }));
  });

  it('does not WARN when every active-branch user is committed', async () => {
    getOverlayCommitStatusMock.mockReturnValue({ state: 'committed', at: 1 });

    await flushOverlaysWithDeadline(fakeSessionManager(['alice', 'bob']));

    expect(warnMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('does not WARN for a user with no overlay-commit status at all (nothing ever written)', async () => {
    getOverlayCommitStatusMock.mockReturnValue(undefined);

    await flushOverlaysWithDeadline(fakeSessionManager(['alice']));

    expect(warnMock).not.toHaveBeenCalled();
  });

  it('WARNs with the deadline-hit flag when the flush does not settle before the deadline', async () => {
    vi.useFakeTimers();
    try {
      flushPendingOverlayCommitsMock.mockReturnValue(new Promise(() => { /* never resolves */ }));
      getOverlayCommitStatusMock.mockReturnValue({ state: 'pending', at: 1 });

      const flushPromise = flushOverlaysWithDeadline(fakeSessionManager(['alice']));
      await vi.advanceTimersByTimeAsync(OVERLAY_FLUSH_DEADLINE_MS + 1);
      await flushPromise;

      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining('flush deadline hit'),
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

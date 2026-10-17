// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3583 — poll-loop bounds (TL t/3583#4 point 3): interval + backoff on poll errors, a hard
// ceiling so a lost job doesn't spin forever, unmount cleanup, and poll-error ≠ job-failed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    startInquiry: vi.fn(),
    getInquiry: vi.fn(),
    listInquiries: vi.fn(),
  },
}));

vi.mock('@bridge', () => ({ api: mockApi }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { useInquiryStore } from './useInquiryStore';

function pollView(overrides: Record<string, unknown> = {}) {
  return {
    jobId: 'job-1', status: 'debating', progressPct: 40,
    terminationReason: null, resultId: null, error: null,
    ...overrides,
  };
}

describe('useInquiryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useInquiryStore.getState().reset();
    useInquiryStore.setState({ question: 'What counts as an AI harm?', fidelity: 'standard' });
  });

  afterEach(() => {
    useInquiryStore.getState()._stopPolling();
    vi.useRealTimers();
  });

  it('polls on a fixed interval until a terminal status, then stops', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-1' });
    mockApi.getInquiry
      .mockResolvedValueOnce(pollView({ status: 'debating', progressPct: 40 }))
      .mockResolvedValueOnce(pollView({ status: 'judging', progressPct: 80 }))
      .mockResolvedValueOnce(pollView({
        status: 'done', progressPct: 100,
        result: { schemaVersion: 1, request: { question: 'q', fidelity: 'standard' }, campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [], derivation: { fidelity: 'standard', models: {}, rounds: 4, callBudget: 150 }, grounding: {}, singleRunCaveat: 'n=1',
        },
      }));

    await useInquiryStore.getState().startInquiry();
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(2);
    expect(useInquiryStore.getState().status).toBe('judging');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(3);
    expect(useInquiryStore.getState().status).toBe('done');
    expect(useInquiryStore.getState().screen()).toBe('answer');

    // No further polling once terminal.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(3);
  });

  it('backs off exponentially on poll errors without treating them as job failure (poll-error ≠ job-failed)', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-2' });
    mockApi.getInquiry
      .mockRejectedValueOnce(new Error('network blip'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(pollView({ status: 'debating', progressPct: 50 }));

    await useInquiryStore.getState().startInquiry();
    expect(useInquiryStore.getState().pollError).toBe('network blip');
    expect(useInquiryStore.getState().status).toBe('queued'); // NOT 'failed' — a poll error is not a job failure
    expect(useInquiryStore.getState().error).toBeNull();

    // First backoff: 3s * 2^1 = 6s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1); // not yet — interval hasn't elapsed
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(2);
    expect(useInquiryStore.getState().pollError).toBe('still down');

    // Second backoff: 3s * 2^2 = 12s.
    await vi.advanceTimersByTimeAsync(12_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(3);
    expect(useInquiryStore.getState().pollError).toBeNull(); // cleared on the next successful poll
    expect(useInquiryStore.getState().status).toBe('debating');
  });

  it('stops polling immediately on a persistent HTTP 404, instead of retrying forever (t/3723)', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-404' });
    mockApi.getInquiry.mockRejectedValue(Object.assign(new Error('HTTP 404: Inquiry not found'), { httpStatus: 404 }));

    await useInquiryStore.getState().startInquiry();
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1);

    expect(useInquiryStore.getState().status).toBe('failed');
    expect(useInquiryStore.getState().error).toMatch(/no longer available/);
    expect(useInquiryStore.getState().pollError).toBeNull();
    // Terminal on the first 404 — no retries, unlike a transient poll error.
    expect(useInquiryStore.getState().screen()).toBe('answer');

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1);
  });

  it('gives up after the poll ceiling and reports a failure, not an infinite spin', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-3' });
    mockApi.getInquiry.mockResolvedValue(pollView({ status: 'debating', progressPct: 10 }));

    await useInquiryStore.getState().startInquiry();
    await vi.advanceTimersByTimeAsync(60 * 60_000 + 10_000); // past the 1-hour ceiling

    expect(useInquiryStore.getState().status).toBe('failed');
    expect(useInquiryStore.getState().error).toMatch(/gave up polling/);
  });

  it('_stopPolling (unmount cleanup) stops the poll loop from making further calls', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-4' });
    mockApi.getInquiry.mockResolvedValue(pollView({ status: 'debating', progressPct: 10 }));

    await useInquiryStore.getState().startInquiry();
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1);

    useInquiryStore.getState()._stopPolling();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mockApi.getInquiry).toHaveBeenCalledTimes(1); // no further polls after cleanup
  });

  it('reset() during an in-flight poll discards the stale response instead of clobbering fresh state', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-5' });
    let resolvePoll: (v: unknown) => void = () => {};
    mockApi.getInquiry.mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }));

    await useInquiryStore.getState().startInquiry();
    useInquiryStore.getState().reset();
    resolvePoll(pollView({ status: 'debating', progressPct: 10 }));
    await vi.advanceTimersByTimeAsync(0);

    // reset() already cleared jobId — the late-arriving poll response for the OLD job must not
    // resurrect it.
    expect(useInquiryStore.getState().jobId).toBeNull();
    expect(useInquiryStore.getState().screen()).toBe('ask');
  });

  describe('"My Questions" history (t/3620)', () => {
    function summary(overrides: Record<string, unknown> = {}) {
      return {
        jobId: 'job-h1', question: 'What counts as an AI harm?', debateId: null,
        truncated: false, createdAt: '2026-09-01T00:00:00.000Z',
        ...overrides,
      };
    }

    it('openList() switches to the list screen and fetches history', async () => {
      mockApi.listInquiries.mockResolvedValue([summary()]);

      useInquiryStore.getState().openList();
      expect(useInquiryStore.getState().screen()).toBe('list');
      expect(useInquiryStore.getState().historyLoading).toBe(true);

      await vi.advanceTimersByTimeAsync(0);
      expect(useInquiryStore.getState().historyLoading).toBe(false);
      expect(useInquiryStore.getState().history).toEqual([summary()]);
    });

    it('fetchHistory() records a listInquiries failure without crashing', async () => {
      mockApi.listInquiries.mockRejectedValue(new Error('server unreachable'));

      await useInquiryStore.getState().fetchHistory();
      expect(useInquiryStore.getState().historyError).toBe('server unreachable');
      expect(useInquiryStore.getState().historyLoading).toBe(false);
    });

    it('closeList() leaves the list screen without disturbing ask/poll state', () => {
      useInquiryStore.getState().openList();
      useInquiryStore.getState().closeList();
      expect(useInquiryStore.getState().screen()).toBe('ask');
    });

    it('openFromHistory() loads a past result straight onto the Answer screen', async () => {
      const result = { schemaVersion: 1, request: { question: 'q', fidelity: 'standard' }, campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [], derivation: { fidelity: 'standard', models: {}, rounds: 4, callBudget: 150 }, grounding: {}, singleRunCaveat: 'n=1' };
      mockApi.getInquiry.mockResolvedValue(pollView({ jobId: 'job-h1', status: 'done', progressPct: 100, result }));

      useInquiryStore.getState().openList();
      await useInquiryStore.getState().openFromHistory('job-h1');

      expect(useInquiryStore.getState().viewingList).toBe(false);
      expect(useInquiryStore.getState().screen()).toBe('answer');
      expect(useInquiryStore.getState().result).toEqual(result);
    });

    it('openFromHistory() surfaces a fetch failure as a failed job rather than crashing', async () => {
      mockApi.getInquiry.mockRejectedValue(new Error('not found'));

      await useInquiryStore.getState().openFromHistory('job-missing');

      expect(useInquiryStore.getState().status).toBe('failed');
      expect(useInquiryStore.getState().error).toBe('not found');
    });
  });
});

describe('useInquiryStore: POV tag (t/4246)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useInquiryStore.getState().reset();
    useInquiryStore.setState({ question: 'Is AI hype outrunning evidence?', fidelity: 'quick', tagSelection: undefined });
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-tag' });
    mockApi.getInquiry.mockResolvedValue(pollView({ jobId: 'job-tag' }));
  });
  afterEach(() => { useInquiryStore.getState()._stopPolling(); });

  it('sends the tag selection on the request', async () => {
    useInquiryStore.getState().setTagSelection({ pov: 'skeptic', tag: 'critical', mode: 'scope' });
    await useInquiryStore.getState().startInquiry();
    expect(mockApi.startInquiry.mock.calls[0][0]).toMatchObject({ tagSelection: { pov: 'skeptic', tag: 'critical', mode: 'scope' } });
  });

  it('an untagged inquiry sends no tagSelection key at all, as before', async () => {
    await useInquiryStore.getState().startInquiry();
    expect(mockApi.startInquiry.mock.calls[0][0]).not.toHaveProperty('tagSelection');
  });
});

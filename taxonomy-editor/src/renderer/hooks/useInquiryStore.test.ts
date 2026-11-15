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
    loadCommunityInquiry: vi.fn(),
    renameInquiry: vi.fn(),
    deleteInquiry: vi.fn(),
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

  it('never lets progressPct decrease across polls, even if a response reports a lower value (t/4714)', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-mono' });
    mockApi.getInquiry
      .mockResolvedValueOnce(pollView({ status: 'debating', progressPct: 60 }))
      .mockResolvedValueOnce(pollView({ status: 'debating', progressPct: 45 })); // out-of-order / retry artifact

    await useInquiryStore.getState().startInquiry();
    expect(useInquiryStore.getState().progressPct).toBe(60);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(useInquiryStore.getState().progressPct).toBe(60); // clamped, not dropped to 45
  });

  it('carries stageDetail through from the poll response, and clears it to null when the field is absent (t/4714 AC4)', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-detail' });
    mockApi.getInquiry
      .mockResolvedValueOnce(pollView({ status: 'debating', progressPct: 20, stageDetail: 'Round 1 of 4 · Accelerationist opening' }))
      .mockResolvedValueOnce(pollView({ status: 'judging', progressPct: 85 })); // no stageDetail field — older build

    await useInquiryStore.getState().startInquiry();
    expect(useInquiryStore.getState().stageDetail).toBe('Round 1 of 4 · Accelerationist opening');

    await vi.advanceTimersByTimeAsync(3_000);
    expect(useInquiryStore.getState().stageDetail).toBeNull();
  });

  it('records client-observed stage timings from poll transitions, ends the last stage at the terminal status (t/324)', async () => {
    vi.setSystemTime(1_000_000);
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-t' });
    mockApi.getInquiry
      .mockResolvedValueOnce(pollView({ status: 'grounding' }))
      .mockResolvedValueOnce(pollView({ status: 'grounding' }))
      .mockResolvedValueOnce(pollView({ status: 'debating' }))
      .mockResolvedValueOnce(pollView({ status: 'failed', error: 'boom' }));

    await useInquiryStore.getState().startInquiry();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);

    const t = useInquiryStore.getState().stageTimings;
    expect(t.grounding).toEqual({ startedAt: 1_000_000, endedAt: 1_006_000 });
    expect(t.debating).toEqual({ startedAt: 1_006_000, endedAt: 1_009_000 });
    expect(t.judging).toEqual({});
  });

  it('prefers server stageTimings over client-observed ones when the response carries them (t/324)', async () => {
    vi.setSystemTime(1_000_000);
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-s' });
    mockApi.getInquiry.mockResolvedValueOnce(pollView({ status: 'debating', stageTimings: { grounding: { startedAt: 900_000, endedAt: 950_000 }, debating: { startedAt: 950_000 } } }));

    await useInquiryStore.getState().startInquiry();
    const t = useInquiryStore.getState().stageTimings;
    expect(t.grounding).toEqual({ startedAt: 900_000, endedAt: 950_000 });
    expect(t.debating.startedAt).toBe(950_000);
  });

  it('appends each distinct stageDetail per stage, skips a repeat, and resets on a new job (t/328)', async () => {
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-h' });
    mockApi.getInquiry
      .mockResolvedValueOnce(pollView({ status: 'debating', stageDetail: 'A' }))
      .mockResolvedValueOnce(pollView({ status: 'debating', stageDetail: 'A' }))
      .mockResolvedValueOnce(pollView({ status: 'debating', stageDetail: 'B' }))
      .mockResolvedValueOnce(pollView({ status: 'judging' }));

    await useInquiryStore.getState().startInquiry();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(useInquiryStore.getState().stageDetailHistory).toEqual({ debating: ['A'] });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(useInquiryStore.getState().stageDetailHistory).toEqual({ debating: ['A', 'B'] });

    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-h2' });
    mockApi.getInquiry.mockResolvedValue(pollView({ jobId: 'job-h2', status: 'queued' }));
    await useInquiryStore.getState().startInquiry();
    expect(useInquiryStore.getState().stageDetailHistory).toEqual({});
    expect(useInquiryStore.getState().stageTimings.debating).toEqual({});
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

  describe('openCommunityResult() (t/4823 regression — blank panel)', () => {
    const result = { schemaVersion: 1, request: { question: 'q', fidelity: 'standard' }, campVerdicts: [], convergences: [], evidenceLayers: [], unresolvedGaps: [], calibration: [], derivation: { fidelity: 'standard', models: {}, rounds: 4, callBudget: 150 }, grounding: {}, singleRunCaveat: 'n=1' };

    it('while the fetch is in flight, jobId is null but screen() is "running" — never the unrendered "ask" value', async () => {
      let resolveFetch: (v: unknown) => void = () => {};
      mockApi.loadCommunityInquiry.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

      const promise = useInquiryStore.getState().openCommunityResult('community-1');

      // InquiryTab.tsx's screen-switch has no 'ask' case (t/4666) — if screen() ever reports
      // 'ask' here, the panel renders a bare empty div. jobId is genuinely null for a community
      // result (there's no job to poll), so screen() must key off status, not jobId, to land on
      // a case the switch actually handles.
      expect(useInquiryStore.getState().jobId).toBeNull();
      expect(useInquiryStore.getState().screen()).toBe('running');

      resolveFetch(result);
      await promise;
      expect(useInquiryStore.getState().screen()).toBe('answer');
    });

    it('a failed fetch still leaves screen() off "ask" (status becomes failed, not null)', async () => {
      mockApi.loadCommunityInquiry.mockRejectedValue(new Error('not found'));

      await useInquiryStore.getState().openCommunityResult('community-missing');

      expect(useInquiryStore.getState().screen()).not.toBe('ask');
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

describe('useInquiryStore: temperature override (t/4770/t/4771)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useInquiryStore.getState().reset();
    useInquiryStore.setState({ question: 'Is AI hype outrunning evidence?', fidelity: 'quick', temperature: undefined });
    mockApi.startInquiry.mockResolvedValue({ jobId: 'job-temp' });
    mockApi.getInquiry.mockResolvedValue(pollView({ jobId: 'job-temp' }));
  });
  afterEach(() => { useInquiryStore.getState()._stopPolling(); });

  it('sends the temperature override on the request', async () => {
    useInquiryStore.getState().setTemperature(1.4);
    await useInquiryStore.getState().startInquiry();
    expect(mockApi.startInquiry.mock.calls[0][0]).toMatchObject({ temperature: 1.4 });
  });

  it('an unset temperature sends no temperature key at all — the server/fidelity default applies', async () => {
    await useInquiryStore.getState().startInquiry();
    expect(mockApi.startInquiry.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('an explicit 0 is a real override, not an unset value — still sent', async () => {
    useInquiryStore.getState().setTemperature(0);
    await useInquiryStore.getState().startInquiry();
    expect(mockApi.startInquiry.mock.calls[0][0]).toMatchObject({ temperature: 0 });
  });
});

describe('useInquiryStore: My-row rename/delete (t/4898)', () => {
  const ROW = { jobId: 'job-rd', question: 'Is X true?', debateId: null, truncated: false, createdAt: '2026-01-01' };

  beforeEach(() => {
    vi.clearAllMocks();
    useInquiryStore.setState({ history: [ROW] });
  });

  it('renameHistoryItem optimistically renames, then calls the API', async () => {
    mockApi.renameInquiry.mockResolvedValue(undefined);
    const p = useInquiryStore.getState().renameHistoryItem('job-rd', 'New title');
    expect(useInquiryStore.getState().history).toEqual([{ ...ROW, title: 'New title' }]);
    await p;
    expect(mockApi.renameInquiry).toHaveBeenCalledWith('job-rd', 'New title');
  });

  it('renameHistoryItem restores the prior row and rethrows on failure', async () => {
    mockApi.renameInquiry.mockRejectedValue(new Error('boom'));
    await expect(useInquiryStore.getState().renameHistoryItem('job-rd', 'New title')).rejects.toThrow('boom');
    expect(useInquiryStore.getState().history).toEqual([ROW]);
  });

  it('deleteHistoryItem optimistically removes the row, then calls the API', async () => {
    mockApi.deleteInquiry.mockResolvedValue(undefined);
    const p = useInquiryStore.getState().deleteHistoryItem('job-rd');
    expect(useInquiryStore.getState().history).toEqual([]);
    await p;
    expect(mockApi.deleteInquiry).toHaveBeenCalledWith('job-rd');
  });

  it('deleteHistoryItem restores the row and rethrows on failure (e.g. a 409 while still running)', async () => {
    const err = Object.assign(new Error('still running'), { httpStatus: 409 });
    mockApi.deleteInquiry.mockRejectedValue(err);
    await expect(useInquiryStore.getState().deleteHistoryItem('job-rd')).rejects.toMatchObject({ httpStatus: 409 });
    expect(useInquiryStore.getState().history).toEqual([ROW]);
  });
});

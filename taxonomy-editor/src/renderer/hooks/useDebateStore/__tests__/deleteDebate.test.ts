// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/94: deleteDebate used to swallow a failed delete (record, set debateError, resolve), so
// DebateBulkDeleteDialog counted every failure as a success. It now rejects on a failed delete,
// without setting debateError (the dialog reports it; t/94#2), and only WARNs when post-delete
// bookkeeping fails, since the debate is already gone.
// The harness is imported FIRST so its hoisted mocks register before the store import resolves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeSession, mockApi } from './storeTestHarness';
import { useDebateStore } from '../../useDebateStore';

const { recorded } = vi.hoisted(() => ({ recorded: [] as { level?: string; message?: string }[] }));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: (ev: { level?: string; message?: string }) => { recorded.push(ev); }, setEventContext: () => {} }),
}));

beforeEach(() => {
  recorded.length = 0;
});

describe('deleteDebate (t/94)', () => {
  it('a failed delete rejects, records the error, and leaves debateError and the active debate alone', async () => {
    useDebateStore.setState({ debateError: null, activeDebateId: 'debate-x', activeDebate: makeSession({ id: 'debate-x' }) as never });
    mockApi.deleteDebateSession.mockRejectedValueOnce(new Error('HTTP 500'));

    await expect(useDebateStore.getState().deleteDebate('debate-x')).rejects.toThrow('HTTP 500');

    expect(useDebateStore.getState().debateError).toBeNull();
    expect(useDebateStore.getState().activeDebateId).toBe('debate-x');
    expect(recorded).toContainEqual(expect.objectContaining({ level: 'error', message: 'Failed to delete debate' }));
  });

  it('a successful delete clears the active debate and resolves', async () => {
    useDebateStore.setState({ activeDebateId: 'debate-y', activeDebate: makeSession({ id: 'debate-y' }) as never });

    await expect(useDebateStore.getState().deleteDebate('debate-y')).resolves.toBeUndefined();

    expect(mockApi.deleteDebateSession).toHaveBeenCalledWith('debate-y');
    expect(useDebateStore.getState().activeDebateId).toBeNull();
  });

  it('a refresh failure after a successful delete WARNs and resolves (the debate is gone)', async () => {
    useDebateStore.setState({
      debateError: null,
      activeDebateId: 'debate-z',
      activeDebate: makeSession({ id: 'debate-z' }) as never,
      loadSessions: vi.fn().mockRejectedValue(new Error('timeout')),
    });

    await expect(useDebateStore.getState().deleteDebate('debate-z')).resolves.toBeUndefined();

    expect(useDebateStore.getState().activeDebateId).toBeNull();
    expect(useDebateStore.getState().debateError).toBeNull();
    expect(recorded).toContainEqual(expect.objectContaining({ level: 'warn', message: expect.stringContaining('follow-up refresh failed') }));
  });
});

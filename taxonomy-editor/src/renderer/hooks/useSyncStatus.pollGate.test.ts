// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251: sync status polls every 45 s, only while visible; one refresh on return.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const getSyncStatus = vi.hoisted(() => vi.fn());
vi.mock('../utils/syncApi', () => ({ getSyncStatus }));
// The gate is switched on for these tests (it ships off, t/4258).
vi.mock('../lib/clientConfig', () => ({ getClientConfig: () => ({ pollGate: { enabled: true } }) }));


const { useSyncStatus, SYNC_POLL_MS } = await import('./useSyncStatus');
const { __resetPollGateForTests } = await import('../lib/pollGate');

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const setVisible = (v: boolean) => { visibility = v ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  __resetPollGateForTests(Date.now());
  getSyncStatus.mockReset().mockResolvedValue({
    enabled: true, unsynced_count: 0, session_branch: null, pr_number: null, pr_url: null,
    push_pending: false, github_configured: true, main_updated_available: false, rebase_in_progress: false,
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('useSyncStatus through the poll gate (t/4251)', () => {
  it('the interval is 45 s, inside the 30 to 60 s the ticket asks for', () => {
    expect(SYNC_POLL_MS).toBe(45_000);
  });

  it('polls every 45 s while visible; zero while hidden; one within 1 s of return', async () => {
    const { unmount } = renderHook(() => useSyncStatus());
    await vi.advanceTimersByTimeAsync(0); // the first fetch
    expect(getSyncStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(getSyncStatus).toHaveBeenCalledTimes(2);

    setVisible(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(getSyncStatus).toHaveBeenCalledTimes(2);

    setVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getSyncStatus).toHaveBeenCalledTimes(3);
    unmount();
  });
});

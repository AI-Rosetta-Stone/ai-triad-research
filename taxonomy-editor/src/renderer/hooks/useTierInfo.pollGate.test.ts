// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251: tier usage polls only while visible; one refresh on return.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
const bridgeGet = vi.hoisted(() => vi.fn());
vi.mock('../bridge/web-bridge', () => ({ bridgeGet }));
// The gate is switched on for these tests (it ships off, t/4258).
vi.mock('../lib/clientConfig', () => ({ getClientConfig: () => ({ pollGate: { enabled: true } }) }));


const { useTierInfo } = await import('./useTierInfo');
const { __resetPollGateForTests } = await import('../lib/pollGate');

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const setVisible = (v: boolean) => { visibility = v ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
const usageCalls = () => bridgeGet.mock.calls.filter((c) => c[0] === '/api/proxy/usage').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_TARGET', 'web');
  visibility = 'visible';
  __resetPollGateForTests(Date.now());
  bridgeGet.mockReset().mockResolvedValue({});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('useTierInfo through the poll gate (t/4251)', () => {
  it('zero usage requests while hidden; one within 1 s of return; then the interval resumes', async () => {
    const { unmount } = renderHook(() => useTierInfo());
    await vi.advanceTimersByTimeAsync(0);
    expect(usageCalls()).toBe(1);

    setVisible(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(usageCalls()).toBe(1);

    setVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(usageCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(usageCalls()).toBe(3);
    unmount();
  });
});

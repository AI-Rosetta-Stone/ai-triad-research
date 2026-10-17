// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251: the health probe goes through the shared poll gate. Hidden: zero probes, the pending one
// cleared. Visible again: one probe at once. The warm-up waits until polling is allowed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../resilience', () => ({ setThrottleFromProbe: vi.fn() }));
vi.mock('../../lib/clientConfig', () => ({
  // The gate is switched on for these tests (it ships off, t/4258).
  getClientConfig: () => ({ pollGate: { enabled: true }, healthProbe: {
    intervalMs: 30_000, warmUpCount: 2, warmUpDiscardCount: 0, warmUpIntervalMs: 1_000, windowSize: 20,
    enterFactor: 2, exitFactor: 1.5, gracePeriodMs: 30_000, timeoutMs: 10_000, thresholdFloorMs: 500, coldStartMultiple: 50,
  } }),
}));

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const setVisible = (v: boolean) => { visibility = v ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  visibility = 'visible';
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});
afterEach(() => { vi.useRealTimers(); });

async function startedProbe() {
  const mod = await import('../healthProbe');
  mod.initHealthProbe();
  await vi.advanceTimersByTimeAsync(2_000); // the 2-sample warm-up
  return mod;
}

describe('healthProbe through the poll gate (t/4251)', () => {
  it('steady state: zero probes while hidden, one within 1 s of becoming visible', async () => {
    const mod = await startedProbe();
    expect(mod.getProbeState().phase).toBe('steady');
    const before = fetchSpy.mock.calls.length;

    setVisible(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchSpy.mock.calls.length).toBe(before);

    setVisible(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchSpy.mock.calls.length).toBe(before + 1);
    mod.stopHealthProbe();
  });

  it('the warm-up does not probe while hidden', async () => {
    visibility = 'hidden';
    const mod = await import('../healthProbe');
    mod.initHealthProbe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    setVisible(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalled();
    mod.stopHealthProbe();
  });

  it('hiding and showing again while a probe is in flight keeps one chain', async () => {
    const mod = await startedProbe();
    let release: () => void = () => {};
    fetchSpy.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, json: async () => ({}) }); }));
    await vi.advanceTimersByTimeAsync(30_000); // a probe starts and hangs
    setVisible(false);
    setVisible(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    const after = fetchSpy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchSpy.mock.calls.length).toBe(after + 1); // one probe per interval, not two
    mod.stopHealthProbe();
  });
});

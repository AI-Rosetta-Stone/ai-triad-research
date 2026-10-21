// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4387: open tabs re-check for a new build, and a reload never runs over unsaved edits.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  needRefresh: false,
  dirtySize: 0,
  updateServiceWorker: vi.fn().mockResolvedValue(undefined),
  onRegisteredSW: undefined as undefined | ((url: string, r: ServiceWorkerRegistration | undefined) => void),
  record: vi.fn(),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (opts: { onRegisteredSW?: (url: string, r: ServiceWorkerRegistration | undefined) => void } = {}) => {
    h.onRegisteredSW = opts.onRegisteredSW;
    return { needRefresh: [h.needRefresh, vi.fn()], offlineReady: [false, vi.fn()], updateServiceWorker: h.updateServiceWorker };
  },
}));
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (sel: (s: { dirty: Set<string> }) => unknown) => sel({ dirty: new Set(Array.from({ length: h.dirtySize }, (_, i) => `f${i}`)) }),
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: h.record }) }));

const { UpdatePrompt, startUpdateChecks, UPDATE_CHECK_MS, VISIBLE_RECHECK_MIN_MS } = await import('./UpdatePrompt');
const { __resetPollGateForTests } = await import('../../lib/pollGate');

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};
const fakeRegistration = (update = vi.fn().mockResolvedValue(undefined)) => ({ update }) as unknown as ServiceWorkerRegistration;

beforeEach(() => {
  vi.useFakeTimers();
  h.needRefresh = false; h.dirtySize = 0; h.onRegisteredSW = undefined;
  h.updateServiceWorker.mockClear(); h.record.mockClear();
  setVisibility('visible');
  __resetPollGateForTests(Date.now());
});
afterEach(() => { vi.useRealTimers(); });

describe('update checks (t/4387)', () => {
  it('checks for a new service worker hourly while the tab is active', () => {
    const reg = fakeRegistration();
    const stop = startUpdateChecks(reg);
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    expect(reg.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('checks when the tab becomes visible again, throttled', () => {
    const reg = fakeRegistration();
    const stop = startUpdateChecks(reg);
    setVisibility('hidden');
    vi.advanceTimersByTime(VISIBLE_RECHECK_MIN_MS);
    setVisibility('visible');
    expect(reg.update).toHaveBeenCalledTimes(1);
    setVisibility('hidden'); setVisibility('visible'); // flapping straight back doesn't re-check
    expect(reg.update).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a failed check is recorded as a WARN and retried at the next interval, never thrown', async () => {
    const reg = fakeRegistration(vi.fn().mockRejectedValue(new Error('offline')));
    const stop = startUpdateChecks(reg);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'service-worker' }));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_MS);
    expect(reg.update).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stop() ends all checks', () => {
    const reg = fakeRegistration();
    startUpdateChecks(reg)();
    vi.advanceTimersByTime(UPDATE_CHECK_MS * 3);
    setVisibility('hidden'); vi.advanceTimersByTime(VISIBLE_RECHECK_MIN_MS); setVisibility('visible');
    expect(reg.update).not.toHaveBeenCalled();
  });
});

describe('UpdatePrompt (t/4387)', () => {
  it('starts the checks once the service worker registers', () => {
    render(<UpdatePrompt />);
    const reg = fakeRegistration();
    act(() => { h.onRegisteredSW?.('/sw.js', reg); });
    vi.advanceTimersByTime(UPDATE_CHECK_MS);
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it('renders nothing until a new version is waiting', () => {
    const { container } = render(<UpdatePrompt />);
    expect(container.firstChild).toBeNull();
  });

  it('a waiting version shows Reload, which activates it, and records it', () => {
    h.needRefresh = true;
    render(<UpdatePrompt />);
    expect(screen.getByText('A new version is available.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(h.updateServiceWorker).toHaveBeenCalledWith(true);
    expect(h.record.mock.calls.map(c => c[0].message)).toEqual(
      expect.arrayContaining([expect.stringContaining('new app version waiting'), expect.stringContaining('user reloading')]),
    );
  });

  it('never reloads over unsaved edits: Reload is disabled with a hint while edits are dirty', () => {
    h.needRefresh = true; h.dirtySize = 2;
    render(<UpdatePrompt />);
    const btn = screen.getByRole('button', { name: 'Reload' });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Save your changes first, then reload.')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(h.updateServiceWorker).not.toHaveBeenCalled();
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4251: the shared poll gate. Fake timers drive the clock; visibilityState is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const switchState = vi.hoisted(() => ({ cfg: { pollGate: { enabled: true } } as { pollGate?: { enabled: boolean } } }));
vi.mock('../clientConfig', () => ({ getClientConfig: () => switchState.cfg }));

import { shouldPoll, isPollAllowed, gatedInterval, pollGateEnabled, POLL_IDLE_MS, __resetPollGateForTests } from '../pollGate';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const setVisible = (v: boolean) => { visibility = v ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
const userInput = () => window.dispatchEvent(new Event('keydown'));

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  switchState.cfg = { pollGate: { enabled: true } };
  __resetPollGateForTests(Date.now());
});
afterEach(() => { vi.useRealTimers(); });

describe('shouldPoll (the pure predicate)', () => {
  it('visible and recently active: poll', () => { expect(shouldPoll(true, 1_000)).toBe(true); });
  it('hidden: never poll, however recent the input', () => { expect(shouldPoll(false, 0)).toBe(false); });
  it('idle past the window: no poll', () => { expect(shouldPoll(true, POLL_IDLE_MS)).toBe(false); });
  it('the idle window is 10 minutes', () => { expect(POLL_IDLE_MS).toBe(600_000); });
});

describe('gatedInterval', () => {
  it('polls on the interval while visible and active', () => {
    const fn = vi.fn();
    const stop = gatedInterval(fn, 30_000);
    vi.advanceTimersByTime(90_000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it('makes zero calls while hidden, then one within 1 s of becoming visible', () => {
    const fn = vi.fn();
    const stop = gatedInterval(fn, 30_000);
    setVisible(false);
    vi.advanceTimersByTime(5 * 60_000);
    expect(fn).not.toHaveBeenCalled();
    userInput(); // input while hidden must not wake it
    vi.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();

    setVisible(true);
    vi.advanceTimersByTime(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(2); // the interval resumed
    stop();
  });

  it('stops after 10 minutes with no input; the next input refreshes once and resumes', () => {
    const fn = vi.fn();
    const stop = gatedInterval(fn, 30_000);
    vi.advanceTimersByTime(POLL_IDLE_MS + 1_000);
    const atIdle = fn.mock.calls.length;
    expect(isPollAllowed()).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(fn).toHaveBeenCalledTimes(atIdle); // nothing while idle

    userInput();
    expect(fn).toHaveBeenCalledTimes(atIdle + 1); // one immediate refresh
    vi.advanceTimersByTime(30_000);
    expect(fn).toHaveBeenCalledTimes(atIdle + 2); // and polling resumed
    stop();
  });

  it('activity keeps it polling past 10 minutes', () => {
    const fn = vi.fn();
    const stop = gatedInterval(fn, 30_000);
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(5 * 60_000); userInput(); }
    expect(isPollAllowed()).toBe(true);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(39);
    stop();
  });

  it('stop() ends polling for good', () => {
    const fn = vi.fn();
    gatedInterval(fn, 30_000)();
    vi.advanceTimersByTime(120_000);
    setVisible(false); setVisible(true);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('the switch (t/4258 deploy hold, TL p/336#614)', () => {
  it('switched off, polling is always allowed: hidden and idle tabs poll as before', () => {
    switchState.cfg = { pollGate: { enabled: false } };
    const fn = vi.fn();
    const stop = gatedInterval(fn, 30_000);
    setVisible(false);
    vi.advanceTimersByTime(POLL_IDLE_MS + 5 * 60_000);
    expect(isPollAllowed()).toBe(true);
    expect(fn.mock.calls.length).toBe(Math.floor((POLL_IDLE_MS + 5 * 60_000) / 30_000));
    stop();
  });

  it('switched on, the gate applies (hidden means no polling)', () => {
    switchState.cfg = { pollGate: { enabled: true } };
    setVisible(false);
    expect(pollGateEnabled()).toBe(true);
    expect(isPollAllowed()).toBe(false);
  });

  it('no pollGate value from the server at all means OFF', () => {
    switchState.cfg = {};
    setVisible(false);
    expect(pollGateEnabled()).toBe(false);
    expect(isPollAllowed()).toBe(true);
  });
});

// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3166 — event-loop lag classification. The timer/histogram glue is boot code; the
// classification (which sample is a starvation WARN vs a routine gauge) is the pure,
// testable core. Both arms + the threshold boundary.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  classifyEventLoopSample, EVENT_LOOP_LAG_WARN_MS,
  startEventLoopMonitor, stopEventLoopMonitor, getLastEventLoopSample,
  type EventLoopSample,
} from '../eventLoopMonitor.js';

const sample = (maxMs: number, overrides: Partial<EventLoopSample> = {}): EventLoopSample => ({
  maxMs, meanMs: 5, p99Ms: 20, utilization: 0.3, gcMs: 0, ...overrides,
});

describe('classifyEventLoopSample (t/3166)', () => {
  it('a multi-second block → warn, message reproduces the greppable "event loop blocked Nms"', () => {
    const { level, message } = classifyEventLoopSample(sample(8123));
    expect(level).toBe('warn');
    expect(message).toContain('event loop blocked 8123ms');
  });

  it('a routine sample (< threshold) → info gauge, NOT a warn (keeps the FR ring clean)', () => {
    const { level, message } = classifyEventLoopSample(sample(42));
    expect(level).toBe('info');
    expect(message).not.toContain('blocked');
    expect(message).toContain('event-loop max 42ms');
  });

  it('threshold is inclusive: max exactly EVENT_LOOP_LAG_WARN_MS → warn; one below → info', () => {
    expect(classifyEventLoopSample(sample(EVENT_LOOP_LAG_WARN_MS)).level).toBe('warn');
    expect(classifyEventLoopSample(sample(EVENT_LOOP_LAG_WARN_MS - 1)).level).toBe('info');
  });

  it('respects an injected threshold (both arms)', () => {
    expect(classifyEventLoopSample(sample(600), 500).level).toBe('warn');
    expect(classifyEventLoopSample(sample(400), 500).level).toBe('info');
  });

  it('gauge message carries mean/p99/ELU for trending', () => {
    const { message } = classifyEventLoopSample(sample(50, { meanMs: 3.2, p99Ms: 12, utilization: 0.55 }));
    expect(message).toContain('mean 3.2ms');
    expect(message).toContain('p99 12ms');
    expect(message).toContain('ELU 55%');
  });

  it('t/4241: gauge message carries the GC pause sum, to distinguish "GC is the lag" from other causes', () => {
    const { message } = classifyEventLoopSample(sample(50, { gcMs: 312 }));
    expect(message).toContain('gc 312ms');
  });
});

// t/4239/t/4240 — /health's unauth branch needs the last sample retained, not discarded after
// logging (the original gap this handoff closes).
describe('getLastEventLoopSample (t/4240)', () => {
  afterEach(() => {
    stopEventLoopMonitor();
    vi.useRealTimers();
  });

  it('is null before the first tick', () => {
    expect(getLastEventLoopSample()).toBeNull();
  });

  it('is set to the tick\'s sample once the interval fires', () => {
    vi.useFakeTimers();
    startEventLoopMonitor(1000);
    vi.advanceTimersByTime(1000);
    const sample = getLastEventLoopSample();
    expect(sample).not.toBeNull();
    expect(typeof sample!.maxMs).toBe('number');
  });

  it('is cleared back to null by stopEventLoopMonitor()', () => {
    vi.useFakeTimers();
    startEventLoopMonitor(1000);
    vi.advanceTimersByTime(1000);
    expect(getLastEventLoopSample()).not.toBeNull();
    stopEventLoopMonitor();
    expect(getLastEventLoopSample()).toBeNull();
  });
});

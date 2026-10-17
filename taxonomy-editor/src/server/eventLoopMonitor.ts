// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3166 — periodic event-loop lag observability. The t/3165 incident (an infra-fabricated
// empty-body 500 while the Node loop was starved by 7–8s of in-process ONNX embedding) was
// diagnosable ONLY by inference — the starvation was recorded nowhere. This turns
// "I inferred N-second starvation from ONNX durations" into a directly greppable
// "event loop blocked Nms at HH:MM:SS".
//
// Deliberately SEPARATE from embeddingsLoad.ts's monitorEventLoopDelay histograms
// (getLoopDelay / getShedLoopDelay, t/3078): those are read + reset per-request to drive
// the load-shed decision. Coupling this 5s observability sampler's reset() to their
// per-request cycle would corrupt both readings. Same cheap libuv primitive, distinct
// lifecycle → distinct histogram.

import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'perf_hooks';

// @types/node dropped the named IntervalHistogram export; derive it from the API so the
// type survives future typings bumps (Dependabot group, PR #2137).
type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { log } from './logger.js';

const NS_PER_MS = 1e6;

/** Max single-tick lag (ms) at/above which a sample is treated as a starvation event
 *  (FR warn), not a routine gauge. 1s is well above normal GC/JIT pauses but far below
 *  the multi-second block that fabricates ingress 5xx (t/3165). */
export const EVENT_LOOP_LAG_WARN_MS = 1000;

const SAMPLE_INTERVAL_MS = 5000;

export interface EventLoopSample {
  /** Worst single-tick delay over the interval (ms). */
  maxMs: number;
  /** Mean tick delay over the interval (ms). */
  meanMs: number;
  /** 99th-percentile tick delay over the interval (ms). */
  p99Ms: number;
  /** Event-loop utilization over the interval (0..1 — fraction of wall-clock the loop was busy). */
  utilization: number;
}

/**
 * Pure decision for one sample. A sample whose WORST tick crossed the warn threshold is a
 * starvation event → `warn` (recorded to the FR ring, which is capacity-bounded and curated).
 * Otherwise it's a routine gauge → `info` (Pino-only; emitting a 2000-capacity FR event every
 * 5s would evict real events). Extracted from the timer glue so both arms are unit-testable.
 */
export function classifyEventLoopSample(
  s: EventLoopSample,
  warnMs: number = EVENT_LOOP_LAG_WARN_MS,
): { level: 'warn' | 'info'; message: string } {
  const gauge = `event-loop max ${s.maxMs.toFixed(0)}ms mean ${s.meanMs.toFixed(1)}ms `
    + `p99 ${s.p99Ms.toFixed(0)}ms ELU ${(s.utilization * 100).toFixed(0)}%`;
  if (s.maxMs >= warnMs) {
    return { level: 'warn', message: `event loop blocked ${s.maxMs.toFixed(0)}ms — ${gauge}` };
  }
  return { level: 'info', message: gauge };
}

let timer: NodeJS.Timeout | null = null;
let hist: IntervalHistogram | null = null;
let lastSample: EventLoopSample | null = null;

/** t/4239/t/4240: the most recent sample, for /health's unauth branch (the t/4180 load-test
 *  harness polls /health anonymously, so this is the only reachable read path during a run).
 *  `null` before the first tick, or after stopEventLoopMonitor(). */
export function getLastEventLoopSample(): EventLoopSample | null {
  return lastSample;
}

/**
 * Start the periodic event-loop monitor. Idempotent (a second call is a no-op while running).
 * The interval is `unref()`d so it never keeps the process alive. Returns the stop fn.
 */
export function startEventLoopMonitor(intervalMs: number = SAMPLE_INTERVAL_MS): () => void {
  if (timer) return stopEventLoopMonitor;
  hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  let prevElu: EventLoopUtilization = performance.eventLoopUtilization();

  timer = setInterval(() => {
    if (!hist) return;
    // One-arg form: delta utilization since prevElu; then re-baseline for the next tick.
    const delta = performance.eventLoopUtilization(prevElu);
    prevElu = performance.eventLoopUtilization();
    const sample: EventLoopSample = {
      maxMs: hist.max / NS_PER_MS,
      meanMs: (Number.isFinite(hist.mean) ? hist.mean : 0) / NS_PER_MS,
      p99Ms: hist.percentile(99) / NS_PER_MS,
      utilization: delta.utilization,
    };
    hist.reset();
    lastSample = sample;

    const { level, message } = classifyEventLoopSample(sample);
    if (level === 'warn') {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'event-loop', level: 'warn',
        message, data: { ...sample },
      });
      log.server.warn({ component: 'event-loop', ...sample }, message);
    } else {
      // Routine gauge — Pino only; never the capacity-bounded FR ring.
      log.server.info({ component: 'event-loop', ...sample }, message);
    }
  }, intervalMs);
  timer.unref();
  return stopEventLoopMonitor;
}

/** Stop the monitor and release the histogram (idempotent). */
export function stopEventLoopMonitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (hist) { hist.disable(); hist = null; }
  lastSample = null;
}

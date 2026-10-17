// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Uses bare fetch() intentionally — this module measures raw server latency
// and must not go through resilientFetch (which adds retry/throttle delays).
// Same approved-exception pattern as clientConfig.ts and flightRecorderInit.ts.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { getClientConfig } from '../lib/clientConfig';
import { setThrottleFromProbe } from './resilience';
import { isPollAllowed, onPollAllowedChange } from '../lib/pollGate';

type ProbePhase = 'idle' | 'warmup' | 'steady';

const MAX_BACKOFF_MS = 300_000; // 5 min cap
const FAILURE_LOG_CUTOFF = 5;

function cfg() { return getClientConfig().healthProbe; }

const RECOVERY_THRESHOLD = 3;

const state = {
  phase: 'idle' as ProbePhase,
  latencies: [] as number[],
  baseline: 0,
  warmUpSamples: [] as number[],
  startTime: 0,
  timerId: 0,
  consecutiveFailures: 0,
  consecutiveGoodPolls: 0,
};

// t/4251: the probe runs only while polling is allowed (tab visible, user active).
let unsubscribeGate: (() => void) | null = null;

/** Resolves once polling is allowed (immediately if it already is). Used by the warm-up. */
function whenPollAllowed(): Promise<void> {
  if (isPollAllowed()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = onPollAllowedChange((allowed) => { if (allowed) { unsubscribe(); resolve(); } });
  });
}

function computeP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(0.95 * sorted.length) - 1, sorted.length - 1);
  return sorted[idx];
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function probe(): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg().timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch('/api/config/client', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      state.consecutiveFailures++;
      return null;
    }
    await res.json();
    state.consecutiveFailures = 0;
    return performance.now() - start;
  } catch (err) {
    clearTimeout(timer);
    state.consecutiveFailures++;
    if (state.consecutiveFailures <= FAILURE_LOG_CUTOFF) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'health-probe',
        level: 'warn',
        message: `Health probe request failed (${state.consecutiveFailures}/${FAILURE_LOG_CUTOFF})`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    return null;
  }
}

async function runWarmUp(): Promise<void> {
  state.phase = 'warmup';
  const { warmUpCount, warmUpDiscardCount, warmUpIntervalMs } = cfg();

  for (let i = 0; i < warmUpCount; i++) {
    if (!isPollAllowed()) {
      await whenPollAllowed(); // only waits when hidden or idle; otherwise the probe starts synchronously, as before
      if (state.phase !== 'warmup') return; // stopped while waiting
    }
    const latency = await probe();
    if (latency !== null) {
      state.warmUpSamples.push(latency);
    }
    if (i < warmUpCount - 1) {
      await new Promise<void>(r => setTimeout(r, warmUpIntervalMs));
    }
  }

  const kept = state.warmUpSamples.slice(warmUpDiscardCount);
  if (kept.length > 0) {
    state.baseline = computeMedian(kept);
    getGlobalRecorder()?.record({
      type: 'lifecycle',
      component: 'health-probe',
      level: 'info',
      message: `Warm-up complete: baseline=${Math.round(state.baseline)}ms (median of ${kept.length} samples, ${warmUpDiscardCount} discarded)`,
    });
  }

  state.phase = 'steady';
  scheduleSteadyState();
}

function nextInterval(): number {
  if (state.consecutiveFailures === 0) return cfg().intervalMs;
  return Math.min(cfg().intervalMs * Math.pow(2, state.consecutiveFailures), MAX_BACKOFF_MS);
}

function scheduleSteadyState(): void {
  let parked = false;
  let inFlight = false;
  const tick = () => {
    if (!isPollAllowed()) { parked = true; state.timerId = 0; return; }
    inFlight = true;
    void steadyProbe().then(() => {
      inFlight = false;
      if (state.phase !== 'steady' || parked) return;
      state.timerId = window.setTimeout(tick, nextInterval());
    });
  };
  // Hidden or idle: clear the pending probe rather than skip it. Allowed again: probe at once, so
  // the throttle state is fresh before anything reads it, then resume the chain.
  unsubscribeGate?.();
  unsubscribeGate = onPollAllowedChange((allowed) => {
    if (!allowed) {
      parked = true;
      if (state.timerId) { clearTimeout(state.timerId); state.timerId = 0; }
    } else if (parked) {
      parked = false;
      // A probe still in flight reschedules the chain itself; starting another would make two chains.
      if (!inFlight) tick();
    }
  });
  state.timerId = window.setTimeout(tick, nextInterval());
}

async function steadyProbe(): Promise<void> {
  const latency = await probe();
  if (latency === null) return;

  if (state.baseline > 0 && latency > state.baseline * cfg().coldStartMultiple) {
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'health-probe', level: 'debug',
      message: `Cold-start spike excluded: ${Math.round(latency)}ms (>${cfg().coldStartMultiple}× baseline ${Math.round(state.baseline)}ms)`,
    });
    return;
  }

  state.latencies.push(latency);
  if (state.latencies.length > cfg().windowSize) state.latencies.shift();
  if (state.baseline === 0) return;

  const elapsed = performance.now() - state.startTime;
  if (elapsed < cfg().gracePeriodMs) return;

  const p95 = computeP95(state.latencies);
  const enterThreshold = Math.max(state.baseline * cfg().enterFactor, cfg().thresholdFloorMs);
  const exitThreshold = Math.max(state.baseline * cfg().exitFactor, cfg().thresholdFloorMs * 0.8);

  if (latency < exitThreshold) {
    state.consecutiveGoodPolls++;
  } else {
    state.consecutiveGoodPolls = 0;
  }

  if (state.consecutiveGoodPolls >= RECOVERY_THRESHOLD && p95 > exitThreshold) {
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'health-probe', level: 'info',
      message: `Recovery: ${RECOVERY_THRESHOLD} consecutive good polls (${Math.round(latency)}ms < ${Math.round(exitThreshold)}ms exit threshold), flushing stale window (p95 was ${Math.round(p95)}ms)`,
    });
    state.latencies = [latency];
    state.consecutiveGoodPolls = 0;
    setThrottleFromProbe('NORMAL', latency, state.baseline);
    return;
  }

  if (p95 > enterThreshold) {
    setThrottleFromProbe('THROTTLED', p95, state.baseline);
  } else if (p95 < exitThreshold) {
    setThrottleFromProbe('NORMAL', p95, state.baseline);
  }
}

export function initHealthProbe(): void {
  if (state.phase !== 'idle') return;
  if (typeof window !== 'undefined' && 'electronAPI' in window) return;
  state.startTime = performance.now();
  void runWarmUp();
}

export function stopHealthProbe(): void {
  unsubscribeGate?.();
  unsubscribeGate = null;
  if (state.timerId) {
    clearTimeout(state.timerId);
    state.timerId = 0;
  }
  state.phase = 'idle';
  state.latencies = [];
  state.warmUpSamples = [];
  state.baseline = 0;
  state.consecutiveFailures = 0;
  state.consecutiveGoodPolls = 0;
}

export function getProbeState(): {
  phase: ProbePhase;
  baseline: number;
  p95: number;
  sampleCount: number;
} {
  return {
    phase: state.phase,
    baseline: Math.round(state.baseline),
    p95: Math.round(computeP95(state.latencies)),
    sampleCount: state.latencies.length,
  };
}

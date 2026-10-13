// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3172 (G8b) — scheduled full-taxonomy grounding sweep. The headline proof is the TWO GV ARMS the
// ticket requires: a stale-hash tree reconciles (nodes_reconciled >= 1) and a clean tree does not
// (nodes_reconciled == 0). The other three lock the contract: an overlapping tick SKIPS rather than
// stacking a 2nd child, a child failure is caught + recorded and NEVER rethrown (must not crash the
// host), and the flag gate leaves the timer un-armed when GROUNDING_SWEEP_ENABLED is OFF (default).
//
// The reconciler child is injected via __setSweepRunnerForTest, so no python is spawned; the flag
// only gates timer-arming in startGroundingSweep, so the arm tests drive runSweep directly.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { records } = vi.hoisted(() => ({
  records: [] as Array<{ type?: string; level?: string; message?: string; data?: Record<string, unknown> }>,
}));

// Capture FR records so the grounding.sweep events are assertable.
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (r: unknown) => { records.push(r as { type?: string }); } }),
  setGlobalRecorder: vi.fn(),
}));

// t/3333: make STORAGE_MODE controllable so the github-api hard-guard arm is exercised. Defaults to
// 'filesystem' (the real test-env value) so every existing test is unaffected; one test flips it.
const cfgMock = vi.hoisted(() => ({ storageMode: 'filesystem' as string }));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, get STORAGE_MODE() { return cfgMock.storageMode; } };
});

import {
  startGroundingSweep,
  stopGroundingSweep,
  decideSweepArm,
  __setSweepRunnerForTest,
  __runSweepOnceForTest,
  __resetSweepForTest,
  __stateForTest,
} from '../groundingSweepScheduler.js';
import type { ReconcilerStats } from '../groundingReconcileHook.js';

/** All grounding-sweep FR events captured this test. FR EventType has no 'grounding.sweep' member
 *  (closed Shared-Lib union) — the component tag is the greppable identity, per G8a precedent. */
function sweepEvents(): typeof records {
  return records.filter((r) => (r as { component?: string }).component === 'grounding-sweep');
}

const ORIG_FLAG = process.env.GROUNDING_SWEEP_ENABLED;

describe('G8b groundingSweepScheduler (t/3172)', () => {
  beforeEach(() => {
    records.length = 0;
    __resetSweepForTest();
    __setSweepRunnerForTest(null); // restore default; individual tests inject their own
    delete process.env.GROUNDING_SWEEP_ENABLED;
    delete process.env.MAX_REPLICAS; // t/4177: default 1 — one test sets it >1
    cfgMock.storageMode = 'filesystem'; // t/3333: default profile is FS-visible; one test flips it
  });
  afterEach(() => {
    stopGroundingSweep();
    __resetSweepForTest();
    __setSweepRunnerForTest(null);
    delete process.env.MAX_REPLICAS;
    if (ORIG_FLAG === undefined) delete process.env.GROUNDING_SWEEP_ENABLED;
    else process.env.GROUNDING_SWEEP_ENABLED = ORIG_FLAG;
  });

  // ── GV FAIL ARM: a stale-hash node reconciles ────────────────────────────────
  it('GV/stale: a stale-hash tree reconciles → FR grounding.sweep with nodes_reconciled >= 1', async () => {
    const stats: ReconcilerStats = { changed: 2, skipped: 4140, removed: 0 };
    __setSweepRunnerForTest(async () => stats);

    await __runSweepOnceForTest();

    const done = sweepEvents().find((e) => e.data?.skipped === false && e.level === 'info');
    expect(done).toBeDefined();
    expect(done?.data?.nodes_reconciled).toBe(2);
    expect(done?.data?.nodes_reconciled as number).toBeGreaterThanOrEqual(1);
    expect(done?.data?.nodes_checked).toBe(2 + 4140 + 0); // changed + skipped + removed
    expect(__stateForTest().inFlight).toBe(false); // flag cleared after the run
  });

  // ── GV CLEAN ARM: an up-to-date tree does zero reconciles ────────────────────
  it('GV/clean: a fully up-to-date tree → FR grounding.sweep with nodes_reconciled == 0 (hash gate)', async () => {
    const stats: ReconcilerStats = { changed: 0, skipped: 4144, removed: 0 };
    __setSweepRunnerForTest(async () => stats);

    await __runSweepOnceForTest();

    const done = sweepEvents().find((e) => e.data?.skipped === false && e.level === 'info');
    expect(done).toBeDefined();
    expect(done?.data?.nodes_reconciled).toBe(0);
    expect(done?.data?.nodes_checked).toBe(4144);
    // No error/warn event on a clean run.
    expect(sweepEvents().some((e) => e.level === 'error' || e.level === 'warn')).toBe(false);
  });

  // ── Non-overlapping: a 2nd tick while one is in flight SKIPS, does not stack ──
  it('overlap: a concurrent tick is skipped (warn, skipped:true) and does not run the reconciler twice', async () => {
    let releaseFirst!: () => void;
    let calls = 0;
    __setSweepRunnerForTest(() => {
      calls++;
      return new Promise<ReconcilerStats>((resolve) => {
        releaseFirst = () => resolve({ changed: 1, skipped: 0, removed: 0 });
      });
    });

    const first = __runSweepOnceForTest();  // enters, sets inFlight, awaits the held runner
    await Promise.resolve();                // let the first microtask reach the await
    expect(__stateForTest().inFlight).toBe(true);

    await __runSweepOnceForTest();          // second tick — must skip immediately
    const skip = sweepEvents().find((e) => e.level === 'warn' && e.data?.skipped === true);
    expect(skip).toBeDefined();
    expect(calls).toBe(1);                  // runner NOT invoked a second time

    releaseFirst();
    await first;
    expect(__stateForTest().inFlight).toBe(false);
    expect(calls).toBe(1);
  });

  // ── Failure containment: a child failure is recorded and NEVER rethrown ──────
  it('failure: reconciler rejection is caught (no throw), recorded as error, inFlight cleared', async () => {
    __setSweepRunnerForTest(async () => { throw new Error('reconcile_grounding.py exited 1: boom'); });

    // Must resolve, not reject — an unhandled rejection on the bare setInterval would crash the host.
    await expect(__runSweepOnceForTest()).resolves.toBeUndefined();

    const err = sweepEvents().find((e) => e.level === 'error');
    expect(err).toBeDefined();
    expect(err?.data?.skipped).toBe(false);
    expect(String(err?.message)).toMatch(/failed/i);
    expect(__stateForTest().inFlight).toBe(false); // reset in finally → next tick can run
  });

  // ── Flag gate: default OFF → timer never armed ───────────────────────────────
  it('flag OFF (default): startGroundingSweep does not arm the timer and returns a callable stop fn', () => {
    delete process.env.GROUNDING_SWEEP_ENABLED;
    const stop = startGroundingSweep(50);
    expect(__stateForTest().armed).toBe(false);
    expect(typeof stop).toBe('function');
    stop(); // no-op, must not throw
    expect(__stateForTest().armed).toBe(false);
  });

  it('flag ON: startGroundingSweep arms the timer; stop disarms it; a 2nd start is idempotent', () => {
    process.env.GROUNDING_SWEEP_ENABLED = '1';
    const stop = startGroundingSweep(50);
    expect(__stateForTest().armed).toBe(true);
    startGroundingSweep(50); // idempotent — still one timer
    expect(__stateForTest().armed).toBe(true);
    stop();
    expect(__stateForTest().armed).toBe(false);
  });

  // ── t/3333: hard-guard the silent-no-op trap on the github-api profile ────────
  describe('decideSweepArm (t/3333 pure predicate)', () => {
    it('flag OFF → disabled (regardless of storage mode)', () => {
      expect(decideSweepArm('filesystem', false)).toBe('disabled');
      expect(decideSweepArm('github-api', false)).toBe('disabled');
    });
    it('flag ON + filesystem → arm', () => {
      expect(decideSweepArm('filesystem', true)).toBe('arm');
    });
    it('flag ON + github-api → blocked-github-api (writes invisible to the read path)', () => {
      expect(decideSweepArm('github-api', true)).toBe('blocked-github-api');
    });
    it('flag ON + filesystem + MAX_REPLICAS=1 (default) → arm', () => {
      expect(decideSweepArm('filesystem', true, 1)).toBe('arm');
    });
    it('flag ON + filesystem + MAX_REPLICAS>1 → blocked-no-lease-multi-replica (no cross-replica lease)', () => {
      expect(decideSweepArm('filesystem', true, 10)).toBe('blocked-no-lease-multi-replica');
    });
    it('github-api takes precedence over the replica check when both would block', () => {
      expect(decideSweepArm('github-api', true, 10)).toBe('blocked-github-api');
    });
  });

  it('t/3333 hard-guard: flag ON + STORAGE_MODE=github-api → REFUSES to arm + records a loud error (not a silent no-op)', () => {
    process.env.GROUNDING_SWEEP_ENABLED = '1';
    cfgMock.storageMode = 'github-api';
    const stop = startGroundingSweep(50);
    // Refused to arm — no timer, so the reconciler can never run + silently no-op.
    expect(__stateForTest().armed).toBe(false);
    expect(typeof stop).toBe('function');
    stop(); // no-op stop must not throw
    // Loud: a grounding-sweep error names the refusal + the discriminating storageMode.
    const refusal = sweepEvents().find((e) => e.level === 'error' && String(e.message).includes('refused to arm'));
    expect(refusal).toBeDefined();
    expect(refusal?.data?.storageMode).toBe('github-api');
    expect(refusal?.data?.armed).toBe(false);
  });

  // ── t/4177: hard-guard N>1 replicas with no cross-replica lease ──────────────
  it('t/4177 hard-guard: flag ON + MAX_REPLICAS>1 → REFUSES to arm + records a loud error (no cross-replica lease)', () => {
    process.env.GROUNDING_SWEEP_ENABLED = '1';
    process.env.MAX_REPLICAS = '10';
    const stop = startGroundingSweep(50);
    // Refused to arm — no timer, so N concurrent uncoordinated sweeps can never run.
    expect(__stateForTest().armed).toBe(false);
    expect(typeof stop).toBe('function');
    stop(); // no-op stop must not throw
    const refusal = sweepEvents().find((e) => e.level === 'error' && String(e.message).includes('refused to arm'));
    expect(refusal).toBeDefined();
    expect(refusal?.data?.maxReplicas).toBe(10);
    expect(refusal?.data?.armed).toBe(false);
  });

  it('t/4177: MAX_REPLICAS=1 (default) still arms normally on a filesystem profile', () => {
    process.env.GROUNDING_SWEEP_ENABLED = '1';
    const stop = startGroundingSweep(50);
    expect(__stateForTest().armed).toBe(true);
    stop();
  });
});

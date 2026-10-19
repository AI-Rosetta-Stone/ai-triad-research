// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpmLimiter, getLimiter, resetLimiters, effectivePerReplicaRpm } from '../ai/rpmLimiter.js';

// Use rpm=3 so intervalMs=20_000 and burstMs=40_000 — keeps expected values legible.
const RPM = 3;
const INTERVAL_MS = 60_000 / RPM; // 20_000

// Tests call reserve(now) directly — no setTimeout, no real wall-clock elapsed-ms assertions.
// This satisfies TL condition #2 (Guard Testability): the pacing predicate is tested
// synchronously and cannot flake on CI timing. acquire() is a thin wrapper and is not
// tested for real wait durations (that would be a CI latency oracle).

describe('RpmLimiter.reserve() — synchronous GCRA scheduling (t/3052)', () => {
  let limiter: RpmLimiter;

  beforeEach(() => {
    // nowMs=0 makes arithmetic exact; interval and burstMs are all multiples of 20_000.
    limiter = new RpmLimiter(RPM, /* nowMs= */ 0);
  });

  it('burst arm: first rpm calls all return ≤ 0 (no pacing)', () => {
    for (let i = 0; i < RPM; i++) {
      expect(limiter.reserve(0)).toBeLessThanOrEqual(0);
    }
  });

  it('pace arm (N+K concurrent): over-cap calls have strictly monotonic positive waits', () => {
    // Exhaust the burst
    for (let i = 0; i < RPM; i++) limiter.reserve(0);

    // Collect K over-cap wait values (all at now=0, simulating concurrent callers)
    const K = 5;
    const waits: number[] = [];
    for (let k = 1; k <= K; k++) {
      waits.push(limiter.reserve(0));
    }

    // k-th over-cap caller waits exactly k × intervalMs
    for (let k = 0; k < K; k++) {
      expect(waits[k]).toBe((k + 1) * INTERVAL_MS);
    }

    // Strictly monotone: each wait > the previous (no batch-release)
    for (let k = 1; k < K; k++) {
      expect(waits[k]).toBeGreaterThan(waits[k - 1]);
    }
  });

  it('idle refill: after burstMs idle, burst capacity refills and all rpm calls pass', () => {
    // Exhaust burst at now=0; nextAllowed lands at 1×INTERVAL_MS after the 3rd caller.
    for (let i = 0; i < RPM; i++) limiter.reserve(0);

    // Advance to 3×INTERVAL_MS (2×INTERVAL_MS idle past the last slot → refills burst).
    const idleNow = 3 * INTERVAL_MS; // 60_000
    for (let i = 0; i < RPM; i++) {
      expect(limiter.reserve(idleNow)).toBeLessThanOrEqual(0);
    }
  });

  it('getLimiter: same key returns the same instance', () => {
    resetLimiters();
    const a = getLimiter('fake-api-key-gemini-1', RPM);
    const b = getLimiter('fake-api-key-gemini-1', RPM);
    expect(a).toBe(b);
  });

  it('getLimiter: different keys return different instances', () => {
    resetLimiters();
    const a = getLimiter('fake-api-key-gemini-1', RPM);
    const b = getLimiter('fake-api-key-groq-1', 30);
    expect(a).not.toBe(b);
  });

  it('resetLimiters: clears the singleton map so getLimiter returns a fresh instance', () => {
    resetLimiters();
    const a = getLimiter('fake-api-key-gemini-1', RPM);
    resetLimiters();
    const b = getLimiter('fake-api-key-gemini-1', RPM);
    expect(a).not.toBe(b);
  });

  it('acquire() resolves immediately when no pacing needed', async () => {
    const fresh = new RpmLimiter(RPM, Date.now());
    // Should resolve without any setTimeout delay (burst arm)
    await expect(fresh.acquire()).resolves.toBeUndefined();
  });
});

describe('effectivePerReplicaRpm + getLimiter MAX_REPLICAS division (t/4177)', () => {
  const ORIG_MAX_REPLICAS = process.env.MAX_REPLICAS;
  beforeEach(() => {
    resetLimiters();
    delete process.env.MAX_REPLICAS;
  });
  afterEach(() => {
    resetLimiters();
    if (ORIG_MAX_REPLICAS === undefined) delete process.env.MAX_REPLICAS;
    else process.env.MAX_REPLICAS = ORIG_MAX_REPLICAS;
  });

  it('MAX_REPLICAS unset (default 1): effective RPM equals the pool RPM unchanged', () => {
    expect(effectivePerReplicaRpm(12)).toBe(12);
  });

  it('MAX_REPLICAS=10: effective RPM is the pool RPM divided by 10', () => {
    process.env.MAX_REPLICAS = '10';
    expect(effectivePerReplicaRpm(12)).toBeCloseTo(1.2);
  });

  it('MAX_REPLICAS=1 (explicit): effective RPM equals the pool RPM unchanged', () => {
    process.env.MAX_REPLICAS = '1';
    expect(effectivePerReplicaRpm(12)).toBe(12);
  });

  it('getLimiter at MAX_REPLICAS=1 paces at the full pool RPM (burst arm matches RPM calls)', () => {
    // getLimiter constructs with nowMs=Date.now() internally — reserve() calls must use the same
    // basis. Pin the clock (t/4269) so the test's captured `now` and the limiter's internal
    // Date.now() can never skew by a real millisecond tick between the two calls.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.now();
      const limiter = getLimiter('fake-api-key-max-replicas-1', RPM);
      for (let i = 0; i < RPM; i++) {
        expect(limiter.reserve(now)).toBeLessThanOrEqual(0);
      }
      // The (RPM+1)-th call must wait — confirms the limiter was built with RPM, not RPM/N with N>1.
      expect(limiter.reserve(now)).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getLimiter at MAX_REPLICAS=10 paces at RPM/10, not the raw pool RPM', () => {
    // Pin the clock (t/4269): at effective RPM 1, burstMs is 0, so even a 1ms skew between this
    // test's `now` and the limiter's internal Date.now() makes the first reserve() wait instead
    // of passing — the MAX_REPLICAS=1 sibling above has the same ordering but is masked by its
    // burst allowance.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      process.env.MAX_REPLICAS = '10';
      const rpm = 10; // effective = 1 → intervalMs = 60_000
      const now = Date.now();
      const limiter = getLimiter('fake-api-key-max-replicas-10', rpm);
      // burst = (effectiveRpm - 1) * intervalMs = 0 — no burst at effective RPM 1.
      expect(limiter.reserve(now)).toBeLessThanOrEqual(0); // first call always allowed
      // Second call must wait a full interval at the DIVIDED rate (60_000ms), not the raw rate (6_000ms).
      expect(limiter.reserve(now)).toBe(60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

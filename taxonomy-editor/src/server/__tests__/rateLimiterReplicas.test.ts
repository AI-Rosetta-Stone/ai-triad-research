// @vitest-environment node

// t/4178 — cross-replica correctness. MAX_REPLICAS is read once at module load, so
// each case resets modules and re-imports with the env var set beforehand to get a
// fresh `MAX_REPLICAS` constant. Default (unset) behavior is already covered by
// rateLimiter.test.ts and is unaffected by this file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

let seq = 0;
const uniqueKey = () => `replica-test-${++seq}-${process.pid}`;

describe('rate limiters at MAX_REPLICAS=10 (t/4178)', () => {
  const originalEnv = process.env.MAX_REPLICAS;

  beforeEach(() => {
    process.env.MAX_REPLICAS = '10';
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.MAX_REPLICAS;
    else process.env.MAX_REPLICAS = originalEnv;
  });

  it('checkRate divides the configured limit by MAX_REPLICAS', async () => {
    const { checkRate } = await import('../security/rateLimiter.js');
    const key = uniqueKey();
    // Fleet-wide limit 50 → this process's share is 5.
    for (let i = 0; i < 5; i++) {
      expect(checkRate(key, 50, 60_000).allowed).toBe(true);
    }
    const blocked = checkRate(key, 50, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(5);
  });

  it('checkRequestRate divides the configured limit by MAX_REPLICAS', async () => {
    const { checkRequestRate } = await import('../security/rateLimiter.js');
    const userId = uniqueKey();
    for (let i = 0; i < 2; i++) {
      expect(checkRequestRate(userId, 20).allowed).toBe(true); // 20 / 10 = 2
    }
    const blocked = checkRequestRate(userId, 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.limit).toBe(2);
  });

  it('checkTokenLimit divides the daily budget by MAX_REPLICAS', async () => {
    const { recordTokenUsage, checkTokenLimit } = await import('../security/rateLimiter.js');
    const userId = uniqueKey();
    recordTokenUsage(userId, 60, 0); // this process's bucket: 60 tokens
    const result = checkTokenLimit(userId, 1000); // fleet-wide 1000 → effective 100
    expect(result.limit).toBe(100);
    expect(result.allowed).toBe(true); // 60 < 100
  });

  it('floors the effective limit at 1 rather than 0, however high MAX_REPLICAS is', async () => {
    process.env.MAX_REPLICAS = '1000';
    const { checkRate } = await import('../security/rateLimiter.js');
    const key = uniqueKey();
    // Fleet-wide limit 5 at 1000 replicas would floor-divide to 0 — must clamp to 1.
    const first = checkRate(key, 5, 60_000);
    expect(first.allowed).toBe(true);
    expect(first.limit).toBe(1);
    expect(checkRate(key, 5, 60_000).allowed).toBe(false);
  });
});

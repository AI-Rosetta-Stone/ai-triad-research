// @vitest-environment node

/**
 * t/715 — generic windowed rate limiter (backs M6 community-submit and M7
 * per-IP write limits).
 */

import { describe, it, expect, vi } from 'vitest';
import { checkRate } from '../security/rateLimiter.js';

let seq = 0;
const uniqueKey = () => `test-key-${++seq}-${process.pid}`;

describe('checkRate', () => {
  it('allows up to the limit, then blocks with a positive retryAfterMs', () => {
    const key = uniqueKey();
    for (let i = 0; i < 5; i++) {
      expect(checkRate(key, 5, 60_000).allowed).toBe(true);
    }
    const blocked = checkRate(key, 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.current).toBe(5);
    expect(blocked.limit).toBe(5);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('tracks keys independently', () => {
    const a = uniqueKey();
    const b = uniqueKey();
    expect(checkRate(a, 1, 60_000).allowed).toBe(true);
    expect(checkRate(a, 1, 60_000).allowed).toBe(false); // a exhausted
    expect(checkRate(b, 1, 60_000).allowed).toBe(true);  // b unaffected
  });

  it('frees capacity after the window elapses', () => {
    vi.useFakeTimers();
    try {
      const key = uniqueKey();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      expect(checkRate(key, 1, 40).allowed).toBe(true);
      expect(checkRate(key, 1, 40).allowed).toBe(false);
      vi.advanceTimersByTime(60);
      expect(checkRate(key, 1, 40).allowed).toBe(true); // window slid past
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports current count as it fills', () => {
    const key = uniqueKey();
    expect(checkRate(key, 3, 60_000).current).toBe(1);
    expect(checkRate(key, 3, 60_000).current).toBe(2);
    expect(checkRate(key, 3, 60_000).current).toBe(3);
  });

  it('window cleanup timing (t/1085) old timestamps are purged by the sliding window on next access', () => {
    vi.useFakeTimers();
    try {
      const key = uniqueKey();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

      // Make requests to fill the window
      expect(checkRate(key, 2, 50).allowed).toBe(true);
      expect(checkRate(key, 2, 50).allowed).toBe(true);
      expect(checkRate(key, 2, 50).allowed).toBe(false); // exhausted

      // Advance past the window — old entries should be purged on next check
      vi.advanceTimersByTime(60);
      expect(checkRate(key, 2, 50).allowed).toBe(true); // window cleaned, capacity available
    } finally {
      vi.useRealTimers();
    }
  });
});

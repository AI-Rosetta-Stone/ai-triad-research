// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DebateRateLimiter } from './debateRateLimiter.js';

describe('DebateRateLimiter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const noop = () => { /* no-op warn */ };

  it('BYOK: passes all calls without delay regardless of volume', async () => {
    const limiter = new DebateRateLimiter(true, 2); // tiny limit, BYOK
    const calls = Array.from({ length: 10 }, () => limiter.waitIfNeeded(noop));
    // All should resolve synchronously — no real await
    const results = await Promise.all(calls);
    expect(results).toHaveLength(10);
  });

  it('free-tier: allows up to maxPerMinute calls without delay', async () => {
    const limiter = new DebateRateLimiter(false, 5);
    for (let i = 0; i < 5; i++) {
      await limiter.waitIfNeeded(noop);
    }
    // No setTimeout was scheduled — fake timers won't need advancing
    expect(vi.getTimerCount()).toBe(0);
  });

  it('free-tier: holds the (N+1)th call and emits WARN once', async () => {
    const limiter = new DebateRateLimiter(false, 3);
    const warns: string[] = [];
    const warn = (msg: string) => warns.push(msg);

    // Fill the window
    for (let i = 0; i < 3; i++) await limiter.waitIfNeeded(noop);

    // 4th call should schedule a wait
    const blocked = limiter.waitIfNeeded(warn);
    expect(vi.getTimerCount()).toBe(1); // setTimeout pending
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/Free-tier rate pacing engaged/);

    // Advance time so the oldest call falls out
    vi.advanceTimersByTime(61_000);
    await blocked;
  });

  it('free-tier: WARN fires only once per limiter instance', async () => {
    const limiter = new DebateRateLimiter(false, 2);
    const warns: string[] = [];
    const warn = (msg: string) => warns.push(msg);

    // Fill the window and trigger first pacing event
    await limiter.waitIfNeeded(noop);
    await limiter.waitIfNeeded(noop);
    const b1 = limiter.waitIfNeeded(warn);
    vi.advanceTimersByTime(61_000);
    await b1;
    expect(warns).toHaveLength(1);

    // Advance past the full window so timestamps are pruned on next calls
    vi.advanceTimersByTime(120_000);

    // Fill window again and trigger a second pacing event
    await limiter.waitIfNeeded(noop);
    await limiter.waitIfNeeded(noop);
    const b2 = limiter.waitIfNeeded(warn);
    vi.advanceTimersByTime(61_000);
    await b2;

    // WARN must still be 1 — the flag is sticky for the lifetime of this adapter
    expect(warns).toHaveLength(1);
  });

  it('free-tier: resumes after wait window elapses', async () => {
    const limiter = new DebateRateLimiter(false, 3);

    for (let i = 0; i < 3; i++) await limiter.waitIfNeeded(noop);

    // Block the 4th call, then let it through
    const blocked = limiter.waitIfNeeded(noop);
    vi.advanceTimersByTime(61_000);
    await blocked;

    // After the window, another call should be free (no new timer)
    const timersBefore = vi.getTimerCount();
    await limiter.waitIfNeeded(noop);
    expect(vi.getTimerCount()).toBe(timersBefore); // no new setTimeout needed
  });

  it('WARN message includes call count and limit', async () => {
    const limiter = new DebateRateLimiter(false, 4);
    const warns: string[] = [];
    const warn = (msg: string) => warns.push(msg);

    for (let i = 0; i < 4; i++) await limiter.waitIfNeeded(noop);
    const b = limiter.waitIfNeeded(warn);
    vi.advanceTimersByTime(61_000);
    await b;

    expect(warns[0]).toMatch(/4 calls in last 60s/);
    expect(warns[0]).toMatch(/limit 4\/min/);
  });
});

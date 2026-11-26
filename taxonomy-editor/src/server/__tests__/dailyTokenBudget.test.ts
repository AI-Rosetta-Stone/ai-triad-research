// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/731: the per-user daily token allowance in shared storage (reserve, then settle).
// "Replicas" here are separate DailyTokenBudget objects over ONE store, which is what three server
// processes over one blob container are. The store's compare-and-swap is real (a write is refused when
// the document changed since it was read), so the concurrency tests exercise the lost-update path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DailyTokenBudget, InMemoryTokenDocStore, dailyTokenDocName, HOLD_TTL_MS,
  type TokenDocStore, type DailyTokenDoc, type ReserveResult, type TokenHold,
} from '../security/dailyTokenBudget.js';
import { log } from '../logger.js';

const KEY = 'free:user:alice.smith@contoso.example';
const IP_KEY = 'free:203.0.113.77';
const LIMIT = 500_000;
const pool = (promptBytes: number, outputCapTokens = 8_000) => ({ promptBytes, outputCapTokens, poolFunded: true });
const own = (promptBytes: number, outputCapTokens = 8_000) => ({ promptBytes, outputCapTokens, poolFunded: false });

/** A store that can be told to fail reads and writes, and counts its writes. */
class SwitchableStore implements TokenDocStore {
  failing = false;
  failRmwOnce = 0;
  names: string[] = [];
  constructor(readonly inner = new InMemoryTokenDocStore()) {}
  async read<T>(name: string) {
    if (this.failing) throw new Error('store down');
    return this.inner.read<T>(name);
  }
  async rmw<T, R>(name: string, fresh: () => T, mutate: (doc: T) => { result: R; skipWrite?: boolean }): Promise<R> {
    if (this.failing) throw new Error('store down');
    if (this.failRmwOnce > 0) { this.failRmwOnce--; throw new Error('write failed'); }
    this.names.push(name);
    return this.inner.rmw(name, fresh, mutate);
  }
}

function holdOf(r: ReserveResult): TokenHold {
  if (!r.ok) throw new Error(`expected an admitted call, got ${JSON.stringify(r)}`);
  return r.hold;
}

let nowMs: number;
const now = () => new Date(nowMs);
let warn: ReturnType<typeof vi.spyOn>;
const warned = (text: string) => warn.mock.calls.some((c) => c.map(String).join(' ').includes(text));

beforeEach(() => {
  nowMs = Date.UTC(2026, 10, 26, 12, 0, 0);
  warn = vi.spyOn(log.server, 'warn').mockImplementation(() => undefined as never);
});
afterEach(() => { warn.mockRestore(); });

describe('daily token budget: reserve then settle (t/731)', () => {
  it('a restart keeps the count: a new budget object over the same store sees what the old one settled', async () => {
    const store = new InMemoryTokenDocStore();
    const before = new DailyTokenBudget(store, { now });
    await before.settle(holdOf(await before.reserve(KEY, LIMIT, pool(10_000))), { inputTokens: 9_000, outputTokens: 1_000 });

    const afterRestart = new DailyTokenBudget(store, { now });
    expect(await afterRestart.usage(KEY)).toEqual({ tokensToday: 10_000, heldTokens: 0 });
    // And the allowance left is the allowance minus that usage, not a fresh day.
    const r = await afterRestart.reserve(KEY, 20_000, pool(4_000, 8_000));
    expect(r).toMatchObject({ ok: false, reason: 'daily_limit', used: 10_000 });
  });

  it('a reservation that does not fit is refused, and nothing is held for it', async () => {
    const store = new InMemoryTokenDocStore();
    const b = new DailyTokenBudget(store, { now });
    const r = await b.reserve(KEY, 50_000, pool(60_000, 8_000));
    expect(r).toEqual({ ok: false, reason: 'daily_limit', used: 0, limit: 50_000, reserved: 68_000 });
    expect(await b.usage(KEY)).toEqual({ tokensToday: 0, heldTokens: 0 });
  });

  it('the hold is the call\'s own worst case: prompt bytes plus the output cap', async () => {
    const b = new DailyTokenBudget(new InMemoryTokenDocStore(), { now });
    const r = await b.reserve(KEY, LIMIT, pool(30_001, 8_000));
    expect(holdOf(r).reserved).toBe(38_001);
    expect(await b.usage(KEY)).toEqual({ tokensToday: 0, heldTokens: 38_001 });
  });

  it('a prompt over the per-call ceiling is refused before anything is read or written', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now, perCallCeilingTokens: 128_000 });
    expect(await b.reserve(KEY, LIMIT, pool(120_001, 8_000))).toEqual({ ok: false, reason: 'per_call_ceiling', reserved: 128_001, ceiling: 128_000 });
    expect(store.names).toEqual([]);
    expect((await b.reserve(KEY, LIMIT, pool(120_000, 8_000))).ok).toBe(true); // exactly at the ceiling passes
  });

  it('three replicas reserving at once cannot together pass the allowance, and no update is lost', async () => {
    const store = new InMemoryTokenDocStore();
    const replicas = [0, 1, 2].map(() => new DailyTokenBudget(store, { now }));
    // 12 calls of 100,000 against 500,000: exactly five fit, whichever replica asks.
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => replicas[i % 3].reserve(KEY, LIMIT, pool(92_000, 8_000))));
    const admitted = results.filter((r) => r.ok);
    expect(admitted).toHaveLength(5);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'daily_limit')).toBe(true);
    expect((await replicas[0].usage(KEY)).heldTokens).toBe(500_000);

    // Settling concurrently from different replicas loses nothing either.
    await Promise.all(admitted.map((r, i) => replicas[(i + 1) % 3].settle(holdOf(r), { inputTokens: 1_000 * (i + 1), outputTokens: 10 })));
    expect(await replicas[2].usage(KEY)).toEqual({ tokensToday: 15_000 + 50, heldTokens: 0 });
  });

  it('a failed call releases its hold: settle with zeros frees the allowance', async () => {
    const b = new DailyTokenBudget(new InMemoryTokenDocStore(), { now });
    const first = holdOf(await b.reserve(KEY, 100_000, pool(92_000, 8_000)));
    expect((await b.reserve(KEY, 100_000, pool(1_000, 1_000))).ok).toBe(false);
    await b.settle(first, { inputTokens: 0, outputTokens: 0 });
    expect(await b.usage(KEY)).toEqual({ tokensToday: 0, heldTokens: 0 });
    expect((await b.reserve(KEY, 100_000, pool(92_000, 8_000))).ok).toBe(true);
  });

  it('an abandoned hold expires after the TTL and not before, with a WARN', async () => {
    const store = new InMemoryTokenDocStore();
    const b = new DailyTokenBudget(store, { now });
    holdOf(await b.reserve(KEY, 100_000, pool(92_000, 8_000))); // never settled: its process "died"
    const other = new DailyTokenBudget(store, { now });

    nowMs += HOLD_TTL_MS - 1;
    expect((await other.reserve(KEY, 100_000, pool(50_000, 8_000))).ok).toBe(false);
    expect((await other.usage(KEY)).heldTokens).toBe(100_000);

    nowMs += 1;
    expect((await other.usage(KEY)).heldTokens).toBe(0);
    expect((await other.reserve(KEY, 100_000, pool(50_000, 8_000))).ok).toBe(true);
    expect(warned('hold expired without a settle')).toBe(true);
  });

  it('a call that outlives its hold still has its real usage added when it settles', async () => {
    const b = new DailyTokenBudget(new InMemoryTokenDocStore(), { now });
    const slow = holdOf(await b.reserve(KEY, LIMIT, pool(50_000, 8_000)));
    nowMs += HOLD_TTL_MS + 5_000;
    holdOf(await b.reserve(KEY, LIMIT, pool(1_000, 1_000))); // sweeps the expired hold
    await b.settle(slow, { inputTokens: 40_000, outputTokens: 2_000 });
    expect((await b.usage(KEY)).tokensToday).toBe(42_000);
  });

  it('store failure fails closed for a pool-funded call, with a WARN, and holds nothing', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now });
    store.failing = true;
    expect(await b.reserve(KEY, LIMIT, pool(1_000))).toEqual({ ok: false, reason: 'unavailable' });
    expect(warned('refusing a pool-funded call (fail closed')).toBe(true);
    store.failing = false;
    expect(await b.usage(KEY)).toEqual({ tokensToday: 0, heldTokens: 0 });
  });

  it('store failure counts an own-key call in this process, with a WARN, and still enforces the allowance there', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now });
    store.failing = true;
    const r = await b.reserve(KEY, 30_000, own(10_000, 8_000));
    expect(holdOf(r).inMemory).toBe(true);
    expect(warned('counting an own-key call in this process only')).toBe(true);
    await b.settle(holdOf(r), { inputTokens: 15_000, outputTokens: 2_000 });
    expect(await b.reserve(KEY, 30_000, own(10_000, 8_000))).toMatchObject({ ok: false, reason: 'daily_limit', used: 17_000 });
  });

  it('a settle whose write fails stays pending and is applied with the next write to that document', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now });
    const h = holdOf(await b.reserve(KEY, LIMIT, pool(20_000, 8_000)));
    store.failRmwOnce = 1;
    expect(await b.settle(h, { inputTokens: 18_000, outputTokens: 500 })).toBeNull();
    expect(warned('usage stays pending in this process')).toBe(true);
    // Counted at once from this process's view, though the document still shows the hold.
    expect((await b.usage(KEY)).tokensToday).toBe(18_500);

    holdOf(await b.reserve(KEY, LIMIT, pool(1_000, 1_000))); // the next write carries the pending settle
    const doc = (await store.inner.read<DailyTokenDoc>(dailyTokenDocName(KEY, '2026-11-26')))!.doc;
    expect(doc.total).toBe(18_500);
    expect(Object.keys(doc.holds)).toHaveLength(1); // only the new call's hold; the settled one is gone
    expect((await b.usage(KEY)).tokensToday).toBe(18_500); // and it is not counted twice
  });

  it('a pending settle is not lost when the next reservation is refused', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now });
    const h = holdOf(await b.reserve(KEY, 30_000, pool(20_000, 8_000)));
    store.failRmwOnce = 1;
    await b.settle(h, { inputTokens: 27_000, outputTokens: 1_000 });
    expect(await b.reserve(KEY, 30_000, pool(5_000, 1_000))).toMatchObject({ ok: false, reason: 'daily_limit', used: 28_000 });
    const doc = (await store.inner.read<DailyTokenDoc>(dailyTokenDocName(KEY, '2026-11-26')))!.doc;
    expect(doc.total).toBe(28_000);
    expect(doc.holds).toEqual({});
  });

  it('no part of the key reaches the document name or body (an email-shaped principal and an IP)', async () => {
    const store = new SwitchableStore();
    const b = new DailyTokenBudget(store, { now });
    for (const key of [KEY, IP_KEY]) {
      await b.settle(holdOf(await b.reserve(key, LIMIT, pool(1_000))), { inputTokens: 900, outputTokens: 50 });
    }
    expect(new Set(store.names).size).toBe(2);
    for (const name of store.names) {
      expect(name).toMatch(/^_system\/daily-tokens\/2026-11-26\/[0-9a-f]{64}\.json$/);
      const body = JSON.stringify((await store.inner.read<DailyTokenDoc>(name))!.doc);
      for (const part of ['alice', 'smith', 'contoso', '@', '203.0.113', 'free:']) {
        expect(name).not.toContain(part);
        expect(body).not.toContain(part);
      }
    }
    const logged = warn.mock.calls.map((c) => c.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n');
    expect(logged).not.toMatch(/alice|contoso|203\.0\.113/);
  });

  it('the day rolls over at 00:00 UTC: yesterday\'s document is not today\'s count', async () => {
    const b = new DailyTokenBudget(new InMemoryTokenDocStore(), { now });
    nowMs = Date.UTC(2026, 10, 26, 23, 59, 0);
    const late = holdOf(await b.reserve(KEY, 100_000, pool(80_000, 8_000)));
    nowMs = Date.UTC(2026, 10, 27, 0, 0, 30);
    expect(await b.usage(KEY)).toEqual({ tokensToday: 0, heldTokens: 0 });
    expect((await b.reserve(KEY, 100_000, pool(80_000, 8_000))).ok).toBe(true);
    // The late call's usage goes to the day it was reserved on.
    await b.settle(late, { inputTokens: 70_000, outputTokens: 1_000 });
    expect((await b.usage(KEY)).tokensToday).toBe(0);
  });

  it('a milestone is reported once per day across replicas', async () => {
    const store = new InMemoryTokenDocStore();
    const a = new DailyTokenBudget(store, { now });
    const c = new DailyTokenBudget(store, { now });
    expect(await a.settle(holdOf(await a.reserve(KEY, 100_000, pool(10_000))), { inputTokens: 55_000, outputTokens: 0 })).toBe(50);
    expect(await c.settle(holdOf(await c.reserve(KEY, 100_000, pool(1_000, 1_000))), { inputTokens: 1_000, outputTokens: 0 })).toBeNull();
    expect(await c.settle(holdOf(await c.reserve(KEY, 100_000, pool(1_000, 1_000))), { inputTokens: 40_000, outputTokens: 0 })).toBe(95);
    expect(warn.mock.calls.filter((call) => String(call[1]).startsWith('Daily token usage at 50%'))).toHaveLength(1);
  });

  it('a call that used more than its hold is recorded in full, with a WARN', async () => {
    const b = new DailyTokenBudget(new InMemoryTokenDocStore(), { now });
    const h = holdOf(await b.reserve(KEY, LIMIT, pool(1_000, 1_000)));
    await b.settle(h, { inputTokens: 1_000, outputTokens: 5_000 });
    expect((await b.usage(KEY)).tokensToday).toBe(6_000);
    expect(warned('used more tokens than its hold')).toBe(true);
  });

  it('rejects options that would switch the limits off', () => {
    const store = new InMemoryTokenDocStore();
    expect(() => new DailyTokenBudget(store, { perCallCeilingTokens: 0 })).toThrow(/must all be positive/);
    expect(() => new DailyTokenBudget(store, { minBytesPerToken: 0 })).toThrow(/must all be positive/);
    expect(() => new DailyTokenBudget(store, { holdTtlMs: -1 })).toThrow(/must all be positive/);
  });
});

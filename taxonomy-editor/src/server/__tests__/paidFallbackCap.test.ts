// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/811 (child t/815): the paid Gemini key's retry after a free-tier 429 is capped per UTC day, on the durable
// reserve/settle path, shared by every caller (one document). Over the cap, or with the store down, the paid key is NOT
// called and the caller's original 429 stands. Through the real generateWithPaidFallback and generateWithSearch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGenerateTextByUsage, mockSearchByUsage, mockIs429, mockGetPaidKey, warnSpy } = vi.hoisted(() => ({
  mockGenerateTextByUsage: vi.fn(),
  mockSearchByUsage: vi.fn(),
  mockIs429: vi.fn(),
  mockGetPaidKey: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('../ai/aiBackends.js', () => ({
  generateTextByUsage: mockGenerateTextByUsage,
  generateTextWithSearchByUsage: mockSearchByUsage,
  is429Error: mockIs429,
  generateText: vi.fn(),
}));

vi.mock('../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../config.js')>();
  return { ...actual, getPaidGeminiFallbackKey: mockGetPaidKey };
});

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
  setGlobalRecorder: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: warnSpy, error: vi.fn(), debug: vi.fn() },
    fr: { info: vi.fn(), warn: vi.fn() },
  },
  getRequestContext: vi.fn(() => ({})),
  getRequestId: vi.fn(() => 'req-test'),
  LOG_MAX_LINE_BYTES: 65536,
}));

import { generateWithPaidFallback, generateWithSearch } from '../routes/ai.js';
import { _setDailyTokenBudgetForTest, _resetPaidCapWarnForTest, PAID_FALLBACK_LIMIT_KEY } from '../routes/dailyTokenGate.js';
import { DailyTokenBudget } from '../security/dailyTokenBudget.js';
import { InMemoryJsonDocStore } from '../storage/jsonDocStore.js';
import { getConfig } from '../runtimeConfig.js';

const CTX = { isFree: true, backend: 'gemini' as const, requestModel: 'gemini-3.5-flash-lite', t0: 0 };
const SEARCH_CTX = { ...CTX };
const PROMPT = 'x'.repeat(4_000); // 4,000 bytes; at ratio 1 and cap 1,000 a paid retry holds 5,000 tokens
const err429 = (): Error => Object.assign(new Error('429 pool exhausted'), { status: 429 });

let store: InMemoryJsonDocStore;
const budgetOver = (s: InMemoryJsonDocStore): DailyTokenBudget => new DailyTokenBudget(s as never, { perCallCeilingTokens: 2_000_000 });
const used = async (b: DailyTokenBudget): Promise<{ tokensToday: number; heldTokens: number }> => b.usage(PAID_FALLBACK_LIMIT_KEY);

let saved: { ratio: number; cap: number; paidCap: number };
beforeEach(() => {
  mockGenerateTextByUsage.mockReset(); mockSearchByUsage.mockReset(); mockIs429.mockReset().mockReturnValue(true);
  mockGetPaidKey.mockReset().mockResolvedValue('paid-key'); warnSpy.mockClear();
  _resetPaidCapWarnForTest();
  store = new InMemoryJsonDocStore({ prefix: '_system/daily-tokens' });
  _setDailyTokenBudgetForTest(budgetOver(store));
  const c = getConfig().sessions;
  saved = { ratio: c.dailyTokenBytesPerToken, cap: c.dailyTokenDefaultOutputCapTokens, paidCap: c.paidFallbackDailyTokens };
  c.dailyTokenBytesPerToken = 1; c.dailyTokenDefaultOutputCapTokens = 1_000;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  const c = getConfig().sessions;
  c.dailyTokenBytesPerToken = saved.ratio; c.dailyTokenDefaultOutputCapTokens = saved.cap; c.paidFallbackDailyTokens = saved.paidCap;
});

/** One free-tier call whose free attempt 429s and whose paid retry then resolves or rejects as given. */
async function paidRetry(paid: { resolve?: unknown; reject?: Error }): Promise<{ out?: unknown; threw?: Error }> {
  mockGenerateTextByUsage.mockRejectedValueOnce(err429());
  if (paid.reject) mockGenerateTextByUsage.mockRejectedValueOnce(paid.reject); else mockGenerateTextByUsage.mockResolvedValueOnce(paid.resolve);
  const p = generateWithPaidFallback(PROMPT, {}, ['free1'], CTX).then((out) => ({ out }), (threw: Error) => ({ threw }));
  await vi.advanceTimersByTimeAsync(3000);
  return p;
}

describe('paid-fallback daily token cap (t/811)', () => {
  it('no cap configured (0): the paid retry proceeds exactly as today, with one WARN that it is uncapped', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 0;
    const r = await paidRetry({ resolve: { text: 'paid-ok', tokenUsage: { inputTokens: 3_000, outputTokens: 400 } } });
    expect(r.out).toMatchObject({ text: 'paid-ok' });
    expect(mockGenerateTextByUsage).toHaveBeenCalledTimes(2);
    await paidRetry({ resolve: { text: 'again' } });
    expect(warnSpy.mock.calls.filter((c) => JSON.stringify(c).includes('NO daily cap')).length).toBe(1); // once per process
  });

  it('over the cap the paid key is NOT called and the original 429 stands; under it the real usage is settled', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 12_000; // a retry holds 5,000
    const b = budgetOver(store); _setDailyTokenBudgetForTest(b);
    const first = await paidRetry({ resolve: { text: 'ok1', tokenUsage: { inputTokens: 3_000, outputTokens: 400 } } });
    expect(first.out).toMatchObject({ text: 'ok1' });
    expect(await used(b)).toEqual({ tokensToday: 3_400, heldTokens: 0 }); // the real usage, not the 5,000 hold
    const second = await paidRetry({ resolve: { text: 'ok2', tokenUsage: { inputTokens: 7_000, outputTokens: 1_000 } } });
    expect(second.out).toMatchObject({ text: 'ok2' });
    expect(await used(b)).toEqual({ tokensToday: 11_400, heldTokens: 0 });
    mockGenerateTextByUsage.mockClear();
    mockGenerateTextByUsage.mockRejectedValueOnce(err429()); // the free attempt only: 11,400 + 5,000 > 12,000
    const third = await generateWithPaidFallback(PROMPT, {}, ['free1'], CTX).then((out) => ({ out }), (threw: Error) => ({ threw }));
    await vi.advanceTimersByTimeAsync(3000);
    expect((third as { threw?: Error }).threw?.message).toBe('429 pool exhausted'); // the ORIGINAL error
    expect(mockGenerateTextByUsage).toHaveBeenCalledTimes(1); // the paid key was never called
    expect(warnSpy.mock.calls.some((c) => JSON.stringify(c).includes('Paid-key fallback refused'))).toBe(true);
  });

  it('a paid call that throws releases its hold and counts nothing', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 12_000;
    const b = budgetOver(store); _setDailyTokenBudgetForTest(b);
    const r = await paidRetry({ reject: new Error('paid upstream exploded') });
    expect(r.threw?.message).toBe('429 pool exhausted');
    expect(await used(b)).toEqual({ tokensToday: 0, heldTokens: 0 });
  });

  it('a cold start keeps the day\'s paid count: a new budget over the same store still refuses', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 8_000;
    await paidRetry({ resolve: { text: 'ok', tokenUsage: { inputTokens: 5_000, outputTokens: 1_000 } } });
    _setDailyTokenBudgetForTest(budgetOver(store)); // "restart"
    expect((await used(budgetOver(store))).tokensToday).toBe(6_000);
    mockGenerateTextByUsage.mockClear();
    mockGenerateTextByUsage.mockRejectedValueOnce(err429());
    const p = generateWithPaidFallback(PROMPT, {}, ['free1'], CTX).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(((await p) as Error).message).toBe('429 pool exhausted'); // 6,000 + 5,000 > 8,000
    expect(mockGenerateTextByUsage).toHaveBeenCalledTimes(1);
  });

  it('the store being down refuses the paid retry (fail closed) and the original 429 stands', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 12_000;
    store.forceFailures('download', 50);
    mockGenerateTextByUsage.mockRejectedValueOnce(err429());
    const p = generateWithPaidFallback(PROMPT, {}, ['free1'], CTX).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(((await p) as Error).message).toBe('429 pool exhausted');
    expect(mockGenerateTextByUsage).toHaveBeenCalledTimes(1);
  });

  it('the search path is capped by the same document: usage there counts toward the same day', async () => {
    getConfig().sessions.paidFallbackDailyTokens = 8_000;
    const b = budgetOver(store); _setDailyTokenBudgetForTest(b);
    mockSearchByUsage.mockRejectedValueOnce(err429()).mockResolvedValueOnce({ text: 'search-ok', tokenUsage: { inputTokens: 5_000, outputTokens: 500 } });
    const p = generateWithSearch(PROMPT, undefined, ['free1'], SEARCH_CTX);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toMatchObject({ text: 'search-ok' });
    expect((await used(b)).tokensToday).toBe(5_500);
    // a generate-path retry now shares that day's count: 5,500 + 5,000 > 8,000, refused
    mockGenerateTextByUsage.mockRejectedValueOnce(err429());
    const q = generateWithPaidFallback(PROMPT, {}, ['free1'], CTX).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(3000);
    expect(((await q) as Error).message).toBe('429 pool exhausted');
    expect(mockGenerateTextByUsage).toHaveBeenCalledTimes(1);
  });
});

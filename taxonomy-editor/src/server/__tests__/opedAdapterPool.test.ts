// @vitest-environment node
// t/616 (t/501; TL p/16#376; Security p/93#69, #71, #73): the web op-ed adapter on the free key pool.
// Real pricing throughout (the real model registry and estimateCost); only the provider call, the budget store and
// the ledger write are faked. Covers: pool keys passed explicitly with noFallback; the per-call draw-down and
// reconcile; a pool refusal stops every later call with no provider call; the missing-usage estimate books the
// shared controls but never a person's own bucket; the $5 check for signed-in pool runs; the anonymous ledger moves
// by the real price (on main it booked $0: the server usage shape went straight into estimateCost).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  generateText: vi.fn(),
  enforced: true,
  ledger: [] as number[],
  store: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../ai/aiBackends.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/aiBackends.js')>()),
  generateText: h.generateText,
}));
vi.mock('../featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../featureFlags.js')>()),
  isFreePoolBudgetEnforced: () => h.enforced,
}));
vi.mock('../storage/freePoolBudget.js', () => ({ getFreePoolBudget: () => h.store }));
vi.mock('../storage/anonOpEdSpend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/anonOpEdSpend.js')>()),
  recordAnonOpEdSpend: vi.fn(async (usd: number) => { h.ledger.push(usd); }),
}));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l() } };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import { createWebOpEdAdapter, OPED_CHARGE_USER_BUCKET_WITHOUT_USAGE, type WebOpEdAdapterOptions } from '../ai/opedAdapter.js';
import { FREE_POOL_CALL_TOKEN_ESTIMATE } from '../ai/freePoolBudgetGate.js';
import { getModelRegistry } from '../ai/aiBackends.js';

const MODEL = 'gemini-3.5-flash-lite';
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-1', stableId: undefined, isAnonymous: true, anonymousSessionId: '1' };
const ALICE = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'alice', isAnonymous: false };
const POOL_KEY = 'SENTINEL-POOL-KEY';

function fakeStore(over: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  let drawn = { calls: 0, tokens: 0 };
  return {
    reserveForKey: vi.fn(async () => ({ ok: true, reservationId: 'adm-1', existing: false })),
    drawDown: vi.fn(async (_id: string, d: { calls: number; tokens: number }) => {
      drawn = { calls: drawn.calls + d.calls, tokens: drawn.tokens + d.tokens };
      return { drawnCalls: drawn.calls, drawnTokens: drawn.tokens, estimateCalls: 22, estimateTokens: 1_000_000 };
    }),
    reserve: vi.fn(async () => ({ ok: true, reservationId: 'call-1' })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    ...over,
  };
}

const poolOpts = (extra: Partial<WebOpEdAdapterOptions> = {}): WebOpEdAdapterOptions => ({
  pool: { keys: POOL_KEY, reservationId: 'adm-1', budgetKey: 'oped:ip:1.2.3.4:run-1' }, ...extra,
});
const ok = (inputTokens: number, outputTokens: number) => ({ text: 'ok', servedModel: MODEL, tokenUsage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });
const price = () => getModelRegistry().pricing![MODEL];

beforeEach(() => {
  h.generateText.mockReset();
  h.enforced = true;
  h.ledger.length = 0;
  h.store = fakeStore();
});

describe('t/616: op-ed adapter on the free pool', () => {
  it('passes only the pool keys, explicitly, with noFallback, and draws the call down first', async () => {
    h.generateText.mockResolvedValue(ok(1000, 500));
    const a = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await runWithUser(ANON, () => a.generateText('p', MODEL, { maxTokens: 1000 }));
    const [, , , , explicitKey, opts] = h.generateText.mock.calls[0];
    expect(explicitKey).toBe(POOL_KEY);
    expect(opts.noFallback).toBe(true);
    expect(h.store!.drawDown).toHaveBeenCalledWith('adm-1', { calls: 1, tokens: FREE_POOL_CALL_TOKEN_ESTIMATE });
  });

  it('reconciles the draw-down to the real tokens', async () => {
    h.generateText.mockResolvedValue(ok(3000, 1500));
    const a = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await runWithUser(ANON, () => a.generateText('p', MODEL, { maxTokens: 2000 }));
    expect(h.store!.drawDown).toHaveBeenLastCalledWith('adm-1', { calls: 0, tokens: 4500 - FREE_POOL_CALL_TOKEN_ESTIMATE });
  });

  it('a pool refusal mid-run stops EVERY later call before its provider call (the remaining voices stop)', async () => {
    h.generateText.mockResolvedValue(ok(100, 100));
    // Past the 2x overdraft: the fallback per-call reserve refuses with daily_cap.
    h.store = fakeStore({
      drawDown: vi.fn(async () => ({ drawnCalls: 999, drawnTokens: 0, estimateCalls: 22, estimateTokens: 1_000_000 })),
      reserve: vi.fn(async () => ({ ok: false, reason: 'daily_cap', resetsAt: '2026-11-26T00:00:00Z' })),
    });
    const a = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await expect(runWithUser(ANON, () => a.generateText('p', MODEL, { maxTokens: 100 }))).rejects.toMatchObject({ code: 'FREE_POOL_EXHAUSTED' });
    await expect(runWithUser(ANON, () => a.generateText('next voice', MODEL, { maxTokens: 100 }))).rejects.toMatchObject({ code: 'FREE_POOL_EXHAUSTED' });
    expect(h.generateText).not.toHaveBeenCalled();
    expect(h.store!.drawDown).toHaveBeenCalledTimes(1); // the second call never reached the store either
  });

  it('a store outage at draw-down falls back to a per-call reserve, and its refusal also stops the run', async () => {
    h.store = fakeStore({
      drawDown: vi.fn(async () => { throw new Error('blob down'); }),
      reserve: vi.fn(async () => { throw new Error('blob down'); }),
    });
    const a = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await expect(runWithUser(ANON, () => a.generateText('p', MODEL, { maxTokens: 100 }))).rejects.toMatchObject({ code: 'FREE_POOL_UNAVAILABLE' });
    expect(h.generateText).not.toHaveBeenCalled();
  });

  it('the anonymous ledger moves by the REAL price of the reported usage (main booked $0)', async () => {
    h.generateText.mockResolvedValue(ok(1000, 500));
    const a = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await runWithUser(ANON, () => a.generateText('p', MODEL, { maxTokens: 1000 }));
    const p = price();
    const expected = (1000 * p.inputPer1M + 500 * p.outputPer1M) / 1_000_000;
    expect(expected).toBeGreaterThan(0);
    expect(h.ledger).toHaveLength(1);
    expect(h.ledger[0]).toBeCloseTo(expected, 10);
  });

  it('no reported usage: the ledger and the pool get the estimate (chars/4 + maxTokens); the user bucket does not', async () => {
    expect(OPED_CHARGE_USER_BUCKET_WITHOUT_USAGE).toBe(false);
    h.generateText.mockResolvedValue({ text: 'ok', servedModel: MODEL, tokenUsage: undefined });
    const prompt = 'x'.repeat(4000); // 1000 estimated input tokens
    const anon = runWithUser(ANON, () => createWebOpEdAdapter(poolOpts()));
    await runWithUser(ANON, () => anon.generateText(prompt, MODEL, { maxTokens: 3000 }));
    const p = price();
    expect(h.ledger[0]).toBeCloseTo((1000 * p.inputPer1M + 3000 * p.outputPer1M) / 1_000_000, 10);
    expect(h.store!.drawDown).toHaveBeenLastCalledWith('adm-1', { calls: 0, tokens: 4000 - FREE_POOL_CALL_TOKEN_ESTIMATE });

    const bookUserTokens = vi.fn();
    h.ledger.length = 0;
    const signedIn = runWithUser(ALICE, () => createWebOpEdAdapter(poolOpts({ bookUserTokens })));
    await runWithUser(ALICE, () => signedIn.generateText(prompt, MODEL, { maxTokens: 800 }));
    expect(bookUserTokens).not.toHaveBeenCalled();
    expect(h.ledger).toEqual([]); // signed-in runs never book the anonymous ledger
  });

  it('signed-in pool run: reported usage goes to the user bucket, never the anonymous ledger', async () => {
    h.generateText.mockResolvedValue(ok(1000, 500));
    const bookUserTokens = vi.fn();
    const a = runWithUser(ALICE, () => createWebOpEdAdapter(poolOpts({ bookUserTokens })));
    await runWithUser(ALICE, () => a.generateText('p', MODEL, { maxTokens: 1000 }));
    expect(bookUserTokens).toHaveBeenCalledWith(1000, 500);
    expect(h.ledger).toEqual([]);
  });

  it('the $5 check refuses at the right call, for a signed-in pool run too (real prices)', async () => {
    // Each call's worst case and its reported usage are both about $2, so calls 1 and 2 run ($4 spent) and call 3
    // (worst case $2, total $6) is refused before the provider.
    const p = price();
    const maxTokens = Math.floor((2 / p.outputPer1M) * 1_000_000);
    h.generateText.mockResolvedValue(ok(1, maxTokens));
    for (const ctx of [ANON, ALICE]) {
      h.generateText.mockClear();
      const a = runWithUser(ctx, () => createWebOpEdAdapter(poolOpts({ bookUserTokens: vi.fn() })));
      await runWithUser(ctx, () => a.generateText('p', MODEL, { maxTokens }));
      await runWithUser(ctx, () => a.generateText('p', MODEL, { maxTokens }));
      await expect(runWithUser(ctx, () => a.generateText('p', MODEL, { maxTokens }))).rejects.toMatchObject({ code: 'ANON_RUN_COST_CEILING' });
      expect(h.generateText).toHaveBeenCalledTimes(2);
    }
  });

  it('a run on the caller\'s own keys is unchanged: no pool key, no draw-down, no cap, no ledger', async () => {
    h.generateText.mockResolvedValue(ok(1000, 500));
    const a = runWithUser(ALICE, () => createWebOpEdAdapter());
    await runWithUser(ALICE, () => a.generateText('p', MODEL, {}));
    const [, , , , explicitKey, opts] = h.generateText.mock.calls[0];
    expect(explicitKey).toBeUndefined();
    expect(opts.noFallback).toBe(false);
    expect(h.store!.drawDown).not.toHaveBeenCalled();
    expect(h.ledger).toEqual([]);
  });
});

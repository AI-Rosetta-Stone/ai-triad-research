// @vitest-environment node
//
// t/4485 — the persistent free-pool budget gate. Unit-tests the pure logic (refusal mapping,
// commit/release no-ops, the 80% WARN dedupe) against a mocked FreePoolBudget store — t/4484's
// real blob-backed implementation is on `main` now (#3808), but mocking storage/freePoolBudget.js
// keeps this file's cases explicit (store null vs. wired) instead of depending on nothing having
// called initFreePoolBudget() in-process.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'http';

const { isFreePoolBudgetEnforced, getFreePoolBudget } = vi.hoisted(() => ({
  isFreePoolBudgetEnforced: vi.fn(() => false),
  getFreePoolBudget: vi.fn(() => null as unknown),
}));
vi.mock('../featureFlags.js', () => ({ isFreePoolBudgetEnforced: () => isFreePoolBudgetEnforced() }));
vi.mock('../storage/freePoolBudget.js', () => ({ getFreePoolBudget: () => getFreePoolBudget() }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => ({ log: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));

import {
  reserveFreePoolCall, commitFreePoolCall, releaseFreePoolCall, getFreePoolHeadroomSnapshot,
  maybeWarnHeadroom, _resetHeadroomWarnForTest, FREE_POOL_CALL_TOKEN_ESTIMATE,
} from '../ai/freePoolBudgetGate.js';
import { log } from '../logger.js';

// Top-level reset: each describe block below sets isFreePoolBudgetEnforced/getFreePoolBudget
// as it needs; without this, a later block (e.g. the "store unwired" no-op tests) would
// otherwise inherit whatever an earlier block last configured.
afterEach(() => {
  isFreePoolBudgetEnforced.mockReturnValue(false);
  getFreePoolBudget.mockReturnValue(null);
});

function fakeRes() {
  const res: Record<string, unknown> = {
    _statusCode: 0, _body: undefined as unknown,
    writeHead: vi.fn((code: number) => { res._statusCode = code; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; }),
  };
  return res as unknown as ServerResponse & { _statusCode: number; _body: Record<string, unknown> };
}

describe('reserveFreePoolCall (enforcement OFF — today\'s default)', () => {
  beforeEach(() => { isFreePoolBudgetEnforced.mockReturnValue(false); });

  it('always allows, with a null reservationId, and writes nothing to res', async () => {
    const res = fakeRes();
    const result = await reserveFreePoolCall(res, 'test-key');
    expect(result).toEqual({ ok: true, reservationId: null });
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

describe('reserveFreePoolCall (enforcement ON, store not wired — the resolveStore() stub)', () => {
  beforeEach(() => { isFreePoolBudgetEnforced.mockReturnValue(true); });

  it('fails closed: 503 free_pool_unavailable, never a 500', async () => {
    const res = fakeRes();
    const result = await reserveFreePoolCall(res, 'test-key');
    expect(result).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(503, expect.anything());
    expect(res._body).toMatchObject({ error: 'free_pool_unavailable' });
  });

  it('WARNs on refusal (alertable separately from the 80% headroom line)', async () => {
    await reserveFreePoolCall(fakeRes(), 'test-key');
    expect(log.api.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'storage_unavailable' }),
      expect.any(String),
    );
  });
});

describe('reserveFreePoolCall / commitFreePoolCall / releaseFreePoolCall (enforcement ON, store wired — t/4484 #3808 live)', () => {
  const fakeStore = {
    reserve: vi.fn(),
    renew: vi.fn(),
    commit: vi.fn(),
    release: vi.fn(),
    headroom: vi.fn(),
    reserveForKey: vi.fn(),
    drawDown: vi.fn(),
    openCountForPrefix: vi.fn(),
  };

  beforeEach(() => {
    isFreePoolBudgetEnforced.mockReturnValue(true);
    getFreePoolBudget.mockReturnValue(fakeStore);
    Object.values(fakeStore).forEach(fn => fn.mockReset());
  });

  it('delegates reserve() to the real store, with the gate\'s call/token estimate', async () => {
    fakeStore.reserve.mockResolvedValue({ ok: true, reservationId: 'real-res-1' });
    const result = await reserveFreePoolCall(fakeRes(), 'debate-1');
    expect(fakeStore.reserve).toHaveBeenCalledWith({ calls: 1, tokens: FREE_POOL_CALL_TOKEN_ESTIMATE, key: 'debate-1' });
    expect(result).toEqual({ ok: true, reservationId: 'real-res-1' });
  });

  it('maps a real daily_cap refusal to 429 free_pool_exhausted', async () => {
    fakeStore.reserve.mockResolvedValue({ ok: false, reason: 'daily_cap', resetsAt: '2026-10-26T00:00:00Z' });
    const res = fakeRes();
    const result = await reserveFreePoolCall(res, 'debate-1');
    expect(result).toEqual({ ok: false });
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
    expect(res._body).toMatchObject({ error: 'free_pool_exhausted', resetsAt: '2026-10-26T00:00:00Z' });
  });

  it('delegates commit() to the real store', async () => {
    await commitFreePoolCall('real-res-1', { calls: 1, tokens: 55 });
    expect(fakeStore.commit).toHaveBeenCalledWith('real-res-1', { calls: 1, tokens: 55 });
  });

  it('delegates release() to the real store', async () => {
    await releaseFreePoolCall('real-res-1');
    expect(fakeStore.release).toHaveBeenCalledWith('real-res-1');
  });

  it('getFreePoolHeadroomSnapshot reads through to the real store\'s headroom()', async () => {
    fakeStore.headroom.mockResolvedValue({ callsUsed: 10, callsCap: 1500, tokensUsed: 0, tokensCap: null, day: '2026-10-25' });
    const snapshot = await getFreePoolHeadroomSnapshot();
    expect(snapshot).toEqual({ callsUsed: 10, callsCap: 1500, tokensUsed: 0, tokensCap: null, day: '2026-10-25' });
  });
});

describe('commitFreePoolCall / releaseFreePoolCall — no-ops, never throw', () => {
  it('commit is a no-op for a null reservationId', async () => {
    await expect(commitFreePoolCall(null, { calls: 1, tokens: 100 })).resolves.toBeUndefined();
  });
  it('release is a no-op for a null reservationId', async () => {
    await expect(releaseFreePoolCall(null)).resolves.toBeUndefined();
  });
  it('commit with a non-null id is also a no-op while the store is unwired (no throw)', async () => {
    await expect(commitFreePoolCall('some-id', { calls: 1, tokens: 100 })).resolves.toBeUndefined();
  });
  it('release with a non-null id is also a no-op while the store is unwired (no throw)', async () => {
    await expect(releaseFreePoolCall('some-id')).resolves.toBeUndefined();
  });
});

describe('getFreePoolHeadroomSnapshot', () => {
  it('returns "not-enforced" when the flag is off', async () => {
    isFreePoolBudgetEnforced.mockReturnValue(false);
    expect(await getFreePoolHeadroomSnapshot()).toBe('not-enforced');
  });
  it('returns "unknown" (never zero) when enforcement is on but the store is unwired', async () => {
    isFreePoolBudgetEnforced.mockReturnValue(true);
    expect(await getFreePoolHeadroomSnapshot()).toBe('unknown');
  });
});

describe('FREE_POOL_CALL_TOKEN_ESTIMATE', () => {
  it('is a positive, sane conservative estimate', () => {
    expect(FREE_POOL_CALL_TOKEN_ESTIMATE).toBeGreaterThan(0);
  });
});

describe('maybeWarnHeadroom (AC5 — the 80% WARN, once per UTC day)', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetHeadroomWarnForTest(); });

  function headroom(overrides: Partial<{ callsUsed: number; callsCap: number; tokensUsed: number; tokensCap: number | null; day: string }> = {}) {
    return { callsUsed: 0, callsCap: 1500, tokensUsed: 0, tokensCap: null, day: '2026-10-25', ...overrides };
  }

  it('does not WARN below 80% calls usage', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 1199, callsCap: 1500 })); // 79.9%
    expect(log.api.warn).not.toHaveBeenCalled();
  });

  it('WARNs with the stable "FREE-POOL-HEADROOM pct=80" marker at exactly 80% calls usage', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 1200, callsCap: 1500 })); // 80.0%
    expect(log.api.warn).toHaveBeenCalledWith(expect.anything(), 'FREE-POOL-HEADROOM pct=80');
  });

  it('WARNs once, not again on a second crossing the same day', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 1200, callsCap: 1500 }));
    maybeWarnHeadroom(headroom({ callsUsed: 1400, callsCap: 1500 }));
    expect(log.api.warn).toHaveBeenCalledTimes(1);
  });

  it('WARNs again on a new UTC day', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 1200, callsCap: 1500, day: '2026-10-25' }));
    maybeWarnHeadroom(headroom({ callsUsed: 1200, callsCap: 1500, day: '2026-10-26' }));
    expect(log.api.warn).toHaveBeenCalledTimes(2);
  });

  it('also triggers from token usage crossing 80%, independent of calls', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 10, callsCap: 1500, tokensUsed: 850_000, tokensCap: 1_000_000 }));
    expect(log.api.warn).toHaveBeenCalledWith(expect.anything(), 'FREE-POOL-HEADROOM pct=80');
  });

  it('a null tokensCap never contributes (no divide-by-null crash, no false trigger)', () => {
    maybeWarnHeadroom(headroom({ callsUsed: 10, callsCap: 1500, tokensUsed: 999_999_999, tokensCap: null }));
    expect(log.api.warn).not.toHaveBeenCalled();
  });
});

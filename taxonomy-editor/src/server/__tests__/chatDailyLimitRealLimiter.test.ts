// @vitest-environment node
//
// t/494 (Second Opinion p/252#15): the per-user daily token limit for chat, on the REAL rate limiter.
// chatUsageBooking.test.ts mocks rateLimiter, so it cannot show that a recorded turn actually refuses
// the next one. This file does not mock it: a turn booked through settleProviderTurn fills the real
// bucket, and the next chat turn is refused 429 by enforceChatAccess.

import { describe, it, expect, vi } from 'vitest';
import type http from 'http';

vi.mock('../ai/freePoolBudgetGate.js', () => ({
  commitFreePoolCall: vi.fn(async () => undefined),
  reconcileDebateDrawDown: vi.fn(async () => undefined),
  releaseFreePoolCall: vi.fn(async () => undefined),
  FREE_POOL_CALL_TOKEN_ESTIMATE: 2000,
  resolveStore: () => null,
}));
vi.mock('../ai/proxyTiers.js', () => ({ isBackendAllowed: () => true, resolveTier: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: {
    server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { chatTurnTokens, settleProviderTurn, enforceChatAccess } from '../routes/chat.js';
import * as rateLimiter from '../security/rateLimiter.js';

const DAILY = 500_000;
const tier = { level: 'free', allowedBackends: ['gemini'], limits: { requestsPerMinute: 1000, tokensPerDay: DAILY } } as never;

function fakeRes() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

describe('t/494: chat daily token limit on the real rate limiter', () => {
  it('a turn booked through settleProviderTurn fills the bucket, and the next chat turn is refused 429', async () => {
    const user = 'real-limiter-user-1';
    expect(rateLimiter.checkTokenLimit(user, DAILY).allowed).toBe(true);
    const effective = rateLimiter.checkTokenLimit(user, DAILY).limit;

    // One turn whose real usage is the whole effective daily allowance.
    const budget = { commit: vi.fn(async () => undefined) };
    await settleProviderTurn(budget, { limitKey: user, dailyTokenLimit: DAILY, promptChars: 0 },
      { promptTokens: effective - 1, completionTokens: 1 });
    expect(budget.commit).toHaveBeenCalledTimes(1);
    expect(rateLimiter.checkTokenLimit(user, DAILY).allowed).toBe(false);

    const res = fakeRes();
    const refused = enforceChatAccess(res as unknown as http.ServerResponse, tier, 'gemini', true, user);
    expect(refused).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Daily token limit exceeded'));
  });

  it('records the per-user usage before the free-pool commit, so a failing commit still moves the bucket', async () => {
    const user = 'real-limiter-user-2';
    const before = rateLimiter.checkTokenLimit(user, DAILY).current;
    const budget = { commit: vi.fn(async () => { throw new Error('store down'); }) };
    await expect(settleProviderTurn(budget, { limitKey: user, dailyTokenLimit: DAILY, promptChars: 0 },
      { promptTokens: 1000, completionTokens: 10 })).rejects.toThrow('store down');
    expect(rateLimiter.checkTokenLimit(user, DAILY).current).toBe(before + 1010);
  });

  it('thinking tokens outside candidatesTokenCount are booked: the larger of completion and total minus prompt', () => {
    const turn = chatTurnTokens({ promptTokens: 150_000, completionTokens: 42, totalTokens: 150_900 }, 0);
    expect(turn).toEqual({ inputTokens: 150_000, outputTokens: 900, estimated: false });
    expect(chatTurnTokens({ promptTokens: 150_000, completionTokens: 42, totalTokens: 150_010 }, 0).outputTokens).toBe(42);
  });
});

// @vitest-environment node
//
// t/494 — chat-stream books the turn's real tokens, not the flat 2,000 per call, against both the
// free-pool budget and the per-user daily token bucket. Three tests, as the design on t/494#5:
//   1. a turn with known provider usage moves both books by exactly that usage;
//   2. a reply with no usage takes the WARN path and books an estimate from the prompt size;
//   3. a user at the daily token limit is refused the next chat turn.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type http from 'http';

const h = vi.hoisted(() => ({
  commitFreePoolCall: vi.fn(async () => undefined),
  reconcileDebateDrawDown: vi.fn(async () => undefined),
  releaseFreePoolCall: vi.fn(async () => undefined),
  recordTokenUsage: vi.fn(() => null as number | null),
  checkTokenLimit: vi.fn(() => ({ allowed: true })),
  checkRate: vi.fn(() => ({ allowed: true })),
  checkRequestRate: vi.fn(() => ({ allowed: true })),
  warn: vi.fn(),
}));

vi.mock('../ai/freePoolBudgetGate.js', () => ({
  commitFreePoolCall: h.commitFreePoolCall,
  reconcileDebateDrawDown: h.reconcileDebateDrawDown,
  releaseFreePoolCall: h.releaseFreePoolCall,
  FREE_POOL_CALL_TOKEN_ESTIMATE: 2000,
  resolveStore: () => null,
}));
vi.mock('../security/rateLimiter.js', () => ({
  recordTokenUsage: h.recordTokenUsage,
  checkTokenLimit: h.checkTokenLimit,
  checkRate: h.checkRate,
  checkRequestRate: h.checkRequestRate,
}));
vi.mock('../ai/proxyTiers.js', () => ({ isBackendAllowed: () => true, resolveTier: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: {
    server: { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import {
  chatTurnTokens, trackFreePoolReservation, recordChatTokenUsage, enforceChatAccess,
  promptCharsOf, CHAT_OUTPUT_TOKEN_ALLOWANCE, settleProviderTurn, chargesVisitorDailyBucket,
} from '../routes/chat.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.checkTokenLimit.mockReturnValue({ allowed: true });
  h.checkRate.mockReturnValue({ allowed: true });
  h.checkRequestRate.mockReturnValue({ allowed: true });
});

describe('t/494: chat turn tokens are the real usage', () => {
  it('a turn with known provider usage moves the free-pool books and the per-user bucket by that usage', async () => {
    const turn = chatTurnTokens({ promptTokens: 150_000, completionTokens: 42 }, 569_593);
    expect(turn).toEqual({ inputTokens: 150_000, outputTokens: 42, estimated: false });

    await trackFreePoolReservation('res-1').commit(turn);
    expect(h.commitFreePoolCall).toHaveBeenCalledWith('res-1', { calls: 1, tokens: 150_042 });

    recordChatTokenUsage('user-a', turn, 500_000);
    expect(h.recordTokenUsage).toHaveBeenCalledWith('user-a', 150_000, 42, 500_000);

    // A debate-covered call reconciles its draw-down to the same real total.
    await trackFreePoolReservation(null, 'debate-1').commit(turn);
    expect(h.reconcileDebateDrawDown).toHaveBeenCalledWith('debate-1', 150_042);
  });

  it('a reply with no usage takes the WARN path and books an estimate from the prompt size, never 2000', async () => {
    const chars = 569_593;
    const turn = chatTurnTokens(undefined, chars);
    expect(turn.estimated).toBe(true);
    expect(turn.inputTokens).toBe(Math.ceil(chars / 4));
    expect(turn.outputTokens).toBe(CHAT_OUTPUT_TOKEN_ALLOWANCE);
    expect(turn.inputTokens + turn.outputTokens).not.toBe(2000);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ promptChars: chars }), expect.stringContaining('t/494'));

    await trackFreePoolReservation('res-2').commit(turn);
    expect(h.commitFreePoolCall).toHaveBeenCalledWith('res-2', { calls: 1, tokens: Math.ceil(chars / 4) + CHAT_OUTPUT_TOKEN_ALLOWANCE });
  });

  it('a user at the daily token limit is refused the next chat turn', () => {
    h.checkTokenLimit.mockReturnValue({ allowed: false } as never);
    const tier = { level: 'free', allowedBackends: ['gemini'], limits: { requestsPerMinute: 30, tokensPerDay: 500_000 } } as never;
    const res = { writeHead: vi.fn(), end: vi.fn() };
    const refused = enforceChatAccess(res as unknown as http.ServerResponse, tier, 'gemini', true, 'user-a');
    expect(refused).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(429, expect.anything());
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining('Daily token limit exceeded'));
  });

  it('a failed provider turn (no usage reported) still books the estimate on both books (Security p/93#27)', async () => {
    const commit = vi.fn(async () => undefined);
    await settleProviderTurn({ commit }, { limitKey: 'user-b', dailyTokenLimit: 500_000, promptChars: 40_000 }, undefined);
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 10_000, outputTokens: CHAT_OUTPUT_TOKEN_ALLOWANCE, estimated: true }));
    // TL p/16#260: a turn with no provider usage is booked to the free pool but NOT to the visitor's bucket.
    expect(h.recordTokenUsage).not.toHaveBeenCalled();
  });

  it('a turn with reported usage charges the visitor bucket; no usage does not (TL p/16#260)', () => {
    expect(chargesVisitorDailyBucket({ promptTokens: 1, completionTokens: 1 })).toBe(true);
    expect(chargesVisitorDailyBucket({ promptTokens: 1 })).toBe(false);
    expect(chargesVisitorDailyBucket(undefined)).toBe(false);
  });

  it('promptCharsOf counts the system instruction and every message', () => {
    expect(promptCharsOf([{ role: 'user', content: 'abc' }, { role: 'assistant', content: 'de' }] as never, 'xyz')).toBe(8);
  });
});

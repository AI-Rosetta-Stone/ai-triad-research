// @vitest-environment node
//
// t/746 part 2 (spend control): route-level wiring of the DURABLE daily token allowance into generate and chat-stream,
// through the real handlers and the real DailyTokenBudget over a shared in-memory document store. The budget's own
// arithmetic is tested in dailyTokenBudget.test.ts; this proves the WIRING: reserve before the provider call, a refusal
// makes no provider call, settle on every exit (success with the real usage, failure with zeros), the count survives a
// 'cold start' (a new budget over the same store), and a store outage refuses a pool-funded call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DailyTokenBudget } from '../security/dailyTokenBudget.js';
import { InMemoryJsonDocStore } from '../storage/jsonDocStore.js';
import * as rateLimiter from '../security/rateLimiter.js';
import type { IncomingMessage, ServerResponse } from 'http';

const getFreePoolKeys = vi.fn();
const reserveFreePoolCall = vi.fn();
const commitFreePoolCall = vi.fn();
const releaseFreePoolCall = vi.fn();
const admitOrDrawDownDebateCall = vi.fn();
const reconcileDebateDrawDown = vi.fn();
const generateTextByUsage = vi.fn();
const generateViaGeminiStream = vi.fn();

vi.mock('../ai/freePoolKeyAccess.js', () => ({ getFreePoolKeys: (...a: unknown[]) => getFreePoolKeys(...a) }));
vi.mock('../ai/freePoolBudgetGate.js', () => ({
  reserveFreePoolCall: (...a: unknown[]) => reserveFreePoolCall(...a),
  commitFreePoolCall: (...a: unknown[]) => commitFreePoolCall(...a),
  releaseFreePoolCall: (...a: unknown[]) => releaseFreePoolCall(...a),
  admitOrDrawDownDebateCall: (...a: unknown[]) => admitOrDrawDownDebateCall(...a),
  reconcileDebateDrawDown: (...a: unknown[]) => reconcileDebateDrawDown(...a),
  getFreePoolHeadroomSnapshot: vi.fn(async () => 'not-enforced'),
  FREE_POOL_CALL_TOKEN_ESTIMATE: 2000,
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

// t/4485 phase 2 tests send a debateId. generationContext.js's own mock below (a relative path
// resolved from THIS file, not from routes/ai.ts's perspective) doesn't actually intercept the
// real module — a pre-existing quirk invisible until a test exercises the debateId-present
// branch of the REAL enforceAnonDebateGate, which otherwise 403s since anon-debates defaults
// off. Mocking the flag directly sidesteps it without touching the unrelated mock-path issue.
vi.mock('../featureFlags.js', () => ({ isAnonDebatesEnabled: () => true }));

vi.mock('../security/accessControl.js', () => ({
  callerTierIdentity: vi.fn(() => ({ principalName: 'testuser', idp: 'aad' })),
  missingApiKeyError: vi.fn(() => null),
  expiredAuthCookies: vi.fn(() => []),
  clientSafeMessage: (msg: string) => msg,
}));

vi.mock('../security/userContext.js', () => ({
  getCurrentUser: vi.fn(() => ({ principalName: 'testuser', idp: 'aad' })),
  getCurrentUserId: vi.fn(() => 'testuser'),
  getStorageUserId: vi.fn(() => 'testuser'),
  isAuthDisabledMode: () => process.env.AUTH_DISABLED === '1' && process.env.NODE_ENV !== 'production',
}));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fr: { info: vi.fn(), warn: vi.fn() },
  },
  getRequestContext: vi.fn(() => ({})),
  getRequestId: vi.fn(() => 'req-test'),
  LOG_MAX_LINE_BYTES: 65536,
}));

vi.mock('../../../../lib/ai-client/index.js', () => ({
  DEFAULT_MODEL: 'test-model',
  generateViaGeminiStream: (...a: unknown[]) => generateViaGeminiStream(...a),
}));

vi.mock('../config.js', () => ({
  hasApiKey: vi.fn(() => false),
  getPaidGeminiFallbackKey: vi.fn(() => null),
  getApiKeys: vi.fn(() => ({})),
  getDataRoot: () => '/fake/data',
  getStateRoot: () => '/fake/state',
  getProjectRoot: () => '/fake/project',
  STORAGE_MODE: 'local',
}));

const FREE_TIER = {
  level: 'free', allowedBackends: ['gemini'], pinnedModel: 'gemini-2.5-flash',
  limits: { requestsPerMinute: 30, tokensPerDay: 100_000 }, serverProvidedKey: true,
};

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: vi.fn(() => FREE_TIER),
  isBackendAllowed: vi.fn(() => true),
  byokGeminiFallbackApplies: vi.fn(() => false),
  freeTierEnabled: vi.fn(() => true),
  freeTierKeyCount: vi.fn(() => 1),
  LOCAL_EMBED_RPM_PER_IP: 120,
}));

vi.mock('../security/rateLimiter.js', () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  checkRequestRate: vi.fn(() => ({ allowed: true })),
  checkTokenLimit: vi.fn(() => ({ allowed: true })),
  recordTokenUsage: vi.fn(() => null),
  nextDailyResetUtc: vi.fn(() => '2026-01-01'),
}));

vi.mock('../ai/aiBackends.js', () => ({
  resolveBackend: vi.fn(() => 'gemini'),
  generateText: vi.fn(),
  generateTextByUsage: (...a: unknown[]) => generateTextByUsage(...a),
  generateTextWithSearchByUsage: vi.fn(),
  classifyNli: vi.fn(),
  computeQueryEmbedding: vi.fn(),
  computeEmbeddings: vi.fn(),
  updateNodeEmbeddings: vi.fn(),
  getEmbeddingsCacheStatus: vi.fn(() => ({ present: true, nodeCount: 0 })),
  setDebateTemperature: vi.fn(),
  resolveEmbeddingsChunked: vi.fn(),
  isContextTooLongError: () => false,
  is429Error: () => false,
  retryAfterMs: () => 0,
  computeAvailableBackends: vi.fn(),
  getResolvedApiModelId: (m: string) => m,
  EMBEDDING_COMPUTE_CHUNK: 128,
  EMBEDDINGS_REQUEST_TIMEOUT_MS: 45_000,
}));

vi.mock('./generationContext.js', () => ({
  resolveGenerationContext: vi.fn(() => ({
    tier: FREE_TIER, isFree: true, limitKey: 'free:1.2.3.4', effectiveModel: 'gemini-2.5-flash', backend: 'gemini',
  })),
  enforceBackendAllowed: vi.fn(() => false),
  enforceAnonDebateGate: vi.fn(() => false),
}));

vi.mock('../embeddingsLoad.js', () => ({
  evaluateEmbeddingLoadShed: vi.fn(() => ({ shed: false })),
  embeddingLoadSnapshot: vi.fn(() => ({})),
  beginEmbeddingCompute: vi.fn(),
  endEmbeddingCompute: vi.fn(),
  isEmbeddingModelWarm: vi.fn(() => false),
  markEmbeddingModelWarm: vi.fn(),
}));

vi.mock('../storage/fileIO.js', () => ({
  loadDictionary: vi.fn(),
  loadAIModels: vi.fn(() => ({ backends: [], models: [] })),
  getTaxonomyDir: () => '/fake/taxonomy',
  resolveDataPath: () => '/fake/taxonomy',
  buildNodeSourceIndex: vi.fn(),
  isSafeId: vi.fn(() => true),
}));

vi.mock('../storage/allowlistStore.js', () => ({ isAllowlisted: vi.fn(() => false) }));

import { registerAiRoutes } from '../routes/ai.js';
import { registerChatRoutes } from '../routes/chat.js';
import { _setDailyTokenBudgetForTest } from '../routes/dailyTokenGate.js';
import { getConfig, getDefaults, validateAndMerge } from '../runtimeConfig.js';
import { getDailyTokenBudget, dailyTokenBudgetHealth, reserveDailyTokens } from '../routes/dailyTokenGate.js';
import { log } from '../logger.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeReq(): IncomingMessage {
  return { headers: {}, socket: { remoteAddress: '203.0.113.9' }, on: vi.fn() } as unknown as IncomingMessage;
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined as unknown,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
    write: vi.fn(() => true),
    on: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}

function registerAll() {
  const { router, handlers } = makeRouter();
  registerAiRoutes(router as never, {} as never);
  registerChatRoutes(router as never, {} as never);
  return handlers;
}


const LIMIT_KEY = 'free:user:testuser'; // what the real resolveGenerationContext derives for the mocked principal 'testuser'
let store: InMemoryJsonDocStore;
let savedSessions: { ceiling: number; cap: number; ratio: number };
function budgetOver(s: InMemoryJsonDocStore, opts: { perCallCeilingTokens?: number } = {}): DailyTokenBudget {
  // Production builds the budget with the config maximum as its own ceiling (the gate checks the live one first); do the same here.
  return new DailyTokenBudget(s as never, { perCallCeilingTokens: 2_000_000, ...opts });
}
function useBudget(b: DailyTokenBudget): void { _setDailyTokenBudgetForTest(b); }
/** The tokens counted for the limit key today, read the way /api/proxy/usage reads them. */
const countedToday = async (b: DailyTokenBudget): Promise<number> => (await b.usage(LIMIT_KEY)).tokensToday;

describe('durable daily token allowance wiring on generate and chat-stream (t/746)', () => {
  beforeEach(() => {
    getFreePoolKeys.mockReset().mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    reserveFreePoolCall.mockReset().mockResolvedValue({ ok: true, reservationId: null });
    commitFreePoolCall.mockReset().mockResolvedValue(undefined);
    releaseFreePoolCall.mockReset().mockResolvedValue(undefined);
    admitOrDrawDownDebateCall.mockReset();
    reconcileDebateDrawDown.mockReset().mockResolvedValue(undefined);
    generateTextByUsage.mockReset().mockResolvedValue({ text: 'ok', tokenUsage: { inputTokens: 10, outputTokens: 20 } });
    generateViaGeminiStream.mockReset().mockResolvedValue(undefined);
    store = new InMemoryJsonDocStore({ prefix: '_system/daily-tokens' });
    useBudget(budgetOver(store));
    const c = getConfig().sessions;
    savedSessions = { ceiling: c.dailyTokenPerCallCeilingTokens, cap: c.dailyTokenDefaultOutputCapTokens, ratio: c.dailyTokenBytesPerToken };
    c.dailyTokenBytesPerToken = 1; // the arithmetic in most tests below is bytes = tokens; the ratio tests set their own
  });

  afterEach(() => {
    const c = getConfig().sessions;
    c.dailyTokenPerCallCeilingTokens = savedSessions.ceiling; c.dailyTokenDefaultOutputCapTokens = savedSessions.cap; c.dailyTokenBytesPerToken = savedSessions.ratio;
  });

  it('generate: a reservation over the daily limit is a 429 with no provider call and no other caller\'s numbers', async () => {
    // FREE_TIER allows 100,000 tokens a day; a 65,536 output cap plus a 40,000-byte prompt reserves 105,536.
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'x'.repeat(40_000) });
    expect(res._statusCode).toBe(429);
    expect(res._body).toMatchObject({ error: 'Daily token limit exceeded', limitType: 'tokens_per_day', rate_limit_source: 'daily_token', limit: 100_000 });
    expect(JSON.stringify(res._body)).not.toContain('testuser'); // the limit key is never returned
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('generate: a request whose worst case is over the per-call ceiling is a 413 per_call_ceiling, no provider call', async () => {
    getConfig().sessions.dailyTokenPerCallCeilingTokens = 70_000;
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'x'.repeat(10_000) }); // 10,000 + 65,536 > 70,000
    expect(res._statusCode).toBe(413);
    expect(res._body).toMatchObject({ code: 'per_call_ceiling', limitType: 'per_call_ceiling', ceiling: 70_000 });
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('generate: success settles the provider\'s real usage; the hold is gone', async () => {
    const b = budgetOver(store); useBudget(b);
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).not.toBe(429);
    const u = await b.usage(LIMIT_KEY);
    expect(u.tokensToday).toBe(30); // 10 + 20, the reported usage, not the 65,538 worst case
    expect(u.heldTokens).toBe(0);
  });

  it('generate: the provider throws -> the hold is released and nothing is counted', async () => {
    generateTextByUsage.mockRejectedValue(new Error('upstream exploded'));
    const b = budgetOver(store); useBudget(b);
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(500);
    const u = await b.usage(LIMIT_KEY);
    expect(u.heldTokens).toBe(0);
    expect(u.tokensToday).toBe(0);
  });

  it('a cold start does not reset the count: a new budget over the same store still sees today\'s tokens', async () => {
    const handlers = registerAll();
    await handlers['POST /api/ai/generate'](fakeReq(), fakeRes(), { prompt: 'hi' });
    expect(await countedToday(budgetOver(store))).toBe(30);
    // "restart": a brand-new budget and a brand-new process-wide singleton, same shared store.
    const restarted = budgetOver(store); useBudget(restarted);
    expect(await countedToday(restarted)).toBe(30);
    await handlers['POST /api/ai/generate'](fakeReq(), fakeRes(), { prompt: 'hi' });
    expect(await countedToday(restarted)).toBe(60);
    // And the limit applies to the carried-over count: fill the day, "restart", and the next call is refused.
    await restarted.settle((await restarted.reserve(LIMIT_KEY, 100_000, { promptBytes: 0, outputCapTokens: 0, poolFunded: true }) as { hold: never }).hold, { inputTokens: 99_000, outputTokens: 0 });
    useBudget(budgetOver(store));
    const refused = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), refused, { prompt: 'hi' });
    expect(refused._statusCode).toBe(429);
  });

  it('generate: the store is down for a pool-funded call -> 503 retryable, no provider call', async () => {
    store.forceFailures('download', 50);
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(503);
    expect(res._body).toMatchObject({ retryable: true });
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('chat-stream: a refused reservation is a JSON 429 before any SSE head, and the provider stream never starts', async () => {
    getConfig().sessions.dailyTokenPerCallCeilingTokens = 1_000;
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).toBe(413); // worst case 65,536+ over a 1,000 ceiling
    expect(res._body).toMatchObject({ code: 'per_call_ceiling' });
    expect(generateViaGeminiStream).not.toHaveBeenCalled();
  });

  it('chat-stream: a turn the provider reported usage for is settled; one it reported none for counts zero (TL p/16#260)', async () => {
    const b = budgetOver(store); useBudget(b);
    const handlers = registerAll();
    generateViaGeminiStream.mockResolvedValue({ usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 } });
    await handlers['POST /api/ai/chat-stream'](fakeReq(), fakeRes(), { messages: [{ role: 'user', content: 'hi' }] });
    expect((await b.usage(LIMIT_KEY)).tokensToday).toBe(500);
    expect((await b.usage(LIMIT_KEY)).heldTokens).toBe(0);
    generateViaGeminiStream.mockResolvedValue(undefined);
    await handlers['POST /api/ai/chat-stream'](fakeReq(), fakeRes(), { messages: [{ role: 'user', content: 'hi again' }] });
    expect((await b.usage(LIMIT_KEY)).tokensToday).toBe(500); // unchanged
    expect((await b.usage(LIMIT_KEY)).heldTokens).toBe(0);
  });

  // TL p/16#481: can a Quick Take's own parallel calls starve each other? The overgeneration pipeline runs 3 drafts at
  // once (DEFAULT_N = 3) and claim verifications run in the background, so take 6 calls in flight, each a median-size
  // debate prompt (32,664 bytes, measured). Each hold is prompt bytes + the assumed output cap.
  async function sixInFlight(): Promise<{ statuses: number[]; heldWhileInFlight: number; heldAfter: number }> {
    const resolvers: Array<(v: unknown) => void> = [];
    generateTextByUsage.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve); }));
    const b = budgetOver(store); useBudget(b);
    const handlers = registerAll();
    const results = Array.from({ length: 6 }, () => ({ res: fakeRes(), done: undefined as unknown as Promise<void> }));
    results.forEach((r) => { r.done = Promise.resolve(handlers['POST /api/ai/generate'](fakeReq(), r.res, { prompt: 'x'.repeat(32_664) })) as Promise<void>; });
    for (let i = 0; i < 200 && resolvers.length + results.filter((r) => r.res._statusCode === 429).length < 6; i++) await new Promise((r) => setTimeout(r, 5));
    const heldWhileInFlight = (await b.usage(LIMIT_KEY)).heldTokens;
    resolvers.forEach((resolve) => resolve({ text: 'ok', tokenUsage: { inputTokens: 8_000, outputTokens: 900 } }));
    await Promise.all(results.map((r) => r.done));
    return { statuses: results.map((r) => r.res._statusCode), heldWhileInFlight, heldAfter: (await b.usage(LIMIT_KEY)).heldTokens };
  }

  it('proposed config (output cap 16,384, 500,000 a day): six parallel median-size calls are all admitted and every hold is released', async () => {
    const sessions = getConfig().sessions; const prevCap = sessions.dailyTokenDefaultOutputCapTokens; const prevLimit = FREE_TIER.limits.tokensPerDay;
    sessions.dailyTokenDefaultOutputCapTokens = 16_384; FREE_TIER.limits.tokensPerDay = 500_000;
    try {
      const r = await sixInFlight();
      expect(r.statuses.every((c) => c === 200)).toBe(true);
      expect(r.heldWhileInFlight).toBe(6 * (32_664 + 16_384)); // 294,288 of 500,000
      expect(r.heldAfter).toBe(0);
    } finally { sessions.dailyTokenDefaultOutputCapTokens = prevCap; FREE_TIER.limits.tokensPerDay = prevLimit; }
  });

  it('the code default (output cap 65,536) over-holds: the same six calls on 500,000 a day are NOT all admitted', async () => {
    const prevLimit = FREE_TIER.limits.tokensPerDay;
    FREE_TIER.limits.tokensPerDay = 500_000;
    try {
      const r = await sixInFlight();
      expect(r.statuses.some((c) => c === 429)).toBe(true); // 6 x (32,664 + 65,536) = 589,200 > 500,000
      expect(r.heldAfter).toBe(0); // the refused ones never held anything, the admitted ones settled
    } finally { FREE_TIER.limits.tokensPerDay = prevLimit; }
  });

  it('/health reports the store and the two effective config values, and follows a config change', () => {
    const sessions = getConfig().sessions; const prev = [sessions.dailyTokenPerCallCeilingTokens, sessions.dailyTokenDefaultOutputCapTokens];
    try {
      sessions.dailyTokenPerCallCeilingTokens = 250_000; sessions.dailyTokenDefaultOutputCapTokens = 16_384;
      expect(dailyTokenBudgetHealth()).toMatchObject({ perCallCeilingTokens: 250_000, defaultOutputCapTokens: 16_384 });
    } finally { [sessions.dailyTokenPerCallCeilingTokens, sessions.dailyTokenDefaultOutputCapTokens] = prev as [number, number]; }
  });

  // TL p/16#489 (1): the ceiling, the output cap and the ratio are read on EVERY reserve, so a config reload changes what is
  // enforced with no restart, and /health reports exactly that value.
  it('a runtime-config change takes effect on the next reserve with no restart, and /health reports the enforced value', async () => {
    const c = getConfig().sessions;
    const call = { promptBytes: 100_000, outputCapTokens: 16_384, poolFunded: true }; // holds 116,384 at 1 byte per token
    c.dailyTokenPerCallCeilingTokens = 128_000;
    const first = await reserveDailyTokens(LIMIT_KEY, 1_500_000, call);
    expect(first.ok).toBe(true);
    expect(dailyTokenBudgetHealth().perCallCeilingTokens).toBe(128_000);
    c.dailyTokenPerCallCeilingTokens = 100_000; // "reload": the same process, the same budget object
    const second = await reserveDailyTokens(LIMIT_KEY, 1_500_000, call);
    expect(second).toMatchObject({ ok: false, reason: 'per_call_ceiling', ceiling: 100_000 });
    expect(dailyTokenBudgetHealth().perCallCeilingTokens).toBe(100_000); // what /health says is what was just enforced
    c.dailyTokenPerCallCeilingTokens = 250_000;
    expect((await reserveDailyTokens(LIMIT_KEY, 1_500_000, call)).ok).toBe(true);
    // the ratio and the output cap are live too
    c.dailyTokenBytesPerToken = 4;
    expect(dailyTokenBudgetHealth().bytesPerToken).toBe(4);
    c.dailyTokenPerCallCeilingTokens = 40_000; // 100,000 / 4 + 16,384 = 41,384 > 40,000
    expect(await reserveDailyTokens(LIMIT_KEY, 1_500_000, call)).toMatchObject({ ok: false, reason: 'per_call_ceiling', reserved: 41_384 });
  });

  // TL p/16#489 (2): a real chat prompt is 569,593 to 695,000 characters (140,000 to 175,000 tokens, t/494#1).
  it('chat: a 695,000-character prompt is admitted at ceiling 250,000 with the measured ratio, and would be refused at 1 byte per token', async () => {
    const c = getConfig().sessions;
    c.dailyTokenPerCallCeilingTokens = 250_000; c.dailyTokenDefaultOutputCapTokens = 16_384;
    FREE_TIER.limits.tokensPerDay = 1_500_000;
    const big = { messages: [{ role: 'user', content: 'x'.repeat(695_000) }] };
    c.dailyTokenBytesPerToken = 3.5; // never above the measured 4.0
    const b = budgetOver(store); useBudget(b);
    const handlers = registerAll();
    const ok = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), ok, big);
    expect(ok._statusCode).not.toBe(413);
    expect(generateViaGeminiStream).toHaveBeenCalledTimes(1);
    expect((await b.usage(LIMIT_KEY)).heldTokens).toBe(0); // settled
    c.dailyTokenBytesPerToken = 1; // the module's old rule
    generateViaGeminiStream.mockClear();
    const refused = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), refused, big);
    expect(refused._statusCode).toBe(413);
    expect(refused._body).toMatchObject({ code: 'per_call_ceiling', ceiling: 250_000 });
    expect(generateViaGeminiStream).not.toHaveBeenCalled();
    FREE_TIER.limits.tokensPerDay = 100_000;
  });

  it('proposed ratio 3.5: the same six median-size debate calls hold 154,302, far under the old 294,288', async () => {
    const c = getConfig().sessions; const prevLimit = FREE_TIER.limits.tokensPerDay;
    c.dailyTokenDefaultOutputCapTokens = 16_384; c.dailyTokenBytesPerToken = 3.5; FREE_TIER.limits.tokensPerDay = 500_000;
    try {
      const r = await sixInFlight();
      expect(r.statuses.every((code) => code === 200)).toBe(true);
      expect(r.heldWhileInFlight).toBe(6 * (Math.ceil(32_664 / 3.5) + 16_384));
      expect(r.heldAfter).toBe(0);
    } finally { FREE_TIER.limits.tokensPerDay = prevLimit; }
  });

  it('sessions.dailyTokenBytesPerToken is capped at 4 (the measured value): 4 is accepted, a larger value is clamped to 4 with an error, a smaller one to 1', () => {
    const defaults = getDefaults();
    const ok = validateAndMerge({ sessions: { dailyTokenBytesPerToken: 4 } }, defaults);
    expect(ok.config.sessions.dailyTokenBytesPerToken).toBe(4);
    expect(ok.errors.filter((e) => e.includes('dailyTokenBytesPerToken'))).toEqual([]);
    const over = validateAndMerge({ sessions: { dailyTokenBytesPerToken: 8 } }, defaults);
    expect(over.config.sessions.dailyTokenBytesPerToken).toBe(4);
    expect(over.errors.some((e) => e.includes('dailyTokenBytesPerToken') && e.includes('above max 4'))).toBe(true);
    expect(validateAndMerge({ sessions: { dailyTokenBytesPerToken: 0.5 } }, defaults).config.sessions.dailyTokenBytesPerToken).toBe(1);
  });

  // Security p/93#150: 'hosted' means NOT single-operator local mode (AUTH_DISABLED=1 outside production).
  it.each([
    ['hosted (AUTH_DISABLED unset)', {}, 'error'],
    ['production with AUTH_DISABLED=1 (the flag is ignored there)', { AUTH_DISABLED: '1', NODE_ENV: 'production' }, 'error'],
    ['local mode (AUTH_DISABLED=1, not production)', { AUTH_DISABLED: '1', NODE_ENV: 'test' }, 'warn'],
  ])('the in-memory store on %s logs at %s', (_name, env, level) => {
    const saved = { AUTH_DISABLED: process.env.AUTH_DISABLED, NODE_ENV: process.env.NODE_ENV, AZURE_STORAGE_ACCOUNT_URL: process.env.AZURE_STORAGE_ACCOUNT_URL };
    delete process.env.AUTH_DISABLED; delete process.env.AZURE_STORAGE_ACCOUNT_URL;
    Object.assign(process.env, env);
    const err = vi.mocked(log.server.error); const warn = vi.mocked(log.server.warn);
    err.mockClear(); warn.mockClear();
    try {
      _setDailyTokenBudgetForTest(null);
      getDailyTokenBudget();
      expect(err.mock.calls.some((c) => JSON.stringify(c).includes('IN-MEMORY'))).toBe(level === 'error');
      expect(warn.mock.calls.some((c) => JSON.stringify(c).includes('in memory (local run)'))).toBe(level === 'warn');
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

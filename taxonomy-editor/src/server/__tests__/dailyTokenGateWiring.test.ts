// @vitest-environment node
//
// t/746 part 2 (spend control): route-level wiring of the DURABLE daily token allowance into generate and chat-stream,
// through the real handlers and the real DailyTokenBudget over a shared in-memory document store. The budget's own
// arithmetic is tested in dailyTokenBudget.test.ts; this proves the WIRING: reserve before the provider call, a refusal
// makes no provider call, settle on every exit (success with the real usage, failure with zeros), the count survives a
// 'cold start' (a new budget over the same store), and a store outage refuses a pool-funded call.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
function budgetOver(s: InMemoryJsonDocStore, opts: { perCallCeilingTokens?: number } = {}): DailyTokenBudget {
  return new DailyTokenBudget(s as never, opts);
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
    useBudget(budgetOver(store, { perCallCeilingTokens: 70_000 }));
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
    useBudget(budgetOver(store, { perCallCeilingTokens: 1_000 }));
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
});

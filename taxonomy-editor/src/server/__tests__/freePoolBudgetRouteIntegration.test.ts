// @vitest-environment node
//
// t/4485 — route-level wiring of the free-pool budget gate into generate and chat-stream (the
// two sites resolveExplicitAiKey covers). The gate's own refusal/commit/release logic is
// unit-tested in freePoolBudgetGate.test.ts; this file only proves the WIRING: each route
// reserves before calling the provider, commits on success, releases on any early return or
// thrown error, and never double-settles a reservation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const getFreePoolKeys = vi.fn();
const reserveFreePoolCall = vi.fn();
const commitFreePoolCall = vi.fn();
const releaseFreePoolCall = vi.fn();
const admitOrDrawDownDebateCall = vi.fn();
const generateTextByUsage = vi.fn();
const generateViaGeminiStream = vi.fn();

vi.mock('../ai/freePoolKeyAccess.js', () => ({ getFreePoolKeys: (...a: unknown[]) => getFreePoolKeys(...a) }));
vi.mock('../ai/freePoolBudgetGate.js', () => ({
  reserveFreePoolCall: (...a: unknown[]) => reserveFreePoolCall(...a),
  commitFreePoolCall: (...a: unknown[]) => commitFreePoolCall(...a),
  releaseFreePoolCall: (...a: unknown[]) => releaseFreePoolCall(...a),
  admitOrDrawDownDebateCall: (...a: unknown[]) => admitOrDrawDownDebateCall(...a),
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

describe('free-pool budget gate wiring across generate and chat-stream (t/4485)', () => {
  beforeEach(() => {
    getFreePoolKeys.mockReset().mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    reserveFreePoolCall.mockReset();
    commitFreePoolCall.mockReset().mockResolvedValue(undefined);
    releaseFreePoolCall.mockReset().mockResolvedValue(undefined);
    admitOrDrawDownDebateCall.mockReset();
    generateTextByUsage.mockReset().mockResolvedValue({ text: 'ok', tokenUsage: { inputTokens: 10, outputTokens: 20 } });
    generateViaGeminiStream.mockReset().mockResolvedValue(undefined);
  });

  it('generate: budget refused (daily_cap) → the gate\'s own response stands, provider never called', async () => {
    reserveFreePoolCall.mockImplementation(async (res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(429);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_exhausted', resetsAt: '2026-10-26T00:00:00Z' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(429);
    expect(res._body).toMatchObject({ error: 'free_pool_exhausted' });
    expect(generateTextByUsage).not.toHaveBeenCalled();
    expect(commitFreePoolCall).not.toHaveBeenCalled();
  });

  it('generate: budget allowed → commits actual token usage after a successful call', async () => {
    reserveFreePoolCall.mockResolvedValue({ ok: true, reservationId: 'res-1' });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).not.toBe(429);
    expect(commitFreePoolCall).toHaveBeenCalledWith('res-1', { calls: 1, tokens: 30 }); // 10 + 20
    expect(releaseFreePoolCall).not.toHaveBeenCalled();
  });

  it('generate: reserved, then the provider throws → releases (never commits) the reservation', async () => {
    reserveFreePoolCall.mockResolvedValue({ ok: true, reservationId: 'res-2' });
    generateTextByUsage.mockRejectedValue(new Error('upstream exploded'));
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(500);
    expect(commitFreePoolCall).not.toHaveBeenCalled();
    expect(releaseFreePoolCall).toHaveBeenCalledWith('res-2');
  });

  it('generate: enforcement off (reservationId null throughout) never calls commit or release', async () => {
    reserveFreePoolCall.mockResolvedValue({ ok: true, reservationId: null });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).not.toBe(429);
    expect(commitFreePoolCall).not.toHaveBeenCalled();
    expect(releaseFreePoolCall).not.toHaveBeenCalled();
  });

  it('chat-stream: budget refused (storage_unavailable) → 503, stream never starts', async () => {
    reserveFreePoolCall.mockImplementation(async (res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(503);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_unavailable' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).toBe(503);
    expect(generateViaGeminiStream).not.toHaveBeenCalled();
  });

  it('chat-stream: budget allowed → commits the estimate after the stream completes', async () => {
    reserveFreePoolCall.mockResolvedValue({ ok: true, reservationId: 'res-3' });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(commitFreePoolCall).toHaveBeenCalledWith('res-3', { calls: 1, tokens: 2000 });
    expect(releaseFreePoolCall).not.toHaveBeenCalled();
  });

  // t/4485 phase 2 — a request carrying a debateId routes through admitOrDrawDownDebateCall,
  // not the plain per-call reserveFreePoolCall. The admission logic itself (admit/draw-down/
  // overdraft/debate_limit) is unit-tested in freePoolBudgetGate.test.ts; this only proves the
  // routes dispatch to it correctly and respect its result.

  it('generate with a debateId: refused admission (429 free_pool_exhausted) never reaches the provider', async () => {
    admitOrDrawDownDebateCall.mockImplementation(async (res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(429);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_exhausted', resetsAt: '2026-10-26T00:00:00Z' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi', debateId: 'deb-1' });
    expect(res._statusCode).toBe(429);
    expect(reserveFreePoolCall).not.toHaveBeenCalled();
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('generate with a debateId: a 3rd-open-debate refusal maps to 429 free_pool_debate_limit', async () => {
    admitOrDrawDownDebateCall.mockImplementation(async (res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(429);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_debate_limit' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi', debateId: 'deb-3' });
    expect(res._statusCode).toBe(429);
    expect(res._body).toMatchObject({ error: 'free_pool_debate_limit' });
  });

  it('generate with a debateId: admitted (fallbackReservationId null) never commits/releases — already settled by draw-down', async () => {
    admitOrDrawDownDebateCall.mockResolvedValue({ ok: true, fallbackReservationId: null });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi', debateId: 'deb-1' });
    expect(res._statusCode).not.toBe(429);
    expect(generateTextByUsage).toHaveBeenCalled();
    expect(commitFreePoolCall).not.toHaveBeenCalled();
    expect(releaseFreePoolCall).not.toHaveBeenCalled();
  });

  it('generate with a debateId: past the overdraft cap (fallbackReservationId set) commits/releases it like a normal call', async () => {
    admitOrDrawDownDebateCall.mockResolvedValue({ ok: true, fallbackReservationId: 'fallback-res-1' });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi', debateId: 'deb-1' });
    expect(res._statusCode).not.toBe(429);
    expect(commitFreePoolCall).toHaveBeenCalledWith('fallback-res-1', { calls: 1, tokens: 30 });
  });

  it('chat-stream with a debateId: refused admission is 429, stream never starts', async () => {
    admitOrDrawDownDebateCall.mockImplementation(async (res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(429);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_exhausted', resetsAt: '2026-10-26T00:00:00Z' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }], linkedDebateId: 'deb-1' });
    expect(res._statusCode).toBe(429);
    expect(generateViaGeminiStream).not.toHaveBeenCalled();
  });

  it('chat-stream with a debateId: admitted (fallbackReservationId null) never commits/releases', async () => {
    admitOrDrawDownDebateCall.mockResolvedValue({ ok: true, fallbackReservationId: null });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }], linkedDebateId: 'deb-1' });
    expect(res._statusCode).not.toBe(429);
    expect(commitFreePoolCall).not.toHaveBeenCalled();
    expect(releaseFreePoolCall).not.toHaveBeenCalled();
  });
});

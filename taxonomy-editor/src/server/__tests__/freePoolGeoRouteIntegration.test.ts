// @vitest-environment node
//
// t/4486 (TL review, t/4486#2) — route-level wiring of the free-pool geo gate. Each of the
// three injection sites TL enumerated must call `getFreePoolKeys` and respect its `{ok:false}`
// (403 `free_pool_region`, already written by that accessor) before reaching the provider:
//   1. POST /api/ai/generate   (routes/ai.ts  — resolveExplicitAiKey)
//   2. POST /api/ai/chat-stream (routes/chat.ts — resolveExplicitAiKey, its own mirror copy)
//   3. POST /api/nli/classify  (routes/ai.ts  — bypassed resolveGenerationContext entirely;
//                                 this is the exact gap the TL's review caught)
//
// The underlying geo lookup itself (DE/FR/CH/GB refused, US allowed) is unit-tested against the
// real bundled DB in freePoolGeoGuard.test.ts. This file only proves the WIRING: each route
// calls through the one sole-reader accessor and stops on its refusal, and the keys it hands to
// the provider when allowed are exactly what the accessor returned.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const getFreePoolKeys = vi.fn();
const classifyNli = vi.fn();
const generateTextByUsage = vi.fn();

vi.mock('../ai/freePoolKeyAccess.js', () => ({ getFreePoolKeys: (...a: unknown[]) => getFreePoolKeys(...a) }));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

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
  generateViaGeminiStream: vi.fn(),
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
// t/945: a BYOK tier with no Gemini key, so the fallback branch applies (serverProvidedKey:
// false distinguishes it from FREE_TIER — it must NOT take the free-tier branch).
const BYOK_TIER = {
  level: 'byok', allowedBackends: ['gemini'], pinnedModel: undefined,
  limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 }, serverProvidedKey: false,
};

const h = vi.hoisted(() => ({ tier: null as unknown, byokFallbackApplies: false }));

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: vi.fn(() => h.tier),
  isBackendAllowed: vi.fn(() => true),
  byokGeminiFallbackApplies: vi.fn(() => h.byokFallbackApplies),
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
  classifyNli: (...a: unknown[]) => classifyNli(...a),
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
  EMBEDDING_COMPUTE_CHUNK: 128,
  EMBEDDINGS_REQUEST_TIMEOUT_MS: 45_000,
}));

vi.mock('./generationContext.js', () => ({
  resolveGenerationContext: vi.fn(() => ({
    tier: h.tier, isFree: (h.tier as { level: string } | null)?.level === 'free',
    limitKey: 'free:1.2.3.4', effectiveModel: 'gemini-2.5-flash', backend: 'gemini',
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

vi.mock('../storage/allowlistStore.js', () => ({
  isAllowlisted: vi.fn(() => false),
}));

import { registerAiRoutes } from '../routes/ai.js';
import { registerChatRoutes } from '../routes/chat.js';

// ── Helpers (entitlementGate.test.ts / embeddingsBatchCapAnd503.test.ts pattern) ──────────────

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

describe('free-pool geo gate wiring across generate, chat and NLI (t/4486)', () => {
  beforeEach(() => {
    h.tier = FREE_TIER;
    h.byokFallbackApplies = false;
    getFreePoolKeys.mockReset();
    classifyNli.mockReset().mockResolvedValue({ results: [] });
    generateTextByUsage.mockReset().mockResolvedValue({ text: 'ok', tokenUsage: null });
  });

  it('POST /api/ai/generate: free+DE → 403 free_pool_region, never reaches the provider', async () => {
    getFreePoolKeys.mockImplementation(async (_req: unknown, res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(403);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_region' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(403);
    expect(res._body).toMatchObject({ error: 'free_pool_region' });
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('POST /api/ai/generate: free+US → allowed, provider called with the accessor\'s keys', async () => {
    getFreePoolKeys.mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).not.toBe(403);
    expect(generateTextByUsage).toHaveBeenCalled();
    expect(generateTextByUsage.mock.calls[0][4]).toBe('server-key-1');
  });

  // t/4486#4 (TL review) — the BYOK-Gemini-fallback bypass. A BYOK user with no Gemini key
  // falls back to the free pool too (t/945); that fallback must be geo-gated exactly like
  // free-tier traffic, not read the pool directly. These prove the fallback path also calls
  // getFreePoolKeys and respects its refusal.
  it('POST /api/ai/generate: BYOK fallback+DE → 403 free_pool_region, never reaches the provider', async () => {
    h.tier = BYOK_TIER;
    h.byokFallbackApplies = true;
    getFreePoolKeys.mockImplementation(async (_req: unknown, res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(403);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_region' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).toBe(403);
    expect(res._body).toMatchObject({ error: 'free_pool_region' });
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('POST /api/ai/generate: BYOK fallback+US → allowed, provider called with the fallback key', async () => {
    h.tier = BYOK_TIER;
    h.byokFallbackApplies = true;
    getFreePoolKeys.mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(res._statusCode).not.toBe(403);
    expect(generateTextByUsage).toHaveBeenCalled();
    expect(generateTextByUsage.mock.calls[0][4]).toBe('server-key-1');
  });

  it('POST /api/ai/chat-stream: BYOK fallback+DE → 403 free_pool_region', async () => {
    h.tier = BYOK_TIER;
    h.byokFallbackApplies = true;
    getFreePoolKeys.mockImplementation(async (_req: unknown, res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(403);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_region' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).toBe(403);
    expect(res._body).toMatchObject({ error: 'free_pool_region' });
  });

  it('POST /api/ai/chat-stream: BYOK fallback+US → allowed, getFreePoolKeys called', async () => {
    h.tier = BYOK_TIER;
    h.byokFallbackApplies = true;
    getFreePoolKeys.mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).not.toBe(403);
    expect(getFreePoolKeys).toHaveBeenCalledTimes(1);
  });

  it('POST /api/ai/generate: BYOK with no fallback (byokFallbackApplies=false) never calls getFreePoolKeys', async () => {
    h.tier = BYOK_TIER;
    h.byokFallbackApplies = false;
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/generate'](fakeReq(), res, { prompt: 'hi' });
    expect(getFreePoolKeys).not.toHaveBeenCalled();
  });

  it('POST /api/ai/chat-stream: free+DE → 403 free_pool_region before any provider call', async () => {
    getFreePoolKeys.mockImplementation(async (_req: unknown, res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(403);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_region' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).toBe(403);
    expect(res._body).toMatchObject({ error: 'free_pool_region' });
  });

  it('POST /api/ai/chat-stream: free+US → allowed, getFreePoolKeys called once', async () => {
    getFreePoolKeys.mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/ai/chat-stream'](fakeReq(), res, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res._statusCode).not.toBe(403);
    expect(getFreePoolKeys).toHaveBeenCalledTimes(1);
  });

  it('POST /api/nli/classify: free+DE → 403 free_pool_region (the route TL found bypassing resolveGenerationContext)', async () => {
    getFreePoolKeys.mockImplementation(async (_req: unknown, res: ServerResponse) => {
      (res as unknown as { writeHead: (n: number) => void }).writeHead(403);
      (res as unknown as { end: (s: string) => void }).end(JSON.stringify({ error: 'free_pool_region' }));
      return { ok: false };
    });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/nli/classify'](fakeReq(), res, { pairs: [{ text_a: 'a', text_b: 'b' }] });
    expect(res._statusCode).toBe(403);
    expect(res._body).toMatchObject({ error: 'free_pool_region' });
    expect(classifyNli).not.toHaveBeenCalled();
  });

  it('POST /api/nli/classify: free+US → allowed, classifyNli called with the accessor\'s keys', async () => {
    getFreePoolKeys.mockResolvedValue({ ok: true, keys: ['server-key-1'] });
    const handlers = registerAll();
    const res = fakeRes();
    await handlers['POST /api/nli/classify'](fakeReq(), res, { pairs: [{ text_a: 'a', text_b: 'b' }] });
    expect(res._statusCode).not.toBe(403);
    expect(classifyNli).toHaveBeenCalledWith([{ text_a: 'a', text_b: 'b' }], ['server-key-1']);
  });
});

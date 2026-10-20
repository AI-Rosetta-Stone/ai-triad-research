// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3188 — both-arms unit test for the large-recompute VOLUME WARN in POST /api/embeddings/compute
// (routes/ai.ts). #1720 shipped `LARGE_RECOMPUTE_WARN_ITEMS=64` WITHOUT the both-arms test the GV
// required, so the threshold predicate was untested (silent rot risk). This closes that gap:
//   FIRES:  texts.length >= 64 && cacheHits === 0 → the volume WARN records (recorder + log).
//   SILENT: texts.length < 64 (below threshold), and cacheHits > 0 at any size → no volume WARN.
// The WARN is observability, not a blocking gate, so this is a pure /add-test addition (self-cert).
//
// Harness mirrors embeddingsBatchCapAnd503.test.ts (the established route-handler pattern), except
// the flight-recorder + log mocks use SHARED hoisted spies so the emitted WARN is assertable.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Hoisted shared spies (vi.hoisted → initialized before any vi.mock factory runs, so the
// factories can reference them eagerly, e.g. `record: recordSpy` / `warn: apiWarn`) ──
const { computeEmbeddings, evaluateEmbeddingLoadShed, recordSpy, apiWarn } = vi.hoisted(() => ({
  computeEmbeddings: vi.fn(),
  evaluateEmbeddingLoadShed: vi.fn(),
  recordSpy: vi.fn(),
  apiWarn: vi.fn(),
}));

// ── Module mocks (hoisted before import) ──────────────────────────────────────
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: recordSpy }),
}));

vi.mock('../security/accessControl.js', () => ({
  callerTierIdentity: () => ({ principalName: 'testuser', idp: 'aad' }),
  missingApiKeyError: vi.fn(() => null),
  expiredAuthCookies: vi.fn(() => []),
  clientSafeMessage: (msg: string) => msg,
}));

vi.mock('../security/userContext.js', () => ({
  getCurrentUser: vi.fn(() => ({ principalName: 'testuser', idp: 'aad' })),
  getCurrentUserId: vi.fn(() => 'testuser'),
}));

vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: apiWarn, error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    fr: { info: vi.fn(), warn: vi.fn() },
  },
  getRequestContext: vi.fn(() => ({})),
  getRequestId: vi.fn(() => 'req-test'),
  LOG_MAX_LINE_BYTES: 65536,
}));

vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'test-model' }));

vi.mock('../config.js', () => ({
  hasApiKey: vi.fn(() => false),
  getPaidGeminiFallbackKey: vi.fn(() => null),
  getDataRoot: () => '/fake/data',
  getStateRoot: () => '/fake/state',
  getProjectRoot: () => '/fake/project',
  STORAGE_MODE: 'local',
}));

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: vi.fn(() => ({ level: 'platform', limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 } })),
  LOCAL_EMBED_RPM_PER_IP: 120,
  getTierKey: vi.fn(() => 'platform'),
}));

vi.mock('../security/rateLimiter.js', () => ({
  checkRate: vi.fn(() => ({ allowed: true })),
  checkRequestRate: vi.fn(() => ({ allowed: true })),
  checkTokenBudget: vi.fn(() => ({ allowed: true })),
  resetRateLimiters: vi.fn(),
}));

vi.mock('../ai/aiBackends.js', () => ({
  computeEmbeddings: (...a: unknown[]) => computeEmbeddings(...a),
  getEmbeddingsCacheStatus: () => ({ present: true, nodeCount: 4144 }),
  computeQueryEmbedding: vi.fn(),
  generateText: vi.fn(),
  generateTextByUsage: vi.fn(),
  classifyNli: vi.fn(),
  updateNodeEmbeddings: vi.fn(),
  setDebateTemperature: vi.fn(),
  resolveEmbeddingsChunked: vi.fn(),
  EMBEDDING_COMPUTE_CHUNK: 128, // t/4287: routes/ai.ts scales its endpoint timeout by this
  EMBEDDINGS_REQUEST_TIMEOUT_MS: 45_000,
}));

vi.mock('./generationContext.js', () => ({
  resolveGenerationContext: vi.fn(() => ({ model: 'test-model', backend: 'gemini' })),
  enforceBackendAllowed: vi.fn(() => false),
}));

vi.mock('../embeddingsLoad.js', () => ({
  evaluateEmbeddingLoadShed: (...a: unknown[]) => evaluateEmbeddingLoadShed(...a),
  embeddingLoadSnapshot: vi.fn(() => ({
    in_flight_embedding_computes: 0, heap_limit_mb: 512, heap_used_mb: 100, rss_mb: 200, event_loop_delay_max_ms: 0,
  })),
  beginEmbeddingCompute: vi.fn(),
  endEmbeddingCompute: vi.fn(),
  isEmbeddingModelWarm: vi.fn(() => false),
  markEmbeddingModelWarm: vi.fn(),
  decideLoadShed: vi.fn(),
  inFlightEmbeddingComputes: vi.fn(() => 0),
  embeddingLoadShedMode: vi.fn(() => 'warn'),
  readRecentLoopDelayMaxMs: vi.fn(() => 0),
  resetEmbeddingModelWarm: vi.fn(),
}));

vi.mock('../storage/fileIO.js', () => ({
  loadDictionary: vi.fn(),
  getTaxonomyDir: () => '/fake/taxonomy',
  resolveDataPath: () => '/fake/taxonomy',
  buildNodeSourceIndex: vi.fn(),
  isSafeId: vi.fn(() => true),
}));

import { registerAiRoutes } from '../routes/ai.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _headers: {}, _body: undefined,
    writeHead: vi.fn((code: number, headers?: Record<string, string>) => { res._statusCode = code; if (headers) Object.assign(res._headers as object, headers); res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}

const LARGE_RECOMPUTE_WARN_ITEMS = 64; // mirrors routes/ai.ts (the threshold under test)
const VOLUME_WARN_RE = /large no-cache recompute/;

/** Volume-WARN records emitted to the flight recorder (filtered by the distinctive message). */
const volumeWarnRecords = () =>
  recordSpy.mock.calls
    .map(c => c[0] as { level?: string; message?: string; component?: string })
    .filter(r => r?.level === 'warn' && VOLUME_WARN_RE.test(r.message ?? ''));

/** Volume-WARN lines emitted to the api logger. */
const volumeWarnLogs = () =>
  apiWarn.mock.calls.filter(c => VOLUME_WARN_RE.test(String(c[c.length - 1] ?? '')));

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('POST /api/embeddings/compute — large-recompute volume WARN (t/3188, #1720 GV both-arms)', () => {
  let computeHandler: Handler;

  beforeEach(() => {
    recordSpy.mockReset();
    apiWarn.mockReset();
    evaluateEmbeddingLoadShed.mockReturnValue({ shed: false });
    const { router, handlers } = makeRouter();
    registerAiRoutes(router as never, {} as Parameters<typeof registerAiRoutes>[1]);
    computeHandler = handlers['POST /api/embeddings/compute'];
  });

  const runCompute = async (texts: string[], cacheHits: number) => {
    computeEmbeddings.mockResolvedValueOnce({
      vectors: texts.map(() => [0.1]), cacheHits, cacheMisses: texts.length - cacheHits,
    });
    const res = fakeRes();
    await computeHandler({} as IncomingMessage, res, { texts }); // no ids → isolates the volume arm
    return res;
  };

  it('FIRES: batch at the threshold (64) fully re-computed (cacheHits=0) → volume WARN on recorder + log', async () => {
    const texts = Array.from({ length: LARGE_RECOMPUTE_WARN_ITEMS }, (_, i) => `novel-${i}`);
    const res = await runCompute(texts, 0);
    expect(res._statusCode).not.toBe(413);
    const recs = volumeWarnRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ component: 'embeddings-compute', data: expect.objectContaining({ item_count: 64, cache_hits: 0, has_ids: false }) });
    expect(volumeWarnLogs()).toHaveLength(1); // both sinks, per the #1720 GV condition
  });

  it('SILENT (below threshold): 63 texts fully re-computed → no volume WARN', async () => {
    const texts = Array.from({ length: LARGE_RECOMPUTE_WARN_ITEMS - 1 }, (_, i) => `novel-${i}`);
    await runCompute(texts, 0);
    expect(volumeWarnRecords()).toHaveLength(0);
    expect(volumeWarnLogs()).toHaveLength(0);
  });

  it('SILENT (cache hits present): large batch that resolves from cache (cacheHits>0) → no volume WARN', async () => {
    const texts = Array.from({ length: 100 }, (_, i) => `cached-${i}`);
    await runCompute(texts, 100); // cacheHits === texts.length → cacheHits !== 0 → predicate false
    expect(volumeWarnRecords()).toHaveLength(0);
    expect(volumeWarnLogs()).toHaveLength(0);
  });
});

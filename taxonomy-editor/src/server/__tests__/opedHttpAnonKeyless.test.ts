// @vitest-environment node
// t/501 (TL p/16#286), closes t/489; extended for t/616 (Security p/93#69, p/93#71): the HTTP-level run. A real HTTP
// request goes into the real POST /api/oped-sets handler (routes/oped.ts createOpEdRun) under the anonymous context
// that server.ts builds (principal '_local', anon storage key). Every step on the request's path is real except
// storage, the geo database, the budget store and the provider: the anonymous gates, resolveGenerationContext, the
// model check, the funding decision, the op-ed core, the web adapter and config's key lookup. The owner's key sits
// in the key store and the env; the free pool holds a sentinel key; the provider is a recorded fetch.
// Expected: the run uses only the pool key; no key-store read; no provider call with an owner key; the pool key never
// appears in an SSE frame or error body; geo, empty-pool and admission refusals are JSON before the stream, with
// zero provider calls.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const h = vi.hoisted(() => ({
  keyStoreReads: [] as Array<{ backend: string; userId: string }>,
  providerCalls: [] as Array<{ url: string; auth: string }>,
  geoAllowed: true,
  enforced: false,
  providerStatus: 400,
  store: null as unknown,
}));

vi.mock('../security/keyStore.js', () => ({
  getKeyStore: () => ({
    getKeys: async (backend: string, userId: string) => {
      h.keyStoreReads.push({ backend, userId });
      return ['OWNER-LOCAL-KEY-NOT-PRINTED'];
    },
    addKey: async () => [], removeKey: async () => [], set: async () => undefined, delete: async () => undefined,
  }),
}));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: l(), ai: l(), security: l() }, getRequestId: () => 'req-t501', LOG_MAX_LINE_BYTES: 65536, writeFramedNdjson: vi.fn() };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
// The geo database (not on the key path; the real lookup refuses loopback, which is where this test connects from).
vi.mock('../ai/freePoolGeoGuard.js', () => ({
  checkFreePoolGeo: vi.fn(async () => (h.geoAllowed ? { allowed: true, country: 'US' } : { allowed: false, country: 'XX', reason: 'restricted_region' })),
}));
// Grounding's query embedding (t/541) is not on the key path; the real one starts the ONNX worker.
vi.mock('../ai/aiBackends.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/aiBackends.js')>()),
  computeQueryEmbedding: vi.fn(async () => new Array(384).fill(0)),
}));
vi.mock('../featureFlags.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../featureFlags.js')>()),
  isFreePoolBudgetEnforced: () => h.enforced,
}));
vi.mock('../storage/freePoolBudget.js', () => ({ getFreePoolBudget: () => h.store }));
// Storage only: these are not on the key path.
vi.mock('../storage/opedStore.js', () => ({
  listOpedSets: vi.fn(async () => []), loadOpedSet: vi.fn(async () => null), deleteOpedSet: vi.fn(),
  getOpedSetsQuotaStatus: vi.fn(async () => ({ allowed: true, resource: 'opeds', current: 0, limit: 15 })),
  finalizeOpedSet: vi.fn(async () => undefined),
}));
vi.mock('../storage/opedShareStore.js', () => ({ refreshOpedShareIfShared: vi.fn(async () => false), publishOpedShare: vi.fn(), unpublishOpedShare: vi.fn() }));
vi.mock('../storage/anonOpEdSpend.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../storage/anonOpEdSpend.js')>()),
  anonOpEdCeilingBreach: vi.fn(async () => null), recordAnonOpEdSpend: vi.fn(async () => undefined),
}));
vi.mock('../storage/fileIO.js', () => ({
  isSafeId: (v: string) => !!v && /^[a-zA-Z0-9_-]+$/.test(v),
  fetchUrlContent: vi.fn(),
  upsertOpedRun: vi.fn(async () => undefined), countRunningOpedRuns: vi.fn(async () => 0), getOpedRun: vi.fn(async () => null),
}));
// The grounding query embedding is not on the key path. The real one cold-loads an ONNX session, which timed out
// under parallel CI load (t/630).
vi.mock('../../../../lib/embeddings/onnxEmbedding.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/embeddings/onnxEmbedding.js')>()),
  computeEmbedding: vi.fn(async () => new Array(384).fill(0)),
}));

import { runWithUser } from '../security/userContext.js';
import { registerOpedRoutes } from '../routes/oped.js';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown) => Promise<void> | void;

// server.ts for an anonymous request with cookie uuid U.
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const OWNER = /OWNER-/;
const POOL_KEY = 'AIzaSENTINEL-POOL-KEY-0000000000000000';
const POOL = /SENTINEL-POOL-KEY/;

const realFetch = globalThis.fetch;
const ENV_NAMES = ['GEMINI_API_KEY', 'AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'AUTH_DISABLED', 'FREE_TIER_GEMINI_KEY'];
const savedEnv: Record<string, string | undefined> = {};
let server: http.Server;
let base: string;

beforeEach(async () => {
  h.keyStoreReads.length = 0;
  h.providerCalls.length = 0;
  h.geoAllowed = true;
  h.enforced = false;
  h.providerStatus = 400;
  h.store = null;
  for (const n of ENV_NAMES) savedEnv[n] = process.env[n];
  for (const n of ENV_NAMES) delete process.env[n];
  process.env.GEMINI_API_KEY = 'OWNER-ENV-KEY-NOT-PRINTED';
  process.env.AI_API_KEY = 'OWNER-FALLBACK-KEY-NOT-PRINTED';
  process.env.FREE_TIER_GEMINI_KEY = POOL_KEY;

  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, fn: Handler) => { handlers[`${m} ${p}`] = fn; };
  registerOpedRoutes({ get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), del: reg('DELETE') } as never, {} as never);
  const create = handlers['POST /api/oped-sets'];

  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      void runWithUser(ANON, () => create(req, res, JSON.parse(raw || '{}'))).catch((err: unknown) => {
        if (!res.headersSent) { res.writeHead(500); }
        res.end(String((err as Error).name));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The provider: any fetch that is not to this test server is recorded and refused (400, or 429 for an exhausted pool).
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith(base)) return realFetch(url, init);
    const hdrs = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    const auth = [...hdrs.entries()].map(([k, v]) => `${k}=${v}`).join(';');
    h.providerCalls.push({ url: u, auth });
    const body = h.providerStatus === 429
      ? { error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }
      : { error: { code: 400, message: 'API key not valid' } };
    return new Response(JSON.stringify(body), { status: h.providerStatus });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const n of ENV_NAMES) { if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n]; }
});

const BODY = { topic: 'Should frontier AI labs publish their safety evaluations?', povs: ['accelerationist'], params: { wordCount: 300, model: 'gemini-3.5-flash-lite' } };

async function post(): Promise<{ status: number; text: string }> {
  const res = await realFetch(`${base}/api/oped-sets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(BODY) });
  return { status: res.status, text: await res.text() };
}

async function postAnonymousOpEd(): Promise<string> {
  const { status, text } = await post();
  // The request passed every pre-start gate into the SSE run; a JSON refusal would not exercise the key path.
  expect(`${status} ${status === 200 ? '' : text}`.trim()).toBe('200');
  // The voice reached the adapter's generation call (not a harness failure before it), and the run finished.
  expect(text).toContain('"type":"voice_start"');
  expect(text).not.toContain('[vitest]');
  expect(text).toContain('"type":"complete"');
  return text;
}

function expectNoOwnerKeyUsed(text: string): void {
  expect(h.keyStoreReads).toEqual([]);
  for (const c of h.providerCalls) expect(c.url + c.auth).not.toMatch(OWNER);
  expect(text).not.toMatch(OWNER);
}

function expectPoolKeyOnlyAndNotLeaked(text: string): void {
  expect(h.providerCalls.length).toBeGreaterThan(0);
  for (const c of h.providerCalls) expect(c.url + c.auth).toMatch(POOL); // every provider call carries the pool key
  expect(text).not.toMatch(POOL); // Security p/93#69: never in an SSE frame or error body
  expect(text).not.toMatch(/key index|keyIndex/i);
}

describe('t/501 + t/616: an anonymous POST /api/oped-sets over HTTP runs on the free pool only', () => {
  it('owner key in the env and the key store: only the pool key reaches the provider, never echoed back', async () => {
    const text = await postAnonymousOpEd();
    expectNoOwnerKeyUsed(text);
    expectPoolKeyOnlyAndNotLeaked(text);
  });

  it('owner key only in the key store (_local slot): no key-store read, only the pool key', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    const text = await postAnonymousOpEd();
    expectNoOwnerKeyUsed(text);
    expectPoolKeyOnlyAndNotLeaked(text);
  });

  it('exhausted pool (every pool call 429) with an owner key present: zero owner-key calls, no key in the stream', async () => {
    h.providerStatus = 429;
    const { status, text } = await post();
    expect(status).toBe(200);
    expectNoOwnerKeyUsed(text);
    expectPoolKeyOnlyAndNotLeaked(text);
  }, 30_000);

  it('a restricted region is refused 403 free_pool_region before the stream, with zero provider calls', async () => {
    h.geoAllowed = false;
    const { status, text } = await post();
    expect(status).toBe(403);
    expect(JSON.parse(text).error).toBe('free_pool_region');
    expect(h.providerCalls).toEqual([]);
    expect(text).not.toMatch(POOL);
  });

  it('an empty pool (free tier off) is refused 503 before the stream, with zero provider calls', async () => {
    delete process.env.FREE_TIER_GEMINI_KEY;
    const { status, text } = await post();
    expect(status).toBe(503);
    expect(text).not.toContain('text/event-stream');
    expect(h.providerCalls).toEqual([]);
    expect(h.keyStoreReads).toEqual([]);
  });

  it('Security p/93#71: an admission larger than the pool has left is refused 429 before the stream, zero provider calls', async () => {
    h.enforced = true;
    const reserveForKey = vi.fn(async () => ({ ok: false, reason: 'daily_cap', resetsAt: '2026-11-26T00:00:00.000Z' }));
    h.store = { reserveForKey, drawDown: vi.fn(), reserve: vi.fn(), commit: vi.fn(), release: vi.fn() };
    const { status, text } = await post();
    expect(status).toBe(429);
    expect(JSON.parse(text)).toMatchObject({ error: 'free_pool_exhausted', resetsAt: '2026-11-26T00:00:00.000Z' });
    expect(h.providerCalls).toEqual([]);
    // Sized from the run's worst case: 1 voice x 7 calls, no source; tokens well over one call's flat estimate.
    const req = (reserveForKey.mock.calls[0] as unknown as [{ key: string; calls: number; tokens: number; maxOpenForPrefix: { prefix: string; max: number } }])[0];
    expect(req.calls).toBe(7);
    expect(req.tokens).toBeGreaterThan(7 * 2000);
    expect(req.key).toMatch(/^oped:ip:127\.0\.0\.1:/);
    expect(req.maxOpenForPrefix).toEqual({ prefix: 'oped:ip:127.0.0.1:', max: 2 });
  });

  it('budget store missing while enforcement is on: 503 free_pool_unavailable before the stream (fail closed)', async () => {
    h.enforced = true;
    h.store = null;
    const { status, text } = await post();
    expect(status).toBe(503);
    expect(JSON.parse(text).error).toBe('free_pool_unavailable');
    expect(h.providerCalls).toEqual([]);
  });
});

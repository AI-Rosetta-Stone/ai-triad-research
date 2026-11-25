// @vitest-environment node
// t/501 (TL p/16#286), closes t/489: the HTTP-level run. A real HTTP request goes into the real
// POST /api/oped-sets handler (routes/oped.ts createOpEdRun) under the anonymous context that server.ts
// builds (principal '_local', anon storage key). Every step on the request's path is real except storage
// and the provider: the anonymous gates, resolveGenerationContext, the model check, the op-ed core, the
// web adapter and config's key lookup. The owner's key sits in the key store and the env; the provider is
// a recorded fetch. Expected: no key-store read and no provider call that carries an owner key.
// The containment gate (#5418) blocks this route for anonymous callers in server.ts before dispatch; this test
// dispatches straight to the handler so it proves the key gate on its own, for when that block is lifted.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const h = vi.hoisted(() => ({
  keyStoreReads: [] as Array<{ backend: string; userId: string }>,
  providerCalls: [] as Array<{ url: string; auth: string }>,
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
  return { log: { server: l(), api: l(), ai: l() }, getRequestId: () => 'req-t501', LOG_MAX_LINE_BYTES: 65536, writeFramedNdjson: vi.fn() };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
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

const realFetch = globalThis.fetch;
const ENV_NAMES = ['GEMINI_API_KEY', 'AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'AUTH_DISABLED'];
const savedEnv: Record<string, string | undefined> = {};
let server: http.Server;
let base: string;

beforeEach(async () => {
  h.keyStoreReads.length = 0;
  h.providerCalls.length = 0;
  for (const n of ENV_NAMES) savedEnv[n] = process.env[n];
  for (const n of ENV_NAMES) delete process.env[n];
  process.env.GEMINI_API_KEY = 'OWNER-ENV-KEY-NOT-PRINTED';
  process.env.AI_API_KEY = 'OWNER-FALLBACK-KEY-NOT-PRINTED';

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

  // The provider: any fetch that is not to this test server is recorded and refused.
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith(base)) return realFetch(url, init);
    const hdrs = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined));
    const auth = [...hdrs.entries()].map(([k, v]) => `${k}=${v}`).join(';');
    h.providerCalls.push({ url: u, auth });
    return new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid' } }), { status: 400 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const n of ENV_NAMES) { if (savedEnv[n] === undefined) delete process.env[n]; else process.env[n] = savedEnv[n]; }
});

async function postAnonymousOpEd(): Promise<string> {
  const res = await realFetch(`${base}/api/oped-sets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'Should frontier AI labs publish their safety evaluations?', povs: ['accelerationist'], params: { wordCount: 300, model: 'gemini-3.5-flash-lite' } }),
  });
  const text = await res.text();
  // The request passed every pre-start gate into the SSE run; a JSON refusal would not exercise the key path.
  expect(`${res.status} ${res.status === 200 ? '' : text}`.trim()).toBe('200');
  // The voice reached the adapter's generation call (not a harness failure before it), and the run finished.
  expect(text).toContain('"type":"voice_start"');
  expect(text).toContain('Generate text via');
  expect(text).not.toContain('[vitest]');
  expect(text).toContain('"type":"complete"');
  return text;
}

function expectNoOwnerKeyUsed(text: string): void {
  expect(h.keyStoreReads).toEqual([]);
  for (const c of h.providerCalls) expect(c.url + c.auth).not.toMatch(OWNER);
  expect(text).not.toMatch(OWNER);
}

// On main both cases fail: with the env key set, the owner's GEMINI_API_KEY goes to the provider; with only
// the key store, the run reads the '_local' slot and sends that key.
describe('t/501: an anonymous POST /api/oped-sets over HTTP never uses an owner key', () => {
  it('owner key in the env and the key store: no key-store read, no provider call with an owner key', async () => {
    expectNoOwnerKeyUsed(await postAnonymousOpEd());
  });

  it('owner key only in the key store (_local slot): no key-store read, no provider call with an owner key', async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    expectNoOwnerKeyUsed(await postAnonymousOpEd());
  });
});

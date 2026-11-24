// @vitest-environment node
// t/516 (t/501 incident): GET /api/backends/available. An anonymous request makes no owner-slot read and is
// answered from the free pool; a signed-in request is unchanged. The handler is the real one, found through the
// real router, and the request runs inside the real user context (runWithUser), so isAnonymousRequest() and
// callerIdentity() are the production functions.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type http from 'http';

const h = vi.hoisted(() => ({
  hasApiKey: vi.fn(async (_backend: string) => true),
  freePoolKeys: 0,
  registry: {
    backends: [{ id: 'gemini' }, { id: 'claude' }, { id: 'groq' }, { id: 'openai' }, { id: 'deepseek' }],
    models: [] as { id: string; backend: string }[],
  },
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: (backend: string) => h.hasApiKey(backend) };
});
vi.mock('../ai/proxyTiers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/proxyTiers.js')>();
  return {
    ...actual,
    freeTierKeyCount: () => h.freePoolKeys,
    // Anonymous (no principal) and signed-in tiers. Anonymous: the default anonymous allow-list.
    resolveTier: (principalName: string) => (principalName
      ? { level: 'platform', allowedBackends: ['gemini', 'claude', 'groq', 'openai', 'deepseek'], limits: { requestsPerMinute: 60, tokensPerDay: 1_000_000 } }
      : { level: 'anonymous', allowedBackends: ['gemini', 'claude', 'groq'], limits: { requestsPerMinute: 10, tokensPerDay: 100_000 } }),
  };
});
vi.mock('../storage/fileIO.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/fileIO.js')>();
  return { ...actual, loadAIModels: async () => h.registry };
});
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerAiRoutes } from '../routes/ai.js';

// server.ts:894-900 for an anonymous request: principal '_local', isAnonymous true.
const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const ALICE = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

function handler(): (req: unknown, res: unknown, body: unknown) => unknown {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
  registerAiRoutes(createRouter(routes as never) as never, {} as never);
  return routes.find(r => r.method === 'GET' && r.path === '/api/backends/available')!.handler;
}

function fakeRes() {
  const r = { statusCode: 200, body: '' as string, writableEnded: false, headersSent: false };
  return Object.assign(r, {
    writeHead(code: number) { r.statusCode = code; r.headersSent = true; return r; },
    setHeader() { return r; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    write() { return true; },
    on() { return r; },
  }) as unknown as http.ServerResponse & { statusCode: number; body: string };
}

async function callAs(ctx: typeof ANON | typeof ALICE) {
  const res = fakeRes();
  await runWithUser(ctx, () => handler()({ method: 'GET', url: '/api/backends/available', headers: {} }, res, undefined));
  return { status: res.statusCode, body: JSON.parse((res as unknown as { body: string }).body) as { backends: { id: string; available: boolean; reason?: string }[] } };
}

beforeEach(() => {
  h.hasApiKey.mockReset().mockResolvedValue(true);
  h.freePoolKeys = 0;
});

describe('t/516: GET /api/backends/available for an anonymous caller', () => {
  it('makes no owner-slot read for any backend, and reports no key for claude or groq', async () => {
    h.freePoolKeys = 0;
    const { status, body } = await callAs(ANON);
    expect(status).toBe(200);
    expect(h.hasApiKey).not.toHaveBeenCalled();
    expect(body.backends.find(b => b.id === 'claude')).toMatchObject({ available: false, reason: 'no_key' });
    expect(body.backends.find(b => b.id === 'groq')).toMatchObject({ available: false, reason: 'no_key' });
    expect(body.backends.find(b => b.id === 'openai')).toMatchObject({ available: false, reason: 'tier_restricted' });
    expect(body.backends.find(b => b.id === 'deepseek')).toMatchObject({ available: false, reason: 'tier_restricted' });
  });

  it('gemini is no_key when the free pool has no keys', async () => {
    h.freePoolKeys = 0;
    const { body } = await callAs(ANON);
    expect(body.backends.find(b => b.id === 'gemini')).toMatchObject({ available: false, reason: 'no_key' });
  });

  it('gemini is available when the free pool has keys, and still no owner slot is read', async () => {
    h.freePoolKeys = 2;
    const { body } = await callAs(ANON);
    expect(body.backends.find(b => b.id === 'gemini')).toMatchObject({ available: true });
    expect(h.hasApiKey).not.toHaveBeenCalled();
  });

  it('the answer does not depend on what the owner holds: owner slots all present or all absent give the same answer', async () => {
    h.freePoolKeys = 0;
    h.hasApiKey.mockResolvedValue(true);
    const withOwnerKeys = await callAs(ANON);
    h.hasApiKey.mockResolvedValue(false);
    const withoutOwnerKeys = await callAs(ANON);
    expect(withOwnerKeys.body).toEqual(withoutOwnerKeys.body);
  });
});

describe('t/516: signed-in answers are unchanged', () => {
  it('reads each backend through hasApiKey for the caller, and reports presence as before', async () => {
    h.hasApiKey.mockImplementation(async (b: string) => b === 'claude');
    const { body } = await callAs(ALICE);
    expect(h.hasApiKey).toHaveBeenCalledWith('claude');
    expect(h.hasApiKey).toHaveBeenCalledWith('gemini');
    expect(body.backends.find(b => b.id === 'claude')).toMatchObject({ available: true });
    expect(body.backends.find(b => b.id === 'gemini')).toMatchObject({ available: false, reason: 'no_key' });
  });
});

// t/516 (SO p/252#24): single-operator local mode. With AUTH_DISABLED=1 every request is anonymous, but the operator
// is the owner: the owner's keys must still answer, so the hosted free-pool branch must not apply.
describe('t/516: AUTH_DISABLED single-operator mode keeps the owner\'s key lookup', () => {
  const saved = process.env.AUTH_DISABLED;
  beforeEach(() => { process.env.AUTH_DISABLED = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = saved; });

  it('an anonymous-flagged request under AUTH_DISABLED reads the key store per backend, as before', async () => {
    h.hasApiKey.mockImplementation(async (b: string) => b === 'claude' || b === 'gemini');
    const { body } = await callAs(ANON);
    expect(h.hasApiKey).toHaveBeenCalledWith('gemini');
    expect(h.hasApiKey).toHaveBeenCalledWith('claude');
    expect(body.backends.find(b => b.id === 'claude')).toMatchObject({ available: true });
    expect(body.backends.find(b => b.id === 'gemini')).toMatchObject({ available: true });
  });

  it('gemini is not decided by the free pool in this mode', async () => {
    h.freePoolKeys = 0;
    h.hasApiKey.mockResolvedValue(true);
    const { body } = await callAs(ANON);
    expect(body.backends.find(b => b.id === 'gemini')).toMatchObject({ available: true });
  });
});

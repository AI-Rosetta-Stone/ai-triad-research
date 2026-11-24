// @vitest-environment node
// t/516: GET /health is unauthenticated, so an anonymous probe reaches it. For an anonymous request its
// geminiKeyConfigured comes from the free pool and makes no owner-slot read. A signed-in request is unchanged.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  hasApiKey: vi.fn(async (_backend: string) => true),
  freePoolKeys: 0,
}));

vi.mock('../community/community.js', () => ({ isAdmin: () => false, getAdminUsers: vi.fn(() => []) }));
vi.mock('../storage/nodeSourceIndex.js', () => ({ getNodeSourceIndexStatus: vi.fn(() => null) }));
vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: (backend: string) => h.hasApiKey(backend) };
});
vi.mock('../ai/proxyTiers.js', () => ({
  parseFreeTierKeys: vi.fn(() => []),
  freeTierKeyCount: () => h.freePoolKeys,
  scaledFreeTierRpm: vi.fn(() => 10),
}));
vi.mock('../runtimeConfig.js', () => ({ getConfig: vi.fn(() => ({ tiers: { free: { tokensPerDay: 1_000_000 } } })) }));
vi.mock('../readOnlyGuard.js', () => ({ getReadOnlyPrincipalEntries: vi.fn(() => new Set()) }));
vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerMetaRoutes } from '../routes/meta.js';
import type { ServerCtx } from '../routes/context.js';

const ANON = { principalName: '_local', idp: '', storageUserId: 'anon-0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11', stableId: undefined, isAnonymous: true, anonymousSessionId: '0f8fad5b-d9cb-469f-a165-8c7c0e2c1a11' };
const ALICE = { principalName: 'alice', idp: 'github', storageUserId: 'alice', stableId: 'github:1', isAnonymous: false };

function healthHandler(): (req: IncomingMessage, res: ServerResponse) => unknown {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
  const fakeCtx = {
    serverRecorder: { buffer: { count: 0, retained: 0, capacity: 0 } },
    serverVersion: 'test', serverStartTime: new Date().toISOString(),
    getGithubBackend: () => null,
  } as unknown as ServerCtx;
  registerMetaRoutes(createRouter(routes as never) as never, fakeCtx);
  return routes.find(r => r.method === 'GET' && r.path === '/health')!.handler as never;
}

function fakeRes() {
  const r = { statusCode: 200, body: '' as string, writableEnded: false, headersSent: false };
  return Object.assign(r, {
    writeHead(code: number) { r.statusCode = code; r.headersSent = true; return r; },
    setHeader() { return r; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    write() { return true; },
    on() { return r; },
  }) as unknown as ServerResponse & { statusCode: number; body: string };
}

async function probe(ctx: typeof ANON | typeof ALICE): Promise<Record<string, unknown>> {
  const res = fakeRes();
  await runWithUser(ctx, () => healthHandler()({ method: 'GET', url: '/health', headers: {} } as IncomingMessage, res as unknown as ServerResponse));
  return JSON.parse((res as unknown as { body: string }).body) as Record<string, unknown>;
}

beforeEach(() => {
  h.hasApiKey.mockReset().mockResolvedValue(true);
  h.freePoolKeys = 0;
});

describe('t/516: GET /health for an anonymous probe', () => {
  it('geminiKeyConfigured is false with an empty free pool, and no owner slot is read', async () => {
    h.freePoolKeys = 0;
    const body = await probe(ANON);
    expect(body.ai).toMatchObject({ geminiKeyConfigured: false });
    expect(h.hasApiKey).not.toHaveBeenCalled();
  });

  it('geminiKeyConfigured is true when the free pool has keys, whatever the owner holds', async () => {
    h.freePoolKeys = 1;
    h.hasApiKey.mockResolvedValue(false);
    const body = await probe(ANON);
    expect(body.ai).toMatchObject({ geminiKeyConfigured: true });
    expect(h.hasApiKey).not.toHaveBeenCalled();
  });
});

describe('t/516: GET /health for a signed-in caller is unchanged', () => {
  it('geminiKeyConfigured reflects the caller’s own key lookup', async () => {
    h.hasApiKey.mockResolvedValue(true);
    const body = await probe(ALICE);
    expect(h.hasApiKey).toHaveBeenCalledWith('gemini');
    expect(body.ai).toMatchObject({ geminiKeyConfigured: true });
  });
});

// t/516 (SO p/252#24): single-operator local mode keeps the owner's key answer on /health.
describe('t/516: AUTH_DISABLED single-operator mode on /health', () => {
  const saved = process.env.AUTH_DISABLED;
  beforeEach(() => { process.env.AUTH_DISABLED = '1'; });
  afterEach(() => { if (saved === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = saved; });

  it('geminiKeyConfigured reads the owner\'s key under AUTH_DISABLED, even with an empty free pool', async () => {
    h.freePoolKeys = 0;
    h.hasApiKey.mockResolvedValue(true);
    const body = await probe(ANON);
    expect(h.hasApiKey).toHaveBeenCalledWith('gemini');
    expect(body.ai).toMatchObject({ geminiKeyConfigured: true });
  });
});

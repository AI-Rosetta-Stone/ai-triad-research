// @vitest-environment node

/**
 * t/2443 — onRetry → emitToUser wiring in POST /api/ai/generate.
 *
 * Verifies that when generateTextByUsage fires its onRetry callback, the route
 * handler calls ctx.emitToUser with:
 *   (a) the userId captured synchronously from ALS before any await, and
 *   (b) the full GenerateTextProgress payload shape.
 *
 * routes/ai.ts IS import-testable (unlike server.ts); this test exercises it via
 * registerAiRoutes + createRouter with all external dependencies mocked.
 *
 * TL test case t/2443#3: AC#1 (unit: mock emitToUser, fire onRetry, assert payload).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRouter } from '../httpKit.js';
import { registerAiRoutes } from '../routes/ai.js';
import { runWithUser } from '../security/userContext.js';
import type { ServerCtx } from '../routes/context.js';

// ── Mock all external dependencies so the handler reaches generateTextByUsage ──

vi.mock('../ai/aiBackends.js', () => ({
  generateTextByUsage: vi.fn(async (_id: string, _vals: unknown, _overrides: unknown, onRetry: ((p: unknown) => void) | undefined) => {
    onRetry?.({ attempt: 1, maxRetries: 3, backoffSeconds: 5, limitType: 'rpm', limitMessage: 'rate limited' });
    return { text: 'ok', tokenUsage: null, servedModel: 'gemini-3.5-flash-lite' };
  }),
  generateTextWithSearchByUsage: vi.fn(),
  generateText: vi.fn(),
  resolveBackend: vi.fn(() => 'gemini'),
  is429Error: vi.fn(() => false),
  isContextTooLongError: vi.fn(() => false),
  retryAfterMs: vi.fn(() => 0),
}));

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: vi.fn(() => ({
    level: 'platform',
    allowedBackends: ['gemini', 'claude', 'groq', 'openai', 'deepseek', 'tavily', 'ollama', 'azure', 'zai', 'moonshot'],
    limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 },
    serverProvidedKey: false,
    pinnedModel: undefined,
  })),
  isBackendAllowed: vi.fn(() => true),
  parseFreeTierKeys: vi.fn(() => []),
  byokGeminiFallbackApplies: vi.fn(() => false),
}));

vi.mock('../security/rateLimiter.js', () => ({
  checkRate: vi.fn(() => ({ allowed: true, limit: 100, current: 0, retryAfterMs: 0 })),
  checkRequestRate: vi.fn(() => ({ allowed: true, limit: 100, current: 0, retryAfterMs: 0 })),
  checkTokenLimit: vi.fn(() => ({ allowed: true, limit: 1_000_000, current: 0 })),
  recordTokenUsage: vi.fn(() => null),
  nextDailyResetUtc: vi.fn(() => ''),
}));

vi.mock('../security/accessControl.js', () => ({
  callerTierIdentity: vi.fn((user: { principalName?: string; idp?: string } | null) => ({
    principalName: user?.principalName ?? '',
    idp: user?.idp ?? '',
  })),
  missingApiKeyError: vi.fn(() => null),
  expiredAuthCookies: vi.fn(() => []),
  clientSafeMessage: vi.fn((msg: string) => msg),
}));

vi.mock('../config.js', () => ({
  hasApiKey: vi.fn(async () => true),
  getPaidGeminiFallbackKey: vi.fn(async () => null),
}));

// t/3498: /api/ai/generate now consults the allowlist store when no explicit
// key is present + backend is gemini (both true in this test's fixture) —
// mock it out so this pre-existing suite doesn't load the real module.
vi.mock('../storage/allowlistStore.js', () => ({
  isAllowlisted: vi.fn(() => false),
}));

vi.mock('../logger.js', () => ({
  log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  getRequestContext: vi.fn(() => null),
  getRequestId: vi.fn(() => 'test-req-id'),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn(() => null),
}));

vi.mock('../../../../lib/ai-client/index.js', () => ({
  DEFAULT_MODEL: 'gemini-flash',
}));

vi.mock('../storage/fileIO.js', () => ({}));

// ── Helpers ──

function makeReq() {
  return {
    url: '/api/ai/generate',
    method: 'POST',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn(), // IncomingMessage is an EventEmitter (no-op mock)
  };
}

function makeRes() {
  const out = { status: 0, body: '', writableEnded: false, headersSent: false };
  return {
    get writableEnded() { return out.writableEnded; },
    get headersSent() { return out.headersSent; },
    writeHead(status: number) { out.status = status; out.headersSent = true; },
    end(body: string) { out.body = body; out.writableEnded = true; },
    setHeader: vi.fn(),
    // t/2522: the handler subscribes to ServerResponse 'close' (NOT req 'close')
    // to abort on client disconnect. No-op mock — 'close' never fires here.
    on: vi.fn(),
    out,
  };
}

function makeCtx(): ServerCtx {
  return {
    emitToUser: vi.fn(),
    broadcastEvent: vi.fn(),
    broadcastTaxonomyUpdate: vi.fn(),
    getGithubBackend: () => null,
    getSessionManager: () => null,
    serverRecorder: null as never,
    ensureSessionBranch: vi.fn(),
    appendServerLogs: (s: string) => s,
    invalidateConflictsCache: vi.fn(),
    serverVersion: '0.0.0',
    serverStartTime: new Date().toISOString(),
  };
}

describe('POST /api/ai/generate — onRetry emitToUser wiring (t/2443 AC#1)', () => {
  let handler: (req: unknown, res: unknown, body: unknown) => Promise<void>;
  let ctx: ServerCtx;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
    const routes: Array<{ method: string; path: string; handler: typeof handler }> = [];
    registerAiRoutes(createRouter(routes as never), ctx);
    const found = routes.find(r => r.method === 'POST' && r.path === '/api/ai/generate');
    if (!found) throw new Error('POST /api/ai/generate not registered');
    handler = found.handler;
  });

  it('calls ctx.emitToUser with the ALS userId and the full GenerateTextProgress payload', async () => {
    const req = makeReq();
    const res = makeRes();

    await runWithUser(
      { principalName: 'alice@example.com', idp: 'google', storageUserId: 'alice', isAnonymous: false },
      () => handler(req, res, { prompt: 'hello', model: 'gemini-flash' }),
    );

    expect(ctx.emitToUser).toHaveBeenCalledOnce();
    expect(ctx.emitToUser).toHaveBeenCalledWith(
      'alice@example.com',
      'generate-text-progress',
      { attempt: 1, maxRetries: 3, backoffSeconds: 5, limitType: 'rpm', limitMessage: 'rate limited' },
    );
  });

  it('carries the correct userId when two concurrent requests run for different users', async () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx();
    const routes1: Array<{ method: string; path: string; handler: typeof handler }> = [];
    const routes2: Array<{ method: string; path: string; handler: typeof handler }> = [];
    registerAiRoutes(createRouter(routes1 as never), ctx1);
    registerAiRoutes(createRouter(routes2 as never), ctx2);
    const h1 = routes1.find(r => r.method === 'POST' && r.path === '/api/ai/generate')!.handler;
    const h2 = routes2.find(r => r.method === 'POST' && r.path === '/api/ai/generate')!.handler;

    await Promise.all([
      runWithUser(
        { principalName: 'alice@example.com', idp: 'google', storageUserId: 'alice', isAnonymous: false },
        () => h1(makeReq(), makeRes(), { prompt: 'p1', model: 'gemini-flash' }),
      ),
      runWithUser(
        { principalName: 'bob@example.com', idp: 'github', storageUserId: 'bob', isAnonymous: false },
        () => h2(makeReq(), makeRes(), { prompt: 'p2', model: 'gemini-flash' }),
      ),
    ]);

    const aliceCall = (ctx1.emitToUser as ReturnType<typeof vi.fn>).mock.calls[0];
    const bobCall = (ctx2.emitToUser as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(aliceCall[0]).toBe('alice@example.com');
    expect(bobCall[0]).toBe('bob@example.com');
  });
});

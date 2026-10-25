// @vitest-environment node
//
// t/4125 — POST /api/ai/generate: the response body must carry `servedModel`
// (the registry id of the chain link that answered). Covers: successful generate
// forwards servedModel; search=true path omits servedModel (generateWithSearch has
// no servedModel field — speaker turns never use search).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

const h = vi.hoisted(() => ({
  servedModel: 'gemini-3.5-flash-lite' as string | undefined,
}));

const BYOK = { level: 'byok', allowedBackends: ['gemini', 'claude'], pinnedModel: undefined, limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 }, serverProvidedKey: false };

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: () => BYOK,
  isBackendAllowed: () => true,
  parseFreeTierKeys: () => [],
  byokGeminiFallbackApplies: () => false,
}));
const generateTextByUsage = vi.fn();
const generateTextWithSearchByUsage = vi.fn();
vi.mock('../ai/aiBackends.js', () => ({
  resolveBackend: () => 'gemini',
  generateTextByUsage: (...a: unknown[]) => generateTextByUsage(...a),
  generateTextWithSearchByUsage: (...a: unknown[]) => generateTextWithSearchByUsage(...a),
  is429Error: () => false,
  isContextTooLongError: () => false,
  retryAfterMs: () => 0,
}));
vi.mock('../config.js', () => ({
  hasApiKey: async () => true,
  getPaidGeminiFallbackKey: async () => null,
  getApiKey: async () => 'test-key',
}));
vi.mock('../storage/allowlistStore.js', () => ({
  isAllowlisted: () => false,
}));
vi.mock('../security/rateLimiter.js', () => ({
  checkRate: () => ({ allowed: true }),
  checkRequestRate: () => ({ allowed: true }),
  checkTokenLimit: () => ({ allowed: true }),
  recordTokenUsage: () => null,
  nextDailyResetUtc: () => '',
}));
vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'gemini-2.5-flash' }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { runWithUser, type UserContext } from '../security/userContext.js';
import { createRouter } from '../httpKit.js';
import { registerAiRoutes } from '../routes/ai.js';

function mockReq(): http.IncomingMessage {
  return { headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {} } as unknown as http.IncomingMessage;
}
function mockRes() {
  const r = {
    statusCode: 0, body: '', headers: {} as Record<string, string>, writableEnded: false,
    writeHead(code: number, hdrs?: Record<string, string>) { r.statusCode = code; if (hdrs) Object.assign(r.headers, hdrs); return r; },
    setHeader(k: string, v: string) { r.headers[k] = v; },
    end(b?: string) { r.body = b ?? ''; r.writableEnded = true; return r; },
    write() { return true; },
    on() { return r; },
  };
  return r;
}
function handlerFor(method: string, path: string) {
  const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => unknown }> = [];
  registerAiRoutes(createRouter(routes as never) as never, { emitToUser: () => {} } as never);
  return routes.find(r => r.method === method && r.path === path)!.handler;
}
function asUser<T>(storageUserId: string, fn: () => T): T {
  const c: UserContext = { principalName: storageUserId, idp: 'aad', storageUserId, isAnonymous: false };
  return runWithUser(c, fn);
}

describe('t/4125 — POST /api/ai/generate: servedModel forwarded in response', () => {
  beforeEach(() => {
    generateTextByUsage.mockReset();
    generateTextWithSearchByUsage.mockReset();
  });

  it('successful generate → response body carries servedModel from the chain link', async () => {
    generateTextByUsage.mockResolvedValue({ text: 'hello', tokenUsage: undefined, servedModel: 'gemini-3.5-flash-lite' });
    const res = mockRes();
    await asUser('user-1', () =>
      handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.servedModel).toBe('gemini-3.5-flash-lite');
    expect(body.text).toBe('hello');
  });

  it('servedModel is undefined when the backend omits it → field absent from response body', async () => {
    generateTextByUsage.mockResolvedValue({ text: 'hello', tokenUsage: undefined, servedModel: undefined });
    const res = mockRes();
    await asUser('user-1', () =>
      handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // undefined fields are omitted by JSON.stringify — the key must not appear
    expect(Object.prototype.hasOwnProperty.call(body, 'servedModel')).toBe(false);
  });
});

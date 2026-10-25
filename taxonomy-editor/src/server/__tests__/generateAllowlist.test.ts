// @vitest-environment node
//
// t/3498 (t/3495 epic) — POST /api/ai/generate: an allowlisted user running Gemini
// with no personal key gets the admin's registered paid key injected server-side.
// Covers: allowlisted+no-key+gemini → admin key used (+ SO-required audit log);
// allowlisted but admin key not configured → falls through to the existing 422
// (no special-cased error); non-allowlisted → unchanged 422; non-gemini backend
// → allowlist branch never consulted.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'http';

const h = vi.hoisted(() => ({
  tier: null as unknown,
  backend: 'gemini' as string,
  isAllowlisted: false,
  paidKey: null as string | null,
  hasConfiguredKey: false,
}));

const BYOK = { level: 'byok', allowedBackends: ['gemini', 'claude'], pinnedModel: undefined, limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 }, serverProvidedKey: false };

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: () => h.tier,
  isBackendAllowed: () => true,
  parseFreeTierKeys: () => [],
  byokGeminiFallbackApplies: () => false,
}));
const generateTextByUsage = vi.fn().mockResolvedValue({ text: 'ok', tokenUsage: undefined, servedModel: 'gemini-3.5-flash-lite' });
vi.mock('../ai/aiBackends.js', () => ({
  resolveBackend: () => h.backend,
  generateTextByUsage: (...a: unknown[]) => generateTextByUsage(...a),
  generateTextWithSearchByUsage: vi.fn(),
  is429Error: () => false,
  isContextTooLongError: () => false,
  retryAfterMs: () => 0,
}));
vi.mock('../config.js', () => ({
  hasApiKey: async () => h.hasConfiguredKey,
  getPaidGeminiFallbackKey: async () => h.paidKey,
}));
vi.mock('../storage/allowlistStore.js', () => ({
  isAllowlisted: () => h.isAllowlisted,
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
import { log } from '../logger.js';
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

describe('t/3498 — POST /api/ai/generate allowlist key injection', () => {
  beforeEach(() => {
    h.tier = BYOK; h.backend = 'gemini'; h.isAllowlisted = false; h.paidKey = null; h.hasConfiguredKey = false;
    generateTextByUsage.mockClear();
    vi.spyOn(log.server, 'info');
  });

  it('allowlisted + gemini + no personal key + admin key configured → admin key used, audit logged, 200', async () => {
    h.isAllowlisted = true;
    h.paidKey = 'admin-paid-key';
    const res = mockRes();
    await asUser('member-1', () => handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash' }));

    expect(res.statusCode).toBe(200);
    expect(generateTextByUsage).toHaveBeenCalledTimes(1);
    expect(generateTextByUsage.mock.calls[0][4]).toBe('admin-paid-key'); // explicitKey param

    const auditCall = vi.mocked(log.server.info).mock.calls.find(c => c[1] === 'allowlist-key-used');
    expect(auditCall).toBeTruthy();
    expect(auditCall![0]).toMatchObject({ userId: 'member-1', model: 'gemini-2.5-flash' });
  });

  it('allowlisted but admin key NOT configured → falls through to the existing 422 (no special-cased error)', async () => {
    h.isAllowlisted = true;
    h.paidKey = null;
    const res = mockRes();
    await asUser('member-1', () => handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash' }));

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toBe('missing_api_key');
    expect(generateTextByUsage).not.toHaveBeenCalled();
    expect(vi.mocked(log.server.info).mock.calls.find(c => c[1] === 'allowlist-key-used')).toBeUndefined();
  });

  it('non-allowlisted + no personal key → unchanged 422, allowlist store never grants a key', async () => {
    h.isAllowlisted = false;
    h.paidKey = 'admin-paid-key'; // even if configured, must not be used for a non-member
    const res = mockRes();
    await asUser('someone-else', () => handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash' }));

    expect(res.statusCode).toBe(422);
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('allowlisted but backend is NOT gemini → allowlist branch never consulted, unchanged 422', async () => {
    h.isAllowlisted = true;
    h.paidKey = 'admin-paid-key';
    h.backend = 'claude';
    const res = mockRes();
    await asUser('member-1', () => handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'claude-opus-4' }));

    expect(res.statusCode).toBe(422);
    expect(generateTextByUsage).not.toHaveBeenCalled();
  });

  it('personal key already provided → allowlist branch never consulted even for an allowlisted member', async () => {
    h.isAllowlisted = true;
    h.paidKey = 'admin-paid-key';
    const res = mockRes();
    await asUser('member-1', () => handlerFor('POST', '/api/ai/generate')(mockReq(), res, { prompt: 'hi', model: 'gemini-2.5-flash', apiKey: 'personal-key' }));

    expect(res.statusCode).toBe(200);
    expect(generateTextByUsage.mock.calls[0][4]).toBe('personal-key'); // personal key wins, not the admin key
    expect(vi.mocked(log.server.info).mock.calls.find(c => c[1] === 'allowlist-key-used')).toBeUndefined();
  });
});

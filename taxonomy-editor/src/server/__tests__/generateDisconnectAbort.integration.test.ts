// @vitest-environment node
//
// t/2522 — REAL-SOCKET regression test for the /api/ai/generate disconnect-abort.
//
// The t/2510 unit test asserted only the pure clean-arm predicate + a pre-aborted
// signal; it never exercised real Node socket 'close' semantics, so it passed green
// while the wiring was dead (req.on('close') fires at message-complete on Node ≥15,
// nodejs/node#33035 — not on client disconnect). This test stands up a real
// http.Server, drives the ACTUAL route handler, and aborts a real client fetch
// mid-generate — the only thing that distinguishes res.on('close') (correct) from
// req.on('close') (dead). A revert to req.on('close') fails the failure arm; a
// message-complete false-abort fails the clean arm.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { createRouter } from '../httpKit.js';
import { registerAiRoutes } from '../routes/ai.js';
import type { ServerCtx } from '../routes/context.js';

const h = vi.hoisted(() => ({
  events: [] as Array<{ type: string }>,
  genImpl: null as null | ((...a: unknown[]) => Promise<unknown>),
  lastSignal: undefined as AbortSignal | undefined,
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (e: { type: string }) => { h.events.push(e); } }),
}));

vi.mock('../ai/aiBackends.js', () => ({
  generateTextByUsage: (...a: unknown[]) => {
    h.lastSignal = a[5] as AbortSignal | undefined; // (usageId, values, overrides, onRetry, key, signal)
    return h.genImpl!(...a);
  },
  generateTextWithSearchByUsage: vi.fn(),
  generateText: vi.fn(),
  resolveBackend: () => 'gemini',
  is429Error: () => false,
  isContextTooLongError: () => false,
  retryAfterMs: () => 0,
}));

vi.mock('../ai/proxyTiers.js', () => ({
  resolveTier: () => ({ level: 'platform', allowedBackends: ['gemini'], limits: { requestsPerMinute: 100, tokensPerDay: 1_000_000 }, serverProvidedKey: false, pinnedModel: undefined }),
  isBackendAllowed: () => true,
  parseFreeTierKeys: () => [],
  byokGeminiFallbackApplies: () => false,
}));

vi.mock('../security/rateLimiter.js', () => ({
  checkRate: () => ({ allowed: true, limit: 100, current: 0, retryAfterMs: 0 }),
  checkRequestRate: () => ({ allowed: true, limit: 100, current: 0, retryAfterMs: 0 }),
  checkTokenLimit: () => ({ allowed: true, limit: 1_000_000, current: 0 }),
  recordTokenUsage: () => null,
  nextDailyResetUtc: () => '',
}));

vi.mock('../security/accessControl.js', () => ({
  callerTierIdentity: () => ({ principalName: '', idp: '' }),
  missingApiKeyError: () => null,
  expiredAuthCookies: () => [],
  clientSafeMessage: (m: string) => m,
}));

vi.mock('../config.js', () => ({ hasApiKey: async () => true, getPaidGeminiFallbackKey: async () => null }));
// t/3498: /api/ai/generate now consults the allowlist store when no explicit
// key is present + backend is gemini (both true in this fixture) — mock it
// out so this pre-existing integration test doesn't load the real module.
vi.mock('../storage/allowlistStore.js', () => ({ isAllowlisted: () => false }));
vi.mock('../logger.js', () => ({ log: { server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }, getRequestContext: () => null, getRequestId: () => 'test-req-id' }));
vi.mock('../../../../lib/ai-client/index.js', () => ({ DEFAULT_MODEL: 'gemini-flash' }));
vi.mock('../storage/fileIO.js', () => ({}));

function makeCtx(): ServerCtx {
  return {
    emitToUser: vi.fn(), broadcastEvent: vi.fn(), broadcastTaxonomyUpdate: vi.fn(),
    getGithubBackend: () => null, getSessionManager: () => null, serverRecorder: null as never,
    ensureSessionBranch: vi.fn(), appendServerLogs: (s: string) => s, invalidateConflictsCache: vi.fn(),
    serverVersion: '0.0.0', serverStartTime: '2026-01-01T00:00:00Z',
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) { if (pred()) return true; await sleep(10); }
  return pred();
}

describe('t/2522 — /api/ai/generate aborts the provider on real client disconnect', () => {
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    h.events = []; h.genImpl = null; h.lastSignal = undefined;
    const routes: Array<{ method: string; path: string; handler: (req: unknown, res: unknown, body: unknown) => Promise<void> }> = [];
    registerAiRoutes(createRouter(routes as never), makeCtx());
    const handler = routes.find(r => r.method === 'POST' && r.path === '/api/ai/generate')!.handler;
    // Real server: parse the body (so the request message completes BEFORE the handler
    // runs — exactly the production sequence that makes req.on('close') dead), then
    // dispatch to the real handler.
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { void handler(req, res, body ? JSON.parse(body) : {}); });
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai/generate`;
  });

  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); });

  it('FAILURE ARM: client abort mid-generate aborts the provider signal + logs ai.cancelled', async () => {
    // Provider never resolves unless its signal aborts (a long, in-flight call).
    h.genImpl = (...a: unknown[]) => new Promise((_res, rej) => {
      const signal = a[5] as AbortSignal | undefined;
      const onAbort = () => rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    const ac = new AbortController();
    const req = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'gemini-flash' }), signal: ac.signal }).catch(() => { /* aborted */ });
    await sleep(60); // let the request reach the handler + provider stub
    ac.abort();       // real client disconnect mid-generate

    const aborted = await waitUntil(() => !!h.lastSignal?.aborted, 800);
    expect(aborted).toBe(true);                                  // provider signal fired
    expect(h.events.some(e => e.type === 'ai.cancelled')).toBe(true); // logged at the route
    expect(h.events.some(e => e.type === 'ai.response')).toBe(false); // not counted as success
    await req;
  });

  it('CLEAN ARM: a normal request completes without ever aborting the provider signal', async () => {
    // Provider takes ~80ms then resolves — long enough that a req.on('close')
    // (message-complete) false-abort would flip lastSignal.aborted before completion.
    h.genImpl = async () => { await sleep(80); return { text: 'done', tokenUsage: null }; };

    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'gemini-flash' }) });
    expect(res.status).toBe(200);
    await res.text();
    await sleep(40); // allow the post-completion res 'close' to fire

    expect(h.lastSignal?.aborted).toBe(false);                        // never false-aborted
    expect(h.events.some(e => e.type === 'ai.cancelled')).toBe(false);
    expect(h.events.some(e => e.type === 'ai.response')).toBe(true);  // normal success path
  });
});

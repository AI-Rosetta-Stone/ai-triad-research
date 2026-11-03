// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4586 AC (flagged missing post-deploy, t/4586#4): GET /health's unauth
// branch must expose githubCircuitOpen — an unauthenticated alert (DevOps's
// poller, t/4586#5) watches rate limit AND circuit state, not just rate limit.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { mockIsAdmin } = vi.hoisted(() => ({ mockIsAdmin: vi.fn(() => false) }));
vi.mock('../community/community.js', () => ({ isAdmin: mockIsAdmin, getAdminUsers: vi.fn(() => []) }));

vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: vi.fn(async () => true) };
});

vi.mock('../ai/proxyTiers.js', () => ({ parseFreeTierKeys: vi.fn(() => ['k1']), freeTierKeyCount: vi.fn(() => 1) }));

import { registerMetaRoutes } from '../routes/meta.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}

function registerAndGetHealthHandler(circuitState: 'closed' | 'open' | 'half-open' | null): Handler {
  const r = makeRouter();
  const githubBackend = circuitState === null ? null : {
    getRateLimitRemaining: () => 1234,
    getRateLimitResetsAt: () => '2026-01-01T00:00:00Z',
    getCircuitState: () => circuitState,
  };
  registerMetaRoutes(r.router as never, { getGithubBackend: () => githubBackend } as unknown as ServerCtx);
  return r.handlers['GET /health'];
}

describe('GET /health (unauth): githubCircuitOpen', () => {
  beforeEach(() => { mockIsAdmin.mockReturnValue(false); });

  it('is null when there is no GitHub backend (Electron/local filesystem mode)', async () => {
    const health = registerAndGetHealthHandler(null);
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.githubCircuitOpen).toBeNull();
  });

  it('is false when the circuit is closed', async () => {
    const health = registerAndGetHealthHandler('closed');
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.githubCircuitOpen).toBe(false);
  });

  it('is true when the circuit is open', async () => {
    const health = registerAndGetHealthHandler('open');
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.githubCircuitOpen).toBe(true);
  });

  it('is false when the circuit is half-open (probing, not fully tripped)', async () => {
    const health = registerAndGetHealthHandler('half-open');
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.githubCircuitOpen).toBe(false);
  });
});

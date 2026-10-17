// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4239/t/4240 — GET /health's UNAUTH branch carries eventLoopLagMs (the t/4180 load-test harness
// polls /health anonymously, same as every VU, so this must be the unauth branch specifically, not
// the admin-gated detailed one below it).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { mockIsAdmin } = vi.hoisted(() => ({ mockIsAdmin: vi.fn(() => false) }));
vi.mock('../community/community.js', () => ({ isAdmin: mockIsAdmin }));

const { mockGetLastSample } = vi.hoisted(() => ({ mockGetLastSample: vi.fn(() => null as { maxMs: number } | null) }));
vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: mockGetLastSample }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: vi.fn(async () => true) };
});

vi.mock('../ai/proxyTiers.js', () => ({ parseFreeTierKeys: vi.fn(() => ['k1']) }));

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

function registerAndGetHealthHandler(): Handler {
  const r = makeRouter();
  registerMetaRoutes(r.router as never, {} as unknown as ServerCtx);
  return r.handlers['GET /health'];
}

describe('GET /health unauth branch carries eventLoopLagMs (t/4240)', () => {
  beforeEach(() => {
    mockIsAdmin.mockReturnValue(false);
    mockGetLastSample.mockReturnValue(null);
  });

  it('is null before the sampler\'s first tick', async () => {
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.eventLoopLagMs).toBeNull();
  });

  it('reflects the sampler\'s last maxMs once it has ticked', async () => {
    mockGetLastSample.mockReturnValue({ maxMs: 123.4 });
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.eventLoopLagMs).toBe(123.4);
  });

  it('is present alongside the existing buildSha/ai fields, unauth branch only', async () => {
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body).toMatchObject({ status: 'ok', buildSha: null, eventLoopLagMs: null });
    expect(res._body.ai).toBeDefined();
    expect(res._body.version).toBeUndefined(); // admin-only field, absent here
  });
});

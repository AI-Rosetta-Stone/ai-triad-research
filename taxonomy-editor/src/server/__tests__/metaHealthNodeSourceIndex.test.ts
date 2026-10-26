// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4521 (t/4517 follow-up): the unauthenticated GET /health carries nodeSourceIndexComplete as
// a bare boolean (or null when no build has happened yet) — same count-only-on-public precedent
// as t/4505's identityAllowlistUnreachable. The full status (indexVersion, summaryReadFailures)
// stays admin-only on GET /health's authenticated branch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { mockIsAdmin, mockGetNodeSourceIndexStatus } = vi.hoisted(() => ({
  mockIsAdmin: vi.fn(() => false),
  mockGetNodeSourceIndexStatus: vi.fn(() => null as { built: boolean; complete: boolean; indexVersion: number; summaryReadFailures: number } | null),
}));
vi.mock('../community/community.js', () => ({ isAdmin: mockIsAdmin, getAdminUsers: vi.fn(() => []) }));
vi.mock('../storage/nodeSourceIndex.js', () => ({ getNodeSourceIndexStatus: mockGetNodeSourceIndexStatus }));

vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: vi.fn(async () => true) };
});

vi.mock('../ai/proxyTiers.js', () => ({ parseFreeTierKeys: vi.fn(() => ['k1']), freeTierKeyCount: vi.fn(() => 1), scaledFreeTierRpm: vi.fn(() => 10) }));

vi.mock('../runtimeConfig.js', () => ({ getConfig: vi.fn(() => ({ tiers: { free: { tokensPerDay: 1_000_000 } } })) }));

vi.mock('../readOnlyGuard.js', () => ({ getReadOnlyPrincipalEntries: vi.fn(() => new Set()) }));

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
  const fakeCtx = {
    serverRecorder: { buffer: { count: 0, retained: 0, capacity: 0 } },
    serverVersion: 'test', serverStartTime: new Date().toISOString(),
    getGithubBackend: () => null,
  } as unknown as ServerCtx;
  registerMetaRoutes(r.router as never, fakeCtx);
  return r.handlers['GET /health'];
}

describe('GET /health (unauth): nodeSourceIndexComplete', () => {
  beforeEach(() => { mockIsAdmin.mockReturnValue(false); });

  it('is null when no build has happened yet', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue(null);
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndexComplete).toBeNull();
  });

  it('is true when the build finished complete', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue({ built: true, complete: true, indexVersion: 3, summaryReadFailures: 0 });
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndexComplete).toBe(true);
  });

  it('is false when the build is partial (not yet complete)', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue({ built: true, complete: false, indexVersion: 3, summaryReadFailures: 2 });
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndexComplete).toBe(false);
  });

  it('never leaks the full status (indexVersion/summaryReadFailures) on the public branch', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue({ built: true, complete: false, indexVersion: 3, summaryReadFailures: 2 });
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndex).toBeUndefined();
  });
});

describe('GET /health (admin): nodeSourceIndex full status', () => {
  beforeEach(() => { mockIsAdmin.mockReturnValue(true); });

  it('passes through null as-is when never built', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue(null);
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndex).toBeNull();
  });

  it('exposes the full status including summaryReadFailures', async () => {
    mockGetNodeSourceIndexStatus.mockReturnValue({ built: true, complete: false, indexVersion: 5, summaryReadFailures: 7 });
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.nodeSourceIndex).toEqual({ built: true, complete: false, indexVersion: 5, summaryReadFailures: 7 });
  });
});

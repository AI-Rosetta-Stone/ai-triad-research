// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4505 (TL decision p/806#104): the unauthenticated GET /health carries
// identityAllowlistUnreachable as a COUNT ONLY — Azure's post-deploy smoke check reads it
// with no admin session. Names and reasons stay on /api/admin/health and the boot WARN; this
// file proves the public branch never leaks one.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { mockIsAdmin } = vi.hoisted(() => ({ mockIsAdmin: vi.fn(() => false) }));
vi.mock('../community/community.js', () => ({ isAdmin: mockIsAdmin, getAdminUsers: vi.fn(() => ['jpsnover', 'ai-triad-smoke']) }));

vi.mock('../eventLoopMonitor.js', () => ({ getLastEventLoopSample: vi.fn(() => null) }));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, hasApiKey: vi.fn(async () => true) };
});

vi.mock('../ai/proxyTiers.js', () => ({ parseFreeTierKeys: vi.fn(() => ['k1']), freeTierKeyCount: vi.fn(() => 1) }));

vi.mock('../readOnlyGuard.js', () => ({ getReadOnlyPrincipalEntries: vi.fn(() => new Set(['github:ai-triad-smoke'])) }));

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
  // t/4584/t/4586: /health's unauth branch now also reads the GitHub rate
  // limit for an unauthenticated monitor to watch — a minimal filesystem-mode
  // ctx (no GitHub backend) reports null for those fields.
  registerMetaRoutes(r.router as never, { getGithubBackend: () => null } as unknown as ServerCtx);
  return r.handlers['GET /health'];
}

describe('GET /health (unauth): identityAllowlistUnreachable is a count, never a name', () => {
  beforeEach(() => { mockIsAdmin.mockReturnValue(false); });

  it('reports the count (2 ADMIN_USERS + 1 READ_ONLY_PRINCIPALS, all unreachable: no IDENTITY_MAP)', async () => {
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    expect(res._body.identityAllowlistUnreachable).toBe(3);
  });

  it('never contains the unreachable entries\' names, in any field', async () => {
    const health = registerAndGetHealthHandler();
    const res = fakeRes();
    await health({} as IncomingMessage, res);
    const serialized = JSON.stringify(res._body);
    expect(serialized).not.toContain('jpsnover');
    expect(serialized).not.toContain('ai-triad-smoke');
    expect(typeof res._body.identityAllowlistUnreachable).toBe('number');
  });
});

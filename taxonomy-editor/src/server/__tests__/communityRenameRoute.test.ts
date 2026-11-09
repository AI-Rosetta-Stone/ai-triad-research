// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4897 (t/4885-C): admin-only PATCH /api/community/:type/:id. Both arms of the admin gate,
// anonymous 401, input validation, `by` taken from the server-side stableId (never the body),
// and store status passthrough. The audit-before-mutate ordering is proven in
// community.ts's own tests (t/4894).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const isAdmin = vi.fn(() => false);
const renameCommunityItem = vi.fn(async () => {});
const isAnonymousUser = vi.fn(() => false);
const getStableId = vi.fn<() => string | undefined>(() => 'github:admin-1');

vi.mock('../community/community.js', () => ({
  isAdmin: (...a: unknown[]) => isAdmin(...a),
  renameCommunityItem: (...a: unknown[]) => renameCommunityItem(...a),
}));
vi.mock('../community/communityOpedShares.js', () => ({ revokeCommunityOpedShare: vi.fn(), getCommunityOpedShareEntry: vi.fn() }));
vi.mock('../storage/communityOpedShareStore.js', () => ({ deletePublicCommunityOpEd: vi.fn() }));
vi.mock('../security/rateLimiter.js', () => ({ checkRate: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })) }));
vi.mock('../security/userContext.js', () => ({
  getStorageUserId: () => 'user-1',
  isAnonymousUser: () => isAnonymousUser(),
  getStableId: () => getStableId(),
}));
vi.mock('../security/rateLimitResponse.js', () => ({ rateLimitResponseBody: () => ({ error: 'rate_limited', retryAfter: 1 }) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../logger.js', () => ({
  log: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, server: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  getRequestId: () => 'test-req', getRequestContext: () => undefined,
}));
vi.mock('../storage/fileIO.js', () => ({ getUserContentBackend: () => ({}) }));

import { registerCommunityRoutes } from '../routes/community.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;
function patchHandler(): Handler {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  const router = { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') };
  registerCommunityRoutes(router as never, { getGithubBackend: () => null } as unknown as ServerCtx);
  return handlers['PATCH /api/community/:type/:id'];
}
function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _status: 200, _body: undefined,
    writeHead: vi.fn((c: number) => { res._status = c; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _status: number };
}

async function rename(body: unknown, type = 'debates', id = 'deb-1') {
  const res = fakeRes();
  const req = { url: `/api/community/${type}/${id}`, method: 'PATCH' } as unknown as IncomingMessage;
  await patchHandler()(req, res, body);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdmin.mockReturnValue(true);
  isAnonymousUser.mockReturnValue(false);
  getStableId.mockReturnValue('github:admin-1');
  renameCommunityItem.mockResolvedValue(undefined);
});

describe('PATCH /api/community/:type/:id — admin gate', () => {
  it('admin arm: renames with by = the server-side stableId, and returns 200', async () => {
    const res = await rename({ title: 'Clearer title', reason: 'typo' });
    expect(res._status).toBe(200);
    expect(renameCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'Clearer title', { by: 'github:admin-1', reason: 'typo' });
  });

  it('non-admin arm: 403, and nothing is renamed', async () => {
    isAdmin.mockReturnValue(false);
    const res = await rename({ title: 'Clearer title' });
    expect(res._status).toBe(403);
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });

  // Handler-level backstop. In production server.ts's auth gate answers anonymous callers
  // first (401 no_session, or 403 anon_route_blocked with an anonymous session).
  it('anonymous reaching the handler: 401 before the admin check, and nothing is renamed', async () => {
    isAnonymousUser.mockReturnValue(true);
    const res = await rename({ title: 'Clearer title' });
    expect(res._status).toBe(401);
    expect(isAdmin).not.toHaveBeenCalled();
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied `by`: the audit actor is always the authenticated admin', async () => {
    await rename({ title: 'Clearer title', by: 'github:someone-else' });
    expect(renameCommunityItem).toHaveBeenCalledWith('debates', 'deb-1', 'Clearer title', { by: 'github:admin-1', reason: undefined });
  });

  it('403 if the admin has no stableId (cannot audit the actor)', async () => {
    getStableId.mockReturnValue(undefined);
    const res = await rename({ title: 'Clearer title' });
    expect(res._status).toBe(403);
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/community/:type/:id — validation', () => {
  it.each(['chats', 'debates', 'opeds', 'inquiries'])('accepts type %s', async (type) => {
    expect((await rename({ title: 'T' }, type))._status).toBe(200);
  });

  it('rejects an unknown type (400)', async () => {
    expect((await rename({ title: 'T' }, 'users'))._status).toBe(400);
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['non-string', { title: 42 }],
    ['whitespace-only', { title: '   ' }],
    ['201 chars after trim', { title: `  ${'x'.repeat(201)}  ` }],
  ])('rejects a %s title (400)', async (_label, body) => {
    expect((await rename(body))._status).toBe(400);
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });

  it('accepts a 200-char title padded with spaces', async () => {
    expect((await rename({ title: `  ${'x'.repeat(200)}  ` }))._status).toBe(200);
  });

  it.each([
    ['non-string', { title: 'T', reason: 5 }],
    ['over 1000 chars', { title: 'T', reason: 'r'.repeat(1001) }],
  ])('rejects a %s reason (400)', async (_label, body) => {
    expect((await rename(body))._status).toBe(400);
    expect(renameCommunityItem).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/community/:type/:id — store errors', () => {
  it('passes through a store 404 (missing item)', async () => {
    renameCommunityItem.mockRejectedValue(Object.assign(new Error('Community item not found'), { statusCode: 404 }));
    expect((await rename({ title: 'T' }))._status).toBe(404);
  });

  it('500 for an unexpected store error', async () => {
    renameCommunityItem.mockRejectedValue(new Error('backend down'));
    expect((await rename({ title: 'T' }))._status).toBe(500);
  });
});

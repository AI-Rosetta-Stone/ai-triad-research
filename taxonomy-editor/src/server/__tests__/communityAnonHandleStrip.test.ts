// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/693 interim (incident t/670 child, Security p/238#31): the anonymous Community list and item responses
// must not carry community_metadata.submitted_by_display, which is the submitter's storage id (for Google and
// Entra sign-ins, their email address). Signed-in responses are unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const anon = vi.hoisted(() => ({ value: true }));
const HANDLE = 'jsnover13-at-gmail-com';
const itemWithHandle = (id: string) => ({
  id,
  title: `Item ${id}`,
  community_metadata: { submitted_by_display: HANDLE, submitted_at: '2026-11-01T00:00:00Z' },
});

vi.mock('../community/community.js', () => ({
  listCommunityChats: vi.fn(async () => [itemWithHandle('c1')]),
  listCommunityDebates: vi.fn(async () => [itemWithHandle('d1')]),
  listCommunityOpEds: vi.fn(async () => [itemWithHandle('o1')]),
  listCommunityInquiries: vi.fn(async () => [itemWithHandle('i1')]),
  loadCommunityItem: vi.fn(async (type: string, id: string) => itemWithHandle(`${type}-${id}`)),
  isAdmin: vi.fn(() => false),
  renameCommunityItem: vi.fn(),
}));
vi.mock('../community/communityOpedShares.js', () => ({ revokeCommunityOpedShare: vi.fn(), getCommunityOpedShareEntry: vi.fn() }));
vi.mock('../storage/communityOpedShareStore.js', () => ({ deletePublicCommunityOpEd: vi.fn() }));
vi.mock('../security/rateLimiter.js', () => ({ checkRate: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })) }));
vi.mock('../security/userContext.js', () => ({
  getStorageUserId: () => 'user-1',
  isAnonymousUser: () => anon.value,
  getStableId: () => undefined,
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
function getHandlers(): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  const router = { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') };
  registerCommunityRoutes(router as never, { getGithubBackend: () => null } as unknown as ServerCtx);
  return handlers;
}
function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _status: 200, _body: undefined,
    writeHead: vi.fn((c: number) => { res._status = c; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: unknown; _status: number };
}
async function get(path: string) {
  const handlers = getHandlers();
  const res = fakeRes();
  const req = { url: path, method: 'GET' } as unknown as IncomingMessage;
  await handlers[`GET ${path.replace(/\/[cdoi]\d$/, '/:id')}`]?.(req, res, undefined);
  return res;
}

const LISTS = ['/api/community/chats', '/api/community/debates', '/api/community/opeds', '/api/community/inquiries'];
const ITEMS = ['/api/community/chats/c1', '/api/community/debates/d1', '/api/community/opeds/o1', '/api/community/inquiries/i1'];
const ROUTE_KEYS = [...LISTS, ...ITEMS.map(p => p.replace(/\/[^/]+$/, '/:id'))];

function allRows(body: unknown): Record<string, unknown>[] {
  return Array.isArray(body) ? body as Record<string, unknown>[] : [body as Record<string, unknown>];
}
function handleOf(row: Record<string, unknown>): unknown {
  return (row.community_metadata as Record<string, unknown> | undefined)?.submitted_by_display;
}

beforeEach(() => { vi.clearAllMocks(); anon.value = true; });

describe('anonymous Community responses omit submitted_by_display (t/693 interim)', () => {
  it.each(LISTS)('anonymous list %s carries no submitted_by_display', async (path) => {
    anon.value = true;
    const res = await get(path);
    expect(res._status).toBe(200);
    const rows = allRows(res._body);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.community_metadata).toBeDefined();
      expect(handleOf(row)).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('-at-');
    }
  });

  it.each(ITEMS)('anonymous item %s carries no submitted_by_display', async (path) => {
    anon.value = true;
    const res = await get(path);
    expect(res._status).toBe(200);
    const [row] = allRows(res._body);
    expect(handleOf(row)).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('-at-');
  });

  it.each(LISTS)('signed-in list %s is unchanged and still carries submitted_by_display', async (path) => {
    anon.value = false;
    const res = await get(path);
    const rows = allRows(res._body);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(handleOf(row)).toBe(HANDLE);
  });

  it.each(ITEMS)('signed-in item %s is unchanged and still carries submitted_by_display', async (path) => {
    anon.value = false;
    const res = await get(path);
    const [row] = allRows(res._body);
    expect(handleOf(row)).toBe(HANDLE);
  });

  it('the strip does not remove other community_metadata keys', async () => {
    anon.value = true;
    const res = await get('/api/community/chats/c1');
    const [row] = allRows(res._body);
    expect((row.community_metadata as Record<string, unknown>).submitted_at).toBe('2026-11-01T00:00:00Z');
  });

  it('the route keys cover all four types, list and item', () => {
    expect(ROUTE_KEYS.length).toBe(8);
  });
});

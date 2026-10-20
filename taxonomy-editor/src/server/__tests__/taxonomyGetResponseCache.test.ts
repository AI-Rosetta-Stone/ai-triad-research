// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4241 — GET /api/taxonomy/:pov's response-buffer cache. Keyed by content hash (the storage
// read's `version`), so it's self-invalidating: no write-hook, and a session user's overlay
// content (a different hash) never gets served main's cached bytes. Promise-dedupe collapses
// concurrent misses for the same hash into one parse+stringify (t/3165 pattern).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ getFlag: () => false }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: vi.fn() }));
vi.mock('../security/userContext.js', () => ({ isAnonymousUser: () => false, getCurrentUserId: () => 'tester' }));

const { mockRawRead } = vi.hoisted(() => ({ mockRawRead: vi.fn() }));
vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: vi.fn(async () => ({ nodes: [] })),
  readTaxonomyFileWithVersion: vi.fn(async () => ({ data: { nodes: [] }, version: 'v1' })),
  readTaxonomyFileRawWithVersion: mockRawRead,
  writeTaxonomyFile: vi.fn(async () => ({ version: 'w1' })),
  loadSyntheticEmbeddings: vi.fn(),
  loadSyntheticCorpus: vi.fn(),
}));

import { registerTaxonomyRoutes, __resetTaxonomyGetCacheForTest } from '../routes/taxonomy.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

// Captures the raw body as a string WITHOUT calling JSON.parse — several tests below spy on the
// GLOBAL JSON.parse to count the route's own parses, and a parse call in this test harness would
// double-count. Assertions compare against JSON.stringify(expected) instead of parsed objects.
function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _bodyRaw: undefined as string | undefined, _headers: {} as Record<string, string>,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string | Buffer) => { res._bodyRaw = b !== undefined ? b.toString() : undefined; res.writableEnded = true; }),
    setHeader: vi.fn((name: string, value: string) => { (res._headers as Record<string, string>)[name] = value; }),
  };
  return res as unknown as ServerResponse & { _bodyRaw?: string; _statusCode: number; _headers: Record<string, string> };
}

const fakeReq = (): IncomingMessage => ({ url: '/api/taxonomy/accelerationist', headers: {} } as unknown as IncomingMessage);

function registerAndGetGetHandler(): Handler {
  const r = makeRouter();
  registerTaxonomyRoutes(r.router as never, { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx);
  return r.handlers['GET /api/taxonomy/:pov'];
}

describe('GET /api/taxonomy/:pov response cache (t/4241)', () => {
  let parseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetTaxonomyGetCacheForTest();
    mockRawRead.mockReset();
    parseSpy = vi.spyOn(JSON, 'parse');
  });

  afterEach(() => { parseSpy.mockRestore(); });

  it('a write changes the content hash, so the next GET parses the fresh content (self-invalidating)', async () => {
    mockRawRead.mockResolvedValueOnce({ content: JSON.stringify({ nodes: [{ id: 'a' }] }), version: 'v1' });
    const get = registerAndGetGetHandler();
    const res1 = fakeRes();
    await get(fakeReq(), res1);
    expect(res1._bodyRaw).toBe(JSON.stringify({ nodes: [{ id: 'a' }] }));

    mockRawRead.mockResolvedValueOnce({ content: JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }] }), version: 'v2' });
    const res2 = fakeRes();
    await get(fakeReq(), res2);
    expect(res2._bodyRaw).toBe(JSON.stringify({ nodes: [{ id: 'a' }, { id: 'b' }] }));
    expect(res2._headers.ETag).toBe('"v2"');
  });

  it('an overlay/session read (a different hash from main) is never served the other version\'s cached bytes', async () => {
    mockRawRead.mockResolvedValueOnce({ content: JSON.stringify({ nodes: [{ id: 'main' }] }), version: 'main-sha' });
    const get = registerAndGetGetHandler();
    const resMain = fakeRes();
    await get(fakeReq(), resMain);
    expect(resMain._bodyRaw).toBe(JSON.stringify({ nodes: [{ id: 'main' }] }));

    mockRawRead.mockResolvedValueOnce({ content: JSON.stringify({ nodes: [{ id: 'overlay' }] }), version: 'overlay-sha' });
    const resOverlay = fakeRes();
    await get(fakeReq(), resOverlay);
    expect(resOverlay._bodyRaw).toBe(JSON.stringify({ nodes: [{ id: 'overlay' }] }));
  });

  it('20 concurrent GETs for the same content hash make exactly 1 JSON.parse (promise-dedupe)', async () => {
    mockRawRead.mockResolvedValue({ content: JSON.stringify({ nodes: [{ id: 'a' }] }), version: 'v1' });
    const get = registerAndGetGetHandler();
    const responses = Array.from({ length: 20 }, () => fakeRes());
    await Promise.all(responses.map(res => get(fakeReq(), res)));
    expect(parseSpy).toHaveBeenCalledTimes(1);
    for (const res of responses) expect(res._bodyRaw).toBe(JSON.stringify({ nodes: [{ id: 'a' }] }));
  });

  it('a second, sequential GET for the same content hash hits the cache (no second parse)', async () => {
    mockRawRead.mockResolvedValue({ content: JSON.stringify({ nodes: [{ id: 'a' }] }), version: 'v1' });
    const get = registerAndGetGetHandler();
    await get(fakeReq(), fakeRes());
    await get(fakeReq(), fakeRes());
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it('fault: a parse failure does not poison the cache for a later, successful retry at the same hash', async () => {
    mockRawRead.mockResolvedValueOnce({ content: 'not valid json{{{', version: 'bad-content' });
    const get = registerAndGetGetHandler();
    const res1 = fakeRes();
    await get(fakeReq(), res1);
    expect(res1._statusCode).toBe(500);

    mockRawRead.mockResolvedValueOnce({ content: JSON.stringify({ nodes: [] }), version: 'bad-content' }); // same hash, now valid
    const res2 = fakeRes();
    await get(fakeReq(), res2);
    expect(res2._statusCode).toBe(200);
    expect(res2._bodyRaw).toBe(JSON.stringify({ nodes: [] }));
  });

  it('a backend without versioning support (empty version string) never caches, and re-parses every time', async () => {
    mockRawRead.mockResolvedValue({ content: JSON.stringify({ nodes: [{ id: 'x' }] }), version: '' });
    const get = registerAndGetGetHandler();
    await get(fakeReq(), fakeRes());
    await get(fakeReq(), fakeRes());
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });
});

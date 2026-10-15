// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4187 — GET /api/taxonomy/:pov sets ETag from the storage read's version; PUT /api/taxonomy/:pov
// requires If-Match and rejects a missing one with 428 BASE_VERSION_REQUIRED before touching storage.

import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ getFlag: () => false }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: vi.fn() }));
vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => false,
  getCurrentUserId: () => 'tester',
}));

const { writeTaxonomyFileSpy } = vi.hoisted(() => ({ writeTaxonomyFileSpy: vi.fn(async () => ({ version: 'def456' })) }));
vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: vi.fn(async () => ({ nodes: [] })),
  readTaxonomyFileWithVersion: vi.fn(async () => ({ data: { nodes: [] }, version: 'abc123' })),
  writeTaxonomyFile: writeTaxonomyFileSpy,
  loadSyntheticEmbeddings: vi.fn(),
  loadSyntheticCorpus: vi.fn(),
}));

import { registerTaxonomyRoutes } from '../routes/taxonomy.js';
import type { ServerCtx } from '../routes/context.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void> | void;

function makeRouter() {
  const handlers: Record<string, Handler> = {};
  const reg = (m: string) => (p: string, h: Handler) => { handlers[`${m} ${p}`] = h; };
  return { router: { get: reg('GET'), put: reg('PUT'), post: reg('POST'), patch: reg('PATCH'), del: reg('DELETE') }, handlers };
}

function fakeRes() {
  const res: Record<string, unknown> = {
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined, _headers: {} as Record<string, string>,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn((name: string, value: string) => { (res._headers as Record<string, string>)[name] = value; }),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number; _headers: Record<string, string> };
}

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { url: '/api/taxonomy/accelerationist', headers } as unknown as IncomingMessage;
}

function registerAndGetHandlers() {
  const r = makeRouter();
  registerTaxonomyRoutes(r.router as never, { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx);
  return r.handlers;
}

describe('GET /api/taxonomy/:pov sets ETag from storage version (t/4187)', () => {
  it('sets ETag to the quoted version returned by readTaxonomyFileWithVersion', async () => {
    const handlers = registerAndGetHandlers();
    const res = fakeRes();
    await handlers['GET /api/taxonomy/:pov'](fakeReq(), res);
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"abc123"');
    expect(res._statusCode).toBe(200);
  });
});

describe('PUT /api/taxonomy/:pov requires If-Match (t/4187)', () => {
  it('rejects a save with no If-Match header: 428 BASE_VERSION_REQUIRED, never reaches storage', async () => {
    const handlers = registerAndGetHandlers();
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq(), res, { nodes: [] });
    expect(res._statusCode).toBe(428);
    expect(res._body.code).toBe('BASE_VERSION_REQUIRED');
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });

  it('accepts a save with an If-Match header and passes it through as baseSha', async () => {
    const handlers = registerAndGetHandlers();
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq({ 'if-match': '"abc123"' }), res, { nodes: [] });
    expect(res._statusCode).toBe(200);
    expect(writeTaxonomyFileSpy).toHaveBeenCalledWith('accelerationist', { nodes: [] }, { baseSha: 'abc123' });
  });

  it('sets the response ETag to the new version returned by writeTaxonomyFile', async () => {
    const handlers = registerAndGetHandlers();
    const res = fakeRes();
    await handlers['PUT /api/taxonomy/:pov'](fakeReq({ 'if-match': '"abc123"' }), res, { nodes: [] });
    expect(res.setHeader).toHaveBeenCalledWith('ETag', '"def456"');
  });
});

// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4229 (t/4167 part B) — PUT /api/taxonomy/:pov refuses a non-admin pov_tags change in hosted
// (STORAGE_MODE=github-api, or filesystem+production) mode with a 403, and is a no-op in genuine
// filesystem/non-prod (desktop, local server) mode. isAdmin/STORAGE_MODE/NODE_ENV are all mocked
// controllable; readTaxonomyFileWithVersion's returned version always matches the test's baseSha
// (the stale-base skip-the-gate path is covered separately, below).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ getFlag: () => false }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: vi.fn() }));
vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => false,
  getCurrentUserId: () => 'nonadmin@example.com',
}));

const { mockIsAdmin } = vi.hoisted(() => ({ mockIsAdmin: vi.fn(() => false) }));
vi.mock('../community/community.js', () => ({ isAdmin: mockIsAdmin }));

const cfgMock = vi.hoisted(() => ({ storageMode: 'github-api' as string }));
// t/4316: isPovTagsGateExempt() now delegates to config.ts's isLocalDeployment(), which is a
// function closing over config.ts's own module-scope STORAGE_MODE — overriding the exported
// STORAGE_MODE getter alone does NOT change what isLocalDeployment() (called internally)
// evaluates, so it's overridden explicitly here too, same pattern as modelsRefreshRoute.test.ts.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return {
    ...actual,
    get STORAGE_MODE() { return cfgMock.storageMode; },
    isLocalDeployment: () => cfgMock.storageMode === 'filesystem' && process.env.NODE_ENV !== 'production',
  };
});

const { writeTaxonomyFileSpy, readVersionMock } = vi.hoisted(() => ({
  writeTaxonomyFileSpy: vi.fn(async () => ({ version: 'def456' })),
  readVersionMock: vi.fn(),
}));
vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: vi.fn(async () => ({ nodes: [] })),
  readTaxonomyFileWithVersion: readVersionMock,
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
    writableEnded: false, headersSent: false, _statusCode: 200, _body: undefined,
    writeHead: vi.fn((code: number) => { res._statusCode = code; res.headersSent = true; }),
    end: vi.fn((b?: string) => { res._body = b !== undefined ? JSON.parse(b) : undefined; res.writableEnded = true; }),
    setHeader: vi.fn(),
  };
  return res as unknown as ServerResponse & { _body: Record<string, unknown>; _statusCode: number };
}

const fakeReq = () => ({ url: '/api/taxonomy/accelerationist', headers: { 'if-match': '"base-sha"' } } as unknown as IncomingMessage);

function oldNodes(...nodes: Array<{ id: string; pov_tags?: string[] }>): void {
  readVersionMock.mockResolvedValue({ data: { nodes }, version: 'base-sha' });
}

describe('PUT /api/taxonomy/:pov pov_tags admin gate, hosted mode (t/4229)', () => {
  let put: Handler;

  beforeEach(() => {
    mockIsAdmin.mockReturnValue(false);
    cfgMock.storageMode = 'github-api';
    writeTaxonomyFileSpy.mockClear();
    const r = makeRouter();
    registerTaxonomyRoutes(r.router as never, { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx);
    put = r.handlers['PUT /api/taxonomy/:pov'];
  });

  afterEach(() => { process.env.NODE_ENV = 'test'; });

  it('non-admin changing an existing node\'s pov_tags: 403, nothing written', async () => {
    oldNodes({ id: 'skp-desires-062', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).toBe(403);
    expect(res._body.error).toContain('skp-desires-062');
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });

  it('non-admin new node carrying pov_tags: refused the same way', async () => {
    oldNodes(); // empty baseline
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-099', pov_tags: ['critical'] }] });
    expect(res._statusCode).toBe(403);
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });

  it('non-admin edit to other fields, pov_tags unchanged: accepted', async () => {
    oldNodes({ id: 'skp-desires-062', label: 'old label', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', label: 'new label', pov_tags: ['critical'] }] });
    expect(res._statusCode).toBe(200);
    expect(writeTaxonomyFileSpy).toHaveBeenCalledOnce();
  });

  it('non-admin edit to other fields, pov_tags order shuffled but same set: accepted (order-insensitive)', async () => {
    oldNodes({ id: 'skp-desires-062', pov_tags: ['a', 'b'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['b', 'a'] }] });
    expect(res._statusCode).toBe(200);
  });

  it('move flow (new id, tags stripped): accepted — the old id is simply absent, a delete', async () => {
    oldNodes({ id: 'skp-desires-062', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'acc-desires-062', pov_tags: [] }] });
    expect(res._statusCode).toBe(200);
    expect(writeTaxonomyFileSpy).toHaveBeenCalledOnce();
  });

  it('admin change: accepted even with a real pov_tags diff', async () => {
    mockIsAdmin.mockReturnValue(true);
    oldNodes({ id: 'skp-desires-062', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).toBe(200);
    expect(writeTaxonomyFileSpy).toHaveBeenCalledOnce();
  });

  // t/4229 SO C1/C2 (e/303#2): the gate must FAIL CLOSED on a version mismatch or a failed/
  // versionless read, not skip — baseSha is caller-supplied and the version is a predictable git
  // blob SHA, so "the write's own precondition will 409 anyway" is not a safe assumption to lean
  // an authorization check on. These three replace the earlier (incorrect) "stale read → 200" test.

  it('C2(i): stale read (version !== baseSha), non-admin tag change: 409 WRITE_CONFLICT, nothing written', async () => {
    readVersionMock.mockResolvedValue({ data: { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical'] }] }, version: 'different-sha' });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).toBe(409);
    expect(res._body.code).toBe('WRITE_CONFLICT');
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });

  it('C2(ii): the read throws, non-admin tag change: not 200, nothing written', async () => {
    readVersionMock.mockRejectedValue(new Error('backend unavailable'));
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).not.toBe(200);
    expect(res._body.code).toBe('VERSION_UNAVAILABLE');
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });

  it('C2(iii): the engineered race — a stale read whose baseSha would later match the real pre-write state is still refused, even though the write mock would succeed', async () => {
    // The attacker's read sees old content X at some other version; their If-Match carries a SHA
    // that happens to equal what the CURRENT content will become after a concurrent legitimate
    // write lands (gitBlobSha is predictable/computable). The gate must not let that coincidence
    // through just because a downstream write call would, hypothetically, succeed.
    readVersionMock.mockResolvedValue({ data: { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical'] }] }, version: 'X-pre-race-sha' });
    writeTaxonomyFileSpy.mockResolvedValueOnce({ version: 'sha-of-C' }); // would succeed if ever called
    const res = fakeRes(); // fakeReq's If-Match is 'base-sha', which still != 'X-pre-race-sha'
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
    expect(res._statusCode).toBe(409);
  });
});

describe('PUT /api/taxonomy/:pov pov_tags admin gate, filesystem/non-prod exemption (t/4229)', () => {
  let put: Handler;

  beforeEach(() => {
    mockIsAdmin.mockReturnValue(false);
    cfgMock.storageMode = 'filesystem';
    process.env.NODE_ENV = 'test'; // non-production
    writeTaxonomyFileSpy.mockClear();
    const r = makeRouter();
    registerTaxonomyRoutes(r.router as never, { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx);
    put = r.handlers['PUT /api/taxonomy/:pov'];
  });

  afterEach(() => { process.env.NODE_ENV = 'test'; });

  it('desktop/local-server save (filesystem, non-prod): _local non-admin pov_tags change is unaffected', async () => {
    oldNodes({ id: 'skp-desires-062', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).toBe(200);
    expect(writeTaxonomyFileSpy).toHaveBeenCalledOnce();
  });

  it('filesystem mode in production (prod rollback runbook): gate stays ON — NODE_ENV, not mode alone, decides exemption', async () => {
    process.env.NODE_ENV = 'production';
    oldNodes({ id: 'skp-desires-062', pov_tags: ['critical'] });
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'skp-desires-062', pov_tags: ['critical', 'new-tag'] }] });
    expect(res._statusCode).toBe(403);
    expect(writeTaxonomyFileSpy).not.toHaveBeenCalled();
  });
});

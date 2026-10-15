// @vitest-environment node
//
// t/4190/t/4192 — the If-Match precondition on conflicts and proposal save routes
// (same contract as t/4189/taxonomy.ts: ETag on read, If-Match on write, 428
// BASE_VERSION_REQUIRED if missing, 409 WRITE_CONFLICT on a stale one). fileIO is
// mocked so these drive only the route-level gating, not storage behavior
// (covered in conflictsFileIO.test.ts / the fileIO unit tests).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { ActionableError } from '../../../../lib/debate/errors.js';

const {
  writeConflictFileMock, createConflictFileMock, readAllConflictFilesWithVersionMock,
  saveProposalMock, readProposalWithVersionMock,
} = vi.hoisted(() => ({
  writeConflictFileMock: vi.fn(async () => ({ version: 'new-sha' })),
  createConflictFileMock: vi.fn(async () => ({ version: 'new-sha' })),
  readAllConflictFilesWithVersionMock: vi.fn(async () => ({ conflicts: [], version: 'conflicts-sha' })),
  saveProposalMock: vi.fn(async () => ({ version: 'new-sha' })),
  readProposalWithVersionMock: vi.fn(async () => ({ data: { foo: 'bar' }, version: 'proposal-sha' })),
}));

vi.mock('../storage/fileIO.js', async (importActual) => {
  const actual = await importActual<typeof import('../storage/fileIO.js')>();
  return {
    ...actual,
    writeConflictFile: writeConflictFileMock,
    createConflictFile: createConflictFileMock,
    readAllConflictFilesWithVersion: readAllConflictFilesWithVersionMock,
    saveProposal: saveProposalMock,
    readProposalWithVersion: readProposalWithVersionMock,
  };
});

import type { ServerCtx } from '../routes/context.js';
import { createRouter, type Handler } from '../httpKit.js';
import { registerConflictsRoutes } from '../routes/conflicts.js';
import { registerSourcesRoutes } from '../routes/sources.js';

const TEST_BASE_SHA = 'test-base-sha';

interface InvokeResult { status: number; body: unknown; headers: Record<string, string> }

async function invoke(
  register: (r: ReturnType<typeof createRouter>, ctx: ServerCtx) => void,
  method: string, routePath: string, body: unknown,
  headers: Record<string, string> = { 'if-match': `"${TEST_BASE_SHA}"` },
  reqUrl: string = routePath,
): Promise<InvokeResult> {
  const routes: { method: string; path: string; handler: Handler }[] = [];
  register(createRouter(routes), { ensureSessionBranch: async () => {} } as unknown as ServerCtx);
  const route = routes.find(r => r.path === routePath && r.method === method);
  if (!route) throw new Error(`route not registered: ${method} ${routePath}`);

  const req = { url: reqUrl, method, headers, socket: {} } as unknown as IncomingMessage;
  const result: InvokeResult = { status: 200, body: undefined, headers: {} };
  const res = {
    writableEnded: false, headersSent: false,
    setHeader(name: string, value: string) { result.headers[name] = value; },
    getHeader() { return undefined; },
    writeHead(s: number) { result.status = s; this.headersSent = true; return this; },
    end(b?: string) { result.body = b ? JSON.parse(b) : undefined; this.writableEnded = true; },
  } as unknown as ServerResponse;

  await route.handler(req, res, body);
  return result;
}

describe('conflicts/proposal save routes — If-Match precondition (t/4190, t/4192)', () => {
  beforeEach(() => {
    writeConflictFileMock.mockClear().mockResolvedValue({ version: 'new-sha' });
    createConflictFileMock.mockClear().mockResolvedValue({ version: 'new-sha' });
    saveProposalMock.mockClear().mockResolvedValue({ version: 'new-sha' });
  });

  it('PUT /api/conflicts/:id requires If-Match: 428 BASE_VERSION_REQUIRED, nothing written', async () => {
    const res = await invoke(registerConflictsRoutes, 'PUT', '/api/conflicts/:id', { claim_id: 'c1' }, {}, '/api/conflicts/c1');
    expect(res.status).toBe(428);
    expect((res.body as { error?: string } | undefined)?.error).toMatch(/If-Match/);
    expect(writeConflictFileMock).not.toHaveBeenCalled();
  });

  it('PUT /api/conflicts/:id with If-Match writes with the baseSha and returns the new ETag', async () => {
    const res = await invoke(
      registerConflictsRoutes, 'PUT', '/api/conflicts/:id', { claim_id: 'c1' },
      { 'if-match': `"${TEST_BASE_SHA}"` }, '/api/conflicts/c1',
    );
    expect(res.status).toBe(200);
    expect(writeConflictFileMock).toHaveBeenCalledWith('c1', { claim_id: 'c1' }, { baseSha: TEST_BASE_SHA });
    expect(res.headers.ETag).toBe('"new-sha"');
  });

  it('PUT /api/conflicts/:id surfaces a storage WRITE_CONFLICT as 409 with its code', async () => {
    writeConflictFileMock.mockRejectedValueOnce(new ActionableError({
      goal: 'g', problem: 'p', location: 'l', nextSteps: [], httpStatus: 409, code: 'WRITE_CONFLICT',
    }));
    const res = await invoke(
      registerConflictsRoutes, 'PUT', '/api/conflicts/:id', { claim_id: 'c1' },
      { 'if-match': `"${TEST_BASE_SHA}"` }, '/api/conflicts/c1',
    );
    expect(res.status).toBe(409);
    expect((res.body as { error?: string; code?: string } | undefined)?.code).toBe('WRITE_CONFLICT');
  });

  it('POST /api/conflicts/:id (create) requires If-Match: 428, nothing written', async () => {
    const res = await invoke(registerConflictsRoutes, 'POST', '/api/conflicts/:id', { claim_id: 'c2' }, {}, '/api/conflicts/c2');
    expect(res.status).toBe(428);
    expect(createConflictFileMock).not.toHaveBeenCalled();
  });

  it('GET /api/conflicts returns an ETag for the wrapper version', async () => {
    const res = await invoke(registerConflictsRoutes, 'GET', '/api/conflicts', undefined, {});
    expect(res.status).toBe(200);
    expect(res.headers.ETag).toBe('"conflicts-sha"');
  });

  it('PUT /api/proposals/:filename requires If-Match: 428 BASE_VERSION_REQUIRED, nothing saved', async () => {
    const res = await invoke(
      registerSourcesRoutes, 'PUT', '/api/proposals/:filename', { any: 'thing' }, {}, '/api/proposals/p1.json',
    );
    expect(res.status).toBe(428);
    expect(saveProposalMock).not.toHaveBeenCalled();
  });

  it('PUT /api/proposals/:filename with If-Match saves with the baseSha and returns the new ETag', async () => {
    const res = await invoke(
      registerSourcesRoutes, 'PUT', '/api/proposals/:filename', { any: 'thing' },
      { 'if-match': `"${TEST_BASE_SHA}"` }, '/api/proposals/p1.json',
    );
    expect(res.status).toBe(200);
    expect(saveProposalMock).toHaveBeenCalledWith('p1.json', { any: 'thing' }, { baseSha: TEST_BASE_SHA });
    expect(res.headers.ETag).toBe('"new-sha"');
  });

  it('GET /api/proposals/:filename returns the proposal content with an ETag', async () => {
    const res = await invoke(
      registerSourcesRoutes, 'GET', '/api/proposals/:filename', undefined, {}, '/api/proposals/p1.json',
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ foo: 'bar' });
    expect(res.headers.ETag).toBe('"proposal-sha"');
  });
});

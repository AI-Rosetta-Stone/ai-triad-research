// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3171 (G8a) — PUT /api/taxonomy/:pov → grounding-reconcile WIRING. Verifies the route computes the
// changed-node set (real diffNodes) and enqueues it ONLY when the flag is on, and always after the
// 200 (fire-and-forget). The hook's debounce/exec/error-isolation is covered separately
// (groundingReconcileHook.test.ts); here the hook is mocked so we assert the route's contract:
//   - flag ON  + changed node  → enqueue(changed ids); response still { ok: true }.
//   - flag ON  + unchanged     → enqueue NOT called (an unchanged PUT reconciles nothing).
//   - flag OFF                 → enqueue NOT called (the enable/sequencing gate).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const { getFlagSpy, enqueueSpy } = vi.hoisted(() => ({ getFlagSpy: vi.fn(), enqueueSpy: vi.fn() }));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../featureFlags.js', () => ({ getFlag: (name: string) => getFlagSpy(name) }));
vi.mock('../groundingReconcileHook.js', () => ({ enqueueGroundingReconcile: (ids: string[]) => enqueueSpy(ids) }));
vi.mock('../security/userContext.js', () => ({
  isAnonymousUser: () => false,
  getCurrentUserId: () => 'tester',
}));

const oldNodesRef: { nodes: Array<{ id: string; text: string }> } = { nodes: [] };
vi.mock('../storage/fileIO.js', () => ({
  readTaxonomyFile: vi.fn(async () => oldNodesRef),
  writeTaxonomyFile: vi.fn(async () => undefined),
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

describe('PUT /api/taxonomy/:pov → grounding reconcile wiring (t/3171)', () => {
  let put: Handler;

  beforeEach(() => {
    getFlagSpy.mockReset();
    enqueueSpy.mockReset();
    oldNodesRef.nodes = [{ id: 'n1', text: 'original' }, { id: 'n2', text: 'stable' }];
    const { router, handlers } = makeRouter();
    registerTaxonomyRoutes(router as never, { ensureSessionBranch: vi.fn(async () => undefined) } as unknown as ServerCtx);
    put = handlers['PUT /api/taxonomy/:pov'];
  });

  it('flag ON + a changed node → enqueues the changed id and still returns { ok: true }', async () => {
    getFlagSpy.mockReturnValue(true);
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'n1', text: 'EDITED' }, { id: 'n2', text: 'stable' }] });
    expect(res._body).toMatchObject({ ok: true });      // response not blocked by the reconcile
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toEqual(['n1']); // only the modified node
  });

  it('flag ON + a new node → enqueues the added id', async () => {
    getFlagSpy.mockReturnValue(true);
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'n1', text: 'original' }, { id: 'n2', text: 'stable' }, { id: 'n3', text: 'brand new' }] });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toContain('n3');
  });

  it('flag ON + unchanged content → does NOT enqueue (nothing to reconcile)', async () => {
    getFlagSpy.mockReturnValue(true);
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'n1', text: 'original' }, { id: 'n2', text: 'stable' }] });
    expect(res._body).toMatchObject({ ok: true });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('flag OFF → never enqueues even when nodes changed (the enable/sequencing gate)', async () => {
    getFlagSpy.mockReturnValue(false);
    const res = fakeRes();
    await put(fakeReq(), res, { nodes: [{ id: 'n1', text: 'EDITED' }, { id: 'n2', text: 'stable' }] });
    expect(res._body).toMatchObject({ ok: true });
    expect(getFlagSpy).toHaveBeenCalledWith('grounding_reconcile_inline'); // gate was consulted → returned false
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  // t/3267 Fix A (t/3268): the enqueue must fire even when the response write races a client disconnect.
  // Before the reorder, enqueue ran AFTER json(res); an ECONNRESET on the response write jumped to the
  // catch and SKIPPED the reconcile. Enqueue-before-json guarantees it runs. This test fails on the old order.
  it('flag ON + response write throws ECONNRESET → still enqueues (enqueue precedes json, t/3267 Fix A)', async () => {
    getFlagSpy.mockReturnValue(true);
    const res = fakeRes();
    // Simulate the client socket already gone: the first response write (json → res.end) throws ECONNRESET.
    (res.end as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const e = new Error('write ECONNRESET') as Error & { code?: string }; e.code = 'ECONNRESET'; throw e;
    });
    await put(fakeReq(), res, { nodes: [{ id: 'n1', text: 'EDITED' }, { id: 'n2', text: 'stable' }] });
    // The reconcile was enqueued BEFORE the failed response write → not skipped by the ECONNRESET.
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy.mock.calls[0][0]).toEqual(['n1']);
  });
});

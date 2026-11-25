// @vitest-environment node
//
// t/424 — POST /api/taxonomy/relevant-nodes takes an optional pool size. Absent, the selection keeps its defaults
// (debate callers are unchanged). Chat can request the full pool. Out-of-range values are refused, not clamped.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  select: vi.fn(async (_input: { params: Record<string, unknown> }) => ({ povNodes: [], situationNodes: [] })),
}));

vi.mock('../routes/corpusAssemblyCache.js', async (orig) => ({
  ...(await orig<typeof import('../routes/corpusAssemblyCache.js')>()),
  getAssembledCorpus: async () => ({ nodeEmbeddings: {}, allNodeIds: [], povNodes: [], situationNodes: [] }),
}));
vi.mock('../storage/fileIO.js', async (orig) => ({
  ...(await orig<typeof import('../storage/fileIO.js')>()),
  readPolicyRegistry: async () => null,
  readLineageCategories: async () => null,
}));
vi.mock('../../../../lib/debate/relevanceSelection.js', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/debate/relevanceSelection.js')>()),
  selectRelevantTaxonomy: (input: { params: Record<string, unknown> }) => h.select(input),
}));

import { createRouter, type Handler } from '../httpKit.js';
import { registerRelevantNodesRoutes } from '../routes/relevantNodes.js';

const routes: Array<{ method: string; path: string; handler: Handler }> = [];
registerRelevantNodesRoutes(createRouter(routes), {} as never);
const handler = routes.find(r => r.method === 'POST' && r.path === '/api/taxonomy/relevant-nodes')!.handler;

async function post(body: Record<string, unknown>): Promise<{ status: number }> {
  const out: { status?: number } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; }, end: () => {}, setHeader: () => {},
    writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  await handler({ url: '/api/taxonomy/relevant-nodes', headers: {}, method: 'POST' } as unknown as IncomingMessage, res, {
    pov: 'accelerationist', topic: 'AI policy', recentTranscript: '', ...body,
  });
  return { status: out.status ?? 200 };
}

beforeEach(() => { h.select.mockClear(); });

describe('relevant-nodes pool size (t/424)', () => {
  it('absent: the selection gets undefined pool sizes, so the defaults apply (debate callers unchanged)', async () => {
    const r = await post({});
    expect(r.status).toBe(200);
    const params = h.select.mock.calls[0][0].params;
    expect(params.minPerCategory).toBeUndefined();
    expect(params.maxTotal).toBeUndefined();
  });

  it('chat can request the full pool: the sizes are passed through', async () => {
    const r = await post({ minPerCategory: 5, maxTotal: 200 });
    expect(r.status).toBe(200);
    const params = h.select.mock.calls[0][0].params;
    expect(params.minPerCategory).toBe(5);
    expect(params.maxTotal).toBe(200);
  });

  it('a pool size out of range is refused with 400 and the selection does not run', async () => {
    expect((await post({ maxTotal: 501 })).status).toBe(400);
    expect((await post({ maxTotal: 0 })).status).toBe(400);
    expect((await post({ minPerCategory: 11 })).status).toBe(400);
    expect((await post({ minPerCategory: 0 })).status).toBe(400);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('a non-integer pool size is refused with 400', async () => {
    expect((await post({ maxTotal: 2.5 })).status).toBe(400);
    expect((await post({ minPerCategory: '3' })).status).toBe(400);
    expect(h.select).not.toHaveBeenCalled();
  });
});

describe('chat round body (t/348#62, TL p/10#248): the real handler', () => {
  it('accepts the body the chat wiring sends (minPerCategory 1, maxTotal 500, threshold 0)', async () => {
    const r = await post({ minPerCategory: 1, maxTotal: 500, threshold: 0 });
    expect(r.status).toBe(200);
  });

  it('refuses the body the wiring sent before the fix (minPerCategory 0, maxTotal 100000) with 400', async () => {
    const r = await post({ minPerCategory: 0, maxTotal: 100000, threshold: 0 });
    expect(r.status).toBe(400);
  });
});

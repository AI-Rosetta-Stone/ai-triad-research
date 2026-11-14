// @vitest-environment node
//
// t/348 — POST /api/taxonomy/chat-synthetic-statements. The route is read-only and fail-soft: it returns the
// best-matching synthetic statement per node (or null), never throws to the caller, and never returns vectors
// or corpus rows. Only the expensive edges are mocked: the query embed, the assembled corpus and the corpus file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  embed: vi.fn(async (_text: string): Promise<number[]> => [1, 0]),
  corpus: vi.fn(async (_pov: string): Promise<{ nodeEmbeddings: Record<string, { vectors?: number[][] }> }> => ({ nodeEmbeddings: {} })),
  loadCorpus: vi.fn(async (_key: string): Promise<unknown> => ({ entries: [] })),
  recorded: [] as Array<{ level?: string; message: string; data?: Record<string, unknown> }>,
}));

vi.mock('../ai/aiBackends.js', async (orig) => ({
  ...(await orig<typeof import('../ai/aiBackends.js')>()),
  computeQueryEmbedding: (text: string) => h.embed(text),
}));
vi.mock('../routes/corpusAssemblyCache.js', async (orig) => ({
  ...(await orig<typeof import('../routes/corpusAssemblyCache.js')>()),
  getAssembledCorpus: (pov: string) => h.corpus(pov),
}));
vi.mock('../storage/fileIO.js', async (orig) => ({
  ...(await orig<typeof import('../storage/fileIO.js')>()),
  loadSyntheticCorpus: (key: string) => h.loadCorpus(key),
}));
vi.mock('../../../../lib/flight-recorder/index.js', async (orig) => ({
  ...(await orig<typeof import('../../../../lib/flight-recorder/index.js')>()),
  getGlobalRecorder: () => ({ record: (e: { level?: string; message: string; data?: Record<string, unknown> }) => { h.recorded.push(e); } }),
}));

import { createRouter, type Handler } from '../httpKit.js';
import { registerTaxonomyRoutes } from '../routes/taxonomy.js';

const routes: Array<{ method: string; path: string; handler: Handler }> = [];
registerTaxonomyRoutes(createRouter(routes), {} as never);
const handler = routes.find(r => r.method === 'POST' && r.path === '/api/taxonomy/chat-synthetic-statements')!.handler;

async function post(body: unknown): Promise<{ status: number; body: unknown }> {
  const out: { status?: number; text?: string } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; },
    end: (t?: string) => { out.text = t; },
    setHeader: () => {},
    writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  const req = { url: '/api/taxonomy/chat-synthetic-statements', headers: {}, method: 'POST' } as unknown as IncomingMessage;
  await handler(req, res, body);
  return { status: out.status ?? 200, body: out.text ? JSON.parse(out.text) : undefined };
}

const warns = (reason?: string) => h.recorded.filter(e => e.level === 'warn' && (reason === undefined || e.data?.reason === reason));

beforeEach(() => {
  h.embed.mockReset().mockResolvedValue([1, 0]);
  h.corpus.mockReset().mockResolvedValue({ nodeEmbeddings: {} });
  h.loadCorpus.mockReset().mockResolvedValue({ entries: [] });
  h.recorded.length = 0;
});

// Two statements for acc-beliefs-001: the first points along x, the second along y.
function seedNode(opts: { pruned?: boolean } = {}) {
  h.corpus.mockResolvedValue({ nodeEmbeddings: { 'acc-beliefs-001': { vectors: [[1, 0], [0, 1]] } } });
  h.loadCorpus.mockResolvedValue({ entries: [
    { node_id: 'acc-beliefs-001', statement: 'Along x.' },
    { node_id: 'acc-beliefs-001', statement: 'Dropped row.', pruned: true },
    { node_id: 'acc-beliefs-001', statement: 'Along y.' },
  ] });
  void opts;
}

describe('POST /api/taxonomy/chat-synthetic-statements (t/348)', () => {
  it('returns the argmax statement for each node, with no vectors or corpus in the response', async () => {
    seedNode();
    h.embed.mockResolvedValue([0.1, 1]); // closer to the y statement
    const r = await post({ pov: 'accelerationist', queryText: 'what about y', nodeIds: ['acc-beliefs-001'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ 'acc-beliefs-001': 'Along y.' });
    expect(JSON.stringify(r.body)).not.toMatch(/0\.1|\[1,|Dropped row/);
  });

  it('skips pruned rows when aligning statements to vectors', async () => {
    seedNode();
    h.embed.mockResolvedValue([1, 0]);
    const r = await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-001'] });
    expect(r.body).toEqual({ 'acc-beliefs-001': 'Along x.' });
  });

  it('an embed failure returns null for every node and WARNs once with reason embedding-unavailable (never throws)', async () => {
    seedNode();
    h.embed.mockRejectedValue(new Error('onnx down'));
    const r = await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-001', 'acc-beliefs-002'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ 'acc-beliefs-001': null, 'acc-beliefs-002': null });
    expect(warns('embedding-unavailable')).toHaveLength(1);
  });

  it('an empty query returns null for every node with reason embedding-unavailable, without embedding', async () => {
    seedNode();
    const r = await post({ pov: 'accelerationist', queryText: '   ', nodeIds: ['acc-beliefs-001'] });
    expect(r.body).toEqual({ 'acc-beliefs-001': null });
    expect(h.embed).not.toHaveBeenCalled();
    expect(warns('embedding-unavailable')).toHaveLength(1);
  });

  it('a node with no usable statements returns null and WARNs with reason no-usable-statements', async () => {
    seedNode();
    h.embed.mockResolvedValue([1, 0]);
    const r = await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-001', 'acc-beliefs-999'] });
    expect(r.body).toEqual({ 'acc-beliefs-001': 'Along x.', 'acc-beliefs-999': null });
    expect(warns('no-usable-statements')).toHaveLength(1);
    expect(warns('no-usable-statements')[0].data).toMatchObject({ nodeId: 'acc-beliefs-999' });
  });

  it('a skipped node WARNs on every request, not once per process (coverage gaps stay visible)', async () => {
    seedNode();
    h.embed.mockResolvedValue([1, 0]);
    await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-999'] });
    await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-999'] });
    expect(warns('no-usable-statements')).toHaveLength(2);
  });

  it('a vector/statement count mismatch counts as no usable statements (null, WARN), never a guessed match', async () => {
    h.corpus.mockResolvedValue({ nodeEmbeddings: { 'acc-beliefs-001': { vectors: [[1, 0]] } } });
    h.loadCorpus.mockResolvedValue({ entries: [
      { node_id: 'acc-beliefs-001', statement: 'A' }, { node_id: 'acc-beliefs-001', statement: 'B' },
    ] });
    const r = await post({ pov: 'accelerationist', queryText: 'x', nodeIds: ['acc-beliefs-001'] });
    expect(r.body).toEqual({ 'acc-beliefs-001': null });
    expect(warns('no-usable-statements')).toHaveLength(1);
  });

  it('a corpus load failure returns null for every node with reason corpus-unavailable (never throws)', async () => {
    // A POV no other test loads, so the process-lifetime statement memo cannot hide the failing read.
    h.corpus.mockResolvedValue({ nodeEmbeddings: { 'sa-beliefs-001': { vectors: [[1, 0]] } } });
    h.loadCorpus.mockRejectedValue(new Error('disk gone'));
    const r = await post({ pov: 'safetyist', queryText: 'x', nodeIds: ['sa-beliefs-001'] });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ 'sa-beliefs-001': null });
    expect(warns('corpus-unavailable')).toHaveLength(1);
  });

  it('rejects an unknown pov, a non-string queryText, bad nodeIds, and more than 12 nodes with 400', async () => {
    seedNode();
    expect((await post({ pov: 'nope', queryText: 'x', nodeIds: [] })).status).toBe(400);
    expect((await post({ pov: 'accelerationist', queryText: 5, nodeIds: [] })).status).toBe(400);
    expect((await post({ pov: 'accelerationist', queryText: 'x', nodeIds: [1] })).status).toBe(400);
    const thirteen = Array.from({ length: 13 }, (_, i) => `acc-beliefs-${i}`);
    expect((await post({ pov: 'accelerationist', queryText: 'x', nodeIds: thirteen })).status).toBe(400);
  });
});

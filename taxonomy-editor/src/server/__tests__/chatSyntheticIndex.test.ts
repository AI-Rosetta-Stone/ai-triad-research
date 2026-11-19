// @vitest-environment node
//
// t/425 — the chat synthetic-statements route returns the chosen statement's index. Default: text per node (the
// bridge contract is unchanged). `?withIndex=1`: { text, index } per node, or null when skipped. The index and the
// text come from the same argmax, and the text matches bestMatchingSyntheticStatement for every query.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const h = vi.hoisted(() => ({
  embed: vi.fn(async (_text: string): Promise<number[]> => [1, 0]),
  corpus: vi.fn(async (_pov: string): Promise<{ nodeEmbeddings: Record<string, { vectors?: number[][] }> }> => ({ nodeEmbeddings: {} })),
  loadCorpus: vi.fn(async (_key: string): Promise<unknown> => ({ entries: [] })),
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

import { createRouter, type Handler } from '../httpKit.js';
import { registerTaxonomyRoutes } from '../routes/taxonomy.js';
import { bestMatchingSyntheticStatement } from '../../../../lib/debate/syntheticStatementLookup.js';

const routes: Array<{ method: string; path: string; handler: Handler }> = [];
registerTaxonomyRoutes(createRouter(routes), {} as never);
const handler = routes.find(r => r.method === 'POST' && r.path === '/api/taxonomy/chat-synthetic-statements')!.handler;

async function post(query: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const out: { status?: number; text?: string } = {};
  const res = {
    writeHead: (s: number) => { out.status = s; }, end: (t?: string) => { out.text = t; },
    setHeader: () => {}, writableEnded: false, headersSent: false,
  } as unknown as ServerResponse;
  const url = `/api/taxonomy/chat-synthetic-statements${query}`;
  await handler({ url, headers: {}, method: 'POST' } as unknown as IncomingMessage, res, body);
  return { status: out.status ?? 200, body: out.text ? JSON.parse(out.text) : {} };
}

// Two statements for acc-beliefs-001: the first along x, the second along y.
function seed() {
  h.corpus.mockResolvedValue({ nodeEmbeddings: { 'acc-beliefs-001': { vectors: [[1, 0], [0, 1]] } } });
  h.loadCorpus.mockResolvedValue({ entries: [
    { node_id: 'acc-beliefs-001', statement: 'Along x.' },
    { node_id: 'acc-beliefs-001', statement: 'Along y.' },
  ] });
}

const BODY = { pov: 'accelerationist', queryText: 'a question', nodeIds: ['acc-beliefs-001', 'acc-beliefs-999'] };

beforeEach(() => {
  h.embed.mockReset().mockResolvedValue([0.1, 1]);
  h.corpus.mockReset().mockResolvedValue({ nodeEmbeddings: {} });
  h.loadCorpus.mockReset().mockResolvedValue({ entries: [] });
  seed();
});

describe('chat synthetic statements: the chosen index (t/425)', () => {
  it('the default response is { text, index } per node (the desktop shape), null when skipped', async () => {
    const r = await post('', BODY);
    expect(r.body).toEqual({ 'acc-beliefs-001': { text: 'Along y.', index: 1 }, 'acc-beliefs-999': null });
  });

  it('the index points at the text: statements[index] equals the text, for several queries', async () => {
    for (const q of [[1, 0], [0, 1], [0.6, 0.6], [0.9, 0.1]]) {
      h.embed.mockResolvedValue(q);
      const r = await post('', { ...BODY, nodeIds: ['acc-beliefs-001'] });
      const chosen = r.body['acc-beliefs-001'] as { text: string; index: number };
      expect(['Along x.', 'Along y.'][chosen.index]).toBe(chosen.text);
    }
  });

  it('the text agrees with bestMatchingSyntheticStatement for every query', async () => {
    const statements = { 'acc-beliefs-001': ['Along x.', 'Along y.'] };
    const vectors = { 'acc-beliefs-001': { vectors: [[1, 0], [0, 1]] } };
    for (const q of [[1, 0], [0, 1], [0.6, 0.6], [0.9, 0.1]]) {
      h.embed.mockResolvedValue(q);
      const indexed = await post('', { ...BODY, nodeIds: ['acc-beliefs-001'] });
      const text = bestMatchingSyntheticStatement('acc-beliefs-001', q, vectors, statements);
      expect((indexed.body['acc-beliefs-001'] as { text: string }).text).toBe(text);
    }
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeEmbeddingsChunked, EMBEDDINGS_MAX_BATCH, EMBEDDINGS_COMPUTE_TIMEOUT_MS } from '../embeddingsBatch';

const mockRecord = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord, intern: (_ns: string, v: string) => v }),
}));

// A fake `post` that returns one deterministic vector per input text ([index-within-request]),
// and records the batch size + ids of every call so we can assert chunking + ordering.
// `stats` optionally attaches per-chunk cacheHits/cacheMisses/corpusNodeCount to the response.
function makePost(stats?: { cacheHits: number; cacheMisses: number; corpusNodeCount?: number }) {
  const calls: { texts: string[]; ids?: string[] }[] = [];
  const post = vi.fn(async (_path: string, body?: unknown) => {
    const { texts, ids } = body as { texts: string[]; ids?: string[] };
    calls.push({ texts, ids });
    return { vectors: texts.map((_t, i) => [i]), ...(stats ?? {}) };
  });
  return { post, calls };
}

/** The client cache-stats FR record (t/3173), or undefined if none was emitted. */
function cacheStatRecord(): { data?: Record<string, unknown> } | undefined {
  return mockRecord.mock.calls
    .map((c) => c[0] as { component?: string; data?: Record<string, unknown> })
    .find((e) => e.component === 'embeddings-compute-client');
}

describe('computeEmbeddingsChunked', () => {
  it('sends a batch at the cap in a single POST (no behaviour change for small inputs)', async () => {
    const { post, calls } = makePost();
    const texts = Array.from({ length: EMBEDDINGS_MAX_BATCH }, (_v, i) => `t${i}`);
    const res = await computeEmbeddingsChunked(post, texts);
    expect(post).toHaveBeenCalledTimes(1);
    expect(calls[0].texts).toHaveLength(EMBEDDINGS_MAX_BATCH);
    expect(res.vectors).toHaveLength(EMBEDDINGS_MAX_BATCH);
    // idempotent flag preserved on the single-batch path, with the batch-sized client timeout (t/4287)
    expect(post).toHaveBeenCalledWith('/api/embeddings/compute', { texts, ids: undefined }, { idempotent: true, timeoutMs: EMBEDDINGS_COMPUTE_TIMEOUT_MS });
  });

  it('t/4287: the client timeout outlasts the server ceiling for a full batch and fits under ACA ingress', () => {
    // Server: ceil(n/128) × 45s + 5s margin. A max batch must not be aborted client-side first.
    const serverCeilingMs = Math.ceil(EMBEDDINGS_MAX_BATCH / 128) * 45_000 + 5_000;
    expect(EMBEDDINGS_COMPUTE_TIMEOUT_MS).toBeGreaterThan(serverCeilingMs);
    expect(EMBEDDINGS_COMPUTE_TIMEOUT_MS).toBeLessThan(240_000); // ACA ingress timeout
  });

  it('splits an oversized batch into ceil(n/cap) sequential POSTs, each within the cap', async () => {
    const { post, calls } = makePost();
    const n = 2587; // the incident batch size
    const texts = Array.from({ length: n }, (_v, i) => `t${i}`);
    await computeEmbeddingsChunked(post, texts);
    const expectedChunks = Math.ceil(n / EMBEDDINGS_MAX_BATCH); // 6 at cap 512
    expect(post).toHaveBeenCalledTimes(expectedChunks);
    for (const c of calls) expect(c.texts.length).toBeLessThanOrEqual(EMBEDDINGS_MAX_BATCH);
    // chunk sizes tile the input exactly (5×512 + 27)
    expect(calls.reduce((sum, c) => sum + c.texts.length, 0)).toBe(n);
    expect(calls[calls.length - 1].texts.length).toBe(n % EMBEDDINGS_MAX_BATCH);
  });

  it('concatenates vectors in input order and keeps ids aligned per chunk', async () => {
    // vector value encodes the ORIGINAL global index so we can prove ordering across chunks
    const post = vi.fn(async (_path: string, body?: unknown) => {
      const { texts } = body as { texts: string[] };
      return { vectors: texts.map((t) => [Number(t.slice(1))]) };
    });
    const n = EMBEDDINGS_MAX_BATCH + 5; // 2 chunks
    const texts = Array.from({ length: n }, (_v, i) => `t${i}`);
    const ids = Array.from({ length: n }, (_v, i) => `id${i}`);
    const res = await computeEmbeddingsChunked(post, texts, ids);
    expect(res.vectors).toEqual(Array.from({ length: n }, (_v, i) => [i]));
    // ids sliced in lockstep with texts: 2nd chunk starts at the cap boundary
    const secondCallIds = (post.mock.calls[1][1] as { ids: string[] }).ids;
    expect(secondCallIds[0]).toBe(`id${EMBEDDINGS_MAX_BATCH}`);
  });

  it('is strictly sequential — chunk N+1 starts only after chunk N resolves', async () => {
    const order: string[] = [];
    let active = 0;
    const post = vi.fn(async (_path: string, body?: unknown) => {
      const { texts } = body as { texts: string[] };
      active += 1;
      expect(active).toBe(1); // never two in-flight at once
      order.push(`start:${texts[0]}`);
      await Promise.resolve();
      order.push(`end:${texts[0]}`);
      active -= 1;
      return { vectors: texts.map(() => [0]) };
    });
    const texts = Array.from({ length: EMBEDDINGS_MAX_BATCH * 2 + 1 }, (_v, i) => `t${i}`); // 3 chunks
    await computeEmbeddingsChunked(post, texts);
    // each chunk fully ends before the next begins
    expect(order).toEqual([
      't0', 't0', `t${EMBEDDINGS_MAX_BATCH}`, `t${EMBEDDINGS_MAX_BATCH}`, `t${EMBEDDINGS_MAX_BATCH * 2}`, `t${EMBEDDINGS_MAX_BATCH * 2}`,
    ].flatMap((label, i) => (i % 2 === 0 ? [`start:${label}`] : [`end:${label}`])));
  });
});

describe('computeEmbeddingsChunked — client cache-stats FR record (t/3173)', () => {
  beforeEach(() => { mockRecord.mockClear(); });

  it('records item_count + summed cache_hits/cache_misses + has_ids for a single compute', async () => {
    const { post } = makePost({ cacheHits: 40, cacheMisses: 10, corpusNodeCount: 4144 });
    const texts = Array.from({ length: 50 }, (_v, i) => `t${i}`);
    const ids = texts.map((_t, i) => `n${i}`);
    await computeEmbeddingsChunked(post, texts, ids);

    const rec = cacheStatRecord();
    expect(rec).toBeDefined();
    expect(rec?.data).toMatchObject({ item_count: 50, has_ids: true, cache_hits: 40, cache_misses: 10, corpus_node_count: 4144 });
  });

  it('SUMS cache stats across chunks (one logical compute = one record)', async () => {
    const { post } = makePost({ cacheHits: 100, cacheMisses: 12 }); // per-chunk
    const texts = Array.from({ length: EMBEDDINGS_MAX_BATCH * 2 + 1 }, (_v, i) => `t${i}`); // 3 chunks
    await computeEmbeddingsChunked(post, texts);

    const recs = mockRecord.mock.calls.filter((c) => (c[0] as { component?: string }).component === 'embeddings-compute-client');
    expect(recs).toHaveLength(1); // exactly one record, not one per chunk
    expect(recs[0][0].data).toMatchObject({ item_count: EMBEDDINGS_MAX_BATCH * 2 + 1, cache_hits: 300, cache_misses: 36, has_ids: false });
  });

  it('emits NO record when the server response omits cache stats (older server)', async () => {
    const { post } = makePost(); // vectors only, no cacheHits/cacheMisses
    await computeEmbeddingsChunked(post, ['a', 'b'], ['n0', 'n1']);
    expect(cacheStatRecord()).toBeUndefined();
  });

  it('emits no record and makes no POST for an empty batch', async () => {
    const { post } = makePost({ cacheHits: 0, cacheMisses: 0 });
    const res = await computeEmbeddingsChunked(post, []);
    expect(post).not.toHaveBeenCalled();
    expect(res.vectors).toEqual([]);
    expect(cacheStatRecord()).toBeUndefined();
  });
});

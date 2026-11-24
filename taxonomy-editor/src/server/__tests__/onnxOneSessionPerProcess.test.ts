// @vitest-environment node
// t/520 (TL p/16#305): one ONNX session per process, and bounded miss batches.
// Staging was killed at its 0.5 GiB limit right after a second ONNX model load (t/520#12): the query embed
// warmed a main-thread session next to the worker's (t/520#13). With the offload flag on, the worker owns
// the only session; with it off, the main thread does. The leaf computes are mocked and count the sessions
// each side would load (a side loads its session on its first call), so "the model loads once" is a count.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  mainLoads: 0, workerLoads: 0,
  mainCalls: [] as string[][], workerCalls: [] as string[][],
  info: vi.fn(),
}));

vi.mock('../../../../lib/embeddings/onnxEmbedding.js', () => {
  const load = () => { if (h.mainLoads === 0) h.mainLoads = 1; };
  return {
    tryWarmup: vi.fn(async () => { load(); return true; }),
    warmup: vi.fn(async () => { load(); }),
    computeEmbedding: vi.fn(async (t: string) => { load(); h.mainCalls.push([t]); return [0.1, 0.2]; }),
    computeEmbeddings: vi.fn(async (t: string[]) => { load(); h.mainCalls.push(t); return t.map(() => [0.1, 0.2]); }),
  };
});
vi.mock('../../../../lib/embeddings/offThreadEmbedding.js', () => ({
  computeEmbeddingsOffThread: vi.fn(async (t: string[]) => {
    if (h.workerLoads === 0) h.workerLoads = 1;
    h.workerCalls.push(t);
    return t.map(() => Float32Array.from([0.1, 0.2]));
  }),
  isWorkerPoolShedError: () => false,
  poolStats: () => ({ queueDepth: 0, cap: 0, liveSlots: 1 }),
}));
vi.mock('../logger.js', () => {
  const l = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { log: { server: l(), api: { ...l(), info: h.info }, ai: l() } };
});
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }), setGlobalRecorder: vi.fn() }));
// Empty precomputed cache: every corpus text is a miss.
vi.mock('../storage/readDataFile.js', () => ({ readDataFile: vi.fn(async () => Buffer.from('{"nodes":{}}')) }));
vi.mock('../ai/fsCache.js', () => ({ readFileWithMtime: vi.fn(() => ({ content: '{}', mtimeMs: 1 })) }));

import { computeEmbeddings, computeQueryEmbedding, _resetEmbeddingsCacheForTest, _setPythonAvailableForTest } from '../ai/aiBackends.js';
import { computeInSubBatches, ONNX_MISS_BATCH } from '../ai/onnxSubBatches.js';

const corpusMisses = (n: number) => Array.from({ length: n }, (_, i) => `uncached node text ${i}`);
let queryN = 0;
const freshQuery = () => `query ${++queryN} ${Date.now()}`; // the query cache must not answer it

beforeEach(() => {
  h.mainLoads = 0; h.workerLoads = 0; h.mainCalls.length = 0; h.workerCalls.length = 0; h.info.mockClear();
  _resetEmbeddingsCacheForTest();
  _setPythonAvailableForTest(false); // ONNX only, the hosted shape
});
afterEach(() => { delete process.env.EMBEDDING_WORKER_OFFLOAD; });

describe('t/520: one ONNX session per process', () => {
  it('offload on: a query embed plus a 20-text corpus batch load the model once, in the worker, never on the main thread', async () => {
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    await computeQueryEmbedding(freshQuery());
    await computeEmbeddings(corpusMisses(20), undefined, undefined, { requester: 'corpus-assembly' });
    expect(h.mainLoads + h.workerLoads).toBe(1);
    expect(h.workerLoads).toBe(1);
    expect(h.mainLoads).toBe(0);
    expect(h.mainCalls).toEqual([]);
  });

  it('offload off: the same pair loads the model once, on the main thread, and never touches the worker', async () => {
    await computeQueryEmbedding(freshQuery());
    await computeEmbeddings(corpusMisses(20), undefined, undefined, { requester: 'corpus-assembly' });
    expect(h.mainLoads + h.workerLoads).toBe(1);
    expect(h.mainLoads).toBe(1);
    expect(h.workerCalls).toEqual([]);
  });
});

describe('t/520: corpus misses are embedded in bounded sub-batches', () => {
  it(`20 corpus misses reach the worker as ceil(20/${ONNX_MISS_BATCH}) calls, none larger than ONNX_MISS_BATCH, in order`, async () => {
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    const texts = corpusMisses(20);
    const { vectors } = await computeEmbeddings(texts, undefined, undefined, { requester: 'corpus-assembly' });
    expect(vectors).toHaveLength(20);
    expect(h.workerCalls).toHaveLength(Math.ceil(20 / ONNX_MISS_BATCH));
    expect(Math.max(...h.workerCalls.map(c => c.length))).toBeLessThanOrEqual(ONNX_MISS_BATCH);
    expect(h.workerCalls.flat()).toEqual(texts);
  });

  it.each([1, 2, 4, 7, 20, 25])('computeInSubBatches(20 texts, size %i) makes ceil(20/size) calls and keeps order', async (size) => {
    const texts = corpusMisses(20);
    const calls: string[][] = [];
    const out = await computeInSubBatches(texts, size, 'test', async (b) => { calls.push(b); return b.map(t => t.toUpperCase()); });
    expect(calls).toHaveLength(Math.ceil(20 / size));
    expect(out).toEqual(texts.map(t => t.toUpperCase()));
  });

  it('logs process RSS and the batch size at info before each sub-batch', async () => {
    await computeInSubBatches(corpusMisses(5), 2, 'corpus-assembly', async (b) => b);
    const lines = h.info.mock.calls.filter(([, msg]) => msg === 'embedding batch start');
    expect(lines).toHaveLength(3);
    expect(lines.map(([f]) => (f as { batchSize: number }).batchSize)).toEqual([2, 2, 1]);
    for (const [f] of lines) {
      expect(f).toMatchObject({ requester: 'corpus-assembly', totalTexts: 5 });
      expect((f as { rssMiB: number }).rssMiB).toBeGreaterThan(0);
    }
  });
});

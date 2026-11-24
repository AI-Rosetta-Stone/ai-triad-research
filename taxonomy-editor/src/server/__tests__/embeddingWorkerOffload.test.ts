// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3183 (t/2977 Item B) — computeEmbeddings delegates the ONNX miss-text pass to the shared
// off-thread worker (t/3181) behind the per-build capability switch EMBEDDING_WORKER_OFFLOAD.
//
// The headline proof is the BOTH-ARMS LIVENESS test the t/3165 incident lacked: under a ≥1347-text
// compute, the main-thread event-loop max-gap stays under the ACA liveness deadline with the flag
// ON (work is off-thread) and BLOWS the deadline with it OFF (a 128-text ONNX chunk blocks the loop
// synchronously). The other four tests lock the contract: flag-OFF byte-identical, flag-ON routes to
// the worker + widens Float32Array→number[], the requester label reaches the worker, and the C6
// demand-baseline WARN fires above the by-design novel-text ceiling / stays silent at it.
//
// The REAL resolveEmbeddings + resolveEmbeddingsChunked run (chunk-and-yield is the mechanism under
// test); only the two leaf computes (onnx in-thread / off-thread worker) and the data-file read are
// mocked. isPythonEmbeddingAvailable is forced false so the chain is onnx-only (the ACA shape).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';

const { onnxCompute, offthread, records } = vi.hoisted(() => ({
  onnxCompute: vi.fn(),
  offthread: vi.fn(),
  records: [] as Array<{ level?: string; message?: string; data?: Record<string, unknown> }>,
}));

// onnx-only chain (Python venv absent = the ACA shape). tryWarmup true → the onnx member is pushed.
vi.mock('../../../../lib/embeddings/onnxEmbedding.js', () => ({
  tryWarmup: vi.fn(async () => true),
  warmup: vi.fn(async () => true),
  computeEmbedding: vi.fn(async () => []),
  computeEmbeddings: onnxCompute,
}));
// The worker contract (t/3181) — mocked so this test never spawns a real thread.
vi.mock('../../../../lib/embeddings/offThreadEmbedding.js', () => ({ computeEmbeddingsOffThread: offthread }));
// Capture FR records so the demand-baseline WARN is assertable.
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: () => ({ record: (r: unknown) => { records.push(r as { message?: string }); } }),
  setGlobalRecorder: vi.fn(),
}));
// Empty cache → every text is a miss → the whole batch flows to the chain compute.
vi.mock('../storage/readDataFile.js', () => ({ readDataFile: vi.fn(async () => Buffer.from('{"nodes":{}}')) }));
vi.mock('../ai/fsCache.js', () => ({ readFileWithMtime: vi.fn(() => ({ content: '{}', mtimeMs: 1 })) }));

import { computeEmbeddings, _resetEmbeddingsCacheForTest, _setPythonAvailableForTest } from '../ai/aiBackends.js';
import { ONNX_MISS_BATCH } from '../ai/onnxSubBatches.js';

const DIM = 8; // tiny vectors — dimensionality is irrelevant to liveness/conversion, keep the test cheap.

/** Busy-spin the main thread for `ms` (simulates a synchronous ONNX batch blocking the event loop). */
function blockFor(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* deliberate synchronous block */ }
}

/** Measure the worst main-thread stall while `run` executes, via a recursive-setImmediate heartbeat. */
async function maxEventLoopGapDuring(run: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let maxGap = 0;
  let running = true;
  const tick = (): void => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  await run();
  running = false;
  return maxGap;
}

const vecs = (n: number, dim = DIM): number[][] => Array.from({ length: n }, () => new Array(dim).fill(0.1));
const f32vecs = (n: number, dim = DIM): Float32Array[] => Array.from({ length: n }, () => Float32Array.from(new Array(dim).fill(0.1)));

describe('computeEmbeddings worker offload (t/3183)', () => {
  beforeEach(() => {
    _resetEmbeddingsCacheForTest();
    _setPythonAvailableForTest(false); // chain = onnx only
    onnxCompute.mockReset();
    offthread.mockReset();
    records.length = 0;
    onnxCompute.mockImplementation(async (t: string[]) => vecs(t.length));
    offthread.mockImplementation(async (t: string[]) => f32vecs(t.length));
    delete process.env.EMBEDDING_WORKER_OFFLOAD;
  });
  afterEach(() => { delete process.env.EMBEDDING_WORKER_OFFLOAD; });

  // ── The both-arms liveness proof (the assertion the t/3165 incident lacked) ──
  it('LIVENESS: flag OFF starves the event loop on a ≥1347-text compute; flag ON keeps it live', async () => {
    const N = 1347;
    const texts = Array.from({ length: N }, (_, i) => `novel-${i}`);
    const BLOCK_MS = 50;   // a single 128-text ONNX chunk's synchronous cost, simulated
    const DEADLINE_MS = 30; // the assertion threshold (well under ACA's liveness budget), injectable here

    // Arm OFF: in-thread onnx blocks synchronously per chunk → the loop stalls past the deadline.
    delete process.env.EMBEDDING_WORKER_OFFLOAD;
    // t/520: misses now reach ONNX in sub-batches of ONNX_MISS_BATCH, so the simulated cost is per text: a
    // 128-text chunk still costs BLOCK_MS in total, and the sub-batches inside a chunk run without yielding.
    onnxCompute.mockImplementation(async (t: string[]) => { blockFor((BLOCK_MS * t.length) / 128); return vecs(t.length); });
    const gapOff = await maxEventLoopGapDuring(() => computeEmbeddings(texts));
    expect(gapOff).toBeGreaterThanOrEqual(DEADLINE_MS); // starves — this is the incident, reproduced
    expect(offthread).not.toHaveBeenCalled();

    // Arm ON: the worker does the same work off the caller's thread → the main loop stays responsive.
    // Model that honestly: the mock resolves via setImmediate and NEVER blocks the caller's stack (a
    // real worker's compute runs on its own thread; only the transferred result crosses back).
    _resetEmbeddingsCacheForTest();
    records.length = 0;
    onnxCompute.mockClear(); // drop the OFF-arm call history so the ON-arm "never touched" check is honest
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    offthread.mockImplementation((t: string[]) => new Promise<Float32Array[]>((resolve) => {
      setImmediate(() => resolve(f32vecs(t.length))); // resolves without blocking the caller's loop
    }));
    const gapOn = await maxEventLoopGapDuring(() => computeEmbeddings(texts));
    expect(gapOn).toBeLessThan(DEADLINE_MS); // live — the loop yields between chunks, nothing blocks it
    expect(offthread).toHaveBeenCalled();
    expect(onnxCompute).not.toHaveBeenCalled(); // flag ON never touches the in-thread path
  });

  it('flag OFF is byte-identical: runs the in-thread onnx path, never the worker', async () => {
    delete process.env.EMBEDDING_WORKER_OFFLOAD;
    const { vectors, cacheMisses } = await computeEmbeddings(['a', 'b', 'c']);
    expect(cacheMisses).toBe(3);
    expect(vectors).toHaveLength(3);
    expect(onnxCompute).toHaveBeenCalledTimes(Math.ceil(3 / ONNX_MISS_BATCH)); // t/520: sub-batched misses
    expect(offthread).not.toHaveBeenCalled();
  });

  it('flag ON routes to the worker and widens Float32Array[] → number[][]', async () => {
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    offthread.mockImplementation(async (t: string[]) =>
      t.map((txt) => { const i = ['x', 'y'].indexOf(txt); return Float32Array.from([i, i + 0.5, i + 0.25, 0, 0, 0, 0, 0]); })); // keyed by text: misses arrive sub-batched (t/520)
    const { vectors } = await computeEmbeddings(['x', 'y']);
    expect(offthread).toHaveBeenCalledTimes(Math.ceil(2 / ONNX_MISS_BATCH)); // t/520: sub-batched misses
    expect(onnxCompute).not.toHaveBeenCalled();
    expect(Array.isArray(vectors[0])).toBe(true);          // number[], not a Float32Array view
    expect(vectors[0][0]).toBeCloseTo(0);
    expect(vectors[1][1]).toBeCloseTo(1.5);                // second text, second component
  });

  it('threads the requester label into the worker (so a shed WARN names who was dropped)', async () => {
    process.env.EMBEDDING_WORKER_OFFLOAD = '1';
    await computeEmbeddings(['q'], undefined, undefined, { requester: 'my-caller' });
    expect(offthread).toHaveBeenCalledWith(expect.any(Array), { requester: 'my-caller' });
  });

  it('C6 demand cap-and-WARN: fires above the by-design baseline, silent at/below it', async () => {
    const over = Array.from({ length: 300 }, (_, i) => `t${i}`); // 300 misses > 256 baseline
    await computeEmbeddings(over);
    const warn = records.find(r => r.level === 'warn' && /exceeds by-design baseline/.test(r.message ?? ''));
    expect(warn).toBeDefined();
    expect(warn!.data).toMatchObject({ requester: 'unknown', cacheMisses: 300, baseline: 256 });

    records.length = 0;
    _resetEmbeddingsCacheForTest();
    await computeEmbeddings(Array.from({ length: 100 }, (_, i) => `s${i}`)); // 100 ≤ 256 → silent
    expect(records.find(r => r.level === 'warn' && /exceeds by-design baseline/.test(r.message ?? ''))).toBeUndefined();
  });
});

// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3165 — the synthetic-embeddings serialize-once cache + the httpKit chunk-yield serializer.
// Root cause: /api/taxonomy/synthetic-embeddings rebuilt (network .npy read + parse + build) AND
// re-`JSON.stringify`'d the STATIC ~4144-vector / ~400MB corpus on every debate-triggered GET — an
// un-yielded ~3s main-thread block + ~400MB GC churn. Fix: serialize once, cache the Buffer, serve it
// near-free; promise-dedupe so a cold-start burst launches ONE build; chunk-yield the cold serialize.
//
// These lock: (1) jsonStringifyChunked is byte-identical to JSON.stringify (arrays/objects/null/edge
// cases) so the response contract is unchanged; (2) the cache serves from memory (loader NOT re-called),
// dedupes concurrent cold callers to one build, and the invalidator forces a rebuild.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadSynth } = vi.hoisted(() => ({ loadSynth: vi.fn() }));
vi.mock('../storage/fileIO.js', () => ({ loadSyntheticEmbeddings: loadSynth }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { jsonStringifyChunked } from '../httpKit.js';
import { __getSyntheticEmbeddingsBufferForTest as getBuffer, __invalidateSyntheticEmbeddingsCache as invalidate } from '../routes/taxonomy.js';

describe('jsonStringifyChunked — byte-identical to JSON.stringify (t/3165)', () => {
  // yieldEvery=2 forces the yield path even on tiny inputs.
  const cases: Array<[string, unknown]> = [
    ['number[][] array', [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9]]],
    ['synthetic-embeddings-shaped map', { n1: { pov: 'acc', vectors: [[0.1, 0.2]] }, n2: { pov: 'saf', vectors: [[0.3, 0.4]] } }],
    ['null', null],
    ['empty array', []],
    ['empty object', {}],
    ['object with undefined-valued key (omitted)', { a: 1, b: undefined, c: 3 }],
    ['array with undefined slot (→ null)', [1, undefined, 3]],
    ['nested + strings + numbers', { k: 'v"quote', arr: [1, [2, 3], { deep: true }], n: -0.5 }],
    ['string primitive', 'hello'],
    ['number primitive', 42],
  ];
  for (const [name, value] of cases) {
    it(name, async () => {
      const buf = await jsonStringifyChunked(value, 2);
      expect(buf.toString('utf-8')).toBe(JSON.stringify(value) ?? 'null');
    });
  }

  it('round-trips a larger map identically', async () => {
    const big: Record<string, { pov: string; vectors: number[][] }> = {};
    for (let i = 0; i < 500; i++) big[`node-${i}`] = { pov: i % 2 ? 'acc' : 'saf', vectors: [[i, i + 0.5, i + 0.25]] };
    const buf = await jsonStringifyChunked(big, 64);
    expect(buf.toString('utf-8')).toBe(JSON.stringify(big));
    expect(JSON.parse(buf.toString('utf-8'))).toEqual(big);
  });

  // t/4286: the per-item stringify loop already yielded every `yieldEvery` items (t/3165), but
  // the OLD implementation's final assembly — `parts.join(',')` then `Buffer.from(hugeString)` —
  // was one synchronous pass over the ENTIRE result, outside any yield. Manually benchmarked at
  // the real synthetic-embeddings corpus scale (4144 nodes, ~400MB JSON-equivalent): the old
  // join+Buffer.from took ~519ms in one block; building per-item Buffers during the already-
  // yielding loop and assembling with Buffer.concat took ~149ms (numbers + methodology on
  // t/4286#1). Not asserted here as a timing test — wall-clock thresholds are too CI-variance-
  // prone at this scale to be a reliable regression guard — but the correctness tests above
  // (byte-identical output, including this larger map) cover the Buffer.concat rewrite directly.
  // NOTE (t/4286#1): this fix is real but modest; the dominant contributor to the canary's
  // 1.7-3.8s event-loop block is diagnosed as `extractNodeVectors()` (lib/npy.ts) called from
  // `loadSyntheticEmbeddings()` (storage/fileIO.ts) — both outside this file's scope, routed to
  // their owners separately.
});

describe('synthetic-embeddings serialize-once cache (t/3165)', () => {
  const sample = { n1: { pov: 'acc', vectors: [[0.1, 0.2]] } };

  beforeEach(() => {
    invalidate();
    loadSynth.mockReset();
  });

  it('serves from cache on the 2nd call — loader runs ONCE', async () => {
    loadSynth.mockResolvedValue(sample);
    const b1 = await getBuffer();
    const b2 = await getBuffer();
    expect(loadSynth).toHaveBeenCalledTimes(1); // cache hit, no rebuild
    expect(b1).toBe(b2); // same cached Buffer instance
    expect(JSON.parse(b1.toString('utf-8'))).toEqual(sample);
  });

  it('promise-dedupe: a concurrent cold burst launches ONE build', async () => {
    let resolveLoad!: (v: unknown) => void;
    loadSynth.mockReturnValue(new Promise((r) => { resolveLoad = r; }));
    const p1 = getBuffer();
    const p2 = getBuffer();
    const p3 = getBuffer();
    resolveLoad(sample);
    const [b1, b2, b3] = await Promise.all([p1, p2, p3]);
    expect(loadSynth).toHaveBeenCalledTimes(1); // single-flight — not 3 builds
    expect(b1).toBe(b2);
    expect(b2).toBe(b3);
  });

  it('invalidator forces a rebuild on the next call', async () => {
    loadSynth.mockResolvedValue(sample);
    await getBuffer();
    invalidate();
    await getBuffer();
    expect(loadSynth).toHaveBeenCalledTimes(2); // rebuilt after invalidation
  });

  it('a failed cold build is not cached — the next call retries', async () => {
    loadSynth.mockRejectedValueOnce(new Error('npy read failed')).mockResolvedValue(sample);
    await expect(getBuffer()).rejects.toThrow('npy read failed');
    const b = await getBuffer(); // retries, succeeds
    expect(loadSynth).toHaveBeenCalledTimes(2);
    expect(JSON.parse(b.toString('utf-8'))).toEqual(sample);
  });

  it('null corpus (no synth files) serializes to `null` and is served', async () => {
    loadSynth.mockResolvedValue(null);
    const b = await getBuffer();
    expect(b.toString('utf-8')).toBe('null');
  });

  it('generation-guard: invalidate() during an in-flight cold build does NOT cache the stale bytes (t/3237)', async () => {
    let resolveLoad!: (v: unknown) => void;
    const fresh = { n2: { pov: 'saf', vectors: [[9, 9]] } };
    loadSynth.mockReturnValueOnce(new Promise((r) => { resolveLoad = r; })).mockResolvedValue(fresh);
    const p = getBuffer();      // cold build in-flight
    invalidate();               // invalidation lands MID-BUILD → bumps the generation
    resolveLoad(sample);        // the in-flight build resolves with the now-stale sample
    const stale = await p;
    expect(JSON.parse(stale.toString('utf-8'))).toEqual(sample); // the awaiter still gets its requested bytes
    const next = await getBuffer();                              // NOT cached → rebuilds
    expect(loadSynth).toHaveBeenCalledTimes(2);
    expect(JSON.parse(next.toString('utf-8'))).toEqual(fresh);   // serves the fresh generation
  });

  it('jsonStringifyChunked does NOT honor a top-level toJSON (documented caveat, t/3237)', async () => {
    const withTopLevelToJSON = { toJSON: () => 'custom', a: 1 } as unknown;
    const buf = await jsonStringifyChunked(withTopLevelToJSON, 2);
    // JSON.stringify honors toJSON → '"custom"'; the chunked serializer iterates entries directly.
    expect(buf.toString('utf-8')).not.toBe(JSON.stringify(withTopLevelToJSON));
    expect(JSON.parse(buf.toString('utf-8'))).toEqual({ a: 1 }); // function value omitted, a:1 kept
  });
});

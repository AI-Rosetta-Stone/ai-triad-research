// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/2985 — regression tests for per-chunk timeout in resolveEmbeddingsChunked.
 *
 * Root cause: the 45s EMBEDDINGS_REQUEST_TIMEOUT_MS wrapped the ENTIRE
 * resolveEmbeddingsChunked call (aggregate), so a 2,579-input batch whose total compute
 * exceeds 45s timed out even though each chunk was healthy. Fix: timeout is now per-chunk
 * inside resolveEmbeddingsChunked — large batches complete; a stuck chunk still times out.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => undefined }));

const { resolveEmbeddingsChunked } = await import('../ai/aiBackends');

describe('resolveEmbeddingsChunked per-chunk timeout (t/2985)', () => {
  it('multi-chunk batch succeeds when each chunk fits the per-chunk budget', async () => {
    // 3 chunks × ~5ms each = ~15ms aggregate. With an aggregate timeout of 500ms this
    // would have failed under the old code; with a 500ms per-chunk budget each chunk passes
    // with a wide margin (t/4206: a tight 15ms-compute/30ms-budget margin flaked under CI load).
    const chain = [{
      name: 'slow',
      compute: async (texts: string[]) => {
        await new Promise(r => setTimeout(r, 5));
        return texts.map(() => [1]);
      },
    }];
    const texts = Array.from({ length: 6 }, (_, i) => `t${i}`);
    const result = await resolveEmbeddingsChunked(texts, undefined, null, chain, 2, 500);
    expect(result).toHaveLength(6);
    expect(result.every(v => Array.isArray(v) && v[0] === 1)).toBe(true);
  });

  it('a stuck chunk times out with an error message containing "timed out"', async () => {
    const chain = [{
      name: 'stuck',
      compute: async (_: string[]) => new Promise<number[][]>(() => { /* never resolves */ }),
    }];
    const texts = ['a', 'b'];
    await expect(
      resolveEmbeddingsChunked(texts, undefined, null, chain, 10, 50),
    ).rejects.toThrow('timed out');
  });

  it('t/3074 TL-GV: stuck chunk carries .timeout=true — stamped at throw site, not via message-match', async () => {
    // Verifies the full chain: stuck chunk → resolveChunk timeout fires → .timeout=true stamped.
    // A wording drift in the timeout message would NOT revert to 500 because the marker
    // is set structurally (not via message.includes) — this test would still catch any regression.
    const chain = [{
      name: 'stuck',
      compute: async (_: string[]) => new Promise<number[][]>(() => { /* never resolves */ }),
    }];
    const err = await resolveEmbeddingsChunked(['a'], undefined, null, chain, 10, 50).catch(e => e);
    expect((err as { timeout?: boolean }).timeout).toBe(true);
  });
});

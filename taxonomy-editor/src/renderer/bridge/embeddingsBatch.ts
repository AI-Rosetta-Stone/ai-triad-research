// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

// Client-side batch chunking for POST /api/embeddings/compute (t/3072).
//
// The server processes the whole request inside a single 50s withEndpointTimeout('embeddings-compute')
// window — it compute-chunks internally at EMBEDDING_COMPUTE_CHUNK=256 (t/2914), but all within that
// one timeout. A single oversized batch blows the 50s ceiling → 504 → 500 → 'mutation' circuit-breaker
// cascade (incident e8760507 sent 2587 items; prior calls of 643 and 792 succeeded). Bounding each POST
// to a safe size turns one catastrophic timeout into sequential, recoverable chunks.

const EMBEDDINGS_COMPUTE_PATH = '/api/embeddings/compute';

/**
 * Max texts per compute POST. Provisional (t/3072): 512 = 2× the server compute-chunk
 * (EMBEDDING_COMPUTE_CHUNK=256, t/2914). Chosen SAFELY BELOW the known-good 792/643-item calls from
 * incident e8760507 (2587 items was the failure) so a full chunk completes well under the 50s
 * 'embeddings-compute' endpoint timeout even under load — a valid safe cap without production
 * calibration. t/3071's batch_size observability is only needed to tune this UP later; recalibrate
 * here (one line) once that data lands, and never raise it above the smallest observed failure
 * without evidence.
 */
export const EMBEDDINGS_MAX_BATCH = 512;

/**
 * Client timeout per compute POST (t/4287). The server scales its endpoint timeout by chunk count:
 * ceil(n / EMBEDDING_COMPUTE_CHUNK=128) × 45s + margin, about 185s for a full EMBEDDINGS_MAX_BATCH
 * (4 chunks). web-bridge's DEFAULT_MUTATION_TIMEOUT_MS (180s) would abort a max-size batch before the
 * server's own guard fires, so this sits just above the server ceiling and below ACA's 240s ingress
 * timeout. Revisit if EMBEDDINGS_MAX_BATCH or the server's per-chunk budget changes.
 */
export const EMBEDDINGS_COMPUTE_TIMEOUT_MS = 200_000;

/** Minimal shape of web-bridge's generic `post` used here (path, JSON body, idempotent flag, timeout). */
type EmbeddingsPost = <T = unknown>(
  path: string,
  body?: unknown,
  opts?: { idempotent?: boolean; timeoutMs?: number },
) => Promise<T>;

/**
 * Compute response. `cacheHits`/`cacheMisses`/`corpusNodeCount` were added server-side in #1704
 * (t/3165); optional here so an older/other server that returns only `vectors` still type-checks.
 */
interface ComputeResponse {
  vectors: number[][];
  cacheHits?: number;
  cacheMisses?: number;
  corpusNodeCount?: number;
}

/**
 * Record the compute cache-resolution stats into the RENDERER flight recorder (t/3173, t/3165 Q3a).
 * The server's own `embedding.compute` record is excluded from an anonymous debate's merged dump
 * (anon has no session branch → the whole server dump is dropped), so the client half is what makes
 * "novel-text volume vs keyed cache-miss" visible in the anon dump: high item_count + cacheHits=0 +
 * no ids = volume (t/2977); cacheHits=0 WITH ids = a keyed miss (the t/3165 shape). Summed across
 * chunks so one logical compute = one record. Best-effort: skipped if the server omitted the stats.
 */
function recordComputeCacheStats(
  itemCount: number,
  hasIds: boolean,
  hits: number | undefined,
  misses: number | undefined,
  corpusNodeCount: number | undefined,
): void {
  if (hits === undefined && misses === undefined) return; // server didn't report stats — nothing to record
  getGlobalRecorder()?.record({
    type: 'system.info',
    component: 'embeddings-compute-client',
    level: 'info',
    message: 'embedding.compute (client)',
    data: {
      item_count: itemCount,
      has_ids: hasIds,
      cache_hits: hits ?? 0,
      cache_misses: misses ?? 0,
      ...(corpusNodeCount !== undefined && { corpus_node_count: corpusNodeCount }),
    },
  });
}

/**
 * Split texts/ids into ≤EMBEDDINGS_MAX_BATCH slices and POST them SEQUENTIALLY — never
 * concurrently, which would re-burst the very server this guards (TL, t/3072). Vectors are
 * concatenated in input order, so the return shape is identical to a single compute call. Each
 * chunk keeps idempotent:true so a load-shed 503 (retryable + Retry-After) still gets its one
 * retry, and embeddings are a pure function of inputs (t/2922).
 */
export async function computeEmbeddingsChunked(
  post: EmbeddingsPost,
  texts: string[],
  ids?: string[],
): Promise<{ vectors: number[][] }> {
  const vectors: number[][] = [];
  let hits = 0;
  let misses = 0;
  let sawStats = false;
  let corpusNodeCount: number | undefined;
  for (let i = 0; i < texts.length; i += EMBEDDINGS_MAX_BATCH) {
    const textChunk = texts.slice(i, i + EMBEDDINGS_MAX_BATCH);
    const idChunk = ids ? ids.slice(i, i + EMBEDDINGS_MAX_BATCH) : undefined;
    // Awaited in the loop → strictly sequential; the next chunk starts only after this one resolves.
    const res = await post<ComputeResponse>(
      EMBEDDINGS_COMPUTE_PATH,
      { texts: textChunk, ids: idChunk },
      { idempotent: true, timeoutMs: EMBEDDINGS_COMPUTE_TIMEOUT_MS },
    );
    vectors.push(...res.vectors);
    if (res.cacheHits !== undefined || res.cacheMisses !== undefined) {
      sawStats = true;
      hits += res.cacheHits ?? 0;
      misses += res.cacheMisses ?? 0;
      if (res.corpusNodeCount !== undefined) corpusNodeCount = res.corpusNodeCount;
    }
  }
  recordComputeCacheStats(texts.length, !!ids, sawStats ? hits : undefined, sawStats ? misses : undefined, corpusNodeCount);
  return { vectors };
}

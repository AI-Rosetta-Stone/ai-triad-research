// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/520: bounded ONNX calls, and the one-session rule's worker path.
//
// A staging container (0.5 GiB) was killed right after a second ONNX model load (t/520#12): the query
// embed warmed a main-thread session next to the worker's (t/520#13). With the worker offload on, the
// worker owns the only session; callers that used the main thread go through embedViaWorker instead.

import { computeEmbeddingsOffThread } from '../../../../lib/embeddings/offThreadEmbedding.js';
import { log } from '../logger.js';

// The most cache-miss texts one ONNX call embeds. An ONNX batch's working memory sits on top of the resident
// model. Measured on origin/main's built worker path, one session, 20 distinct ~400-char misses, peak process
// RSS (3 runs each): one batch of 20: 605-616 MiB; 8: 477-481; 4: 418-425; 2: 386-400; 1: 375-397, the same
// as embedding a single text (382-396 MiB, the resident-model floor). At 100 misses, 1 per call was also the
// fastest (1.2 s vs 2.0 s at 2 and 1.6 s at 4), so the bound costs no time. Two sessions peaked at 731-744.
export const ONNX_MISS_BATCH = 1;

const MiB = (bytes: number): number => Math.round(bytes / 1048576);

/** Run `compute` over `texts` in sub-batches of at most `size`, in order. Before each sub-batch, log the
 *  process RSS and the batch size at info: an out-of-memory kill is a SIGKILL, which no handler can catch,
 *  so the last of these lines is the trail it leaves. */
export async function computeInSubBatches<V>(
  texts: string[],
  size: number,
  requester: string,
  compute: (batch: string[]) => Promise<V[]>,
): Promise<V[]> {
  const out: V[] = [];
  for (let i = 0; i < texts.length; i += size) {
    const batch = texts.slice(i, i + size);
    log.api.info({
      component: 'api', subsystem: 'ai-backends', requester,
      batchSize: batch.length, batchIndex: i / size, totalTexts: texts.length, rssMiB: MiB(process.memoryUsage().rss),
    }, 'embedding batch start');
    for (const v of await compute(batch)) out.push(v);
  }
  return out;
}

/** Embed `texts` in the worker (the process's only ONNX session when the offload is on), in bounded
 *  sub-batches, widened to number[][]. Rejects as the worker does; callers must not fall back in-process. */
export async function embedViaWorker(texts: string[], requester: string, size: number = ONNX_MISS_BATCH): Promise<number[][]> {
  const vecs = await computeInSubBatches(texts, size, requester, (b) => computeEmbeddingsOffThread(b, { requester }));
  return vecs.map(v => Array.from(v));
}

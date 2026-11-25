// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License.

/**
 * The one place the debate engine's phases embed text (t/561).
 *
 * The phases used to import lib/embeddings/onnxEmbedding directly, which loads a main-thread ONNX
 * session. On the hosted server the embedding worker already holds the process's session, so an
 * inquiry loaded a second ~300 MiB model and staging was OOM-killed (t/520). Every phase embed now
 * goes through the host's adapter, in this order:
 *
 *   1. `adapter.computeEmbeddings(texts)`: the host's batch embed (server: the worker session;
 *      CLI: the in-process ONNX session).
 *   2. `adapter.computeQueryEmbedding(text)` once per text, for hosts with only the single-text call
 *      (Electron main, older adapters).
 *   3. The direct in-process ONNX call, only when the adapter has neither. Logged as a WARN, since on
 *      a host with its own embedding session this loads a second one.
 */

import type { AIAdapter } from '../aiAdapter.js';
import { getGlobalRecorder } from '../../flight-recorder/index.js';

export type EmbedRoute = 'adapter-batch' | 'adapter-query' | 'direct-onnx';

/** Which route `embedTexts` will take for this adapter. Exported for tests and diagnostics. */
export function embedRoute(adapter: AIAdapter | undefined): EmbedRoute {
  if (typeof adapter?.computeEmbeddings === 'function') return 'adapter-batch';
  if (typeof adapter?.computeQueryEmbedding === 'function') return 'adapter-query';
  return 'direct-onnx';
}

/** Embed `texts` through the host adapter. Returns one vector per text, in input order. */
export async function embedTexts(adapter: AIAdapter | undefined, texts: string[], debateId?: string): Promise<number[][]> {
  if (texts.length === 0) return [];
  switch (embedRoute(adapter)) {
    case 'adapter-batch':
      return adapter!.computeEmbeddings!(texts);
    case 'adapter-query': {
      const out: number[][] = [];
      for (const t of texts) out.push((await adapter!.computeQueryEmbedding!(t)).vector);
      return out;
    }
    case 'direct-onnx': {
      getGlobalRecorder()?.record({
        type: 'ai.fallback', component: 'debate-engine', level: 'warn', debate_id: debateId,
        message: 'embedTexts: adapter has no computeEmbeddings or computeQueryEmbedding; using the in-process ONNX session directly (a host with its own embedding session will now hold two)',
      });
      console.warn('[debate] WARN embedTexts: adapter provides no embed method; falling back to direct in-process ONNX (t/561)');
      const { computeEmbeddings } = await import('../../embeddings/onnxEmbedding.js');
      return computeEmbeddings(texts);
    }
  }
}

/** A batch embedder bound to one adapter, for helpers that take `(texts) => Promise<number[][]>`. */
export function adapterEmbedder(adapter: AIAdapter | undefined, debateId?: string): (texts: string[]) => Promise<number[][]> {
  return (texts: string[]) => embedTexts(adapter, texts, debateId);
}

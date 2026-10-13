// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, type ExecFileException } from 'child_process';
import { fileURLToPath } from 'node:url';
import { Worker as NodeWorker } from 'node:worker_threads';
import { loadApiKey, hasApiKey } from './apiKeyStore.js';
import { app, net } from 'electron';
import { PROJECT_ROOT, resolveDataPath } from './fileIO.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { createEmbeddingIO, type EmbeddingsFile } from '../../../lib/electron-shared/embeddingIO.js';
import {
  tryWarmup as onnxTryWarmup,
  computeEmbedding as onnxComputeEmbedding,
  computeEmbeddings as onnxComputeEmbeddings,
  getExecutionProvider as onnxGetEP,
  dispose as onnxDispose,
} from '../../../lib/embeddings/onnxEmbedding.js';
import { resolveEmbeddings, type EmbeddingFallback } from '../../../lib/embeddings/embeddingResolver.js';
import {
  computeEmbeddingsOffThread,
  shutdownEmbeddingWorker,
  __setEmbeddingWorkerFactory,
  type EmbeddingWorkerLike,
} from '../../../lib/embeddings/offThreadEmbedding.js';
console.log('[embeddings] About to import tavily...');
import { tavilySearch, buildSearchAugmentedPrompt } from '../../../lib/search/tavily.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
console.log('[embeddings] Tavily import OK');

const EXPECTED_DIMENSION = 384;

// ── Shared AI-client imports ──
import {
  withTimeout,
  resolveBackend,
  getDefaultTimeout,
  resolveTimeout,
  GEMINI_BASE,
  GEMINI_SAFETY_SETTINGS,
  callProvider,
  withRetry,
  SERVER_RETRY_CONFIG,
  generateViaDeepSeekStream,
  generateViaGeminiStream,
  DEFAULT_MODEL,
} from '../../../lib/ai-client/index.js';
import type { GenerateOptions, RateLimitType as SharedRateLimitType, FetchFn, UrlContextMetadata, GeminiContent, StopReason, ProviderCallDiagnostics } from '../../../lib/ai-client/index.js';
import type { ModelEntry, ModelRegistry } from '../../../lib/ai-client/index.js';
import { assertKeyForBackend } from '../../../lib/ai-client/apiKeyFallback.js';
import { resolveModelEntry as resolveModelEntryFromCache, getMainRegistry } from './modelConfigCache.js';

// ── Electron net.fetch wrapper ──
// Electron's net.fetch requires Buffer.from for string bodies in some cases.
const electronFetch: FetchFn = ((url: RequestInfo | URL, init?: RequestInit) => {
  if (init?.body && typeof init.body === 'string') {
    return net.fetch(url as string, { ...init, body: Buffer.from(init.body, 'utf-8') });
  }
  return net.fetch(url as string, init as Parameters<typeof net.fetch>[1]);
}) as FetchFn;

/** Find embed_taxonomy.py — may be in PROJECT_ROOT/scripts or one level up (when PROJECT_ROOT is taxonomy-editor/) */
function findEmbedScript(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'scripts', 'embed_taxonomy.py'),
    path.join(PROJECT_ROOT, '..', 'scripts', 'embed_taxonomy.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return candidates[0]; // fallback — will produce a clear "file not found" error
}
const EMBED_SCRIPT = findEmbedScript();
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// ---------- Worker-offload flag (EMBEDDING_WORKER_OFFLOAD=1) ----------
// Default off. When enabled, all embedding compute routes through lib/embeddings/offThreadEmbedding
// (worker-only chain, no in-thread ONNX, no Gemini API fallback — fail loud per TL GV t/3184#2).

const WORKER_OFFLOAD = process.env.EMBEDDING_WORKER_OFFLOAD === '1';

if (WORKER_OFFLOAD) {
  // Packaged builds: embeddingWorker.js is listed in asarUnpack → app.asar.unpacked.
  // Dev builds: tsc emits it to dist/main/lib/embeddings/ relative to this module.
  // Relative URL ../../../lib/embeddings/embeddingWorker.js from compiled
  // dist/main/taxonomy-editor/src/main/embeddings.js resolves to dist/main/lib/embeddings/ ✓.
  __setEmbeddingWorkerFactory((): EmbeddingWorkerLike => {
    const workerPath = app.isPackaged
      ? path.join(
          path.dirname(app.getAppPath()),
          'app.asar.unpacked',
          'dist', 'main', 'lib', 'embeddings', 'embeddingWorker.js',
        )
      : fileURLToPath(new URL('../../../lib/embeddings/embeddingWorker.js', import.meta.url));
    return new NodeWorker(workerPath) as unknown as EmbeddingWorkerLike;
  });
}

// ---------- Warm-up: ONNX native → Python subprocess fallback ----------

let _warmupDone = false;
let _onnxReady = false;

/**
 * Fire-and-forget: tries ONNX native runtime first (GPU/CPU, no Python needed).
 * Falls back to Python sentence_transformers if ONNX init fails.
 */
export function warmupEmbeddingModel(): void {
  if (_warmupDone) return;
  _warmupDone = true;
  if (WORKER_OFFLOAD) {
    // C2: worker owns the ONNX session exclusively — skip in-thread warmup to avoid
    // the double ~250MB model footprint. Worker lazily spawns on first compute (t/3184).
    getGlobalRecorder()?.record({
      type: 'system.info', component: 'embeddings', level: 'info',
      message: 'EMBEDDING_WORKER_OFFLOAD active — skipping in-thread ONNX warmup; worker owns the session (t/3184 C2)',
    });
    return;
  }
  console.log('[embeddings] Warming up embedding model (trying ONNX native first)...');
  const t0 = Date.now();

  void onnxTryWarmup().then((ready: boolean) => {
    if (ready) {
      _onnxReady = true;
      const ep = onnxGetEP();
      console.log(`[embeddings] ONNX warmup OK in ${Date.now() - t0}ms (EP=${ep})`);
    } else {
      console.log('[embeddings] ONNX unavailable, falling back to Python subprocess');
      execFile(
        PYTHON,
        [EMBED_SCRIPT, 'encode', 'warmup'],
        { timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true },
        (err) => {
          if (err) {
            console.warn('[embeddings] Python warmup failed (non-fatal):', err.message);
          } else {
            console.log(`[embeddings] Python warmup complete in ${Date.now() - t0}ms`);
          }
        },
      );
    }
  });
}

/** Dispose ONNX session (or shut down the embedding worker) on app shutdown. */
export async function disposeEmbeddingModel(): Promise<void> {
  if (WORKER_OFFLOAD) { shutdownEmbeddingWorker(); return; }
  if (_onnxReady) await onnxDispose();
}

export function getEmbeddingInfo(): { backend: string; execution_provider?: string } {
  if (WORKER_OFFLOAD) return { backend: 'onnx-worker' };
  if (_onnxReady) return { backend: 'onnx', execution_provider: onnxGetEP() };
  if (_warmupDone) return { backend: 'python' };
  return { backend: 'unknown' };
}

// ---------- Local embeddings from embeddings.json ----------

const io = createEmbeddingIO({
  resolveDataPath,
  embedScriptPath: EMBED_SCRIPT,
  recordError: (err) => getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'embeddings',
    level: 'error',
    message: 'Operation failed',
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  }),
});

/**
 * Compute embeddings for a list of texts.
 * Accepts an optional parallel array of node IDs. For IDs found in
 * the local embeddings.json, the pre-computed vector is returned directly
 * (no API call needed). Any texts without a local match fall back to the
 * Gemini API.
 */
export async function computeEmbeddings(
  texts: string[],
  ids?: string[],
): Promise<number[][]> {
  const localData = io.loadEmbeddingsFile();
  const chain: EmbeddingFallback[] = [];
  if (WORKER_OFFLOAD) {
    // Worker-only chain: no Gemini API fallback (t/3184 TL GV Q3 — fail loud, not degrade).
    // resolveEmbeddings catches compute() errors and falls through to next entry; a single-entry
    // chain ensures a worker shed propagates as an ActionableError rather than silently
    // switching to the Gemini API (different embedding space, masks a broken worker).
    chain.push({
      name: 'onnx-worker',
      compute: async (t) => {
        const vecs = await computeEmbeddingsOffThread(t, { requester: 'computeEmbeddings' });
        return vecs.map(v => Array.from(v));
      },
    });
  } else {
    if (_onnxReady) {
      chain.push({ name: 'onnx', compute: (t) => onnxComputeEmbeddings(t) });
    }
    chain.push({ name: 'gemini-api', compute: (t) => computeEmbeddingsViaApi(t) });
  }
  return resolveEmbeddings(texts, ids, localData, chain);
}

/**
 * Compute a query embedding for a single text.
 * Priority: ONNX native → Python sentence-transformers → Gemini API.
 */
export async function computeQueryEmbedding(text: string): Promise<number[]> {
  if (WORKER_OFFLOAD) {
    // Worker-only — no in-thread ONNX, no Python, no API fallback (t/3184 TL GV Q3).
    const [vec] = await computeEmbeddingsOffThread([text], { requester: 'computeQueryEmbedding' });
    return Array.from(vec);
  }
  if (_onnxReady) {
    try {
      return await onnxComputeEmbedding(text);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'embeddings',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.warn('[embeddings] ONNX embedding failed, trying Python fallback:', err);
    }
  }
  try {
    return await io.computeQueryViaLocalPython(text);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'embeddings',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.warn('[embeddings] Local Python embedding failed, falling back to Gemini API:', err);
    return computeQueryViaApi(text);
  }
}

// ---------- Update embeddings.json for changed nodes ----------

export interface NodeEmbeddingInput {
  id: string;
  text: string;
  pov: string;
  exclusionText?: string;
}

const EXCLUDES_RE = /\s*Excludes:.*/s;

function stripExcludes(text: string): string {
  return EXCLUDES_RE.test(text) ? text.replace(EXCLUDES_RE, '').trim() : text;
}

/**
 * Re-embed a set of nodes via local Python and update embeddings.json.
 * Runs asynchronously — caller can fire-and-forget.
 */
/** Compute embeddings for a batch of {id,text} items — ONNX native batch when the model
 *  is warmed up, else the Python subprocess. Extracted + deduped from updateNodeEmbeddings's
 *  two identical main/exclusion compute blocks (t/1914 complexity split). */
async function embedItems(items: { id: string; text: string }[]): Promise<Record<string, number[]>> {
  if (_onnxReady) {
    console.log(`[embeddings] Using ONNX native batch (EP=${onnxGetEP()})`);
    const vecs = await onnxComputeEmbeddings(items.map(n => n.text));
    const out: Record<string, number[]> = {};
    for (let i = 0; i < items.length; i++) out[items[i].id] = vecs[i];
    return out;
  }
  return new Promise<Record<string, number[]>>((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [EMBED_SCRIPT, 'batch-encode'],
      { timeout: 120_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Python batch-encode failed: ${err.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as Record<string, number[]>);
        } catch (parseErr) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'embeddings',
            level: 'error',
            message: 'Operation failed',
            error: { name: (parseErr as Error).name ?? 'Error', message: String(parseErr), stack: (parseErr as Error).stack },
          });
          reject(new Error(`Failed to parse batch-encode output: ${parseErr}`));
        }
      },
    );
    child.stdin!.write(JSON.stringify(items));
    child.stdin!.end();
  });
}

/**
 * Re-embed a set of nodes and update embeddings.json.
 *
 * Returns `{ staleNodeIds }` — the requested nodes whose embedding could NOT be refreshed this
 * call (empty = full success). The renderer surfaces a non-blocking "embeddings stale" warning
 * on any non-empty result so a failed embedding update can never masquerade as a clean save
 * (t/2060, the false-success blocker; contract TL-approved t/2060#4). A DirectML GPU OOM in the
 * embed pass no longer throws away the whole update — the affected nodes surface in staleNodeIds
 * instead, and successfully-embedded nodes are still persisted (partial success).
 */
export async function updateNodeEmbeddings(nodes: NodeEmbeddingInput[]): Promise<{ staleNodeIds: string[] }> {
  if (nodes.length === 0) return { staleNodeIds: [] };

  const filePath = io.getEmbeddingsPath();
  const items = nodes.map(n => ({ id: n.id, text: n.text }));
  console.log(`[embeddings] Updating ${nodes.length} node embeddings...`);

  // Primary embeddings. A failure here (e.g. a DirectML GPU OOM, t/2060) must NOT throw away the
  // whole update, or the renderer can't tell which nodes went stale — leave the failed ids out of
  // `vectors` so they surface in staleNodeIds below, and record the failure (ADR-003).
  let vectors: Record<string, number[]> = {};
  try {
    vectors = await embedItems(items);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'embeddings', level: 'error',
      message: 'updateNodeEmbeddings: embedding pass failed — affected nodes left stale',
      data: { requested: nodes.length },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }

  // Exclusion vectors are a SECONDARY signal — a failure here doesn't make a node's primary
  // embedding stale, so it never contributes to staleNodeIds; skip + log (warn) and continue.
  const exclItems = nodes
    .filter(n => n.exclusionText)
    .map(n => ({ id: n.id, text: n.exclusionText! }));
  let exclVectors: Record<string, number[]> = {};
  if (exclItems.length > 0) {
    console.log(`[embeddings] Generating ${exclItems.length} exclusion vectors...`);
    try {
      exclVectors = await embedItems(exclItems);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'embeddings', level: 'warn',
        message: 'updateNodeEmbeddings: exclusion embedding pass failed — exclusion vectors skipped (primary embeddings unaffected)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  }

  // Read existing embeddings.json (fresh, not from cache)
  let data: EmbeddingsFile;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    data = JSON.parse(raw) as EmbeddingsFile;
  } catch {
    /* telemetry — silent by design */
    // Create new file structure
    data = {
      model: 'all-MiniLM-L6-v2',
      dimension: 384,
      node_count: 0,
      nodes: {},
    };
  }

  // Merge new vectors (with dimension validation); track which requested nodes actually got a
  // fresh vector persisted this call.
  const expectedDim = data.dimension || 384;
  const written = new Set<string>();
  for (const node of nodes) {
    if (vectors[node.id]) {
      const vec = vectors[node.id];
      if (vec.length !== expectedDim) {
        console.warn(`[embeddings] Dimension mismatch for ${node.id}: got ${vec.length}, expected ${expectedDim} — skipping`);
        continue;
      }
      const exclVec = exclVectors[node.id];
      if (exclVec && exclVec.length !== expectedDim) {
        console.warn(`[embeddings] Exclusion dimension mismatch for ${node.id}: got ${exclVec.length}, expected ${expectedDim} — skipping exclusion`);
      }
      data.nodes[node.id] = {
        pov: node.pov,
        vector: vec,
        exclusion_vector: (exclVec && exclVec.length === expectedDim) ? exclVec : null,
      };
      written.add(node.id);
    }
  }

  // Only persist when we actually refreshed ≥1 vector — a total embed failure (all stale) must
  // NOT rewrite the file (and a prior read-miss default-structure write would CLOBBER existing
  // embeddings.json with an empty one, t/2060 data-loss guard).
  if (written.size > 0) {
    data.node_count = Object.keys(data.nodes).length;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[embeddings] Updated embeddings.json (${data.node_count} total nodes)`);
    io.invalidateCache();
  }

  // Any requested node without a freshly-persisted vector is STALE (its text changed but its
  // stored vector wasn't refreshed) — the contract the renderer surfaces (t/2060).
  const staleNodeIds = nodes.filter(n => !written.has(n.id)).map(n => n.id);
  if (staleNodeIds.length > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'embeddings', level: 'warn',
      message: 'updateNodeEmbeddings: some nodes left with stale embeddings',
      data: { stale: staleNodeIds.length, requested: nodes.length },
    });
  }
  return { staleNodeIds };
}

// ---------- NLI cross-encoder classification ----------

export interface NliPair {
  text_a: string;
  text_b: string;
  [key: string]: unknown; // extra fields are preserved
}

export interface NliResult {
  text_a: string;
  text_b: string;
  nli_label: 'entailment' | 'neutral' | 'contradiction';
  nli_entailment: number;
  nli_neutral: number;
  nli_contradiction: number;
  margin: number;
  [key: string]: unknown;
}

const NLI_BATCH_SIZE = 500;
const NLI_LOW_MEMORY_THRESHOLD = 2 * 1024 ** 3; // 2 GB

/**
 * Classify text pairs as entailment, neutral, or contradiction using the
 * local NLI cross-encoder (cross-encoder/nli-deberta-v3-small).
 * Batches into chunks of NLI_BATCH_SIZE to bound peak memory usage.
 */
export async function classifyNli(pairs: NliPair[]): Promise<NliResult[]> {
  if (pairs.length === 0) return [];

  if (pairs.length > NLI_BATCH_SIZE && os.freemem() < NLI_LOW_MEMORY_THRESHOLD) {
    console.warn(`[nli-classify] Low available RAM (${Math.round(os.freemem() / 1024 ** 2)} MB) for ${pairs.length} pairs — may OOM`);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'embeddings', level: 'warn',
      message: `nli-classify: low RAM (${Math.round(os.freemem() / 1024 ** 2)} MB) for ${pairs.length} pairs`,
    });
  }

  const results: NliResult[] = [];
  for (let i = 0; i < pairs.length; i += NLI_BATCH_SIZE) {
    const batch = pairs.slice(i, i + NLI_BATCH_SIZE);
    const batchResults = await classifyNliBatch(batch);
    results.push(...batchResults);
  }
  return results;
}

async function classifyNliBatch(pairs: NliPair[]): Promise<NliResult[]> {
  const inputJson = JSON.stringify(pairs);

  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [EMBED_SCRIPT, 'nli-classify'],
      { timeout: 120_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const combined = `${stderr || ''}${stdout || ''}`.toLowerCase();
          const isLikelyOom = combined.includes('memory') || combined.includes('killed') ||
            (err as ExecFileException).signal === 'SIGKILL';
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'embeddings', level: 'error',
            message: `nli-classify subprocess failed for ${pairs.length} pairs`,
            data: { stderr, exitCode: (err as ExecFileException).code, signal: (err as ExecFileException).signal },
          });
          reject(new ActionableError({
            goal: `Classify ${pairs.length} text pairs with NLI cross-encoder`,
            problem: `Python subprocess exited non-zero.${stderr ? ` Stderr: ${stderr.trim()}` : ' (no stderr — process may have been killed)'}`,
            location: 'embeddings.classifyNliBatch',
            nextSteps: isLikelyOom
              ? ['Insufficient memory — close other applications and retry', 'Classification runs in batches of 500; reduce total pair count if OOM persists']
              : ['Check Python environment has cross-encoder/nli-deberta-v3-small installed', 'Run embed_taxonomy.py nli-classify manually to see the full traceback'],
          }));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as NliResult[]);
        } catch (parseErr) {
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'embeddings', level: 'error',
            message: 'Failed to parse NLI output',
            error: { name: (parseErr as Error).name ?? 'Error', message: String(parseErr), stack: (parseErr as Error).stack },
          });
          reject(new ActionableError({
            goal: `Parse NLI output for ${pairs.length} pairs`,
            problem: `JSON parse failed: ${parseErr}${stderr ? `\nStderr: ${stderr.trim()}` : ''}`,
            location: 'embeddings.classifyNliBatch',
            nextSteps: ['Check that embed_taxonomy.py outputs valid JSON to stdout', 'Run embed_taxonomy.py nli-classify manually to diagnose'],
          }));
        }
      },
    );
    child.stdin!.write(inputJson);
    child.stdin!.end();
  });
}

// ---------- Gemini API fallback ----------

const GEMINI_MODEL = 'gemini-embedding-001'; // model-lint:allow-external — embedding model, governed by the embeddings API not the chat registry (t/3559)
// GEMINI_BASE is imported from shared lib/ai-client
const BATCH_SIZE = 100;
const MAX_RETRIES = 5;

interface GeminiBatchResponse {
  embeddings: { values: number[] }[];
}

async function callGeminiBatchApi(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  apiKey: string,
): Promise<number[][]> {
  assertKeyForBackend(apiKey, 'gemini', 'embedding'); // t/4105 C5: a direct send that bypasses callProvider, so the foreign-key guard runs here
  const url = `${GEMINI_BASE}/${GEMINI_MODEL}:batchEmbedContents?key=${apiKey}`;

  const requests = texts.map(text => ({
    model: `models/${GEMINI_MODEL}`,
    content: { parts: [{ text }] },
    taskType,
    outputDimensionality: EXPECTED_DIMENSION,
  }));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ requests }), 'utf-8'),
    });

    if (response.status === 429 || response.status === 503) {
      if (attempt === MAX_RETRIES) {
        const label = response.status === 503 ? 'temporarily unavailable' : 'rate limited';
        throw new ActionableError({
          goal: 'Batch-embed texts via Gemini Embedding API',
          problem: `Gemini Embedding API ${label} after ${MAX_RETRIES} attempts.`,
          location: 'embeddings.callGeminiBatchApi',
          nextSteps: [
            'Wait a few minutes and try again.',
            'Check your Gemini API quota at https://aistudio.google.com/apikey',
            'Consider using local Python embeddings with Update-TaxEmbeddings.',
          ],
        });
      }
      const backoff = Math.min(2 ** attempt, 30);
      console.log(`[batchEmbed] ${response.status}, retrying in ${backoff}s (attempt ${attempt}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, backoff * 1000));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ActionableError({
        goal: 'Batch-embed texts via Gemini Embedding API',
        problem: `Gemini API error ${response.status}: ${body}`,
        location: 'embeddings.callGeminiBatchApi',
        nextSteps: [
          'Check the API response status and error message above.',
          'Verify your Gemini API key is valid in Settings.',
          'Check your quota at https://aistudio.google.com/apikey',
        ],
      });
    }

    const json = (await response.json()) as GeminiBatchResponse;
    return json.embeddings.map(e => e.values);
  }

  throw new ActionableError({
    goal: 'Batch-embed texts via Gemini Embedding API',
    problem: 'Exhausted all retry attempts without a successful response.',
    location: 'embeddings.callGeminiBatchApi',
    nextSteps: [
      'Wait a few minutes and try again.',
      'Check your network connection and Gemini API status.',
      'Consider using local Python embeddings with Update-TaxEmbeddings.',
    ],
  });
}


async function computeEmbeddingsViaApi(texts: string[]): Promise<number[][]> {
  const apiKey = loadApiKey();
  if (!apiKey) throw new ActionableError({
    goal: 'Compute embeddings via Gemini API',
    problem: 'No Gemini API key configured.',
    location: 'embeddings.computeEmbeddingsViaApi',
    nextSteps: [
      'Set a Gemini API key in Settings.',
      'Or run Update-TaxEmbeddings to generate local embeddings without an API key.',
    ],
  });

  const allVectors: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors = await callGeminiBatchApi(batch, 'RETRIEVAL_DOCUMENT', apiKey);
    if (vectors.length > 0 && vectors[0].length !== EXPECTED_DIMENSION) {
      console.warn(`[embeddings] API returned ${vectors[0].length}-dim vectors, expected ${EXPECTED_DIMENSION}. Cosine similarity against local embeddings may be unreliable.`);
    }
    allVectors.push(...vectors);
  }
  return allVectors;
}

async function computeQueryViaApi(text: string): Promise<number[]> {
  const apiKey = loadApiKey();
  if (!apiKey) throw new ActionableError({
    goal: 'Compute query embedding via Gemini API',
    problem: 'No Gemini API key configured.',
    location: 'embeddings.computeQueryViaApi',
    nextSteps: [
      'Set a Gemini API key in Settings.',
      'Or install Python with sentence-transformers for local embeddings.',
    ],
  });

  const vectors = await callGeminiBatchApi([text], 'RETRIEVAL_QUERY', apiKey);
  return vectors[0];
}

// ---------- Text generation — delegates to shared lib/ai-client ----------

// Re-export RateLimitType from the shared package for consumers
export type RateLimitType = SharedRateLimitType;

export interface GenerateTextProgress {
  attempt: number;
  maxRetries: number;
  backoffSeconds: number;
  limitType: RateLimitType;
  limitMessage: string;
}

type AIBackend = 'gemini' | 'claude' | 'groq' | 'openai' | 'ollama';

// ── API model ID mapping — cache logic extracted to modelConfigCache.ts (testable without electron) ──

/** Find ai-models.json — may be at PROJECT_ROOT or one level up (when PROJECT_ROOT is taxonomy-editor/) */
function findModelsConfig(): string {
  const candidates = [
    path.join(PROJECT_ROOT, 'ai-models.json'),
    path.join(PROJECT_ROOT, '..', 'ai-models.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return candidates[0];
}

function resolveModelEntry(friendlyId: string): ModelEntry | undefined {
  return resolveModelEntryFromCache(findModelsConfig(), friendlyId);
}

// t/3614: registry is now required by getDefaultTimeout/getModelMinTimeout — cached via
// modelConfigCache's mtime-guarded loader, reusing this file's existing config-path resolution.
function resolveRegistry(): ModelRegistry {
  return getMainRegistry(findModelsConfig());
}

/**
 * KeySource for the AI call log (t/4088), given a resolved backend: Electron's `generateText`
 * only ever loads keys via the encrypted key store (`loadApiKey`/`hasApiKey`) — never an env var
 * or an explicit-key parameter — so 'store' and 'none' (keyless Ollama) are the only sources that
 * occur on this path; '' covers the key-not-found case (which `generateText` itself refuses before
 * any call, so this value only ever reaches the log via a caller's own catch-block entry).
 */
export function resolveAiCallLogKeySource(backend: string): string {
  if (backend === 'ollama') return 'none';
  return hasApiKey(backend as Parameters<typeof hasApiKey>[0]) ? 'store' : '';
}

/**
 * The Model/Backend/KeySource context for an AI call log entry (t/4088), given the caller's
 * requested model (or none, which defaults the same way `generateText` does). Callers compute
 * this ONCE before calling `generateText` and reuse it for both the success and failure log
 * entries, since the desktop path has no fallback chain (t/4048) — the requested model is always
 * the model actually called.
 */
export function resolveAiCallLogContext(model?: string): { model: string; backend: string; keySource: string } {
  const friendlyModel = model || DEFAULT_MODEL;
  // registry passed explicitly (AC 3, t/4088): resolveBackend's registry param is optional and
  // falls through to an id-prefix guess when omitted — this is the registry-first form.
  const backend = resolveBackend(friendlyModel, resolveRegistry());
  return { model: friendlyModel, backend, keySource: resolveAiCallLogKeySource(backend) };
}

/** Return a fixedTemperature override for GenerateOptions when the entry requires one. */
function fixedTempOverride(entry: ModelEntry | undefined): { fixedTemperature?: number } {
  return entry?.fixedTemperature != null ? { fixedTemperature: entry.fixedTemperature } : {};
}

let _lastLoggedModel: string | null = null;
let _debateTemperature: number | null = null;

/** Set the temperature for debate AI calls. Pass null to reset to default (0.7). */
export function setDebateTemperature(temp: number | null): void {
  if (temp === _debateTemperature) return;
  _debateTemperature = temp;
  if (temp !== null) console.log(`[AI] Debate temperature set to: ${temp}`);
  else console.log('[AI] Debate temperature reset to default (0.7)');
}

// t/3528: trailing options grouped in one object rather than five positional params —
// every prior addition (signal t/2507, responseSchema, maxTokens t/3524) forced every
// caller to pass placeholder `undefined` holes to reach the new param.
export interface GenerateTextCallOptions {
  timeoutMs?: number;
  temperature?: number;
  signal?: AbortSignal;
  responseSchema?: Record<string, unknown>;
  maxTokens?: number;
}

export async function generateText(
  prompt: string,
  model?: string,
  onRetry?: (progress: GenerateTextProgress) => void,
  opts?: GenerateTextCallOptions,
): Promise<{ text: string; stopReason?: StopReason; diagnostics?: ProviderCallDiagnostics; servedModel?: string }> {
  const { timeoutMs, temperature, signal, responseSchema, maxTokens } = opts ?? {};
  const friendlyModel = model || DEFAULT_MODEL;
  // registry passed explicitly (t/4141): resolveBackend's registry param is optional and falls
  // through to an id-prefix guess when omitted, routing the request and its key to a provider
  // the registry didn't name.
  const backend = resolveBackend(friendlyModel, resolveRegistry());
  const entry = resolveModelEntry(friendlyModel);
  const resolvedModel = entry?.apiModelId ?? friendlyModel;

  const apiKey = backend === 'ollama' ? 'ollama-local' : loadApiKey(backend);
  const keySource = backend === 'ollama' ? 'local (no key needed)' : apiKey ? 'Electron encrypted store' : '(not found)';
  if (!apiKey) {
    const names: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', groq: 'Groq', openai: 'OpenAI' };
    const backendName = names[backend] ?? backend;
    throw new ActionableError({
      goal: `Generate text via ${backendName} API`,
      problem: `No ${backendName} API key configured.`,
      location: 'embeddings.generateText',
      nextSteps: [
        `Set a ${backendName} API key in Settings.`,
        'Or switch to a different AI backend that has a key configured.',
      ],
    });
  }

  // Log on first call or model change
  if (_lastLoggedModel !== friendlyModel) {
    if (_lastLoggedModel) {
      console.log(`[AI] Model changed: ${_lastLoggedModel} → ${friendlyModel} (API: ${resolvedModel}) | Backend: ${backend} | Key source: ${keySource}`);
    } else {
      console.log(`[AI] Backend: ${backend} | Model: ${friendlyModel} (API: ${resolvedModel}) | Key source: ${keySource}`);
    }
    _lastLoggedModel = friendlyModel;
  }

  const providerOpts: GenerateOptions = {
    temperature: temperature ?? _debateTemperature ?? 0.7,
    timeoutMs: resolveTimeout(timeoutMs, friendlyModel, resolveRegistry()), // t/3644: floor-enforced
    ...fixedTempOverride(entry),
    ...(signal ? { signal } : {}),
    ...(responseSchema ? { responseSchema } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    identityRegistry: resolveRegistry(), // t/4018: lets callProvider's served-identity classifier warn on divergence
  };

  const providerFn = backend === 'deepseek'
    ? () => generateViaDeepSeekStream(electronFetch, prompt, resolvedModel, apiKey, providerOpts)
    : () => callProvider(electronFetch, backend, prompt, resolvedModel, apiKey, providerOpts);

  const result = await withRetry(
    providerFn,
    SERVER_RETRY_CONFIG,
    `${backend}/${resolvedModel}`,
    (msg: string) => {
      console.log(msg);
      const attemptMatch = msg.match(/attempt (\d+)\/(\d+).*waiting (\d+)s/);
      if (attemptMatch && onRetry) {
        onRetry({
          attempt: parseInt(attemptMatch[1], 10),
          maxRetries: parseInt(attemptMatch[2], 10),
          backoffSeconds: parseInt(attemptMatch[3], 10),
          limitType: 'unknown',
          limitMessage: msg,
        });
      }
    },
  );

  console.log('[generateText] Success, result length:', result.text.length);
  // t/4048 (e/275#2/#4, SO condition 4 satisfied for this backend): desktop has no fallback
  // chain — lib/debate/aiAdapter.ts's createCLIAdapter is the only code that walks the model
  // registry's fallback-chain config, and it's CLI-only, never this path — so servedModel is
  // simply the single model this call resolved to, DERIVED from the same defaulting as the call
  // itself (friendlyModel = model || DEFAULT_MODEL), never echoed from the raw `model` param.
  // THIS EXEMPTION LAPSES the moment this function starts walking that per-model fallback
  // config: servedModel must become the answering link, and e/268#6 condition 4's
  // forced-fallback test becomes mandatory. See embeddings.noFallbackChainTripwire.test.ts,
  // which fails loudly if that line is crossed without this comment being revisited. (That
  // test name-matches the registry field and the two ServerAPI/CLI helper functions that walk
  // it — spelled out there, deliberately not here, so this comment can't trip its own tripwire.)
  //
  // SCOPE (TL review, #3061): servedModel tracks OUR routing (which registry link answered), NOT
  // whether the provider served that model. Provider-side substitution is classified by
  // callProvider's ai.model_identity event (t/3677/t/3731) using `result.providerReportedModel`.
  // That field is deliberately NOT read here: it is a raw provider string (not a registry id) and
  // forensics-only, so consuming it would lapse its own no-consumer exemption (lib/ai-client/types.ts).
  return { text: result.text, stopReason: result.stopReason, diagnostics: result.diagnostics, servedModel: friendlyModel };
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

export async function generateChatStream(
  systemInstruction: string,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  model?: string,
  temperature?: number,
  urlContext?: boolean,
): Promise<{ text: string; urlContextMetadata?: UrlContextMetadata }> {
  const friendlyModel = model || DEFAULT_MODEL;
  // registry passed explicitly (t/4141): see generateText's identical comment.
  const backend = resolveBackend(friendlyModel, resolveRegistry());
  const entry = resolveModelEntry(friendlyModel);
  const resolvedModel = entry?.apiModelId ?? friendlyModel;

  const apiKey = backend === 'ollama' ? 'ollama-local' : loadApiKey(backend);
  if (!apiKey) {
    const names: Record<string, string> = { gemini: 'Gemini', claude: 'Claude', groq: 'Groq', openai: 'OpenAI' };
    const backendName = names[backend] ?? backend;
    throw new ActionableError({
      goal: `Stream chat response via ${backendName} API`,
      problem: `No ${backendName} API key configured.`,
      location: 'embeddings.generateChatStream',
      nextSteps: [
        `Set a ${backendName} API key in Settings.`,
        'Or switch to a different AI backend that has a key configured.',
      ],
    });
  }

  if (backend !== 'gemini') {
    const prompt = systemInstruction + '\n\n' + messages.map(m =>
      m.role === 'user' ? `[User]: ${m.content}` : `[Assistant]: ${m.content}`
    ).join('\n\n') + '\n\n[Assistant]:';
    const opts: GenerateOptions = {
      temperature: temperature ?? 0.7,
      timeoutMs: getDefaultTimeout(friendlyModel, resolveRegistry()),
      ...fixedTempOverride(entry),
      identityRegistry: resolveRegistry(), // t/4018: lets callProvider's served-identity classifier warn on divergence
    };
    const providerResult = backend === 'deepseek'
      ? await generateViaDeepSeekStream(electronFetch, prompt, resolvedModel, apiKey, opts, onChunk)
      : await callProvider(electronFetch, backend, prompt, resolvedModel, apiKey, opts);
    if (backend !== 'deepseek') onChunk(providerResult.text);
    return { text: providerResult.text };
  }

  const geminiContents: GeminiContent[] = messages.map(m => ({ role: m.role, parts: [{ text: m.content }] }));
  const opts: GenerateOptions = {
    temperature: temperature ?? 0.3,
    timeoutMs: getDefaultTimeout(friendlyModel, resolveRegistry()),
    systemMessage: systemInstruction,
    geminiContents,
    urlContext,
    ...fixedTempOverride(entry),
  };
  const result = await generateViaGeminiStream(electronFetch, '', resolvedModel, apiKey, opts, onChunk);
  console.log(`[chatStream] Complete, total length: ${result.text.length}`);
  return { text: result.text, urlContextMetadata: result.urlContextMetadata };
}

export interface GroundingSegment {
  startIndex: number;
  endIndex: number;
  text?: string;
  confidence?: number;
}

export interface GroundingCitation {
  uri: string;
  title: string;
  segments: GroundingSegment[];
}

/**
 * Tavily search + LLM pipeline: search the web via Tavily, then pass
 * the results as context to the current AI model for grounded generation.
 */
async function generateWithTavily(
  prompt: string,
  model: string,
  tavilyKey: string,
): Promise<{ text: string; searchQueries?: string[]; citations?: GroundingCitation[] }> {
  const searchQuery = prompt.length > 400 ? prompt.slice(0, 400) : prompt;
  console.log(`[AI] Tavily search for model=${model}, query length=${searchQuery.length}`);

  const searchResult = await tavilySearch(searchQuery, tavilyKey, {
    maxResults: 5,
    includeAnswer: true,
    searchDepth: 'basic',
  }, net.fetch as unknown as typeof fetch);

  const { augmentedPrompt, searchQueries, citations: searchCitations } = buildSearchAugmentedPrompt(prompt, searchResult);

  const { text } = await generateText(augmentedPrompt, model);

  const citations: GroundingCitation[] = searchCitations.map((c: any) => ({
    uri: c.uri,
    title: c.title,
    segments: [],
  }));

  return {
    text,
    searchQueries: searchQueries.length ? searchQueries : undefined,
    citations: citations.length ? citations : undefined,
  };
}

// One candidate from a Gemini grounded-search response (only the fields we read).
type GroundedCandidate = {
  content: { parts: { text: string }[] };
  groundingMetadata?: {
    searchEntryPoint?: { renderedContent?: string };
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
    groundingSupports?: {
      segment?: { startIndex?: number; endIndex?: number; text?: string };
      groundingChunkIndices?: number[];
      confidenceScores?: number[];
    }[];
  };
};

type GroundingSupport = {
  segment?: { startIndex?: number; endIndex?: number; text?: string };
  groundingChunkIndices?: number[];
  confidenceScores?: number[];
};

/** Attach each grounding support's segment (with confidence) to its cited chunk
 *  (mutates `citations`). Extracted from buildGroundingResult (t/1914). */
function attachGroundingSegments(citations: GroundingCitation[], supports: GroundingSupport[]): void {
  for (const s of supports) {
    const seg = s.segment;
    if (!seg || typeof seg.startIndex !== 'number' || typeof seg.endIndex !== 'number') continue;
    const idxs = s.groundingChunkIndices ?? [];
    const scores = s.confidenceScores ?? [];
    idxs.forEach((ci, k) => {
      if (ci >= 0 && ci < citations.length) {
        citations[ci].segments.push({
          startIndex: seg.startIndex as number,
          endIndex: seg.endIndex as number,
          text: seg.text,
          confidence: scores[k],
        });
      }
    });
  }
}

/** Parse a Gemini grounded-search candidate into { text, citations, searchQueries }.
 *  Extracted verbatim from generateTextWithSearch's inline grounding parse (t/1914). */
function buildGroundingResult(candidate: GroundedCandidate): { text: string; searchQueries?: string[]; citations?: GroundingCitation[] } {
  let text = candidate.content.parts
    .filter(p => typeof p.text === 'string')
    .map(p => p.text)
    .join('');
  const meta = candidate.groundingMetadata;
  const chunks = meta?.groundingChunks ?? [];
  const supports = meta?.groundingSupports ?? [];

  const citations: GroundingCitation[] = chunks.map(c => ({
    uri: c.web?.uri || '',
    title: c.web?.title || c.web?.uri || '(untitled source)',
    segments: [],
  }));
  attachGroundingSegments(citations, supports);

  if (!text && supports.length > 0) {
    const segTexts = supports
      .map(s => s.segment?.text)
      .filter((t): t is string => !!t);
    if (segTexts.length > 0) text = segTexts.join(' ');
  }

  const searchQueries = citations.map(c => c.title).filter(Boolean);

  return {
    text,
    searchQueries: searchQueries.length ? searchQueries : undefined,
    citations: citations.length ? citations : undefined,
  };
}

/**
 * Generate text with web search grounding.
 * Gemini: uses built-in google_search tool.
 * Other backends: uses Tavily search + LLM if TAVILY_API_KEY is available.
 * Falls back to regular generateText when no search provider is available.
 */
export async function generateTextWithSearch(
  prompt: string,
  model?: string,
): Promise<{ text: string; searchQueries?: string[]; citations?: GroundingCitation[] }> {
  const resolvedModel = model || DEFAULT_MODEL;
  // registry passed explicitly (t/4141): see generateText's identical comment.
  const backend = resolveBackend(resolvedModel, resolveRegistry());

  // Non-Gemini: use Tavily search + LLM if Tavily key is available
  if (backend !== 'gemini') {
    const tavilyKey = loadApiKey('tavily') || process.env.TAVILY_API_KEY;
    if (tavilyKey) {
      return generateWithTavily(prompt, resolvedModel, tavilyKey);
    }
    const { text } = await generateText(prompt, resolvedModel);
    return { text };
  }

  const apiKey = loadApiKey(backend);
  if (!apiKey) throw new ActionableError({
    goal: 'Generate text with web search grounding via Gemini',
    problem: 'No Gemini API key configured.',
    location: 'embeddings.generateTextWithSearch',
    nextSteps: [
      'Set a Gemini API key in Settings.',
      'Or switch to a different AI backend with a Tavily key for search grounding.',
    ],
  });

  assertKeyForBackend(apiKey, 'gemini', 'search-grounding'); // t/4105 C5: a direct send that bypasses callProvider, so the foreign-key guard runs here
  const apiModel = resolveModelEntry(resolvedModel)?.apiModelId ?? resolvedModel;
  const url = `${GEMINI_BASE}/${apiModel}:generateContent?key=${apiKey}`;

  console.log(`[AI] Grounded search: ${resolvedModel} with google_search tool`);

  const _searchBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 16384,
    },
    safetySettings: GEMINI_SAFETY_SETTINGS,
  });
  const response = await withTimeout(
    electronFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: _searchBody,
    }),
    60_000,
    'Gemini grounded search request',
  );

  if (!response.ok) {
    const body = await response.text();
    throw new ActionableError({
      goal: 'Generate text with web search grounding via Gemini',
      problem: `Gemini search grounding error ${response.status}: ${body.slice(0, 300)}`,
      location: 'embeddings.generateTextWithSearch',
      nextSteps: [
        'Check the API response status and error message above.',
        'Verify your Gemini API key is valid in Settings.',
        'The google_search tool may not be available for this model. Try a different model.',
      ],
    });
  }

  const json = await response.json() as Record<string, unknown>;
  const candidates = (json as { candidates?: GroundedCandidate[] }).candidates;
  if (!candidates?.length) throw new ActionableError({
    goal: 'Generate text with web search grounding via Gemini',
    problem: 'No candidates returned from Gemini grounded search.',
    location: 'embeddings.generateTextWithSearch',
    nextSteps: [
      'The model may have filtered the response due to safety settings.',
      'Try rephrasing the prompt or using a different model.',
      'Retry the request — this may be a transient issue.',
    ],
  });

  return buildGroundingResult(candidates[0]);
}

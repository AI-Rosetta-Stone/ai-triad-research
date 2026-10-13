// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// AI / embeddings handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Model config + discovery, embedding compute, NLI, text generation (plain +
// grounded search), chat streaming, debate temperature, URL fetch, and the
// read-only calibration views. Handler bodies moved verbatim; channels unchanged.

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, getDataRootPath } from '../fileIO.js';
import { computeEmbeddings, computeQueryEmbedding, generateText, generateTextWithSearch, generateChatStream, updateNodeEmbeddings, classifyNli, setDebateTemperature, getEmbeddingInfo, resolveAiCallLogContext } from '../embeddings.js';
import type { ChatMessage, NodeEmbeddingInput, NliPair } from '../embeddings.js';
import { refreshAIModels } from '../modelDiscovery.js';
import { refreshModelsRequestSchema } from './refreshModelsRequestSchema.js';
import { ActionableError, errorMessage } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { DEFAULT_TEMPERATURE, resolveBackend, DEFAULT_MODEL } from '../../../../lib/ai-client/index.js';
import type { UrlContextMetadata } from '../../../../lib/ai-client/index.js';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../../../../lib/debate/constants.js';
import { buildEmbeddingFailureError } from '../embeddingErrors.js';
import { fetchUrlForPrompt } from '../../../../lib/url-fetch/fetchUrlForPrompt.js';
import { extractHttpUrls } from '../../../../lib/url-fetch/extractHttpUrls.js';
import { writeAICallLogEntry } from '../aiCallLog.js';

// AI call-log status classifier (t/3370). Duplicated from src/server/ai/aiBackends.ts'
// deriveCallLogStatus — that copy is unexported, and main-process code depending on
// server code is the wrong dependency direction (separate deployment targets).
function deriveCallLogStatus(err: unknown): string {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string };
  const code = e?.statusCode ?? e?.status;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  const msg = (e?.message ?? '').toLowerCase();
  if (e?.name === 'AbortError' || msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'error';
}

// t/3417: AbortSignal.timeout() (the per-attempt fetch deadline, ai-client's
// makeFetchSignal) fires with .name === 'TimeoutError', NOT 'AbortError' — it doesn't
// match generate-text's cancel check, so without this it fell through to the generic
// ActionableError, which tells the user to check their API key / rate limits —
// misleading for a request that simply took too long to respond.
function buildTimeoutError(err: unknown, elapsedMs: number): ActionableError {
  return new ActionableError({
    goal: 'Generate text via AI backend',
    problem: `The AI backend did not respond within the allotted timeout for this request (${elapsedMs}ms elapsed).`,
    location: 'ipcHandlers.generateText',
    nextSteps: [
      'Retry — a single slow response does not necessarily mean the backend is down',
      'If this recurs, the prompt may be too large or complex for the current model — try a shorter prompt or a faster model',
      'Try a different AI backend if the current one is consistently slow',
    ],
    innerError: err,
  });
}

// t/3528: single payload object for the 'generate-text' IPC channel, replacing six
// positional params that preload.cts/electron.d.ts/electron-bridge.ts each had to
// restate in the same order by hand.
interface GenerateTextIpcPayload {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  temperature?: number;
  requestId?: string;
  maxTokens?: number;
}

// t/3524: maxTokens crosses an IPC trust boundary (renderer → main → provider) and directly
// scales spend, so the main process clamps/validates rather than trusting the caller (SO
// condition, t/3524#2). Non-integer/non-positive input is dropped (provider default applies);
// values above the ceiling are clamped down. Either case is logged so a silent drop/clamp is
// diagnosable from a flight recorder dump (root AGENTS.md fallback-path logging rule).
const MAX_TOKENS_CEILING = 32_000;

function clampMaxTokens(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < 1) {
    getGlobalRecorder()?.record({
      type: 'system.info',
      component: 'ipc-handlers',
      level: 'warn',
      message: `generate-text: ignoring invalid maxTokens (${JSON.stringify(raw)}) — must be a positive integer; falling back to provider default`,
    });
    return undefined;
  }
  if (raw > MAX_TOKENS_CEILING) {
    getGlobalRecorder()?.record({
      type: 'system.info',
      component: 'ipc-handlers',
      level: 'warn',
      message: `generate-text: clamping maxTokens from ${raw} to ceiling ${MAX_TOKENS_CEILING}`,
    });
    return MAX_TOKENS_CEILING;
  }
  return raw;
}

// ── Per-request AbortController map (t/2509) ──────────────────────────────

const activeGenerations = new Map<string, AbortController>();

// ── Fetch-and-inject helpers (t/2484) ─────────────────────────────────────

const MAX_FETCH_URLS = 3;

// Mirrors the non-urlContext branch of src/renderer/prompts/chat.ts.
// Main process can't import renderer — kept in sync manually.
const HONEST_FAIL_INSTRUCTION =
  `=== HANDLING LINKS ===\nWhen the user's message contains a URL: you have not visited that URL and cannot read its contents. Lead your response by stating this clearly (e.g., "I haven't read that link") and ask the user to paste the relevant text. Do not speculate about or summarise the page's contents.`;

// Canonical shape shared with ServerAPI (t/2483) — reuses UrlContextMetadata so
// the renderer UrlContextChip parses both Gemini and app-fetch events identically.
interface AppFetchEvent {
  source: 'app-fetch';
  urlContextMetadata: UrlContextMetadata;
}

export function registerAiHandlers(): void {
  ipcMain.handle('load-ai-models', () => {
    try {
      const configPath = path.join(PROJECT_ROOT, 'ai-models.json');
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'load-ai-models: failed to read/parse ai-models.json — returning null (AI features will be unavailable)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  });

  ipcMain.handle('refresh-ai-models', async (_event, opts?: unknown) => {
    if (opts === undefined) return refreshAIModels();
    let parsed;
    try {
      parsed = refreshModelsRequestSchema.parse(opts);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ipc-handlers', level: 'warn',
        message: `refresh-ai-models: malformed payload rejected — ${errorMessage(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: errorMessage(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: 'Refresh the AI model registry',
        problem: err instanceof ActionableError ? err.problem : `refresh-ai-models payload is malformed: ${errorMessage(err)}`,
        location: 'ipc/aiHandlers.ts refresh-ai-models',
        nextSteps: ['Retry a plain refresh (no options)', 'If accepting a proposal, resend the exact proposal shown by a prior dry run'],
        innerError: err,
      });
    }
    return refreshAIModels(parsed);
  });

  ipcMain.handle('get-embedding-info', () => {
    const info: Record<string, unknown> = getEmbeddingInfo();
    try {
      const cfgPath = path.join(PROJECT_ROOT, 'lib', 'debate', 'calibration-config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      info.calibration_version = cfg.schema_version;
    } catch { /* telemetry — silent by design;  calibration config not found — leave undefined */ }
    return info;
  });

  ipcMain.handle('compute-embeddings', async (_event, texts: string[], ids?: string[]) => {
    try {
      return { vectors: await computeEmbeddings(texts, ids) };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.error('[IPC] compute-embeddings failed:', err instanceof Error ? err.message : String(err));
      throw buildEmbeddingFailureError(
        'Compute text embeddings for taxonomy nodes',
        'ipcHandlers.computeEmbeddings',
        'Embedding computation failed',
        err,
      );
    }
  });

  ipcMain.handle('compute-query-embedding', async (_event, text: string) => {
    try {
      return { vector: await computeQueryEmbedding(text) };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.error('[IPC] compute-query-embedding failed:', err instanceof Error ? err.message : String(err));
      throw buildEmbeddingFailureError(
        'Compute embedding for a search query',
        'ipcHandlers.computeQueryEmbedding',
        'Query embedding failed',
        err,
      );
    }
  });

  ipcMain.handle('update-node-embeddings', async (_event, nodes: NodeEmbeddingInput[]) => {
    try {
      // Resolves { staleNodeIds } (empty = full success) — an embed OOM surfaces as stale ids,
      // not a throw, so the renderer can flag the degradation (t/2060). Only a genuinely
      // unexpected fault (e.g. file-write) reaches the catch below.
      return await updateNodeEmbeddings(nodes);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.error('[IPC] update-node-embeddings failed:', err instanceof Error ? err.message : String(err));
      throw buildEmbeddingFailureError(
        `Update embeddings for ${nodes.length} taxonomy node(s)`,
        'ipcHandlers.updateNodeEmbeddings',
        'Embedding update failed',
        err,
      );
    }
  });

  ipcMain.handle('nli-classify', async (_event, pairs: NliPair[]) => {
    const t0 = Date.now();
    getGlobalRecorder()?.record({ type: 'system.info', component: 'ipc-handlers', level: 'info', message: `nli-classify start: ${pairs.length} pairs` });
    try {
      const results = await classifyNli(pairs);
      getGlobalRecorder()?.record({ type: 'system.info', component: 'ipc-handlers', level: 'info', message: `nli-classify ok: ${results.length} results in ${Date.now() - t0}ms`, data: { duration_ms: Date.now() - t0, result_count: results.length } });
      return { results };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ipc-handlers', level: 'error',
        message: `nli-classify failed after ${Date.now() - t0}ms`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err;
    }
  });

  ipcMain.handle('generate-text', async (event, payload: GenerateTextIpcPayload) => {
    const { prompt, model, timeoutMs, temperature, requestId, maxTokens } = payload;
    const t0 = Date.now();
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && controller) activeGenerations.set(requestId, controller);
    const clampedMaxTokens = clampMaxTokens(maxTokens);
    let retryCount = 0;
    // t/4088: computed once and reused for every log entry below — the desktop path has no
    // fallback chain (t/4048), so the requested model is always the model actually called.
    const { model: logModel, backend, keySource } = resolveAiCallLogContext(model);
    try {
      const { text, stopReason, diagnostics, servedModel } = await generateText(prompt, model, (progress) => {
        retryCount = progress.attempt;
        event.sender.send('generate-text-progress', progress);
      }, { timeoutMs, temperature, signal: controller?.signal, maxTokens: clampedMaxTokens });
      writeAICallLogEntry({ scenario: 'Debate', promptId: '', promptStart: prompt, retryCount, status: '200', model: logModel, backend, keySource });
      return { text, stopReason, diagnostics, servedModel };
    } catch (err) {
      if ((err as Error).name === 'AbortError' || controller?.signal.aborted) {
        getGlobalRecorder()?.record({
          type: 'system.info',
          component: 'ipc-handlers',
          level: 'info',
          message: 'ai.cancelled',
          data: { requestId, elapsed_ms: Date.now() - t0 },
        });
        writeAICallLogEntry({ scenario: 'Debate', promptId: '', promptStart: prompt, retryCount, status: deriveCallLogStatus(err), model: logModel, backend, keySource });
        throw err;
      }
      if ((err as Error).name === 'TimeoutError') {
        const elapsedMs = Date.now() - t0;
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ipc-handlers', level: 'warn',
          message: `generate-text timed out after ${elapsedMs}ms`,
          error: { name: 'TimeoutError', message: String((err as Error).message ?? err) },
        });
        writeAICallLogEntry({ scenario: 'Debate', promptId: '', promptStart: prompt, retryCount, status: deriveCallLogStatus(err), model: logModel, backend, keySource });
        throw buildTimeoutError(err, elapsedMs);
      }
      const problem = err instanceof ActionableError ? err.problem : (err instanceof Error ? err.message : String(err));
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: `generate-text failed: ${problem}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.error('[IPC] generate-text failed:', problem);
      writeAICallLogEntry({ scenario: 'Debate', promptId: '', promptStart: prompt, retryCount, status: deriveCallLogStatus(err), model: logModel, backend, keySource });
      throw new ActionableError({
        goal: 'Generate text via AI backend',
        problem: `AI generation failed: ${problem}`,
        location: 'ipcHandlers.generateText',
        nextSteps: [
          'Verify your API key is set (Settings > API Keys)',
          'Check that the selected AI model is available and not rate-limited',
          'Try a different AI backend if the current one is unreachable',
        ],
        innerError: err,
      });
    } finally {
      if (requestId) activeGenerations.delete(requestId);
    }
  });

  ipcMain.handle('ai:cancel-generate', (_event, requestId: string) => {
    activeGenerations.get(requestId)?.abort();
  });

  ipcMain.handle('set-debate-temperature', (_event, temp: number | null) => {
    setDebateTemperature(temp);
  });

  ipcMain.handle('start-chat-stream', async (event, systemInstruction: string, messages: ChatMessage[], model?: string, temperature?: number, urlContext?: boolean) => {
    console.log('[IPC:chat-stream] start, model:', model, 'msgs:', messages.length, 'urlContext:', urlContext ?? false);
    const send = (channel: string, data: unknown) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, data);
    };

    // Fetch-and-inject: when model lacks native URL grounding, fetch URLs from
    // the last user message and prepend content as an ephemeral system block.
    const isUrlCapable = resolveBackend(model ?? DEFAULT_MODEL) === 'gemini' && urlContext === true;
    let effectiveSystem = systemInstruction;
    let appFetchEvent: AppFetchEvent | undefined;

    if (!isUrlCapable) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      const urls = lastUser ? extractHttpUrls(lastUser.content, MAX_FETCH_URLS) : [];
      if (urls.length > 0) {
        try {
          const results = await Promise.all(urls.map(u => fetchUrlForPrompt(u)));
          const timestamp = new Date().toISOString();
          const successes = results
            .map((r, i) => ({ url: urls[i], r }))
            .filter(x => x.r.ok) as Array<{ url: string; r: Extract<typeof results[number], { ok: true }> }>;

          if (successes.length === 0) {
            effectiveSystem = HONEST_FAIL_INSTRUCTION + '\n\n' + systemInstruction;
          } else {
            const block = successes
              .map(({ url, r }) => `=== FETCHED PAGE CONTENT ===\nContent of "${r.title ?? url}" (${r.finalUrl}) fetched at ${timestamp}:\n${r.text}`)
              .join('\n\n');
            effectiveSystem = block + '\n\n' + systemInstruction;
          }

          appFetchEvent = {
            source: 'app-fetch',
            urlContextMetadata: {
              urlMetadata: results.map((r, i) => ({
                retrievedUrl: urls[i],
                urlRetrievalStatus: r.ok ? 'SUCCESS' : 'FAILED',
                source: 'app-fetch' as const,
                truncated: r.ok ? r.truncated : undefined,
              })),
            },
          };
        } catch (err) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'ipc-handlers',
            level: 'error',
            message: 'URL fetch-and-inject failed unexpectedly',
            error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
          });
          effectiveSystem = HONEST_FAIL_INSTRUCTION + '\n\n' + systemInstruction;
        }
      }
    }

    const { text: fullText, urlContextMetadata } = await generateChatStream(
      effectiveSystem,
      messages,
      (chunk: string) => send('chat-stream-chunk', chunk),
      model,
      temperature,
      urlContext,
    );
    console.log('[IPC:chat-stream] done, returning', fullText.length, 'chars');
    if (urlContextMetadata) send('chat-stream-url-metadata', urlContextMetadata);
    if (appFetchEvent) send('chat-stream-url-metadata', appFetchEvent);
    send('chat-stream-done', fullText);
    return fullText;
  });

  ipcMain.handle('generate-text-with-search', async (_event, prompt: string, model?: string) => {
    try {
      return await generateTextWithSearch(prompt, model);
    } catch (err) {
      const problem = err instanceof ActionableError ? err.problem : (err instanceof Error ? err.message : String(err));
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: `generate-text-with-search failed: ${problem}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.error('[IPC] generate-text-with-search failed:', problem);
      throw new ActionableError({
        goal: 'Generate AI text with grounded web search',
        problem: `AI grounded search failed: ${problem}`,
        location: 'ipcHandlers.generateTextWithSearch',
        nextSteps: [
          'Verify your API key is set (Settings > API Keys)',
          'Check that the selected model supports grounded search (e.g. Gemini)',
          'Try the request again — transient network errors are common',
        ],
        innerError: err,
      });
    }
  });

  ipcMain.handle('fetch-url-content', async (_event, url: string) => {
    // S-SSRF: Only allow http/https protocols to prevent file:// and internal network access
    if (!/^https?:\/\//i.test(url)) {
      return { content: '', error: 'Only http/https URLs are allowed' };
    }
    try {
      const { fetchUrlContent } = await import('../../../../lib/debate/taxonomyLoader.js');
      const markdown = await fetchUrlContent(url);
      return { content: markdown };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { content: '', error: String(err) };
    }
  });

  ipcMain.handle('get-calibration-history', () => {
    try {
      const dataRoot = getDataRootPath();

      // Read parameter history
      const histPath = path.join(dataRoot, 'calibration', 'parameter-history.json');
      let history: unknown[] = [];
      if (fs.existsSync(histPath)) {
        try { history = JSON.parse(fs.readFileSync(histPath, 'utf-8')); } catch { /* telemetry — silent by design;  corrupt */ }
      }

      // Capture current snapshot from provisional-weights.json
      const weightsPath = path.join(PROJECT_ROOT, 'lib', 'debate', 'provisional-weights.json');
      let weights: Record<string, unknown> = {};
      try { weights = JSON.parse(fs.readFileSync(weightsPath, 'utf-8')); } catch { /* telemetry — silent by design;  use defaults */ }

      const current = {
        exploration_exit: (weights?.thresholds as Record<string, number>)?.exploration_exit ?? 0.65,
        relevance_threshold: DEFAULT_RELEVANCE_THRESHOLD,
        attack_weights: [1.0, 1.1, 1.2],
        draft_temperature: DEFAULT_TEMPERATURE,
        saturation_weights: (weights?.saturation as Record<string, number>) ?? {
          recycling_pressure: 0.30, crux_maturity: 0.25, concession_plateau: 0.15,
          engagement_fatigue: 0.15, pragmatic_convergence: 0.05, scheme_stagnation: 0.10,
        },
        recent_window: 8,
        gc_trigger: (weights?.network as Record<string, number>)?.gc_trigger ?? 175,
        polarity_resolved: 0.85,
        max_nodes_cap: 50,
        semantic_recycling_threshold: 0.85,
        cluster_min_similarity: 0.55,
        duplicate_similarity_threshold: 0.85,
        fire_confidence_threshold: 0.7,
        cohesion_clear_theme: 0.60,
        kp_divisor: 500,
      };

      return { current, history };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'get-calibration-params: failed to load calibration params — returning nulls (debate engine will use hardcoded defaults)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { current: null, history: [] };
    }
  });

  // ── Calibration log (per-debate metrics) ──
  ipcMain.handle('get-calibration-log', () => {
    try {
      const dataRoot = getDataRootPath();
      const logPath = path.join(dataRoot, 'calibration', 'core', 'calibration-log.jsonl');
      if (!fs.existsSync(logPath)) return { entries: [], validationReport: null };

      // JSONL: one JSON object per line. Parse each non-empty line independently.
      const entries = fs.readFileSync(logPath, 'utf-8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));

      // Also load validation report if available
      const reportPath = path.join(dataRoot, 'calibration', 'validation-report.json');
      let validationReport = null;
      if (fs.existsSync(reportPath)) {
        try { validationReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8')); } catch { /* telemetry — silent by design;  ok */ }
      }

      return { entries, validationReport };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'get-calibration-log: failed to read calibration log — returning empty log',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { entries: [], validationReport: null };
    }
  });
}

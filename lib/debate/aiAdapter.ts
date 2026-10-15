// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Multi-backend AI client for CLI debate runner.
 * Supports Gemini, Claude, and Groq with retry logic.
 *
 * Provider implementations, retry/timeout helpers, model resolution, and
 * type definitions are imported from the shared `lib/ai-client` package.
 * This module keeps CLI-specific concerns: filesystem registry loading,
 * env-var key resolution, envelope generation, fallback chains, and
 * the `ExtendedAIAdapter` factory.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { tavilySearch, buildSearchAugmentedPrompt } from '../search/tavily.js';
import { ActionableError } from './errors.js';
import { resolveGenericFallbackKey, keyHint, isKeyRoutingRefusal, assertKeyForBackend, LISTING_WARN } from '../ai-client/apiKeyFallback.js';
import type { GenerateRequest, GenerateResponse } from './cacheTypes.js';
import { buildCacheUsage, emptyCacheUsage, flattenEnvelope } from './cacheTypes.js';

// ── Shared ai-client imports ────────────────────────────
import {
  callProvider,
  withRetry,
  CLI_RETRY_CONFIG,
  resolveModel,
  getDefaultTimeout,
  resolveTimeout,
  getModelMinTimeout,
  GEMINI_BASE,
  geminiGroundedSearch,
  DEFAULT_MODEL,
  utf8ByteLength,
} from '../ai-client/index.js';
import { callGeminiBatchEmbed } from '../ai-client/providers/gemini-embeddings.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import {
  computeEmbedding as onnxComputeEmbedding,
  tryWarmup as onnxTryWarmup,
  isReady as onnxIsReady,
} from '../embeddings/onnxEmbedding.js';
import type {
  ProviderResult,
  GenerateOptions as SharedGenerateOptions,
  ModelRegistry,
  GroundingCitation,
} from '../ai-client/index.js';

// ── Interface ────────────────────────────────────────────

export interface GenerateOptions extends SharedGenerateOptions {
  // Re-declare commonly used fields for resilience against resolution failures
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AIAdapter {
  generateText(prompt: string, model: string, options?: GenerateOptions): Promise<string>;
  /** The host-loaded ai-models registry (CLI reads the file; Electron/web/server load it their own way).
   *  REQUIRED (t/3614): consumers apply the pure, imported `getModelMinTimeout(model, adapter.registry)` —
   *  the floor computation is one correct answer per model and stays imported; only the registry DATA is
   *  host-provided. Required-not-optional so a stub can no longer answer 0 without conspicuously
   *  hand-rolling an empty ModelRegistry (the t/3612 defect: 7 adapters silently returned 0). */
  registry: ModelRegistry;
  /** Optional callback for retry progress events. Set by the engine to surface retries in the UI. */
  onRetryProgress?: (info: { attempt: number; maxRetries: number; backoffSeconds: number; message: string }) => void;
  generate?(request: GenerateRequest): Promise<GenerateResponse>;
  computeQueryEmbedding?(text: string): Promise<{ vector: number[] }>;
  /**
   * The provider-reported model string from the most recent successful generateText call.
   * Set by CLI adapters for forensic dating of silent provider model swaps (t/4195).
   * ADDITIVE-OPTIONAL — NO consumer may branch on this field until the exemption lapses
   * (the moment a consumer uses it for routing or gating logic, not logging/display).
   */
  readonly lastProviderModel?: string;
}

/**
 * Extended adapter with optional capabilities for interventions that need
 * web search, NLI, or embeddings. CLI adapters may not implement these —
 * consumers must check availability before calling.
 */
export interface ExtendedAIAdapter extends AIAdapter {
  generate?(request: GenerateRequest): Promise<GenerateResponse>;
  generateTextWithSearch?(prompt: string, model?: string): Promise<{ text: string; searchQueries?: string[]; citations?: GroundingCitation[] }>;
  nliClassify?(pairs: { text_a: string; text_b: string }[]): Promise<{ results: { nli_label: string; nli_entailment: number }[] }>;
  computeQueryEmbedding?(text: string): Promise<{ vector: number[] }>;
}

// ── Model registry (filesystem loading) ─────────────────

let _registry: ModelRegistry | null = null;

function loadRegistry(repoRoot: string): ModelRegistry {
  if (_registry) return _registry;
  const configPath = path.join(repoRoot, 'ai-models.json');
  if (!fs.existsSync(configPath)) {
    throw new ActionableError({
      goal: 'Load AI model registry',
      problem: `Model registry not found at: ${configPath}`,
      location: 'aiAdapter.loadRegistry',
      nextSteps: ['Run from the ai-triad-research repo root', 'Check ai-models.json exists'],
    });
  }
  try {
    _registry = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ModelRegistry;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'state.error', component: 'ai-adapter', level: 'error', message: `Failed to parse model registry at ${configPath}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new ActionableError({
      goal: 'Parse AI model registry',
      problem: `Failed to parse model registry at ${configPath}: ${errMsg}`,
      location: 'aiAdapter.loadRegistry',
      nextSteps: ['Run from the ai-triad-research repo root', 'Check ai-models.json exists'],
      innerError: err,
    });
  }
  return _registry;
}

// ── API key resolution ───────────────────────────────────

const BACKEND_ENV_KEYS: Record<string, string> = {
  gemini: 'GEMINI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  xai: 'XAI_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

function resolveApiKey(backend: string, explicitKey?: string): string {
  // Ollama is local — no API key needed
  if (backend === 'ollama') return 'ollama-local';
  if (explicitKey) return explicitKey;
  const backendKey = process.env[BACKEND_ENV_KEYS[backend] ?? ''];
  if (backendKey) return backendKey;
  // AI_API_KEY is a fallback for gemini ONLY (t/4105); for any other backend a set AI_API_KEY throws, naming its own variable.
  const fallback = resolveGenericFallbackKey(backend);
  if (fallback) return fallback;
  throw new ActionableError({
    goal: `Resolve API key for ${backend} backend`,
    problem: `No API key for ${backend}`,
    location: 'aiAdapter.resolveApiKey',
    nextSteps: [`Set ${keyHint(backend)}, or Register-AIBackend`], // PowerShell's hint: gemini alone offers AI_API_KEY
  });
}

// ── Usage telemetry ─────────────────────────────────────

function emitUsageTelemetry(
  backend: string,
  model: string,
  latencyMs: number,
  usage?: ProviderResult['usage'],
  modelId?: string, // t/3946: friendly model id (e.g. "claude-sonnet-5") for cost-report lookup
): void {
  const entry = {
    ts: new Date().toISOString(),
    backend,
    model,
    ...(modelId !== undefined ? { modelId } : {}),
    latencyMs: Math.round(latencyMs),
    ...usage,
  };
  process.stderr.write(`[usage] ${JSON.stringify(entry)}\n`);
}

// ── Envelope-based generation (structured prompt with caching) ──

function envelopeSystemText(env: { layer1_static: string; layer2_persona: string; layer3_turn: string }): string {
  return [env.layer3_turn, env.layer1_static, env.layer2_persona]
    .filter(s => s.length > 0)
    .join('\n\n');
}

function callEnvelopeProvider(
  backend: string,
  req: GenerateRequest,
  apiKey: string,
  registry: ModelRegistry,
): Promise<ProviderResult> {
  const sysText = envelopeSystemText(req.envelope);
  return callProvider(fetch, backend, req.envelope.layer4_variable, req.model, apiKey, {
    ...req.options,
    timeoutMs: resolveTimeout(req.options?.timeoutMs, req.model, registry), // t/3644: floor-enforced
    systemMessage: sysText || undefined,
    requestedModelId: req.model, // t/3677: served-identity record
    identityRegistry: registry, // t/3731: served-identity classifier cross-check
  });
}

// ── Token counting ──────────────────────────────────────

export async function countTokens(
  text: string,
  apiKey?: string,
): Promise<{ tokenCount: number; accurate: boolean }> {
  const key = apiKey ?? process.env.GEMINI_API_KEY ?? process.env.AI_API_KEY;
  if (key) {
    assertKeyForBackend(key, 'gemini', 'countTokens'); // t/4105 C5: a direct send that bypasses callProvider, so the foreign-key guard runs here
    try {
      const url = `${GEMINI_BASE}/gemini-2.5-flash:countTokens?key=${key}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = await resp.json() as { totalTokens: number };
        return { tokenCount: data.totalTokens, accurate: true };
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'ai-adapter', level: 'warn', message: 'Token count API call failed — falling back to heuristic', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  }
  const charsPerToken = /^\s*[\[{]/.test(text) ? 2.5 : 3.2;
  return { tokenCount: Math.ceil(text.length / charsPerToken), accurate: false };
}

// ── Local Python embedding (matches taxonomy model: all-MiniLM-L6-v2, 384-dim) ──

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function computeEmbeddingViaPython(repoRoot: string, text: string): number[] | null {
  const script = path.join(repoRoot, 'scripts', 'embed_taxonomy.py');
  if (!fs.existsSync(script)) return null;
  try {
    const stdout = execFileSync(PYTHON, [script, 'encode', text], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }).toString('utf-8');
    const vector = JSON.parse(stdout) as number[];
    if (Array.isArray(vector) && vector.length > 0) return vector;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'ai-adapter', level: 'warn', message: 'Python embedding computation failed — falling back to API', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
  }
  return null;
}

// ── Factory ──────────────────────────────────────────────

export function createCLIAdapter(repoRoot: string, explicitApiKey?: string): ExtendedAIAdapter {
  const registry = loadRegistry(repoRoot);
  let _lastProviderModel: string | undefined;

  // Warm up ONNX embedding model in background (loads once, stays warm for all calls)
  onnxTryWarmup().then(ok => {
    if (ok) console.log('[ai-adapter] ONNX embedding ready — subprocess cold-starts eliminated');
  }).catch(() => { /* tryWarmup handles its own logging */ });

  const retryLog = (msg: string) => {
    process.stderr.write(msg + '\n');
    const match = msg.match(/attempt (\d+)\/(\d+) failed \((.+?)\), waiting (\d+)s/);
    if (match) {
      const attempt = parseInt(match[1], 10);
      const maxRetries = parseInt(match[2], 10);
      const reason = match[3];
      const backoffSeconds = parseInt(match[4], 10);
      adapter.onRetryProgress?.({ attempt, maxRetries, backoffSeconds, message: msg });
      getGlobalRecorder()?.record({
        type: 'ai.retry', component: 'ai-adapter', level: 'warn',
        message: `Retry ${attempt}/${maxRetries}: ${reason}`,
        data: { attempt, maxRetries, backoffSeconds, reason },
      });
    }
  };

  function isTimeoutOrNetworkError(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return true;
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('timed out') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')
      || msg.includes('ETIMEDOUT') || msg.includes('fetch failed') || msg.includes('network');
  }

  function is4xxError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /\b4\d{2}\b/.test(msg);
  }

  function signalFetch(baseFetch: typeof globalThis.fetch, signal: AbortSignal): typeof globalThis.fetch {
    return (input, init) => baseFetch(input, { ...init, signal });
  }

  async function callWithTimeout(
    fn: (signal: AbortSignal) => Promise<ProviderResult>,
    timeoutMs: number,
    externalSignal?: AbortSignal,
  ): Promise<ProviderResult> {
    const controller = new AbortController();
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => controller.abort(externalSignal.reason), { once: true });
    }
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async function doGenerateText(prompt: string, model: string, options?: GenerateOptions): Promise<string> {
    const { apiModelId, backend, fixedTemperature } = resolveModel(registry, model);
    const apiKey = resolveApiKey(backend, explicitApiKey);
    // Use registry-driven timeout (tiered default + minTimeoutMs floor from ai-models.json — t/3518 Phase 2).
    // Floor applies even when caller passes an explicit timeout so slow-flagship models can't be
    // accidentally undersized by a short timeoutMs (matches behaviour of the old string-match floor).
    const baseTimeoutMs = options?.timeoutMs ?? getDefaultTimeout(model, registry);
    const floorMs = getModelMinTimeout(model, registry);
    const timeoutMs = Math.max(baseTimeoutMs, floorMs);
    const opts = { ...options, timeoutMs, fixedTemperature, requestedModelId: model, identityRegistry: registry }; // t/3677/t/3731

    const t0 = performance.now();
    getGlobalRecorder()?.record({
      type: 'ai.request', component: 'ai-adapter', level: 'info',
      message: `generateText ${backend}/${apiModelId}`,
      data: { backend, model: apiModelId, fn: 'generateText', promptBytes: utf8ByteLength(prompt) },
    });

    const attemptCall = () => callWithTimeout(
      (signal) => withRetry(
        () => callProvider(signalFetch(fetch, signal), backend, prompt, apiModelId, apiKey, opts),
        CLI_RETRY_CONFIG, `${backend}/${apiModelId}`, retryLog,
      ),
      timeoutMs,
      options?.signal,
    );

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await attemptCall();
        emitUsageTelemetry(backend, apiModelId, performance.now() - t0, result.usage, model);
        getGlobalRecorder()?.record({
          type: 'ai.response', component: 'ai-adapter', level: 'info',
          duration_ms: Math.round(performance.now() - t0),
          message: `generateText success ${backend}/${apiModelId}`,
          data: { backend, model: apiModelId, fn: 'generateText', usage: result.usage, rawStopReason: result.rawStopReason, diagnostics: result.diagnostics },
        });
        if (result.stopReason === 'max_tokens') {
          throw new ActionableError({
            goal: 'Generate AI response',
            problem: `Response truncated at provider output limit (${result.rawStopReason ?? 'max_tokens'}) — JSON parse would fail on partial output`,
            location: 'aiAdapter.doGenerateText',
            nextSteps: ['Raise maxTokens for this stage', 'Shorten the prompt'],
          });
        }
        if (result.stopReason === 'content_filter') {
          throw new ActionableError({
            goal: 'Generate AI response',
            problem: `Response blocked by provider content policy (${result.rawStopReason ?? 'content_filter'})`,
            location: 'aiAdapter.doGenerateText',
            nextSteps: ['Review the prompt for policy-violating content', 'Try a different model or backend'],
          });
        }
        _lastProviderModel = result.providerReportedModel;
        return result.text;
      } catch (err) {
        lastErr = err;
        if (attempt === 0 && isTimeoutOrNetworkError(err) && !is4xxError(err)) {
          const elapsed = Math.round(performance.now() - t0);
          getGlobalRecorder()?.record({
            type: 'ai.retry', component: 'ai-adapter', level: 'warn',
            message: `generateText timeout ${backend}/${apiModelId} after ${elapsed}ms — retrying once`,
            data: { backend, model: apiModelId, elapsed, attempt: 1 },
          });
          continue;
        }
        break;
      }
    }

    // SO e/284#12 cond 6: a refused primary key throws to the caller. It is never a reason to fail over,
    // or another provider would silently serve a request meant for this one.
    if (isKeyRoutingRefusal(lastErr)) throw lastErr;

    const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const isAuthError = errMsg.includes('401') || errMsg.includes('403');
    getGlobalRecorder()?.record({
      type: 'ai.error', component: 'ai-adapter', level: 'error',
      error_category: isAuthError ? 'permissions' : isTimeoutOrNetworkError(lastErr) ? 'network' : 'ai_provider',
      duration_ms: Math.round(performance.now() - t0),
      message: `generateText failed ${backend}/${apiModelId}: ${errMsg.slice(0, 120)}`,
      error: { name: lastErr instanceof Error ? lastErr.name : 'Error', message: errMsg, stack: lastErr instanceof Error ? lastErr.stack : undefined },
      data: { backend, model: apiModelId, fn: 'generateText', isAuthError },
    });

    const chain = registry.fallbackChains?.[model] ?? [];
    for (const fbModel of chain) {
      const fb = resolveModel(registry, fbModel);
      if (isAuthError && fb.backend === backend) continue;
      let fbKey: string;
      try { fbKey = resolveApiKey(fb.backend, explicitApiKey); } catch (err) {
        // A SECONDARY link with only AI_API_KEY is skipped (the primary already failed on its own provider);
        // a foreign-credential refusal is never softened.
        if (isKeyRoutingRefusal(err, 'AIApiKeyForeignCredentialRefused')) throw err;
        if (isKeyRoutingRefusal(err, 'AIApiKeyGeminiOnlyRefused')) {
          process.stderr.write(`[cascade] WARN skipping ${fb.backend}/${fb.apiModelId}: ${LISTING_WARN}
`);
        }
        getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'ai-adapter', level: 'warn', message: `Fallback key resolution failed for ${fb.backend}/${fb.apiModelId}`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        continue;
      }
      process.stderr.write(`[cascade] ${backend}/${apiModelId} failed, trying ${fb.backend}/${fb.apiModelId}\n`);
      try {
        const fbTimeoutMs = getDefaultTimeout(fbModel, registry);
        const fbOpts = { ...opts, timeoutMs: fbTimeoutMs, fixedTemperature: fb.fixedTemperature };
        const fbResult = await callWithTimeout(
          (signal) => withRetry(
            () => callProvider(signalFetch(fetch, signal), fb.backend, prompt, fb.apiModelId, fbKey, fbOpts),
            { ...CLI_RETRY_CONFIG, maxRetries: 2 }, `cascade:${fb.backend}/${fb.apiModelId}`, retryLog,
          ),
          fbTimeoutMs,
          options?.signal,
        );
        emitUsageTelemetry(fb.backend, fb.apiModelId, performance.now() - t0, fbResult.usage, fbModel);
        return fbResult.text;
      } catch (err) {
        if (isKeyRoutingRefusal(err)) throw err; // cond 6: a refusal is never absorbed by the cascade
        getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'ai-adapter', level: 'warn', message: `Fallback provider ${fb.backend}/${fb.apiModelId} failed`, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
        continue;
      }
    }

    if (isTimeoutOrNetworkError(lastErr)) {
      throw new ActionableError({
        goal: `Generate AI response from ${backend}/${apiModelId}`,
        problem: `AI call timed out after ${Math.round(timeoutMs / 1000)}s — no response from ${model}`,
        location: 'lib/debate/aiAdapter.ts:doGenerateText',
        nextSteps: ['Click Retry to attempt the call again, or switch to a faster model'],
      });
    }
    throw lastErr;
  }

  async function doGenerate(request: GenerateRequest): Promise<GenerateResponse> {
    const { apiModelId, backend, fixedTemperature } = resolveModel(registry, request.model);
    const apiKey = resolveApiKey(backend, explicitApiKey);
    const resolvedReq = { ...request, model: apiModelId, options: { ...request.options, fixedTemperature } };

    const t0 = performance.now();
    getGlobalRecorder()?.record({
      type: 'ai.request', component: 'ai-adapter', level: 'info',
      message: `generate (envelope) ${backend}/${apiModelId}`,
      data: { backend, model: apiModelId, fn: 'generate', promptBytes: utf8ByteLength(flattenEnvelope(request.envelope)) },
    });
    try {
      const result = await withRetry(
        () => callEnvelopeProvider(backend, resolvedReq, apiKey, registry),
        CLI_RETRY_CONFIG, `${backend}/${apiModelId}`, retryLog,
      );

      const latency = performance.now() - t0;
      const usage = buildCacheUsage({
        inputTokens: result.usage?.promptTokens,
        outputTokens: result.usage?.completionTokens,
        cacheReadTokens: result.usage?.cachedTokens,
      });
      emitUsageTelemetry(backend, apiModelId, latency, result.usage, request.model);
      getGlobalRecorder()?.record({
        type: 'ai.response', component: 'ai-adapter', level: 'info',
        duration_ms: Math.round(latency),
        message: `generate (envelope) success ${backend}/${apiModelId}`,
        data: { backend, model: apiModelId, fn: 'generate', usage: { inputTokens: result.usage?.promptTokens, outputTokens: result.usage?.completionTokens, cachedTokens: result.usage?.cachedTokens }, rawStopReason: result.rawStopReason, diagnostics: result.diagnostics },
      });
      if (result.stopReason === 'max_tokens') {
        throw new ActionableError({
          goal: 'Generate AI response',
          problem: `Response truncated at provider output limit (${result.rawStopReason ?? 'max_tokens'}) — JSON parse would fail on partial output`,
          location: 'aiAdapter.generate',
          nextSteps: ['Raise maxTokens for this stage', 'Shorten the prompt'],
        });
      }
      if (result.stopReason === 'content_filter') {
        throw new ActionableError({
          goal: 'Generate AI response',
          problem: `Response blocked by provider content policy (${result.rawStopReason ?? 'content_filter'})`,
          location: 'aiAdapter.generate',
          nextSteps: ['Review the prompt for policy-violating content', 'Try a different model or backend'],
        });
      }
      return { text: result.text, usage, model: apiModelId, backend, responseTimeMs: Math.round(latency) };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'ai.error', component: 'ai-adapter', level: 'warn',
        error_category: 'ai_provider',
        duration_ms: Math.round(performance.now() - t0),
        message: `generate (envelope) fallback ${backend}/${apiModelId}`,
        error: { name: err instanceof Error ? err.name : 'Error', message: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
        data: { backend, model: apiModelId, fn: 'generate', fallback: true },
      });
      // Graceful degradation: fall back to flat generateText
      process.stderr.write(`[envelope-fallback] ${backend}/${apiModelId}: ${err instanceof Error ? err.message.slice(0, 100) : err}\n`);
      const flatPrompt = flattenEnvelope(request.envelope);
      const text = await doGenerateText(flatPrompt, request.model, request.options);
      const latency = performance.now() - t0;
      return { text, usage: emptyCacheUsage(), model: apiModelId, backend, responseTimeMs: Math.round(latency) };
    }
  }

  const adapter: ExtendedAIAdapter = {
    generateText: doGenerateText,
    registry,
    generate: process.env.DEBATE_ENVELOPE !== '0' ? doGenerate : undefined,
    get lastProviderModel() { return _lastProviderModel; },

    async generateTextWithSearch(prompt: string, model?: string): Promise<{ text: string; searchQueries?: string[]; citations?: GroundingCitation[] }> {
      const resolved = model || DEFAULT_MODEL;
      const { backend, apiModelId } = resolveModel(registry, resolved);

      if (backend === 'gemini') {
        const apiKey = resolveApiKey(backend, explicitApiKey);
        const result = await geminiGroundedSearch(fetch, prompt, apiModelId, apiKey);
        return { text: result.text, searchQueries: result.searchQueries, citations: result.citations };
      }

      const tavilyKey = process.env.TAVILY_API_KEY;
      if (tavilyKey) {
        const searchQuery = prompt.length > 400 ? prompt.slice(0, 400) : prompt;
        const searchResult = await tavilySearch(searchQuery, tavilyKey, {
          maxResults: 5,
          includeAnswer: true,
          searchDepth: 'basic',
        });
        const { augmentedPrompt, searchQueries } = buildSearchAugmentedPrompt(prompt, searchResult);
        const text = await doGenerateText(augmentedPrompt, resolved);
        const citations: GroundingCitation[] = searchResult.results.map(r => ({
          uri: r.url,
          title: r.title,
          segments: [],
        }));
        return { text, searchQueries: searchQueries.length ? searchQueries : undefined, citations: citations.length ? citations : undefined };
      }

      // t/3177: Fallback-Path Logging — TAVILY_API_KEY absent, no search available
      getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'ai-adapter', level: 'warn', message: `generateTextWithSearch: TAVILY_API_KEY not set — returning plain generation (no search). model=${resolved} backend=${backend}` });
      const text = await doGenerateText(prompt, resolved);
      return { text };
    },

    async computeQueryEmbedding(text: string): Promise<{ vector: number[] }> {
      // ONNX in-process first (all-MiniLM-L6-v2, 384-dim — same model, no subprocess cold-start)
      if (onnxIsReady()) {
        try {
          const vector = await onnxComputeEmbedding(text);
          return { vector };
        } catch (err) {
          getGlobalRecorder()?.record({ type: 'system.error', component: 'ai-adapter', level: 'warn', message: 'ONNX embedding failed — trying Python fallback', error: { name: (err as Error).name ?? 'Error', message: String(err) } });
        }
      }

      // Python subprocess fallback (cold-starts model each call — slower)
      const pyVec = computeEmbeddingViaPython(repoRoot, text);
      if (pyVec) return { vector: pyVec };

      // Gemini API last resort (768-dim — dimension mismatch with taxonomy, attribution accuracy degrades)
      let apiKey: string;
      try {
        apiKey = resolveApiKey('gemini', explicitApiKey);
      } catch {
        throw new ActionableError({
          goal: 'Compute query embedding for claim attribution',
          problem: 'No embedding backend available. ONNX runtime not loaded, Python sentence-transformers not found, and no Gemini API key.',
          location: 'aiAdapter.createCLIAdapter.computeQueryEmbedding',
          nextSteps: [
            'Ensure onnxruntime-node is installed: npm install onnxruntime-node',
            'Or install sentence-transformers: pip install sentence-transformers==4.1.0',
            'Or set GEMINI_API_KEY env var (note: Gemini embeddings have lower attribution accuracy due to dimension mismatch)',
          ],
        });
      }
      console.warn('[embedding] ONNX and Python unavailable, falling back to Gemini API (dimension mismatch with taxonomy — attribution accuracy may degrade)');
      const vectors = await callGeminiBatchEmbed(fetch, [text], 'RETRIEVAL_QUERY', apiKey);
      return { vector: vectors[0] };
    },
  };

  return adapter;
}

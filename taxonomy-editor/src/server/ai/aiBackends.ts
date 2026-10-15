// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * AI backend service — mirrors main/embeddings.ts without Electron's net.fetch.
 * Uses standard fetch (Node 22+).
 *
 * Provider logic (Gemini, Claude, Groq, OpenAI), retry, and utility functions
 * are delegated to the shared lib/ai-client package.
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { createRequire } from 'module';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

const require = createRequire(import.meta.url);
import { getApiKey, getApiKeyForListing, getProjectRoot, EMBED_SCRIPT, resolveDataPath, isEmbeddingWorkerOffloadEnabled, getApiKeySource, type AIBackend } from '../config.js';
import { listingNotConfiguredHint, assertKeyForBackend, isKeyRoutingRefusal } from '../../../../lib/ai-client/apiKeyFallback.js';
import { chainLinkKeys, throwNoApiKeyError } from './chainLinkKeys.js';
import { writeAICallLogEntry, isAICallLogEnabled, classifyKeySource, resolveChainLinkKeySource, emitChainLinkComplete, type ChainLinkComplete } from './aiCallLog.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { parseJsonRobust } from '../../../../lib/debate/helpers.js';
import { extractProviderReason, deriveKeyErrorMessage } from './providerErrors.js';
import { readFileWithMtime } from './fsCache.js';
import { readDataFile } from '../storage/readDataFile.js';
import { tavilySearch, buildSearchAugmentedPrompt } from '../../../../lib/search/tavily.js';
import { resolveEmbeddings, type EmbeddingFallback } from '../../../../lib/embeddings/embeddingResolver.js';
import type { EmbeddingsFile } from '../../../../lib/electron-shared/embeddingIO.js';
// t/1641/t/1643: in-process ONNX all-MiniLM-L6-v2 384-dim encoder (shared lib, t/1651).
// Aliased on import — this file also exports `computeEmbeddings`. Provides the hosted
// fallback when the Python ML venv is absent (DevOps venv slim, t/1642).
import {
  computeEmbedding as onnxComputeEmbedding,
  computeEmbeddings as onnxComputeEmbeddings,
  tryWarmup as onnxTryWarmup,
} from '../../../../lib/embeddings/onnxEmbedding.js';
// t/3183 (t/2977 Item B): off-main-thread ONNX compute via the shared worker (t/3181). Consumed
// only when EMBEDDING_WORKER_OFFLOAD is on; flag-off never touches this path (byte-identical).
import { computeEmbeddingsOffThread, isWorkerPoolShedError, poolStats } from '../../../../lib/embeddings/offThreadEmbedding.js';
import {
  resolveBackend,
  callProvider,
  withRetry,
  buildModelEntryMap,
  getApiModelId as getApiModelIdFromMap,
  resolveTimeout,
  withTimeout,
  SERVER_RETRY_CONFIG,
  geminiGroundedSearch,
  DEFAULT_MODEL,
  getUsage,
  renderTemplate,
  type ModelEntry,
  type ModelRegistry,
  type UsageConfig,
  type GenerateOptions,
  type ProviderResult,
  type RateLimitType,
  type GroundingCitation as SharedGroundingCitation,
} from '../../../../lib/ai-client/index.js';

import { log } from '../logger.js';
import { callWithKeyRotation } from './keyRotator.js';
// Re-export for existing callers (functions moved to providerErrors.ts to break circular dep).
export { is429Error, isContextTooLongError, retryAfterMs } from './providerErrors.js';

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

// ── Multi-provider availability (t/772) ──

export interface BackendAvailability {
  id: string;
  available: boolean;
  models?: string[];
  reason?: 'no_key' | 'tier_restricted' | 'rate_limited';
}

/**
 * Pure computation behind GET /api/backends/available (t/772): a backend is
 * available only when BOTH a key exists for it AND it's authorized for the
 * caller's tier — so the multi-provider UI stops assigning speaker models to
 * backends that 403 at generation time. tier_restricted takes precedence over
 * no_key (a missing key is moot if the tier forbids the backend).
 */
// Narrow structural type is load-bearing: backendAvailability.test.ts passes {}
// (no backends/models) to exercise the empty-registry path. Narrowing to ModelRegistry
// would require a fully-populated object and break that test.
export function computeAvailableBackends(
  registry: { backends?: { id: string }[]; models?: { id: string; backend: string }[] },
  allowedBackends: string[],
  keyPresence: Record<string, boolean>,
): BackendAvailability[] {
  const models = registry.models ?? [];
  return (registry.backends ?? []).map(({ id }) => {
    const tierAllowed = allowedBackends.includes(id);
    if (!tierAllowed) return { id, available: false, reason: 'tier_restricted' as const };
    if (!keyPresence[id]) return { id, available: false, reason: 'no_key' as const };
    return { id, available: true, models: models.filter(m => m.backend === id).map(m => m.id) };
  });
}

// ── Temperature state ──

let _debateTemperature: number | null = null;

export function setDebateTemperature(temp: number | null): void {
  if (temp === _debateTemperature) return;
  _debateTemperature = temp;
}

export function getDebateTemperature(): number | null {
  return _debateTemperature;
}

// ── Re-export shared types ──

export type { RateLimitType };

export interface GenerateTextProgress {
  attempt: number;
  maxRetries: number;
  backoffSeconds: number;
  limitType: RateLimitType;
  limitMessage: string;
}

// ── Model ID mapping (mtime-cached) ──

let _modelEntryCache: Record<string, ModelEntry> | null = null;
let _fallbackChainCache: Record<string, string[]> | null = null;
let _defaultsCache: Record<string, string> | null = null;
let _debateTiersCache: Record<string, Record<string, string>> | null = null;
let _rawRegistryCache: ModelRegistry | null = null;
let _modelConfigMtime = 0;
function loadModelConfig(): { entryMap: Record<string, ModelEntry>; fallbackChains: Record<string, string[]>; defaults: Record<string, string>; debateTiers: Record<string, Record<string, string>> } {
  try {
    const configPath = path.join(getProjectRoot(), 'ai-models.json');
    const { content: raw, mtimeMs } = readFileWithMtime(configPath, _modelEntryCache ? _modelConfigMtime : undefined);
    if (raw !== null) {
      const registry = JSON.parse(raw) as ModelRegistry;
      _modelEntryCache = buildModelEntryMap(registry);
      _fallbackChainCache = registry.fallbackChains ?? {};
      _defaultsCache = registry.defaults ?? {};
      _debateTiersCache = (registry.debateTiers ?? {}) as Record<string, Record<string, string>>;
      _rawRegistryCache = registry;
      _modelConfigMtime = mtimeMs;
      log.api.debug({ models: Object.keys(_modelEntryCache!).length, chains: Object.keys(_fallbackChainCache!).length }, 'Reloaded model config');
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'ai-backends',
      level: 'error',
      message: 'Failed to load/reload the model registry (ai-models.json) — serving from the previous cache or empty maps', // e/134 #4
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.api.warn({ err }, 'Failed to load model config');
    if (!_modelEntryCache) _modelEntryCache = {};
    if (!_fallbackChainCache) _fallbackChainCache = {};
    if (!_defaultsCache) _defaultsCache = {};
    if (!_debateTiersCache) _debateTiersCache = {};
  }
  return { entryMap: _modelEntryCache!, fallbackChains: _fallbackChainCache!, defaults: _defaultsCache!, debateTiers: _debateTiersCache! };
}

/** t/3563: the friendly model id designated for a debate tier + backend in ai-models.json
 *  (e.g. debateTiers.basic.gemini). Single source of truth for "the current, cheap, fast model
 *  for this backend" — used by the key-probe so a model retirement is a registry edit, not a
 *  hand-maintained literal. Returns undefined if the registry lacks the tier/backend entry. */
export function resolveDebateTierModel(tier: string, backend: string): string | undefined {
  return loadModelConfig().debateTiers[tier]?.[backend];
}

/** t/3581: the raw parsed model registry (ai-models.json), for consumers that need the whole
 *  ModelRegistry rather than a decomposed slice — e.g. deriveDebateConfig in the inquiry pipeline.
 *  Same mtime-cached read as the rest of this module; returns an empty registry if the file is
 *  unreadable (loadModelConfig already WARNs on that path). */
export function getModelRegistry(): ModelRegistry {
  loadModelConfig(); // ensure the cache is populated / refreshed
  return _rawRegistryCache ?? ({ backends: [], models: [] } as unknown as ModelRegistry);
}

function loadModelMap(): Record<string, string> {
  const { entryMap } = loadModelConfig();
  return Object.fromEntries(Object.entries(entryMap).map(([k, v]) => [k, v.apiModelId]));
}

// t/4196 Stage 1: registry is required (null = prefix-only, acknowledged) so a mismatch between
// ai-models.json and resolveBackend's id-prefix guess can't silently pick the wrong chain shape.
function getFallbackChain(modelId: string, registry: Pick<ModelRegistry, 'models'> | null): string[] {
  const { fallbackChains, defaults } = loadModelConfig();
  const explicit = fallbackChains[modelId];
  if (explicit) return explicit;

  const backend = resolveBackend(modelId, registry ?? undefined);
  const chain: string[] = [];
  const sameDefault = defaults[backend];
  if (sameDefault && sameDefault !== modelId) chain.push(sameDefault);
  for (const fb of ['gemini', 'groq'] as const) {
    if (fb === backend) continue;
    const fbDefault = defaults[fb];
    if (fbDefault && !chain.includes(fbDefault)) { chain.push(fbDefault); break; }
  }

  if (chain.length > 0) {
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'ai-backends', level: 'info',
      message: `Auto-generated fallback chain for ${modelId}: ${chain.join(' → ')}`,
      data: { model: modelId, chain, source: 'auto-generated' },
    });
  }

  return chain;
}

function getApiModelId(friendlyId: string): string {
  const map = loadModelMap();
  const mapped = getApiModelIdFromMap(map, friendlyId);

  if (mapped !== friendlyId && !map[friendlyId]) {
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'ai-backends', level: 'warn',
      message: `Fuzzy-remapped model ${friendlyId} → ${mapped}`,
      data: { requestedModel: friendlyId, resolvedModel: mapped },
    });
    log.api.warn({ friendlyId, mapped }, 'Fuzzy-remapped unknown model ID');
  } else if (mapped === friendlyId && !map[friendlyId]) {
    log.api.warn({ friendlyId }, 'Unknown model ID — sending as-is (this may fail)');
  }

  return mapped;
}

// ── Token usage tracking ──

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface GenerateResult {
  text: string;
  tokenUsage?: TokenUsage;
  servedModel: string;
}

/** Convert shared ProviderResult.usage to the local TokenUsage shape. */
function mapUsage(usage: ProviderResult['usage']): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.promptTokens ?? 0,
    outputTokens: usage.completionTokens ?? 0,
    totalTokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
  };
}

// ── Public API ──

export { resolveBackend };

/**
 * The ordered list of models generateText() will attempt: the resolved model
 * followed by its fallback chain.
 *
 * t/829: when an explicit key is supplied (e.g. the free-tier server Gemini
 * key), that key belongs to a single provider — so cross-provider fallbacks are
 * dropped. Passing a Gemini key to Groq/Claude only produces auth errors,
 * making the fallback chain useless. Without an explicit key each model resolves
 * its own per-backend key, so the full cross-provider chain is kept.
 */
export function buildModelsToTry(resolved: string, hasExplicitKey: boolean, registry: Pick<ModelRegistry, 'models'> | null): string[] {
  return filterChainForExplicitKey([resolved, ...getFallbackChain(resolved, registry)], hasExplicitKey, registry);
}

/**
 * Pure filter (t/829): when an explicit key is in play, keep only models that
 * resolve to the same backend as the first (resolved) model — the explicit key
 * belongs to one provider. No-op when there's no explicit key or the chain is
 * empty. Split out from buildModelsToTry so the filtering is unit-testable
 * without loading ai-models.json.
 *
 * t/4196 Stage 1 (key-routing site, AC2): this decides which models a caller's explicit key may
 * be sent to — an id-prefix/registry disagreement here sends the key to the wrong provider (the
 * t/4099 class). registry is required; pass null only with a reason for prefix-only acceptance.
 */
export function filterChainForExplicitKey(models: string[], hasExplicitKey: boolean, registry: Pick<ModelRegistry, 'models'> | null): string[] {
  if (!hasExplicitKey || models.length === 0) return models;
  const primaryBackend = resolveBackend(models[0], registry ?? undefined);
  return models.filter(m => resolveBackend(m, registry ?? undefined) === primaryBackend);
}

/** Parse a withRetry progress message and forward it to onRetry + the recorder. */
function reportProviderRetry(
  msg: string,
  backend: string,
  apiModel: string,
  onRetry?: (p: GenerateTextProgress) => void,
): void {
  const attemptMatch = msg.match(/attempt (\d+)\/(\d+)/);
  const backoffMatch = msg.match(/waiting (\d+)s/);
  const reasonMatch = msg.match(/failed \((.+?)\), waiting/);
  const attempt = attemptMatch ? parseInt(attemptMatch[1], 10) : 1;
  const maxRetries = attemptMatch ? parseInt(attemptMatch[2], 10) : SERVER_RETRY_CONFIG.maxRetries;
  const backoffSeconds = backoffMatch ? parseInt(backoffMatch[1], 10) : 5;
  const reason = reasonMatch?.[1] ?? msg;
  onRetry?.({ attempt, maxRetries, backoffSeconds, limitType: 'unknown', limitMessage: msg });
  getGlobalRecorder()?.record({
    type: 'ai.retry', component: 'ai-adapter', level: 'warn',
    message: `Retry ${attempt}/${maxRetries}: ${reason}`,
    data: { attempt, maxRetries, backoffSeconds, reason, backend, model: apiModel },
  });
}

/** Resolve a friendly model name to its provider API model ID (t/2457 streaming path). */
export function getResolvedApiModelId(friendlyId: string): string {
  return getApiModelId(friendlyId);
}

/**
 * Whether `model` is a registered friendly id in ai-models.json (t/2687). `resolveBackend` /
 * `resolveModel` fall back to a prefix guess for unknown ids, so they never reject — callers that
 * must NOT send an unregistered id to a provider (e.g. the op-ed create boundary) use this to gate.
 */
export function isRegisteredModel(model: string): boolean {
  return loadModelConfig().entryMap[model] !== undefined;
}

// Normalize the caller-supplied key(s) to a filtered array, or undefined when the
// caller passed nothing (→ fall back to the stored keys for each backend).
function normalizeExplicitKeys(explicitApiKey: string | string[] | undefined): string[] | undefined {
  if (explicitApiKey === undefined) return undefined;
  return Array.isArray(explicitApiKey) ? explicitApiKey.filter(Boolean) : [explicitApiKey];
}

// Per-attempt generation options: explicit temperature > debate override > 0.7;
// explicit timeout > backend default. entryMap is the full model registry keyed by
// friendly id — fixedTemperature is resolved for currentModel on each attempt so
// fallback models get their own value, not the primary's (t/2108).
function buildGenerateOptions(
  options: { temperature?: number; signal?: AbortSignal; responseSchema?: Record<string, unknown>; maxTokens?: number } | undefined,
  timeoutMs: number | undefined,
  currentModel: string,
  entryMap: Record<string, ModelEntry>,
): GenerateOptions {
  const entry = entryMap[currentModel];
  return {
    temperature: options?.temperature ?? _debateTemperature ?? 0.7,
    timeoutMs: resolveTimeout(timeoutMs, currentModel, getModelRegistry()), // t/3644: floor-enforced
    ...(entry?.fixedTemperature != null ? { fixedTemperature: entry.fixedTemperature } : {}),
    // t/2510: caller cancellation (client disconnect) → callProvider passes this into
    // the provider fetch's init.signal (AbortSignal.any with the per-attempt timeout).
    ...(options?.signal ? { signal: options.signal } : {}),
    // t/2610: structured-output pass-through. callProvider → gemini.ts (90-94) turns
    // responseSchema into native constrained decoding (responseMimeType=application/json
    // + toGeminiSchema). Threaded here so the web op-ed AIAdapter matches the Electron/
    // CLI adapter's schema-enforced path exactly (no prompt-instructed divergence).
    ...(options?.responseSchema ? { responseSchema: options.responseSchema } : {}),
    ...(options?.maxTokens != null ? { maxTokens: options.maxTokens } : {}),
    identityRegistry: getModelRegistry(), // t/4019: served-identity classifier cross-check
  };
}

export async function generateText(
  prompt: string,
  model?: string,
  onRetry?: (p: GenerateTextProgress) => void,
  timeoutMs?: number,
  explicitApiKey?: string | string[],
  options?: {
    temperature?: number;
    signal?: AbortSignal;
    responseSchema?: Record<string, unknown>;
    maxTokens?: number;
    /** t/4088: called once per chain link completion (success or failure) for the AI call log. */
    onChainLinkComplete?: ChainLinkComplete;
  },
): Promise<GenerateResult> {
  const resolved = model || DEFAULT_MODEL;
  const explicitKeys = normalizeExplicitKeys(explicitApiKey);
  const registry = getModelRegistry(); // read once per call, not once per chain link (TL e/284#19)
  const modelsToTry = buildModelsToTry(resolved, explicitKeys !== undefined, registry);
  const entryMap = loadModelConfig().entryMap;

  let lastError: unknown;
  const onChainLinkComplete = options?.onChainLinkComplete; // t/4088: hoisted once — repeated optional access adds no further complexity
  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const currentModel = modelsToTry[mi];
    const backend = resolveBackend(currentModel, registry); // registry first (t/4105 cond 3)
    const keys = await chainLinkKeys(modelsToTry, mi, backend, explicitKeys);
    if (!keys) continue;

    // t/4088: per-link retry count and key source for the AI call log.
    let linkRetryCount = 0;
    const linkKeySource = await resolveChainLinkKeySource(onChainLinkComplete, explicitKeys, keys, backend);

    const apiModel = getApiModelId(currentModel);
    const opts = buildGenerateOptions(options, timeoutMs, currentModel, entryMap);

    try {
      // t/3052+t/3056: rotate across the key pool (round-robin + 429 cooldown);
      // callWithKeyRotation paces free-tier keys automatically via pool membership.
      // t/3062: withRetry wraps callWithKeyRotation (not inside it) so a 429 bubbles
      // out to the rotation loop immediately; the inner loop exhausts the key pool
      // before outer withRetry ever sees the error and backs off for 120s.
      // t/2510: signal-aware backoff + pre-attempt abort check; an AbortError is
      // rethrown non-retryable so a deliberate cancel never enters the retry ladder.
      const result = await withRetry(
        () => callWithKeyRotation(backend, keys,
          (apiKey) => callProvider(fetch, backend, prompt, apiModel, apiKey, opts)),
        SERVER_RETRY_CONFIG,
        `${backend}/${apiModel}`,
        (msg: string) => { linkRetryCount++; reportProviderRetry(msg, backend, apiModel, onRetry); },
        options?.signal,
      );

      if (mi > 0) {
        getGlobalRecorder()?.record({
          type: 'ai.fallback', component: 'ai-adapter', level: 'info',
          message: `Fallback succeeded: ${currentModel} (after ${resolved} failed)`,
          data: { originalModel: resolved, fallbackModel: currentModel, fallbackIndex: mi },
        });
      }
      emitChainLinkComplete(onChainLinkComplete, { model: currentModel, backend, keySource: linkKeySource, retryCount: linkRetryCount, status: '200' });
      return { text: result.text, tokenUsage: mapUsage(result.usage), servedModel: currentModel };
    } catch (err) {
      // t/2524: a deliberate cancellation (client disconnect) must NOT advance the
      // fallback chain — otherwise every remaining chain entry emits a spurious
      // warn-level ai.fallback on user cancel. Rethrow AbortError immediately (same
      // name-check as t/2507; DOMException-compatible).
      if ((err as { name?: unknown } | null)?.name === 'AbortError') {
        emitChainLinkComplete(onChainLinkComplete, { model: currentModel, backend, keySource: linkKeySource, retryCount: linkRetryCount, status: 'aborted' });
        throw err;
      }
      if (isKeyRoutingRefusal(err)) throw err; // cond 6: a refused key is never a reason to fail over — no log entry (no call made)
      lastError = err;
      emitChainLinkComplete(onChainLinkComplete, { model: currentModel, backend, keySource: linkKeySource, retryCount: linkRetryCount, status: deriveCallLogStatus(err) });
      if (mi < modelsToTry.length - 1) {
        const nextModel = modelsToTry[mi + 1];
        getGlobalRecorder()?.record({
          type: 'ai.fallback', component: 'ai-adapter', level: 'warn',
          message: `${currentModel} failed after retries — falling back to ${nextModel}`,
          data: { failedModel: currentModel, nextModel, fallbackIndex: mi, error: String(err), chain: modelsToTry },
        });
      }
    }
  }

  if (lastError === undefined) throwNoApiKeyError(resolveBackend(resolved, registry), modelsToTry); // every link was skipped
  throw lastError;
}

export type { SharedGroundingCitation as GroundingCitation };
export type { GroundingSegment } from '../../../../lib/ai-client/providers/gemini-search.js';

export async function generateTextWithSearch(
  prompt: string, model?: string, explicitApiKey?: string | string[],
): Promise<{ text: string; searchQueries?: string[]; citations?: SharedGroundingCitation[] }> {
  const resolved = model || DEFAULT_MODEL;
  // t/4196 Stage 1 (key-routing site, AC2): decides gemini vs Tavily+LLM, and which key goes
  // downstream — the server-side twin of t/4141's embeddings.ts fix. Registry first (t/4105 cond 3).
  const backend = resolveBackend(resolved, getModelRegistry());

  if (backend !== 'gemini') {
    const tavilyKey = await getApiKey('tavily');
    if (tavilyKey) {
      const searchQuery = prompt.length > 400 ? prompt.slice(0, 400) : prompt;
      log.api.info({ model: resolved, queryLength: searchQuery.length }, 'Tavily search');
      const searchResult = await tavilySearch(searchQuery, tavilyKey, {
        maxResults: 5,
        includeAnswer: true,
        searchDepth: 'basic',
      });
      const { augmentedPrompt, searchQueries, citations: searchCitations } = buildSearchAugmentedPrompt(prompt, searchResult);
      const { text } = await generateText(augmentedPrompt, resolved, undefined, undefined, explicitApiKey);
      const citations: SharedGroundingCitation[] = searchCitations.map(c => ({
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
    // t/3176 (Fallback-Path Logging): no Tavily key → search is silently omitted and we degrade to
    // plain generation. WARN so a missing-key regression (answers ungrounded) is visible, not silent.
    log.api.warn({ model: resolved, backend }, 'generateTextWithSearch: no Tavily key — falling back to plain generation (search omitted)');
    const result = await generateText(prompt, resolved, undefined, undefined, explicitApiKey);
    return { text: result.text };
  }

  // t/3175: parity with generateText's resilience stack. Previously this used only
  // explicitApiKey[0] and called geminiGroundedSearch directly — so a debate round's
  // search-verify bursts hammered ONE free-tier key (the other pool keys idle) → 429
  // api_key_exhausted with no retry. Route the grounded-search provider call through
  // callWithKeyRotation (round-robin + 429 cooldown across the whole pool) wrapped in
  // withRetry (backoff), exactly like generateText (aiBackends.ts:383). Paid-overflow
  // is layered at the route caller (routes/ai.ts), mirroring generateWithPaidFallback.
  const fallbackKey = (Array.isArray(explicitApiKey) || explicitApiKey) ? undefined : await getApiKey('gemini');
  const keys: string[] = Array.isArray(explicitApiKey)
    ? explicitApiKey.filter(Boolean)
    : explicitApiKey
      ? [explicitApiKey]
      : (fallbackKey ? [fallbackKey] : []);
  if (keys.length === 0) {
    throw new ActionableError({
      goal: 'Perform grounded search via Gemini',
      problem: 'No Gemini API key configured',
      location: 'aiBackends.generateTextWithSearch',
      nextSteps: ['Set your Gemini API key in Settings'],
    });
  }

  const apiModel = getApiModelId(resolved);
  return withRetry(
    () => callWithKeyRotation('gemini', keys,
      (apiKey) => geminiGroundedSearch(fetch, prompt, apiModel, apiKey)),
    SERVER_RETRY_CONFIG,
    `gemini-search/${apiModel}`,
  );
}

// ── UsageID wrappers (t/1262) ──

/** t/3245: classify a generateText failure into an AI-call-log Status string — the HTTP/API status when
 *  the error carries one, else a coarse aborted/timeout/error class. Never throws (used on a catch path). */
function deriveCallLogStatus(err: unknown): string {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string };
  const code = e?.statusCode ?? e?.status;
  if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  const msg = (e?.message ?? '').toLowerCase();
  if (e?.name === 'AbortError' || msg.includes('abort')) return 'aborted';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'error';
}

/**
 * Resolve AI call parameters from the UsageID registry, then delegate to
 * generateText(). Tier-based model overrides and key rotation are preserved —
 * the registry provides defaults; the caller passes overrides for tier pinning.
 */
export async function generateTextByUsage(
  usageId: string,
  values: Record<string, string>,
  overrides?: Partial<UsageConfig>,
  onRetry?: (p: GenerateTextProgress) => void,
  explicitApiKey?: string | string[],
  signal?: AbortSignal, // t/2510: caller cancellation (client disconnect) → provider fetch
): Promise<GenerateResult> {
  const repoRoot = getProjectRoot();
  const config = getUsage(usageId, repoRoot);
  const merged = overrides ? { ...config, ...overrides } : config;

  const prompt = merged.messageTemplate
    ? renderTemplate(merged.messageTemplate, values)
    : merged.message ?? values.prompt ?? '';

  getGlobalRecorder()?.record({
    type: 'ai.call_by_usage', component: 'ai-backends', level: 'info',
    message: `generateTextByUsage: ${usageId}`,
    data: { usageId, model: merged.model, hasOverrides: !!overrides, valueKeys: Object.keys(values) },
  });

  // t/3245: AI Call Log capture (TS side of t/3242's PS hook). Logs ONE record per call with the final
  // status + total retry count — PS logs per-attempt, a documented granularity divergence (t/3245 PR).
  // Flag off → the onRetry wrap and the write are both skipped (zero overhead). Scenario defaults to
  // usageId, mirroring the PS -Scenario default.
  if (!isAICallLogEnabled()) {
    return generateText(prompt, merged.model, onRetry, merged.timeoutMs, explicitApiKey, { temperature: merged.temperature, signal });
  }
  // t/4088: per-chain-link logging via onChainLinkComplete — model/backend/keySource captured per link.
  // countingOnRetry replaced: retry count is now tracked inside generateText per link (t/4088).
  return generateText(prompt, merged.model, onRetry, merged.timeoutMs, explicitApiKey, {
    temperature: merged.temperature,
    signal,
    onChainLinkComplete: ({ model, backend, keySource, retryCount, status }) => {
      writeAICallLogEntry({ scenario: usageId, promptId: usageId, promptStart: prompt, model, backend, keySource, retryCount, status });
    },
  });
}

/**
 * UsageID wrapper for search — resolves config from the registry, then
 * delegates to generateTextWithSearch(). The execution path (Gemini grounding
 * or Tavily augmentation) is unchanged; the registry provides observability
 * and centralized parameter defaults.
 */
export async function generateTextWithSearchByUsage(
  usageId: string,
  values: Record<string, string>,
  overrides?: Partial<UsageConfig>,
  explicitApiKey?: string | string[],
): Promise<{ text: string; searchQueries?: string[]; citations?: SharedGroundingCitation[] }> {
  const repoRoot = getProjectRoot();
  const config = getUsage(usageId, repoRoot);
  const merged = overrides ? { ...config, ...overrides } : config;

  const prompt = merged.messageTemplate
    ? renderTemplate(merged.messageTemplate, values)
    : merged.message ?? values.prompt ?? '';

  getGlobalRecorder()?.record({
    type: 'ai.call_by_usage', component: 'ai-backends', level: 'info',
    message: `generateTextWithSearchByUsage: ${usageId}`,
    data: { usageId, model: merged.model, hasOverrides: !!overrides, valueKeys: Object.keys(values) },
  });

  // t/3245: AI Call Log capture. generateTextWithSearch exposes no retry callback → RetryCount 0. Same
  // .then(onFulfilled, onRejected) settle-side-effect pattern as generateTextByUsage (no double-record).
  // t/4088: derive model/backend/keySource up-front; generateTextWithSearch doesn't expose chain links.
  if (!isAICallLogEnabled()) {
    return generateTextWithSearch(prompt, merged.model, explicitApiKey);
  }
  const searchModel = merged.model ?? DEFAULT_MODEL;
  const searchBackend = resolveBackend(searchModel, getModelRegistry());
  const normalizedSearchKeys = normalizeExplicitKeys(explicitApiKey);
  const searchKeySource = normalizedSearchKeys !== undefined
    ? classifyKeySource(normalizedSearchKeys[0] ?? '', searchBackend)
    : await getApiKeySource(searchBackend);
  const logCtx = { scenario: usageId, promptId: usageId, promptStart: prompt, model: searchModel, backend: searchBackend, keySource: searchKeySource };
  return await generateTextWithSearch(prompt, merged.model, explicitApiKey).then(
    (result) => { writeAICallLogEntry({ ...logCtx, retryCount: 0, status: '200' }); return result; },
    (err: unknown) => { writeAICallLogEntry({ ...logCtx, retryCount: 0, status: deriveCallLogStatus(err) }); throw err; },
  );
}

// ── Embeddings ──

let embeddingsCache: EmbeddingsFile | null = null;
// Hydrate-once dedup: coalesce concurrent callers onto one fs.readFile (t/3085).
let embeddingsLoadInFlight: Promise<EmbeddingsFile | null> | null = null;
// t/3086: Python availability probe result. Declared here so _setPythonAvailableForTest (below)
// satisfies no-use-before-define. Populated lazily by isPythonEmbeddingAvailable().
let _pythonAvailable: boolean | null = null;

function getEmbeddingsPath(): string {
  return path.join(resolveDataPath('taxonomy/Origin'), 'embeddings.json');
}
const EMBEDDINGS_REL_PATH = path.join('taxonomy', 'Origin', 'embeddings.json');

/**
 * Load the precomputed embeddings.json once, asynchronously, with promise coalescing so
 * concurrent callers all await the same read rather than each issuing a separate disk I/O.
 * t/3085: replaces sync fs.readFileSync; ENOENT promoted to warn because in prod ACA
 * (github-api mode) the file never reaches /tmp — every absence fires this path.
 */
async function loadEmbeddingsFileAsync(): Promise<EmbeddingsFile | null> {
  if (embeddingsCache) return embeddingsCache;
  if (embeddingsLoadInFlight) return embeddingsLoadInFlight;
  embeddingsLoadInFlight = (async () => {
    try {
      const buf = await readDataFile(EMBEDDINGS_REL_PATH, { largeFile: true });
      const raw = buf.toString('utf-8');
      const parsed = JSON.parse(raw) as EmbeddingsFile;
      embeddingsCache = parsed;
      const nodeCount = Object.keys(parsed.nodes ?? {}).length;
      getGlobalRecorder()?.record({
        type: 'system.info', component: 'ai-backends', level: 'info',
        message: `embeddings.json loaded: ${nodeCount} nodes`,
        data: { embeddings_node_count: nodeCount, embeddings_model: parsed.model },
      });
      return embeddingsCache;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // t/3085: ENOENT promoted to warn — in prod ACA (github-api mode) the file never
      // reaches /tmp, so every request hits this path. It is not a normal miss; it is the
      // root-cause symptom that triggers ~3,600 ONNX re-embeds per debate.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-backends', level: 'warn',
        message: code === 'ENOENT'
          ? 'embeddings.json not found — re-embedding all taxonomy texts (quota impact in prod)'
          : 'embeddings.json unreadable — falling back to full re-embed (API quota)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    } finally {
      embeddingsLoadInFlight = null;
    }
  })();
  return embeddingsLoadInFlight;
}

/** Pre-warm the embeddings cache at server startup (t/3085). Fire-and-forget; errors are FR-recorded. */
export async function prewarmEmbeddingsCache(): Promise<void> {
  await loadEmbeddingsFileAsync();
}

/** t/3086: probe result after prewarmEmbeddingsCache() resolves. */
export function getEmbeddingsCacheStatus(): { present: boolean; nodeCount: number | null } {
  if (!embeddingsCache) return { present: false, nodeCount: null };
  return { present: true, nodeCount: Object.keys(embeddingsCache.nodes ?? {}).length };
}

/** t/3165: a stable core POV belief node used as the /readyz + deploy-gate RESOLUTION canary.
 *  If the taxonomy ever legitimately drops it, update this one constant (the resolution check
 *  will otherwise false-fail; corpusNodeCount>0 distinguishes that config case from a dead cache). */
export const EMBEDDINGS_RESOLUTION_CANARY = 'acc-beliefs-003';
const EMBEDDING_DIM = 384; // all-MiniLM-L6-v2

/**
 * t/3165: RESOLUTION probe (presence != resolution). The t/3165 class is a cache that is
 * present (nodeCount>0) but doesn't actually resolve a keyed lookup at runtime (stale/wrong
 * corpus, or empty/corrupt vectors). Asserts the canary id resolves to a real EMBEDDING_DIM
 * vector — the SAME `nodes[id].vector` lookup the compute path uses (embeddingResolver.ts),
 * so /readyz gates on the real resolve path, not mere file presence. `/readyz` and DevOps2's
 * deploy gate (t/3091) share this single predicate.
 */
export function getEmbeddingsResolution(): {
  present: boolean; nodeCount: number | null; resolves: boolean; canaryId: string;
} {
  const cache = embeddingsCache;
  const present = !!(cache && cache.nodes && Object.keys(cache.nodes).length > 0);
  const nodeCount = cache ? Object.keys(cache.nodes ?? {}).length : null;
  const vec = cache?.nodes?.[EMBEDDINGS_RESOLUTION_CANARY]?.vector;
  // t/3192: non-prod-only test knob — force resolves:false so /readyz returns 503 warming, letting
  // DevOps exercise the deploy warm-gate's FIRE arm (resolves:false → block the traffic-shift)
  // against a REAL staging/throwaway revision without an actually-broken cache. Gated to
  // NODE_ENV!=='production' so it can NEVER force a false-negative /readyz in prod.
  const forceResolvesFalse = process.env.NODE_ENV !== 'production' && process.env.READYZ_FORCE_RESOLVES_FALSE === '1';
  const resolves = !forceResolvesFalse && present && Array.isArray(vec) && vec.length === EMBEDDING_DIM && vec.some((v) => v !== 0);
  return { present, nodeCount, resolves, canaryId: EMBEDDINGS_RESOLUTION_CANARY };
}

/** Reset the embeddings cache — test isolation only. */
export function _resetEmbeddingsCacheForTest(): void {
  embeddingsCache = null;
  embeddingsLoadInFlight = null;
}

/** Pre-set Python availability without spawning the probe — test isolation only. */
export function _setPythonAvailableForTest(v: boolean): void {
  _pythonAvailable = v;
}

/** Clear the cached Python-availability probe result so the next call re-runs it — test isolation only. */
export function _resetPythonAvailableForTest(): void {
  _pythonAvailable = null;
}

const EMBEDDINGS_REQUEST_TIMEOUT_MS = 45_000;

// Chunk-and-yield ceiling for a single computeEmbeddings call (t/2914 item 2). One large
// in-process ONNX batch blocks the event loop for the whole compute — a real prod 2389-text
// batch froze it ~46.8s → 500, past ACA's liveness deadline, and the t/2905 concurrency cap
// can't catch a *single* request. Splitting the batch and yielding (setImmediate) between
// chunks keeps the loop responsive to health checks + other work during a big compute.
// TUNE from the first post-deploy large-compute trace (t/2904 loop-delay/heap observability).
// t/3180 (t/2977 Item A, interim relief): 256→128 — the t/3165 incident's novel-text batches
// (~200/792) still blocked the loop enough to trip ACA liveness 503s at chunk=256; halving the
// chunk yields the loop 2× as often between ONNX passes → fewer liveness 503s. Interim only
// (reduces, doesn't eliminate — the durable fix is worker-offload, t/2977 Item B / t/3183).
const EMBEDDING_COMPUTE_CHUNK = 128;

// t/3183 C6 (t/2977#6) — PROVISIONAL demand baseline for the novel-text class's 3rd recurrence.
// The worker (Item B) raises the compute CEILING (a big batch no longer blocks the loop) but does
// NOT bound DEMAND. When a single request's NOVEL (cacheHits=0) count exceeds this, we emit ONE
// WARN naming the requester — never a hard reject — so an unbounded-demand caller is visible BEFORE
// it saturates the worker queue (offload on) or the loop (offload off).
//
// TIERING vs LARGE_RECOMPUTE_WARN_ITEMS=64 (routes/ai.ts, #1720) — intentionally NOT redundant
// (TL p/522#134):
//   • 64  = "notable volume" — a large recompute happened (INFO/WARN, expected under cold cache).
//   • 256 = "demand baseline exceeded — the DEMAND itself may be the bug" (the class's failure mode).
//
// 256 is CALIBRATED (t/3199, TL sign-off t/3199#3) on two independent axes — it must sit ABOVE the
// legit residual-novel-per-turn max or it fires every normal debate (noise = dead gate):
//  • Organic demand: a normal turn's residual-novel count is ~200 (trace-derived from t/3165 — the
//    792/1347 batches were largely STATIC corpus, now cached, so they over-state a normal turn).
//    256 > ~200 → normal turns never false-fire.
//  • Physical ceiling: the offload worker computes ~10 texts/s (measured at the re-canary) and the
//    route timeout is ~50s → a single all-novel request hits a ~500-text wall. 256 ≈ HALF that wall,
//    so the WARN fires with ~2× margin BEFORE requests start timing out.
// Validated at the storm-replay canary (GREEN — staging rev 0000166, image b2b79c95; t/3209). t/3085
// residual (kept visible): that storm was SYNTHETIC (uniform 128-novel/request), so the ORGANIC leg
// stays trace-derived, not directly measured — the prod-turn re-confirm (t/3210) closes it after the
// flag flips ON. WARN-only; never a hard cap.
const NOVEL_TEXT_DEMAND_BASELINE = 256;

// Resolve a (possibly large) batch in chunks, yielding the event loop between chunks. Safe
// because resolveEmbeddings is order-preserving and per-text pure (local cache-hit or chain
// compute), so concatenating per-chunk results is identical to resolving the whole batch at
// once. Exported for unit test. `chunkSize` and `chunkTimeoutMs` are injectable so tests can
// force chunking small and verify per-chunk timeout behaviour (t/2985).
export async function resolveEmbeddingsChunked(
  texts: string[],
  ids: string[] | undefined,
  local: EmbeddingsFile | null,
  chain: EmbeddingFallback[],
  chunkSize: number = EMBEDDING_COMPUTE_CHUNK,
  chunkTimeoutMs: number = EMBEDDINGS_REQUEST_TIMEOUT_MS,
): Promise<number[][]> {
  // t/2985: timeout is per-chunk, not aggregate — large healthy batches complete while a
  // stuck chunk still gets bounded. The outer withTimeout (aggregate) was removed.
  // t/3074 TL-GV: stamp .timeout at the rejection throw site (not via message-matching —
  // that was fragile-prose per t/2952; a wording drift in withTimeout would silently revert
  // timeouts to 500). Promise.race owns the rejection object so the marker is structural.
  const resolveChunk = async (t: string[], i: string[] | undefined): Promise<number[][]> => {
    const timeoutErr = Object.assign(
      new Error(`embeddings-chunk timed out after ${chunkTimeoutMs / 1000}s`),
      { timeout: true },
    );
    const timeoutRace = new Promise<never>((_, reject) =>
      setTimeout(() => reject(timeoutErr), chunkTimeoutMs),
    );
    return Promise.race([resolveEmbeddings(t, i, local, chain), timeoutRace]);
  };
  if (texts.length <= chunkSize) return resolveChunk(texts, ids);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += chunkSize) {
    const vecs = await resolveChunk(texts.slice(i, i + chunkSize), ids?.slice(i, i + chunkSize));
    for (const v of vecs) out.push(v);
    // Yield the loop between chunks so a big compute can't monopolize it past the liveness deadline.
    if (i + chunkSize < texts.length) await new Promise<void>((r) => setImmediate(r));
  }
  return out;
}

// t/1641/t/1643: `_explicitApiKey` is retained for call-site arity (server.ts passes
// the free-tier key) but is no longer consumed — embeddings are computed by the local
// Python encoder or the in-process ONNX fallback, both 384-dim/all-MiniLM-L6-v2, no API.
/**
 * t/3373: emit the clean, greppable worker-pool-shed WARN token IFF `err` is a queue-shed (i.e. its
 * ActionableError carries WORKER_POOL_SHED_CODE). Does NOT throw or swallow — the offload wrapper
 * re-throws so the resolve/fallback/503 path is byte-identical. Must be called at the offload
 * boundary (before resolveEmbeddings, which discards the shed code into a generic error). Exported
 * so the shed-vs-generic discrimination is unit-testable without the full computeEmbeddings surface.
 * component:'api' is the proven Log-Analytics sink (t/3110/t/3308 lesson); DevOps matches the token.
 */
export function logWorkerPoolShedIfApplicable(err: unknown, ctx: { requester: string; inputCount: number }): void {
  if (!isWorkerPoolShedError(err)) return;
  log.api.warn(
    { component: 'api', subsystem: 'ai-backends', requester: ctx.requester, inputCount: ctx.inputCount, ...poolStats() },
    'embeddings worker-pool shed',
  );
}

export async function computeEmbeddings(
  texts: string[], ids?: string[], _explicitApiKey?: string,
  opts?: { requester?: string },
): Promise<{ vectors: number[][]; cacheHits: number; cacheMisses: number }> {
  const startMs = Date.now();
  // t/3183: label the caller so a worker-queue shed WARN (offload on) and the demand-baseline WARN
  // both name WHO. Defaults to 'unknown' — callers pass the route/usage (see routes/ai.ts).
  const requester = opts?.requester ?? 'unknown';
  const local = await loadEmbeddingsFileAsync();
  // t/3086: pre-pass hit count (cheap dict lookup, same data resolveEmbeddings uses).
  const cacheHits = (ids && local)
    ? ids.filter(id => id != null && local.nodes[id] != null).length
    : 0;
  const cacheMisses = texts.length - cacheHits;

  // t/3183 C6: the worker raises the compute ceiling but does not bound demand (class's 3rd
  // recurrence). One WARN per over-baseline request makes an unbounded-demand caller visible
  // BEFORE it saturates the worker queue / starves the loop — offload on or off.
  if (cacheMisses > NOVEL_TEXT_DEMAND_BASELINE) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-backends', level: 'warn',
      message: `Novel-text demand ${cacheMisses} exceeds by-design baseline ${NOVEL_TEXT_DEMAND_BASELINE} (calibrated: organic-normal ~200 + ~500-text throughput/timeout wall, t/3199) — the worker raises the compute ceiling but does not bound demand; check for an unbounded-demand caller`,
      data: { requester, cacheMisses, cacheHits, baseline: NOVEL_TEXT_DEMAND_BASELINE, inputCount: texts.length },
    });
  }

  const chain: EmbeddingFallback[] = [];

  // Local Python encoder stays primary when present (TL ruling t/1641#10).
  if (await isPythonEmbeddingAvailable()) {
    chain.push({
      name: 'python-batch',
      compute: (t, missingIds) => {
        const finalIds = missingIds
          ? missingIds.map((id, j) => id ?? `_idx_${j}`)
          : t.map((_, j) => `_idx_${j}`);
        return computeBatchViaLocalPython(t, finalIds);
      },
    });
  }

  // t/1641/t/1643: in-process ONNX all-MiniLM-L6-v2 (shared lib t/1651) — hosted
  // fallback when the Python ML venv is absent (DevOps venv slim, t/1642). Same
  // 384-dim vector space as the stored corpus; no API key, no network.
  if (isEmbeddingWorkerOffloadEnabled()) {
    // t/3183 (t/2977 Item B): flag ON → run the ONNX pass in the shared worker thread so a large
    // miss-text batch can't block the event loop past ACA's liveness deadline (t/3165). Widen the
    // worker's Float32Array views → number[][] for the resolver. A shed/crash rejects (load-shed
    // 503) and is NOT caught here — an in-thread recompute would reintroduce the exact starvation the
    // offload removes.
    // t/3209 (C1 — the SO single-session invariant): do NOT call onnxTryWarmup() under the flag. It
    // warms/inits a MAIN-THREAD ONNX session, but the WORKER owns the only session (t/3181); warming
    // here too was a 2× ~250MB model double-load that could OOM under storm load (the C1 defect the
    // canary surfaced alongside the emit bug). The worker inits ONNX itself; if it's genuinely
    // unavailable the worker fails LOUD → resolveEmbeddings "all fallbacks failed" (caught below),
    // which the canary sees — no silent in-thread fallback.
    chain.push({
      name: 'onnx-batch-worker',
      compute: (t) => computeEmbeddingsOffThread(t, { requester })
        .then(vecs => vecs.map(v => Array.from(v)))
        .catch((err: unknown) => {
          // t/3373: emit the clean shed token HERE, then re-throw UNCHANGED (byte-identical resolve
          // path). It must be here — resolveEmbeddings swallows each fallback's error and re-throws a
          // generic 'All embedding fallbacks failed', so the shed's ActionableError.code is gone by
          // computeEmbeddings' catch. See logWorkerPoolShedIfApplicable.
          logWorkerPoolShedIfApplicable(err, { requester, inputCount: t.length });
          throw err;
        }),
    });
  } else if (await onnxTryWarmup()) {
    // Flag OFF → today's exact in-thread call (warms + uses the main-thread session) → byte-identical.
    chain.push({ name: 'onnx-batch', compute: (t) => onnxComputeEmbeddings(t) });
  }

  // t/3165 observability: emit the RESOLVED chain + the offload-flag value to Pino/stdout. The
  // completion record at :821 lands in the FR ring ONLY (invisible to Log Analytics) — which is
  // precisely why the "offload looked engaged at flip but silently wasn't" regression took inference
  // to diagnose. A prod compute now self-reports on stdout: offloadFlag=false + chain=['onnx-batch']
  // (in-process, main-thread — the t/3165 starvation shape) vs offloadFlag=true +
  // chain=['onnx-batch-worker'] (engaged). Unconditional + pre-compute → can't be masked by a
  // swallowed downstream error.
  // t/3246: emit under the established component:'api' (proven to reach Log Analytics) with the
  // subsystem identity in a `subsystem` field — the earlier novel component:'ai-backends' kept
  // offloadFlag/chainMembers invisible in LA (same drop as the synth serialize_ms lines).
  log.api.info({
    component: 'api', subsystem: 'ai-backends', requester,
    offloadFlag: isEmbeddingWorkerOffloadEnabled(),
    chainMembers: chain.map(c => c.name),
    inputCount: texts.length, cacheHits, cacheMisses,
  }, 'computeEmbeddings chain resolved');

  try {
    // t/2985: timeout is now per-chunk inside resolveEmbeddingsChunked — no aggregate ceiling.
    const result = await resolveEmbeddingsChunked(texts, ids, local, chain);
    const elapsedMs = Date.now() - startMs;
    getGlobalRecorder()?.record({
      type: 'ai.response', component: 'ai-backends', level: 'info',
      message: `computeEmbeddings completed: ${texts.length} inputs in ${elapsedMs}ms`,
      data: { inputCount: texts.length, dimensions: result[0]?.length ?? 0, elapsedMs, chainMembers: chain.map(c => c.name), cacheHits, cacheMisses },
    });
    return { vectors: result, cacheHits, cacheMisses };
  } catch (err) {
    const elapsedMs = Date.now() - startMs;
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-backends', level: 'error',
      message: `Embedding computation failed after ${elapsedMs}ms (${texts.length} inputs)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { inputCount: texts.length, elapsedMs, chainMembers: chain.map(c => c.name) },
    });
    // t/3209: also surface the underlying error to Pino/stdout (→ Log Analytics). The FR record above
    // lives in the ring buffer only, so a container-side compute failure was previously invisible in
    // logs — the offload NO-GO was diagnosable ONLY by inference (zero worker/fallback lines reached
    // stdout). The real cause (e.g. the worker's ERR_MODULE_NOT_FOUND surfaced through resolveEmbeddings)
    // is now greppable instead of masked by the generic ActionableError below.
    log.api.error({ component: 'api', subsystem: 'ai-backends', inputCount: texts.length, elapsedMs, chainMembers: chain.map(c => c.name), err: String(err) }, 'computeEmbeddings failed');
    // t/2985: distinguish a per-chunk timeout from an empty-chain init failure so triage
    // isn't misdirected to a packaging cause when the encoder worked but timed out.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timed out')) {
      throw new ActionableError({
        goal: 'Compute embeddings',
        problem: `Embedding chunk timed out after ${elapsedMs}ms (${texts.length} inputs) — a ${EMBEDDING_COMPUTE_CHUNK}-text chunk exceeded the ${EMBEDDINGS_REQUEST_TIMEOUT_MS / 1000}s per-chunk budget`,
        location: 'aiBackends.computeEmbeddings',
        nextSteps: [
          `Increase EMBEDDINGS_REQUEST_TIMEOUT_MS (currently ${EMBEDDINGS_REQUEST_TIMEOUT_MS}ms) if ONNX compute on this host is slower than expected`,
          'Or reduce the batch size sent to /api/embeddings/compute',
        ],
      });
    }
    // e/134 (Shared Lib handoff, e/134#2 + t/3538): resolveEmbeddings now throws a well-formed
    // ActionableError naming the tried fallback chain. Preserve that precise diagnosis instead of
    // relabeling EVERY failure as an ONNX-init failure — the old blanket wrap misdirected triage
    // (a fallback-exhaustion or worker-module error reported as "ONNX fallback failed to initialize").
    // Only synthesize the generic ONNX message when the underlying error is NOT already actionable.
    if (err instanceof ActionableError) throw err;
    throw new ActionableError({
      goal: 'Compute embeddings',
      problem: `No local embedding encoder available after ${elapsedMs}ms — the Python sentence-transformers venv is absent and the in-process ONNX all-MiniLM-L6-v2 fallback failed to initialize`,
      location: 'aiBackends.computeEmbeddings',
      nextSteps: [
        'Verify the baked ONNX model directory is present (AI_TRIAD_ONNX_MODEL_DIR points to model.onnx + tokenizer.json + tokenizer_config.json)',
        'Or install Python with sentence-transformers: pip install sentence-transformers',
      ],
    });
  }
}

function computeBatchViaLocalPython(texts: string[], ids: string[]): Promise<number[][]> {
  const input = texts.map((text, i) => ({ id: ids[i], text }));
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON, [EMBED_SCRIPT, 'batch-encode'], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`Python batch-encode failed: ${err.message}\n${stderr}`)); return; }
      try {
        const map = JSON.parse(stdout) as Record<string, number[]>;
        const vectors = ids.map(id => map[id]);
        if (vectors.some(v => !v || !Array.isArray(v))) { reject(new Error('Incomplete vectors from batch-encode')); return; }
        resolve(vectors as number[][]);
      } catch (e) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'ai-backends',
          level: 'warn',
          message: 'Failed to parse batch-encode output',
          error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack },
        });
        reject(new Error(`Parse failed: ${e}`));
      }
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}

// ── Python embedding availability probe ──

function isPythonEmbeddingAvailable(): Promise<boolean> {
  if (_pythonAvailable !== null) return Promise.resolve(_pythonAvailable);
  return new Promise(resolve => {
    execFile(PYTHON, ['-c', 'import sentence_transformers'], { timeout: 10_000, windowsHide: true }, (err) => {
      _pythonAvailable = !err;
      // t/3176 (Fallback-Path Logging): unavailable Python → the compute path silently degrades to
      // the ONNX/API fallback for the process lifetime. WARN (not info) so it surfaces in prod logs.
      if (!_pythonAvailable) log.server.warn('[embeddings] Python sentence-transformers unavailable — using API only');
      resolve(_pythonAvailable);
    });
  });
}

function computeQueryViaLocalPython(text: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON, [EMBED_SCRIPT, 'encode', text], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`Python embed failed: ${err.message}\n${stderr}`)); return; }
      try {
        const v = JSON.parse(stdout) as number[];
        if (!Array.isArray(v) || v.length === 0) { reject(new Error('Empty vector')); return; }
        resolve(v);
      } catch (e) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ai-backends', level: 'warn',
          message: 'Failed to parse Python embedding output',
          error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack },
        });
        reject(new Error(`Parse failed: ${e}`));
      }
    });
  });
}

// ── Query embedding LRU cache ──

const QUERY_CACHE_MAX = 256;
const _queryCache = new Map<string, number[]>();

function getCachedQueryEmbedding(text: string): number[] | undefined {
  const vec = _queryCache.get(text);
  if (vec) {
    _queryCache.delete(text);
    _queryCache.set(text, vec);
  }
  return vec;
}

function setCachedQueryEmbedding(text: string, vec: number[]): void {
  if (_queryCache.size >= QUERY_CACHE_MAX) {
    const oldest = _queryCache.keys().next().value!;
    _queryCache.delete(oldest);
  }
  _queryCache.set(text, vec);
}

// t/1641/t/1643: `_explicitApiKey` is retained for call-site arity (server.ts passes
// the free-tier key) but is no longer consumed — the query embedding is computed by
// the local Python encoder or the in-process ONNX fallback, both 384-dim/all-MiniLM-L6-v2.
// This closes t/1643: the old Gemini fallback returned a 3072-dim RETRIEVAL_QUERY vector
// in a different vector space than the stored 384-dim MiniLM corpus, silently breaking
// cosine similarity whenever Python was absent.
export async function computeQueryEmbedding(text: string, _explicitApiKey?: string): Promise<number[]> {
  const cached = getCachedQueryEmbedding(text);
  if (cached) return cached;

  if (await isPythonEmbeddingAvailable()) {
    try {
      const vec = await computeQueryViaLocalPython(text);
      setCachedQueryEmbedding(text, vec);
      return vec;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ai-backends',
        level: 'warn',
        message: 'Local Python embedding failed; falling back to in-process ONNX',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      _pythonAvailable = false;
    }
  }

  // In-process ONNX all-MiniLM-L6-v2 (shared lib t/1651) — hosted fallback when the
  // Python ML venv is absent (DevOps venv slim, t/1642). Same 384-dim space as the
  // stored corpus; no API key, no network.
  if (await onnxTryWarmup()) {
    try {
      const vec = await onnxComputeEmbedding(text);
      setCachedQueryEmbedding(text, vec);
      return vec;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ai-backends',
        level: 'error',
        message: 'In-process ONNX query embedding failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      // fall through to the ActionableError below
    }
  }

  throw new ActionableError({
    goal: 'Compute query embedding',
    problem: 'No local embedding encoder available — the Python sentence-transformers venv is absent and the in-process ONNX all-MiniLM-L6-v2 fallback failed to initialize',
    location: 'aiBackends.computeQueryEmbedding',
    nextSteps: [
      'Verify the baked ONNX model directory is present (AI_TRIAD_ONNX_MODEL_DIR points to model.onnx + tokenizer.json + tokenizer_config.json)',
      'Or install Python with sentence-transformers: pip install sentence-transformers',
    ],
  });
}

export async function updateNodeEmbeddings(nodes: { id: string; text: string; pov: string; exclusionText?: string }[]): Promise<void> {
  if (nodes.length === 0) return;
  const filePath = getEmbeddingsPath();

  // t/1641: encode a batch of {id,text} to an id→vector map. Local Python
  // sentence-transformers is primary when present; the in-process ONNX
  // all-MiniLM-L6-v2 fallback (shared lib t/1651) covers the hosted case where
  // the Python ML venv has been slimmed away (DevOps venv slim, t/1642). Same
  // 384-dim/all-MiniLM-L6-v2 space either way; no API key, no network.
  const encodeBatch = async (batch: { id: string; text: string }[]): Promise<Record<string, number[]>> => {
    const ids = batch.map(b => b.id);
    const texts = batch.map(b => b.text);
    let vecs: number[][] | null = null;

    if (await isPythonEmbeddingAvailable()) {
      try {
        vecs = await computeBatchViaLocalPython(texts, ids);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ai-backends', level: 'warn',
          message: 'Local Python batch embedding failed; falling back to in-process ONNX',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        _pythonAvailable = false;
      }
    }

    if (!vecs) {
      if (!(await onnxTryWarmup())) {
        throw new ActionableError({
          goal: 'Update node embeddings',
          problem: 'No local embedding encoder available — the Python sentence-transformers venv is absent and the in-process ONNX all-MiniLM-L6-v2 fallback failed to initialize',
          location: 'aiBackends.updateNodeEmbeddings',
          nextSteps: [
            'Verify the baked ONNX model directory is present (AI_TRIAD_ONNX_MODEL_DIR points to model.onnx + tokenizer.json + tokenizer_config.json)',
            'Or install Python with sentence-transformers: pip install sentence-transformers',
          ],
        });
      }
      try {
        vecs = await onnxComputeEmbeddings(texts);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ai-backends', level: 'error',
          message: 'In-process ONNX batch embedding failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw new ActionableError({
          goal: 'Update node embeddings',
          problem: 'The in-process ONNX all-MiniLM-L6-v2 encoder failed while embedding a node batch',
          location: 'aiBackends.updateNodeEmbeddings',
          nextSteps: [
            'Verify the baked ONNX model directory is intact (AI_TRIAD_ONNX_MODEL_DIR points to model.onnx + tokenizer.json + tokenizer_config.json)',
            'Or install Python with sentence-transformers: pip install sentence-transformers',
          ],
        });
      }
    }

    const map: Record<string, number[]> = {};
    ids.forEach((id, i) => { map[id] = vecs![i]; });
    return map;
  };

  const vectors = await encodeBatch(nodes.map(n => ({ id: n.id, text: n.text })));
  const exclNodes = nodes.filter(n => n.exclusionText);
  const exclVectors: Record<string, number[]> = exclNodes.length > 0
    ? await encodeBatch(exclNodes.map(n => ({ id: n.id, text: n.exclusionText! })))
    : {};

  let data: EmbeddingsFile;
  try {
    const buf = await readDataFile(EMBEDDINGS_REL_PATH, { largeFile: true });
    data = JSON.parse(buf.toString('utf-8')) as EmbeddingsFile;
  }
  catch (err) {
    // t/3176 (Fallback-Path Logging): a read failure here silently starts from an EMPTY baseline —
    // this write only re-adds the current nodes, so any embeddings the file held for OTHER nodes are
    // dropped until the next full re-embed. That data-losing degradation must not be silent. WARN.
    // e/134 #2: the FR record is mandatory in server scope (docs/error-handling.md) — the Pino WARN
    // alone doesn't reach a flight-recorder dump; record both.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-backends', level: 'warn',
      message: 'updateNodeEmbeddings: embeddings file unreadable — continuing with an EMPTY baseline (other nodes’ stored embeddings are discarded this write; they re-populate on the next full embed)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { path: EMBEDDINGS_REL_PATH },
    });
    log.api.warn(
      { err: (err as Error).message, path: EMBEDDINGS_REL_PATH },
      'updateNodeEmbeddings: embeddings file unreadable — continuing with an EMPTY baseline (other nodes’ stored embeddings are discarded this write; they re-populate on the next full embed)',
    );
    data = { model: 'all-MiniLM-L6-v2', dimension: 384, node_count: 0, nodes: {} };
  }

  for (const node of nodes) {
    if (vectors[node.id]) {
      data.nodes[node.id] = {
        pov: node.pov,
        vector: vectors[node.id],
        exclusion_vector: exclVectors[node.id] ?? null,
      };
    }
  }
  data.node_count = Object.keys(data.nodes).length;
  // e/134 #1 (CRITICAL): this is a production write path. A disk-full or read-only-mount
  // condition previously threw a raw exception with no FR record and no ActionableError.
  // Record + wrap so the failure is diagnosable and carries recovery guidance.
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'ai-backends', level: 'error',
      message: `Failed to write embeddings.json (${data.node_count} nodes)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { path: filePath, nodeCount: data.node_count },
    });
    throw new ActionableError({
      goal: 'Persist updated node embeddings',
      problem: 'Writing embeddings.json failed — likely a full disk, read-only mount, or permission denial on the data root',
      location: 'aiBackends.updateNodeEmbeddings',
      nextSteps: [
        'Check the data-root disk for a full or read-only condition (ENOSPC / EROFS / EACCES)',
        `Verify the process can write to ${filePath} and its parent directory`,
        'Re-run the embedding update once the disk/mount condition is resolved',
      ],
      innerError: err, // t/2761: chain the raw fs error rather than embedding its message
    });
  }
  embeddingsCache = null;
  embeddingsLoadInFlight = null; // bust any in-flight read that would return the stale file
}

// ── NLI classification ──

const NLI_TIMEOUT_MS = 30_000;
const NLI_LABELS = ['entailment', 'neutral', 'contradiction'] as const;
type NliLabel = (typeof NLI_LABELS)[number];

/** The four fields the Python `nli-classify` path merges into each input item (see scripts/embed_taxonomy.py cmd_nli_classify). */
interface NliFields {
  nli_label: NliLabel;
  nli_entailment: number;
  nli_neutral: number;
  nli_contradiction: number;
}

/**
 * Primary path: classify pairs via the local Python sentence-transformers
 * cross-encoder. Resolves with the merged items (input fields + 4 NLI fields)
 * or rejects on subprocess/parse failure so the caller can fall back.
 */
function classifyNliViaPython(pairs: { text_a: string; text_b: string }[]): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = execFile(PYTHON, [EMBED_SCRIPT, 'nli-classify'], { timeout: NLI_TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const isTimeout = !!(err as { killed?: boolean }).killed || /ETIMEDOUT|timed?\s*out/i.test(err.message);
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ai-backends', level: 'warn',
          message: `NLI classify (local Python) failed: ${isTimeout ? 'timeout' : 'subprocess error'} — trying API fallback`,
          error: { name: err.name ?? 'Error', message: err.message, stack: err.stack },
          data: { pairCount: pairs.length, isTimeout, stderr: stderr?.slice(0, 500), backend: 'local-python' },
        });
        reject(err);
        return;
      }
      try { resolve(JSON.parse(stdout)); } catch (e) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'ai-backends', level: 'warn',
          message: 'Failed to parse NLI classify output (local Python) — trying API fallback',
          error: { name: (e as Error).name ?? 'Error', message: String(e), stack: (e as Error).stack },
          data: { pairCount: pairs.length, stdoutLength: stdout?.length },
        });
        reject(e);
      }
    });
    child.stdin!.write(JSON.stringify(pairs));
    child.stdin!.end();
  });
}

/** Clamp/normalize an LLM-returned score into [0,1]; non-finite → 0. */
function normNliScore(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Coerce one parsed LLM result object into the 4 canonical NLI fields.
 * Tolerates a missing/garbled label by deriving it from the argmax score.
 */
function coerceNliFields(raw: Record<string, unknown>): NliFields {
  const nli_entailment = normNliScore(raw.nli_entailment ?? raw.entailment);
  const nli_neutral = normNliScore(raw.nli_neutral ?? raw.neutral);
  const nli_contradiction = normNliScore(raw.nli_contradiction ?? raw.contradiction);
  const rawLabel = String(raw.nli_label ?? raw.label ?? '').toLowerCase().trim();
  let nli_label: NliLabel;
  if ((NLI_LABELS as readonly string[]).includes(rawLabel)) {
    nli_label = rawLabel as NliLabel;
  } else {
    const scores: [NliLabel, number][] = [
      ['entailment', nli_entailment], ['neutral', nli_neutral], ['contradiction', nli_contradiction],
    ];
    nli_label = scores.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }
  return { nli_label, nli_entailment, nli_neutral, nli_contradiction };
}

/**
 * Fallback path: classify pairs via a hosted LLM (UsageID
 * `server.nli-classify-fallback`). Used when the local Python encoder is
 * unavailable (e.g. the ML venv has been removed from the image — t/1641).
 * BYOK: the caller supplies the API key per-request (ADR-002); no keys baked.
 * Returns each input item passed through plus the 4 NLI fields, matching the
 * Python contract so downstream consumers are unaffected.
 */
async function classifyNliViaApi(
  pairs: { text_a: string; text_b: string }[],
  apiKey?: string | string[],
): Promise<unknown[]> {
  const items = pairs.map((p, index) => ({ index, text_a: p.text_a, text_b: p.text_b }));
  const result = await generateTextByUsage(
    'server.nli-classify-fallback',
    { pairs: JSON.stringify(items) },
    undefined,
    undefined,
    apiKey,
  );

  const parsed = parseJsonRobust(result.text);
  const rows: Record<string, unknown>[] = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : Array.isArray((parsed as { results?: unknown })?.results)
      ? ((parsed as { results: Record<string, unknown>[] }).results)
      : [];

  if (rows.length === 0) {
    throw new ActionableError({
      goal: 'Classify NLI pairs via hosted LLM fallback',
      problem: `LLM NLI fallback returned no parseable results (${result.text?.length ?? 0} chars)`,
      location: 'aiBackends.classifyNliViaApi',
      nextSteps: [
        'Verify the server.nli-classify-fallback UsageID prompt requests a JSON array',
        'Check the AI backend is reachable and the supplied key is valid',
      ],
    });
  }

  // Map results back to pairs by declared index; fall back to positional order.
  const byIndex = new Map<number, Record<string, unknown>>();
  rows.forEach((row, i) => {
    const idx = typeof row.index === 'number' ? row.index : i;
    if (!byIndex.has(idx)) byIndex.set(idx, row);
  });

  return pairs.map((p, i) => ({
    ...p,
    ...coerceNliFields(byIndex.get(i) ?? rows[i] ?? {}),
  }));
}

/**
 * Classify NLI (entailment/neutral/contradiction) for each text pair.
 *
 * Primary path is the local Python cross-encoder; when it is unavailable or
 * fails (subprocess error, timeout, or unparseable output) the request falls
 * back to a hosted LLM via UsageID `server.nli-classify-fallback`. The fallback
 * needs a caller-supplied API key (BYOK, ADR-002) — omit it and only the local
 * path is attempted. Output items preserve input fields and add the 4 NLI
 * fields regardless of which path served the request.
 */
export async function classifyNli(
  pairs: { text_a: string; text_b: string }[],
  apiKey?: string | string[],
): Promise<unknown[]> {
  if (pairs.length === 0) return [];

  try {
    return await classifyNliViaPython(pairs);
  } catch (pyErr) {
    try {
      const results = await classifyNliViaApi(pairs, apiKey);
      getGlobalRecorder()?.record({
        type: 'ai.fallback', component: 'ai-backends', level: 'info',
        message: 'NLI classify served by hosted LLM fallback (local Python unavailable)',
        data: { pairCount: pairs.length, backend: 'llm-fallback' },
      });
      return results;
    } catch (apiErr) {
      const isTimeout = !!(pyErr as { killed?: boolean }).killed || /ETIMEDOUT|timed?\s*out/i.test((pyErr as Error).message ?? '');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-backends', level: 'error',
        message: 'NLI classify failed on both local Python and API fallback',
        error: { name: (apiErr as Error).name ?? 'Error', message: String(apiErr), stack: (apiErr as Error).stack },
        data: {
          pairCount: pairs.length,
          pythonError: String((pyErr as Error).message ?? pyErr).slice(0, 300),
          apiError: String((apiErr as Error).message ?? apiErr).slice(0, 300),
        },
      });
      if (apiErr instanceof ActionableError) throw apiErr;
      const apiErrMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      throw new ActionableError({
        goal: 'Classify NLI pairs',
        problem: isTimeout
          ? `Local Python NLI subprocess timed out after ${NLI_TIMEOUT_MS / 1000}s and the API fallback also failed (${pairs.length} pairs)`
          : `Local Python NLI encoder failed and the API fallback also failed: ${apiErrMsg}`,
        location: 'aiBackends.classifyNli',
        nextSteps: [
          'Verify the AI backend is reachable and a valid API key was supplied for the fallback',
          'If the local encoder should be available, verify Python sentence-transformers is installed',
          'Reduce the number of pairs per request',
        ],
        innerError: apiErr,
      });
    }
  }
}

// ── Model discovery (refresh) ──

export async function refreshAIModels(): Promise<unknown> {
  const result: Record<string, { ok: boolean; count: number; error?: string }> = {};
  for (const backend of ['gemini', 'claude', 'groq'] as AIBackend[]) {
    // A listing loop (SO e/284#2 cond 1): a backend with only AI_API_KEY reads 'not configured', never throws.
    const key = await getApiKeyForListing(backend);
    if (!key) { result[backend] = { ok: false, count: 0, error: listingNotConfiguredHint(backend) ?? 'No API key' }; continue; }
    assertKeyForBackend(key, backend, 'discovery'); // t/4105 C5: this send bypasses callProvider, so guard it here
    try {
      if (backend === 'gemini') {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        if (!resp.ok) {
          // t/1624: a non-200 is a result, not a swallowed failure. Parse the
          // provider error body for the specific reason (SERVICE_DISABLED,
          // restricted, quota, invalid…) instead of collapsing every case into a
          // bare `HTTP ${status}`, and record it structured. NO key material in
          // the message/log/FR — the key rides in the fetch URL, never the payload.
          let reason: string | undefined;
          try {
            reason = extractProviderReason(await resp.json());
          } catch {
            /* body absent or non-JSON — silent by design: the non-200 is still
               recorded below with reason:null, so no diagnostic is lost. */
          }
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'ai-backends',
            level: 'warn',
            message: 'Gemini model discovery rejected the request',
            data: { backend: 'gemini', httpStatus: resp.status, reason: reason ?? null },
          });
          result[backend] = { ok: false, count: 0, error: deriveKeyErrorMessage(resp.status, reason) };
          continue;
        }
        const json = await resp.json() as { models: unknown[] };
        result[backend] = { ok: true, count: json.models?.length || 0 };
      } else {
        result[backend] = { ok: true, count: 0, error: 'Discovery not implemented for this backend in container mode' };
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ai-backends',
        level: 'error',
        message: `Model discovery failed for backend '${backend}'`, // e/134 #4
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { backend },
      });
      result[backend] = { ok: false, count: 0, error: String(err) };
    }
  }
  return result;
}

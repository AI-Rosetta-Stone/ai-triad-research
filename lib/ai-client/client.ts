// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { ActionableError } from '../debate/errors.js';
import type { FetchFn, GenerateOptions, ProviderResult, BackendId } from './types.js';
import type { ModelRegistry } from './registry.js';
import { resolveModel, resolveTimeout, estimateCost } from './registry.js';
import { withRetry, type RetryConfig, CLI_RETRY_CONFIG } from './retry.js';
import { assertKeyForBackend } from './apiKeyFallback.js';
import { generateViaGemini } from './providers/gemini.js';
import { generateViaClaude } from './providers/claude.js';
import { generateViaGroq } from './providers/groq.js';
import { generateViaOpenAI } from './providers/openai.js';
import { generateViaDeepSeek } from './providers/deepseek.js';
import { generateViaOllama } from './providers/ollama.js';
import { generateViaAzure } from './providers/azure.js';
import { generateViaZai } from './providers/zai.js';
import { generateViaMoonshot } from './providers/moonshot.js';
import { generateViaXai } from './providers/xai.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { classifyServedIdentity, observeServedIdentity, attachServedIdentitySummary } from './servedIdentity.js';
import { telemetryClient } from '../telemetry.js';

export interface AIClientDeps {
  fetch: FetchFn;
  resolveApiKey: (backend: string) => string | Promise<string>;
  onUsage?: (backend: string, model: string, latencyMs: number, usage?: ProviderResult['usage']) => void;
  onRetryLog?: (msg: string) => void;
}

/** Running cost of a client's calls (t/3946). `unpricedCalls` is reported next to the total so a
 *  total missing calls never looks complete: those calls had no pricing entry and aren't in it. */
export interface AICostSummary {
  accumulatedCostUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

export interface AIClient {
  generateText(prompt: string, model: string, opts?: GenerateOptions): Promise<ProviderResult>;
  getCostSummary(): AICostSummary;
}

function dispatchProvider(
  fetchFn: FetchFn,
  backend: string,
  prompt: string,
  apiModelId: string,
  apiKey: string,
  opts: GenerateOptions,
): Promise<ProviderResult> {
  switch (backend) {
    case 'claude': return generateViaClaude(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'groq': return generateViaGroq(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'openai': return generateViaOpenAI(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'azure': return generateViaAzure(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'deepseek': return generateViaDeepSeek(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'ollama': return generateViaOllama(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'zai': return generateViaZai(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'moonshot': return generateViaMoonshot(fetchFn, prompt, apiModelId, apiKey, opts);
    case 'xai': return generateViaXai(fetchFn, prompt, apiModelId, apiKey, opts);
    default: return generateViaGemini(fetchFn, prompt, apiModelId, apiKey, opts);
  }
}

/**
 * The single provider-dispatch seam both runtimes traverse (CLI aiAdapter + Electron aiBackends both
 * call this directly; neither goes through createAIClient.generateText). One `ai.model_identity` event
 * per call, `{ backend, requested, apiModelIdSent, providerReported, state, reason, ... }` (t/3677).
 * `providerReported` is `undefined` when the provider reported no served id, never fabricated.
 *
 * t/3731 Phase 3: the pair is classified by `classifyServedIdentity` against `opts.identityRegistry`.
 * WARN-ONLY: the event is raised to `warn` on the first occurrence of a divergent (backend, sent, served)
 * triple, and every other call stays `info`. It never blocks; blocking would be a gate promotion.
 */
export async function callProvider(
  fetchFn: FetchFn,
  backend: string,
  prompt: string,
  apiModelId: string,
  apiKey: string,
  opts: GenerateOptions,
): Promise<ProviderResult> {
  const startTime = Date.now();
  try {
    // t/4105 C5: the one chokepoint every provider send passes; refuse another backend's credential before any request.
    assertKeyForBackend(apiKey, backend, 'provided');
    const result = await dispatchProvider(fetchFn, backend, prompt, apiModelId, apiKey, opts);
    const served = result.providerReportedModel;
    const identity = classifyServedIdentity({ registry: opts.identityRegistry, backend, sent: apiModelId, served });
    const seen = observeServedIdentity(backend, apiModelId, served, identity);
    attachServedIdentitySummary(getGlobalRecorder()); // t/4023: the per-reason counts ride every dump
    getGlobalRecorder()?.record({
      type: 'ai.model_identity',
      component: 'ai-client',
      level: seen.warn ? 'warn' : 'info',
      message: `served-identity ${backend}/${apiModelId} -> ${served ?? '(unreported)'}: ${identity.state}/${identity.reason}`,
      data: {
        backend,
        requested: opts.requestedModelId,
        apiModelIdSent: apiModelId,
        providerReported: served,
        state: identity.state,
        reason: identity.reason,
        ...(identity.resolvedSent ? { resolvedSent: identity.resolvedSent } : {}),
        ...(seen.divergentCount ? { divergentCount: seen.divergentCount } : {}),
        // First call to this backend in this process: surfaces a newly used adapter for calibration (TL t/3731#7).
        ...(seen.firstSeen ? { firstSeen: true, registryPresent: !!opts.identityRegistry } : {}),
      },
    });

    // Track successful AI request
    telemetryClient.trackEvent({
      name: 'ai_request_completed',
      properties: {
        provider: backend,
        model: apiModelId,
        status: 'success',
      },
      measurements: {
        latency_ms: Date.now() - startTime,
        tokens_input: result.usage?.promptTokens || 0,
        tokens_output: result.usage?.completionTokens || 0,
      }
    });

    return result;
  } catch (error) {
    telemetryClient.trackEvent({
      name: 'ai_request_failed',
      properties: {
        provider: backend,
        model: apiModelId,
        error_type: error?.constructor?.name || 'unknown',
      },
      measurements: {
        latency_ms: Date.now() - startTime,
      }
    });
    throw error;
  }
}

export function createAIClient(
  deps: AIClientDeps,
  registry: ModelRegistry,
  retryConfig: RetryConfig = CLI_RETRY_CONFIG,
): AIClient {
  let accumulatedCostUsd = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  return {
    getCostSummary: () => ({ accumulatedCostUsd, pricedCalls, unpricedCalls }),
    async generateText(prompt: string, model: string, opts?: GenerateOptions): Promise<ProviderResult> {
      if (opts?.maxCostUsd != null && accumulatedCostUsd >= opts.maxCostUsd) {
        throw new ActionableError({
          goal: 'Generate text via AI',
          problem: `Budget exceeded: accumulated cost $${accumulatedCostUsd.toFixed(4)} >= cap $${opts.maxCostUsd.toFixed(4)}`,
          location: 'ai-client.createAIClient',
          nextSteps: ['Increase the budget cap', 'Start a new session to reset the budget', 'Switch to a cheaper model'],
        });
      }
      const { apiModelId, backend, fixedTemperature } = resolveModel(registry, model);
      const apiKey = await deps.resolveApiKey(backend);
      // Registry-driven per-model temperature constraint (t/2068): the model's
      // fixedTemperature (if any) overrides the caller's temperature so providers send it.
      const effectiveOpts = {
        ...opts,
        timeoutMs: resolveTimeout(opts?.timeoutMs, model, registry), // t/3644: floor-enforced, not bypassable
        requestedModelId: model, // t/3677: caller's friendlyId for the served-identity record
        identityRegistry: registry, // t/3731: the served-identity classifier's cross-check
        ...(fixedTemperature != null ? { fixedTemperature } : {}),
      };
      const t0 = performance.now();
      const result = await withRetry(
        () => callProvider(deps.fetch, backend, prompt, apiModelId, apiKey, effectiveOpts),
        retryConfig,
        `${backend}/${apiModelId}`,
        deps.onRetryLog,
        effectiveOpts.signal,
      );
      if (result.usage) {
        // Price by the friendly id the caller invoked, never the apiModelId: pricing is keyed by
        // models[].id, and azure and openai share GPT apiModelIds at different prices (t/3946, SO e/248).
        result.estimatedCostUsd = estimateCost(registry, model, result.usage);
        if (result.estimatedCostUsd != null) {
          accumulatedCostUsd += result.estimatedCostUsd;
          pricedCalls++;
        } else {
          // Fail closed (t/3946#5 item 5): count it so the total can't silently look complete.
          unpricedCalls++;
        }
      }
      deps.onUsage?.(backend, apiModelId, performance.now() - t0, result.usage);
      return result;
    },
  };
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2610 (parent epic t/2604): the server-side AIAdapter injected into the shared
// `lib/oped` generation core (`generateOpEdSet`) for the web build. It delegates to
// the server's key-managed, fallback-chained provider path (`aiBackends.generateText`)
// so hosted op-ed generation uses the same backend selection, retry, and
// cancellation machinery as every other server AI call — the web container never
// holds a raw API key.
//
// Structured-output parity (TL gap 2, Shared Lib-confirmed p/116#29): the core passes
// `responseSchema`/`maxTokens` to `generateText`; `aiBackends.generateText` now threads
// those to `callProvider` → gemini.ts native constrained decoding, IDENTICAL to the
// Electron/CLI adapter's schema-enforced path. No prompt-instructed divergence.

import type { AIAdapter, GenerateOptions } from '../../../../lib/debate/aiAdapter.js';
import * as ai from './aiBackends.js';
import { estimateCost, resolvePricingKey } from '../../../../lib/ai-client/registry.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { isAnonymousUser } from '../security/userContext.js';
import { recordAnonOpEdSpend, ANON_OPED_PER_RUN_CAP_USD } from '../storage/anonOpEdSpend.js';
import { log } from '../logger.js';

/** Build the web op-ed AIAdapter. `generateText` is the only method the `lib/oped`
 *  core requires (t/2608#3) — no search/embedding methods are needed (grounding
 *  computes its query embedding directly via onnxEmbedding inside the core).
 *  One adapter is built per run (oped.ts createOpEdRun), so the closure's `runSpendUsd` is that run's total. */
export function createWebOpEdAdapter(): AIAdapter {
  const recordSpend = isAnonymousUser(); // read per request, inside the request's async context
  let runSpendUsd = 0; // t/467 (TL p/16#221): what this anonymous run has spent so far
  return {
    async generateText(prompt: string, model: string, options?: GenerateOptions): Promise<string> {
      // t/467 (TL p/16#221): before every call, refuse it if this run's total plus this call's worst case would
      // exceed the per-run ceiling. Nothing is sent to a provider for a refused call.
      if (recordSpend) assertCallWithinRunCeiling(prompt, model, options?.maxTokens, runSpendUsd);
      const result = await ai.generateText(
        prompt,
        model,
        undefined,            // onRetry — retry progress isn't surfaced on the op-ed SSE stream for P1
        options?.timeoutMs,
        undefined,            // explicitApiKey — the server resolves keys per backend
        {
          temperature: options?.temperature,
          signal: options?.signal,           // client-disconnect cancellation → provider fetch abort
          responseSchema: options?.responseSchema,
          maxTokens: options?.maxTokens,
          // t/467 (TL p/16#215): an anonymous run uses only its price-checked model, so the spend counted
          // is the spend made. No fallback model can serve it.
          noFallback: recordSpend,
        },
      );
      // t/467 (TL p/16#211, p/16#216): an anonymous run's priced cost counts toward the ceilings. The check
      // is on the SERVED model, not the requested one: a reroute below this layer must not escape pricing.
      if (recordSpend) {
        const served = result.servedModel || model;
        if (!resolvePricingKey(ai.getModelRegistry(), served)) {
          throw new ActionableError({
            goal: 'Refuse an anonymous op-ed run whose served model has no price',
            problem: `The served model '${served}' has no price on file, so its spend cannot be counted toward the anonymous ceilings.`,
            location: 'opedAdapter.generateText',
            nextSteps: ['Choose a priced model, or sign in to run with your own key.'],
            code: 'ANON_UNPRICED_SERVED_MODEL',
            httpStatus: 403,
          });
        }
        runSpendUsd += await recordCallCost(result.tokenUsage, served);
      }
      return result.text;
    },
    // t/3614: required AIAdapter member — host-loaded registry data (cached via getModelRegistry).
    // This adapter never runs the debate engine, but the interface requires it uniformly.
    registry: ai.getModelRegistry(),
  };
}

/** t/467 (TL p/16#221): the worst-case cost of ONE call before it is sent. Input tokens are bounded by
 *  prompt.length / 2 (a token is rarely under two characters), and output tokens by the call's maxTokens.
 *  Undefined when the model has no price. */
function worstCallUsd(model: string, prompt: string, maxTokens: number): number | undefined {
  return estimateCost(ai.getModelRegistry(), model, { promptTokens: Math.ceil(prompt.length / 2), completionTokens: maxTokens });
}

/** Refuse (throw, before any provider call) an anonymous call that could take this run past the per-run ceiling,
 *  or that cannot be bounded: no maxTokens, or an unpriced model. Each refusal names its reason. */
function assertCallWithinRunCeiling(prompt: string, model: string, maxTokens: number | undefined, runSpendUsd: number): void {
  const refuse = (code: string, problem: string): never => {
    log.server.warn({ component: 'oped', model, reason: code, runSpendUsd }, `Anonymous op-ed call refused: ${problem}`);
    throw new ActionableError({
      goal: 'Keep an anonymous op-ed run within the per-run cost ceiling',
      problem,
      location: 'opedAdapter.assertCallWithinRunCeiling',
      nextSteps: ['Shorten the request, or sign in to run with your own key.'],
      code,
      httpStatus: 403,
    });
  };
  if (maxTokens === undefined) refuse('ANON_UNBOUNDED_CALL', 'this call sets no output limit, so its worst-case cost cannot be bounded for an anonymous run.');
  const worst = worstCallUsd(model, prompt, maxTokens as number);
  if (worst === undefined) refuse('ANON_UNPRICED_MODEL', `model '${model}' has no price on file, so an anonymous run cannot use it.`);
  if (runSpendUsd + (worst as number) > ANON_OPED_PER_RUN_CAP_USD) {
    refuse('ANON_RUN_COST_CEILING', `this call could take the run past the $${ANON_OPED_PER_RUN_CAP_USD} per-run ceiling (spent $${runSpendUsd.toFixed(4)}, worst case for this call $${(worst as number).toFixed(4)}).`);
  }
}

/** t/467: add one anonymous call's priced cost to the spend ledger and return it. A failed write is logged (the run
 *  continues, but that spend is then not counted). An unpriced call is logged, since it is not counted either. */
async function recordCallCost(usage: Parameters<typeof estimateCost>[2] | undefined, model: string): Promise<number> {
  const usd = usage ? estimateCost(ai.getModelRegistry(), model, usage) : undefined;
  if (usd == null) {
    log.server.warn({ component: 'oped', model, reason: 'anon-oped-unpriced-call' }, 'Anonymous op-ed call has no price; not counted toward the spend ceiling');
    return 0;
  }
  try { await recordAnonOpEdSpend(usd); }
  catch (err) { log.server.warn({ component: 'oped', model, err: String(err), reason: 'anon-oped-spend-record-failed' }, 'Anonymous op-ed spend could not be recorded'); }
  return usd;
}

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
import { estimateCost } from '../../../../lib/ai-client/registry.js';
import { isAnonymousUser } from '../security/userContext.js';
import { recordAnonOpEdSpend } from '../storage/anonOpEdSpend.js';
import { log } from '../logger.js';

/** Build the web op-ed AIAdapter. `generateText` is the only method the `lib/oped`
 *  core requires (t/2608#3) — no search/embedding methods are needed (grounding
 *  computes its query embedding directly via onnxEmbedding inside the core). */
export function createWebOpEdAdapter(): AIAdapter {
  const recordSpend = isAnonymousUser(); // read per request, inside the request's async context
  return {
    async generateText(prompt: string, model: string, options?: GenerateOptions): Promise<string> {
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
        },
      );
      // t/467 (TL p/16#211): an anonymous run's priced cost counts toward the daily and monthly ceilings.
      if (recordSpend) await recordCallCost(result.tokenUsage, result.servedModel || model);
      return result.text;
    },
    // t/3614: required AIAdapter member — host-loaded registry data (cached via getModelRegistry).
    // This adapter never runs the debate engine, but the interface requires it uniformly.
    registry: ai.getModelRegistry(),
  };
}

/** t/467: add one anonymous call's priced cost to the spend ledger. A failed write is logged (the run
 *  continues, but that spend is then not counted). An unpriced call is logged, since it is not counted either. */
async function recordCallCost(usage: Parameters<typeof estimateCost>[2] | undefined, model: string): Promise<void> {
  const usd = usage ? estimateCost(ai.getModelRegistry(), model, usage) : undefined;
  if (usd == null) {
    log.server.warn({ component: 'oped', model, reason: 'anon-oped-unpriced-call' }, 'Anonymous op-ed call has no price; not counted toward the spend ceiling');
    return;
  }
  try { await recordAnonOpEdSpend(usd); }
  catch (err) { log.server.warn({ component: 'oped', model, err: String(err), reason: 'anon-oped-spend-record-failed' }, 'Anonymous op-ed spend could not be recorded'); }
}

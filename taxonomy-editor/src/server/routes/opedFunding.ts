// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/616 (t/501, TL p/16#374, Security p/93#69 and p/93#71): decide, BEFORE the op-ed SSE stream opens, how a run is
// funded, and refuse with a JSON error while that is still possible.
//   - Hosted anonymous (the tier's serverProvidedKey), or signed in on the byok tier with no stored key for the
//     backend (the chat rule, byokGeminiFallbackApplies): the free key pool. Geo gate (403 free_pool_region), empty
//     pool (503), then the run admission sized from its worst case (429 free_pool_exhausted when the pool can't
//     hold it). Zero provider calls on any refusal.
//   - Anyone else: unchanged; the server resolves keys as before.
// Signed-in pool runs also book their reported usage to their own daily token bucket (TL p/16#376 answer 3).

import type http from 'http';
import { getClientIp } from '../httpKit.js';
import { getCurrentUser, isAnonymousUser, isHostedAnonymousRequest } from '../security/userContext.js';
import * as rateLimiter from '../security/rateLimiter.js';
import * as proxyTiers from '../ai/proxyTiers.js';
import { getFreePoolKeys } from '../ai/freePoolKeyAccess.js';
import { getStoredUserKeysBeforeFreePool, type AIBackend } from '../config.js';
import { getModelRegistry } from '../ai/aiBackends.js';
import { admitOpEdRun, opedAdmissionEstimate, opedRequesterKeyPrefix, tokensForRunCap } from '../ai/opedPoolAdmission.js';
import type { WebOpEdAdapterOptions } from '../ai/opedAdapter.js';
import { resolveOutletBand } from '../../../../lib/oped/outletBands.js';

export interface OpEdFundingInput {
  tier: ReturnType<typeof proxyTiers.resolveTier>;
  backend: AIBackend;
  limitKey: string;
  model: string;
  runId: string;
  voices: number;
  sourceMaterial: string | undefined;
  outlet: string | undefined;
  wordCount: number;
}

/** The requester scope for the open-runs cap (freePoolBudgetGate debateRequesterKeyPrefix's rule): the signed-in
 *  principal, else `ip:<ip>`. An anonymous request's principal is the shared '_local', so it must never be the scope:
 *  every visitor would share one cap. */
function requesterIdFor(req: http.IncomingMessage): string {
  const principal = isAnonymousUser() ? undefined : getCurrentUser()?.principalName;
  return principal || `ip:${getClientIp(req)}`;
}

async function usesFreePool(input: OpEdFundingInput): Promise<boolean> {
  // A hosted anonymous request has no other key since #5430; with the free tier off it gets the empty-pool 503
  // here, before the stream, rather than a provider failure inside it.
  if (input.tier.serverProvidedKey || isHostedAnonymousRequest()) return true;
  if (!proxyTiers.byokGeminiFallbackApplies(input.tier.level, input.backend, undefined)) return false;
  return (await getStoredUserKeysBeforeFreePool(input.backend)).length === 0; // t/204: a stored key comes first
}

/** The generation stage's maxTokens, as lib/oped/generate.ts computes it. */
function generationMaxTokens(outlet: string | undefined, wordCount: number): number {
  const targetWords = wordCount > 0 ? wordCount : resolveOutletBand(outlet).words;
  return Math.ceil(targetWords * 3) + 5000;
}

/** Resolve the run's funding. `{ ok: false }` means a JSON refusal is already written; the caller must return. */
export async function resolveOpEdFunding(
  req: http.IncomingMessage, res: http.ServerResponse, input: OpEdFundingInput,
): Promise<{ ok: true; adapter: WebOpEdAdapterOptions } | { ok: false }> {
  if (!(await usesFreePool(input))) return { ok: true, adapter: {} };
  const pool = await getFreePoolKeys(req, res);
  if (!pool.ok) return { ok: false }; // 403 free_pool_region already written
  if (pool.keys.length === 0) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    // t/467 (Rosetta Stone p/74#26): a stable code for the client to map on; the sentence moves to `message`.
    res.end(JSON.stringify({ error: 'free_pool_empty', message: 'Free tier is not available' }));
    return { ok: false };
  }
  const requesterId = requesterIdFor(req);
  const estimate = opedAdmissionEstimate({
    voices: input.voices,
    sourceBytes: input.sourceMaterial ? Buffer.byteLength(input.sourceMaterial, 'utf8') : 0,
    generationMaxTokens: generationMaxTokens(input.outlet, input.wordCount),
  }, tokensForRunCap(getModelRegistry(), input.model));
  const admission = await admitOpEdRun(res, requesterId, input.runId, estimate);
  if (!admission.ok) return { ok: false }; // 429/503 already written
  const { tier, limitKey } = input;
  return {
    ok: true,
    adapter: {
      pool: {
        keys: pool.keys.length === 1 ? pool.keys[0] : pool.keys,
        reservationId: admission.reservationId,
        budgetKey: `${opedRequesterKeyPrefix(requesterId)}${input.runId}`,
      },
      // Signed-in pool runs: the per-user daily token bucket, as chat does. Anonymous runs have the shared ledger.
      bookUserTokens: isAnonymousUser() ? undefined : (inTok, outTok) => { rateLimiter.recordTokenUsage(limitKey, inTok, outTok, tier.limits.tokensPerDay); },
    },
  };
}

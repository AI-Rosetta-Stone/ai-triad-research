// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
//
// Shared generation-context resolution + backend-entitlement gate (t/2625).
//
// INVARIANT: every route that runs server-side AI generation from a user-supplied model
// MUST resolve through `resolveGenerationContext` (which pins the free tier's model and
// derives the target backend) and gate with `enforceBackendAllowed` BEFORE calling the
// provider. Otherwise a free/restricted-tier caller can select a premium backend via
// `body.model` (the class this closes: /api/evidence-qbaf + /api/ai/search bypassed it;
// chat-stream + /api/ai/generate already routed through this). Extracted from the verbatim
// copies previously duplicated in routes/ai.ts and routes/chat.ts.

import http from 'http';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { DEFAULT_MODEL } from '../../../../lib/ai-client/index.js';
import * as proxyTiers from '../ai/proxyTiers.js';
import * as ai from '../ai/aiBackends.js';
import { type AIBackend } from '../config.js';
import { getClientIp } from '../httpKit.js';
import { callerTierIdentity } from '../security/accessControl.js';
import { getCurrentUser } from '../security/userContext.js';
import { isAnonDebatesEnabled } from '../featureFlags.js';
import { log } from '../logger.js';

export type ResolvedTier = ReturnType<typeof proxyTiers.resolveTier>;

/** ALS-verified request identity, not raw headers (t/848). */
function callerIdentity(): { principalName: string; idp: string } {
  return callerTierIdentity(getCurrentUser());
}

/** Resolve the caller's tier + rate-limit key + effective (pinned-for-free) model +
 *  target backend from the request. Pure setup — sends no response. */
export function resolveGenerationContext(req: http.IncomingMessage, model: string | undefined): {
  tier: ResolvedTier; isFree: boolean; limitKey: string; effectiveModel: string | undefined; backend: AIBackend;
} {
  const { principalName, idp } = callerIdentity(); // t/848: verified context, not raw headers
  const tier = proxyTiers.resolveTier(principalName, idp);
  const isFree = tier.level === 'free';
  // Free tier (t/793): keyed per-IP (all keyless users would otherwise share one
  // bucket), with the model pinned. Other tiers key by user and honour the request model.
  const limitKey = isFree ? `free:${getClientIp(req)}` : (principalName || '_anonymous');
  const effectiveModel = isFree ? (tier.pinnedModel ?? model) : model;
  // t/4196 Stage 1 (AC3): null, not the real registry — this module is mocked (partial factory,
  // no getModelRegistry) across many route-level test suites; wiring the real registry through
  // here has a blast radius disproportionate to a routing decision that's already prefix-correct
  // for every registered model today. Prefix-only, acknowledged.
  const backend = ai.resolveBackend(effectiveModel || DEFAULT_MODEL, undefined);
  return { tier, isFree, limitKey, effectiveModel, backend };
}

/** 403 + record when the resolved backend isn't allowed on the caller's tier.
 *  Returns true when it has already sent a response (caller must return). */
export function enforceBackendAllowed(res: http.ServerResponse, tier: ResolvedTier, backend: AIBackend): boolean {
  if (proxyTiers.isBackendAllowed(tier, backend)) return false;
  // t/1463: record the tier context so a tier-restriction 403 is a one-line FR read
  // instead of a server.ts → proxyTiers → runtimeConfig code trace.
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'ai-generate', level: 'warn',
    message: `Backend '${backend}' not available on '${tier.level}' tier`,
    data: { tier_level: tier.level, requested_backend: backend, allowed_backends: tier.allowedBackends },
  });
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `Backend '${backend}' not available on your tier`, tier_level: tier.level, requested_backend: backend }));
  return true;
}

/** 403 + record when an anonymous/free-tier caller runs a DEBATE while anon debates are disabled
 *  (t/3230: a single anon debate drains the shared free Gemini key pool (K=4) → 429 storm → ~485s
 *  retry → user-facing 500). The `debateId` marker is present on every debate generate — including
 *  the fact-check `search` calls, the biggest key burn — so `isFree && debateId` scopes the block
 *  to exactly the free-tier debate flow; authenticated debates and all non-debate free-tier
 *  generation are untouched. Reversible: an admin flip of the `anon-debates` flag → true re-enables
 *  with no redeploy. Returns true when it has already sent a response (caller must return). */
export function enforceAnonDebateGate(res: http.ServerResponse, isFree: boolean, debateId: string | undefined): boolean {
  if (!isFree || !debateId || isAnonDebatesEnabled()) return false;
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'ai-generate', level: 'warn',
    message: 'Anonymous debate generation blocked — anon debates disabled (t/3230)',
    data: { tier_level: 'free', debateId: debateId.slice(0, 64), reason: 'anon-debates-disabled' },
  });
  // TL GV condition (observable): also emit to Pino/stdout so blocks are countable in Log Analytics
  // (the FR record above lives in the ring buffer only). One line per blocked anon debate.
  log.api.warn({ component: 'ai-generate', reason: 'anon-debates-disabled', tier_level: 'free', debateId: debateId.slice(0, 64) }, 'anon debate generation blocked (t/3230)');
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'Anonymous debates are temporarily disabled. Sign in to run debates.',
    reason: 'anon_debates_disabled', retryable: false,
  }));
  return true;
}

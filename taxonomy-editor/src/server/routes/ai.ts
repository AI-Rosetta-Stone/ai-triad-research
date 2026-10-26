// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the auth-logout / AI-generation /
// proxy-info / embeddings+NLI route run, moved verbatim out of server.ts behind
// the registration seam. This run sits between registerKeysRoutes and
// registerDebatesRoutes, so registration order — and the routeTable snapshot —
// is preserved by placing registerAiRoutes() at its former position.
//
// The run's module-level helpers move in with it: FRESH_LOGIN_PROVIDERS,
// callerIdentity, BACKEND_DISPLAY, freeTierEmbeddingGate. callerIdentity and
// parseCookies are PURE mirrors of the server.ts helpers (they depend only on
// imports, hold no state) — duplicated here so this run needs no ServerCtx
// surface; server.ts keeps its own copies for the routes that stay behind.

import http from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, getClientIp, withEndpointTimeout } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { callerTierIdentity, missingApiKeyError, expiredAuthCookies } from '../security/accessControl.js';
import { getCurrentUser, getCurrentUserId, getStorageUserId } from '../security/userContext.js';
import * as allowlistStore from '../storage/allowlistStore.js';
import { EMBEDDING_COMPUTE_CHUNK, EMBEDDINGS_REQUEST_TIMEOUT_MS, type GenerateTextProgress } from '../ai/aiBackends.js';
import { log, getRequestContext, getRequestId } from '../logger.js';
import { DEFAULT_MODEL } from '../../../../lib/ai-client/index.js';
import { hasApiKey, getPaidGeminiFallbackKey, type AIBackend } from '../config.js';
import * as proxyTiers from '../ai/proxyTiers.js';
import * as rateLimiter from '../security/rateLimiter.js';
import * as ai from '../ai/aiBackends.js';
import { resolveGenerationContext, enforceBackendAllowed, enforceAnonDebateGate } from './generationContext.js';
import { getFreePoolKeys } from '../ai/freePoolKeyAccess.js';
import {
  reserveFreePoolCall, commitFreePoolCall, releaseFreePoolCall, getFreePoolHeadroomSnapshot,
  admitOrDrawDownDebateCall, reconcileDebateDrawDown, FREE_POOL_CALL_TOKEN_ESTIMATE,
} from '../ai/freePoolBudgetGate.js';

import * as fileIO from '../storage/fileIO.js';
import { beginEmbeddingCompute, endEmbeddingCompute, embeddingLoadSnapshot, evaluateEmbeddingLoadShed, isEmbeddingModelWarm, markEmbeddingModelWarm } from '../embeddingsLoad.js';

// Pure mirror of the server.ts parseCookies helper (used by the logout /
// fresh-login handlers). Depends only on the request headers; holds no state.
function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key) cookies[key] = rest.join('=');
  }
  return cookies;
}

/**
 * t/848: resolve the caller's identity from the verified ALS user context (set
 * once by the S9 middleware from AZURE_AUTH_ENABLED-guarded headers) — NEVER by
 * re-reading raw x-ms-client-principal-* headers, which are spoofable when the
 * container is reachable without Easy Auth (direct ingress / misconfig). An
 * anonymous caller maps to '' so resolveTier yields the free/anonymous tier
 * (the free tier keys on an empty principal), never platform.
 */
function callerIdentity(): { principalName: string; idp: string } {
  return callerTierIdentity(getCurrentUser());
}

// t/896: user-facing provider names for the missing_api_key fast-fail message.
// t/1959: keyed off the ApiKeyBackend union (AIBackend re-export) so omitting a
// backend is a COMPILE error, not a runtime fall-through to the raw backend id.
// Labels mirror ai-models.json (the single source of truth for provider names).
const BACKEND_DISPLAY: Record<AIBackend, string> = {
  gemini: 'Gemini', claude: 'Claude (Anthropic)', groq: 'Groq',
  openai: 'OpenAI', deepseek: 'DeepSeek', tavily: 'Tavily', ollama: 'Ollama',
  azure: 'Azure OpenAI', zai: 'Z.AI (GLM)', moonshot: 'Moonshot (Kimi)',
  xai: 'xAI (Grok)',
};

// ── POST /api/ai/generate guard/step helpers (extracted from the handler, ADR-007)
// Each guard returns true when it has already sent a response (caller must return).
type ResolvedTier = ReturnType<typeof proxyTiers.resolveTier>;

/** Per-IP (free) / per-user RPM + daily-token limits. 429 + log/record on breach. */
function enforceAiRateLimits(res: http.ServerResponse, isFree: boolean, limitKey: string, tier: ResolvedTier, backend: AIBackend): boolean {
  const rpmCheck = isFree
    ? rateLimiter.checkRate(limitKey, tier.limits.requestsPerMinute, 60_000)
    : rateLimiter.checkRequestRate(limitKey, tier.limits.requestsPerMinute);
  if (!rpmCheck.allowed) {
    // t/924: rate-limit rejections were silent server-side — log + record so the
    // 429 is diagnosable (which limit, pool state, retry timing).
    log.server.warn({ component: 'rate-limiter', type: 'requests_per_minute', limitKey, limit: rpmCheck.limit, current: rpmCheck.current, retryAfterMs: rpmCheck.retryAfterMs, backend }, 'AI request rate-limited (RPM)');
    getGlobalRecorder()?.record({
      type: 'ai.error', component: 'rate-limiter', level: 'warn',
      message: `RPM limit reached (${rpmCheck.current}/${rpmCheck.limit})`,
      data: { type: 'requests_per_minute', rate_limit_source: 'per_ip_rpm', limitKey, limit: rpmCheck.limit, current: rpmCheck.current, retryAfterMs: rpmCheck.retryAfterMs, backend, tier: tier.level },
    });
    res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit exceeded', limitType: 'requests_per_minute', rate_limit_source: 'per_ip_rpm', rate_limit_type: 'api_call', retryAfterMs: rpmCheck.retryAfterMs, limit: rpmCheck.limit, current: rpmCheck.current })); return true;
  }
  const tokenCheck = rateLimiter.checkTokenLimit(limitKey, tier.limits.tokensPerDay);
  if (!tokenCheck.allowed) {
    log.server.warn({ component: 'rate-limiter', type: 'tokens_per_day', limitKey, limit: tokenCheck.limit, current: tokenCheck.current, backend }, 'AI request rate-limited (daily tokens)');
    getGlobalRecorder()?.record({
      type: 'ai.error', component: 'rate-limiter', level: 'warn',
      message: `Daily token limit reached (${tokenCheck.current}/${tokenCheck.limit})`,
      data: { type: 'tokens_per_day', rate_limit_source: 'daily_token', limitKey, limit: tokenCheck.limit, current: tokenCheck.current, backend, tier: tier.level },
    });
    res.writeHead(429); res.end(JSON.stringify({ error: 'Daily token limit exceeded', limitType: 'tokens_per_day', rate_limit_source: 'daily_token', rate_limit_type: 'api_call', limit: tokenCheck.limit, current: tokenCheck.current })); return true;
  }
  return false;
}

/** t/4485#5: the debate-admission requester scope — the signed-in principal, or the correctly-
 *  derived IP for anonymous callers. Deliberately called ONLY from the debate branch below, not
 *  unconditionally — `getClientIp` has logging side effects (a proxy-without-XFF WARN) that a
 *  platform/BYOK call has no reason to trigger just to compute a value it won't use. */
function requesterIdFor(req: http.IncomingMessage): string {
  return callerIdentity().principalName || `ip:${getClientIp(req)}`;
}

type AdmitFreePoolCallResult =
  | { ok: true; reservationId: string | null; debateReservationId: string | null }
  | { ok: false };

/** t/4485 phase 2: admits (first call) or draws down (later calls) a free-tier debate's budget
 *  when `debateId` is present, else falls back to a normal per-call reservation. Keeps this
 *  branch out of resolveExplicitAiKey's own body so its complexity doesn't grow (t/3821
 *  baseline) — same reasoning as trackFreePoolReservation below. `reservationId` (fallback or
 *  plain per-call) and `debateReservationId` (covered-by-the-debate's-own-reservation) are
 *  mutually exclusive — trackFreePoolReservation below dispatches on which one is set. */
async function admitFreePoolCall(req: http.IncomingMessage, res: http.ServerResponse, budgetKey: string, debateId: string | undefined): Promise<AdmitFreePoolCallResult> {
  if (!debateId) {
    const result = await reserveFreePoolCall(res, budgetKey);
    if (!result.ok) return { ok: false };
    return { ok: true, reservationId: result.reservationId, debateReservationId: null };
  }
  const debateResult = await admitOrDrawDownDebateCall(res, requesterIdFor(req), debateId);
  if (!debateResult.ok) return { ok: false };
  return { ok: true, reservationId: debateResult.fallbackReservationId, debateReservationId: debateResult.debateReservationId };
}

/** Resolve the key to inject: free tier → server FREE_TIER_GEMINI_KEY, gated by the free-pool
 *  geo restriction (t/4486) — 403 `free_pool_region` when the caller's IP is EEA/CH/UK or
 *  unresolvable, 503 if the pool has no keys configured; platform → undefined (server-side
 *  keys); BYOK → client key, with a free-tier Gemini fallback for a BYOK user with no key for
 *  the pinned backend (t/945) — **also geo-gated** (t/4486#4, TL review: this fallback used to
 *  read the pool directly, a fourth bypass of the restriction). **Also budget-gated** (t/4485):
 *  both free-pool paths go through `admitFreePoolCall` — a debate's calls admit/draw-down
 *  server-side (phase 2, t/4485#5); any other call reserves 1 call against the daily budget.
 *  429 `free_pool_exhausted`/`free_pool_debate_limit` or 503 `free_pool_unavailable` when
 *  refused. The debate-admission requester scope is the signed-in principal, or the correctly-
 *  derived IP for anonymous callers (t/4485#5 — never the per-tier `limitKey`, which free-tier
 *  rate limiting keys on IP even for signed-in users). Returns `{ ok: false }` after sending the
 *  error response on any refusal; on success, `reservationId`/`debateReservationId` are
 *  mutually exclusive and non-null only when the caller still has something to settle later
 *  (trackFreePoolReservation dispatches on which one is set). */
async function resolveExplicitAiKey(req: http.IncomingMessage, res: http.ServerResponse, tier: ResolvedTier, clientKey: string | undefined, backend: AIBackend, debateId: string | undefined):
  Promise<{ ok: true; key: string | string[] | undefined; reservationId: string | null; debateReservationId: string | null } | { ok: false }> {
  const budgetKey = debateId ?? 'generate';
  if (tier.serverProvidedKey) {
    // t/4486: the ONLY injection-path reader of the free pool — applies the geo gate.
    const poolResult = await getFreePoolKeys(req, res);
    if (!poolResult.ok) return { ok: false }; // 403 free_pool_region already written
    // t/846: FREE_TIER_GEMINI_KEY may be a comma-separated list; >1 key round-robins
    // across server keys via callWithKeyRotation in generateText.
    const freeKeys = poolResult.keys;
    if (freeKeys.length === 0) { res.writeHead(503); res.end(JSON.stringify({ error: 'Free tier is not available' })); return { ok: false }; }
    const budgetResult = await admitFreePoolCall(req, res, budgetKey, debateId); // t/4485: 429/503 already written on refusal
    if (!budgetResult.ok) return { ok: false };
    return { ok: true, key: freeKeys.length === 1 ? freeKeys[0] : freeKeys, reservationId: budgetResult.reservationId, debateReservationId: budgetResult.debateReservationId };
  }
  let explicitKey: string | string[] | undefined = tier.level === 'platform' ? undefined : (clientKey || undefined);
  if (!explicitKey && proxyTiers.byokGeminiFallbackApplies(tier.level, backend, explicitKey)) {
    const poolResult = await getFreePoolKeys(req, res);
    if (!poolResult.ok) return { ok: false }; // 403 free_pool_region already written
    if (poolResult.keys.length > 0) {
      explicitKey = poolResult.keys.length === 1 ? poolResult.keys[0] : poolResult.keys;
      const budgetResult = await admitFreePoolCall(req, res, budgetKey, debateId); // t/4485: same budget as the free tier itself
      if (!budgetResult.ok) return { ok: false };
      return { ok: true, key: explicitKey, reservationId: budgetResult.reservationId, debateReservationId: budgetResult.debateReservationId };
    }
    // An empty pool is NOT an error for this branch — unlike the free tier's own 503, a BYOK
    // user with no fallback available just proceeds with no key, same as pre-t/4486 behavior.
    // No budget reservation either — there's no free-pool key to reserve against.
  }
  return { ok: true, key: explicitKey, reservationId: null, debateReservationId: null };
}

/** t/4485 (+ t/4485#9 debate reconciliation): tracks one free-pool budget reservation's
 *  lifecycle so the generate handler doesn't need its own `if (reservationId)` / `if
 *  (!committed)` branches at each of its several commit/release points (that inline branching is
 *  what pushed the handler's cyclomatic complexity over its baseline, t/3821) — `commit`/
 *  `releaseIfUnsettled` absorb the null-checks and the settled-or-not bookkeeping internally.
 *  `reservationId` and `debateReservationId` are mutually exclusive: a plain/fallback
 *  reservation commits/releases normally; a debate-covered call instead reconciles the real
 *  token count via `reconcileDebateDrawDown` (its estimate was already drawn down up front) and
 *  has nothing to release (there's no partial amount to undo once drawn down). A no-op
 *  throughout when both are null (budget enforcement off, the common case today, or a BYOK call
 *  with no free-pool key). */
function trackFreePoolReservation(reservationId: string | null, debateReservationId: string | null = null) {
  let settled = false;
  return {
    async commit(usage: { inputTokens: number; outputTokens: number } | undefined): Promise<void> {
      settled = true;
      const tokens = usage ? usage.inputTokens + usage.outputTokens : FREE_POOL_CALL_TOKEN_ESTIMATE;
      if (debateReservationId) { await reconcileDebateDrawDown(debateReservationId, tokens); return; }
      if (!reservationId) return;
      await commitFreePoolCall(reservationId, { calls: 1, tokens });
    },
    async releaseIfUnsettled(): Promise<void> {
      if (settled || debateReservationId || !reservationId) return;
      await releaseFreePoolCall(reservationId);
    },
  };
}

/** 422 fast-fail (t/896) when there's no usable key for the target backend — before
 *  the request reaches the AI adapter (which would surface an opaque upstream 401/403).
 *  Free tier (server-provided) is exempt. Returns true if a 422 was sent. */
async function enforceKeyPresent(res: http.ServerResponse, backend: AIBackend, tier: ResolvedTier, explicitKey: string | string[] | undefined): Promise<boolean> {
  const haveExplicitKey = (typeof explicitKey === 'string' && explicitKey.length > 0)
    || (Array.isArray(explicitKey) && explicitKey.length > 0);
  const missingKey = missingApiKeyError({
    backend,
    displayName: BACKEND_DISPLAY[backend] ?? backend,
    serverProvidedKey: !!tier.serverProvidedKey,
    haveExplicitKey,
    hasResolvedKey: haveExplicitKey || (!tier.serverProvidedKey && await hasApiKey(backend)),
  });
  if (!missingKey) return false;
  res.writeHead(422, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(missingKey));
  return true;
}

/** True for a deliberate cancellation (client disconnect → AbortController.abort()).
 *  The ai-client throws `DOMException('Aborted','AbortError')` and rethrows it
 *  non-retryable (t/2507), so name-matching distinguishes cancel from a genuine
 *  failure — and from a per-attempt timeout, which surfaces as `TimeoutError`. */
export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'AbortError';
}

/** Clean-arm guard for the `/api/ai/generate` disconnect abort (t/2510): abort ONLY
 *  when the request hasn't finished AND the response isn't already written. A `'close'`
 *  that fires after normal completion (response sent) must not false-abort. Exported
 *  for unit testing the clean/failure arms without booting the HTTP server. */
export function shouldAbortOnClientClose(finished: boolean, responseEnded: boolean): boolean {
  return !finished && !responseEnded;
}

/** Generate via the standard chat-response usage; on a free-tier 429 with the whole
 *  free pool exhausted, retry ONCE with the admin-registered paid Gemini key after a
 *  deliberate 3s throttle (t/948). Re-throws the original error when there's no paid
 *  path or the paid retry also fails. The paid key never enters the round-robin pool. */
// Exported for the t/3111 fallback-ordering test (free pool tried first; paid reached
// ONLY on a free-tier 429; paid never in the rotation). Otherwise an internal helper.
export async function generateWithPaidFallback(
  prompt: string,
  usageOverrides: Record<string, unknown>,
  explicitKey: string | string[] | undefined,
  ctx: { isFree: boolean; backend: AIBackend; requestModel: string; t0: number; onRetry?: (p: GenerateTextProgress) => void; signal?: AbortSignal },
): Promise<Awaited<ReturnType<typeof ai.generateText>>> {
  const { isFree, backend, requestModel, t0, onRetry, signal } = ctx;
  try {
    return await ai.generateTextByUsage('server.chat-response', { prompt }, usageOverrides, onRetry, explicitKey, signal);
  } catch (genErr) {
    const paidKey = (ai.is429Error(genErr) && isFree) ? await getPaidGeminiFallbackKey() : null;
    if (!paidKey) throw genErr; // non-free, non-429, or no paid key → outer 429 mapping records it
    // e/134 #6: a fallback path must record at WARN, not info (Fallback-Path Logging rule,
    // docs/error-handling.md) — at info it's below the default filter and the free-pool-exhausted
    // → paid-key degradation goes unseen. The search path (generateWithSearch) already does this.
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'ai-generate', level: 'warn',
      message: 'Free-tier keys exhausted — waiting 3s before paid fallback',
      data: { model: requestModel, backend, fallback: 'paid', delayMs: 3000, freeKeyCount: proxyTiers.freeTierKeyCount() },
    });
    // Throttle: caps paid-key throughput (~20/min) and gives free keys time to exit
    // cooldown so the next request reverts to the free pool.
    await new Promise(r => setTimeout(r, 3000));
    try {
      const result = await ai.generateTextByUsage('server.chat-response:paid-fallback', { prompt }, usageOverrides, onRetry, paidKey, signal);
      getGlobalRecorder()?.record({
        type: 'ai.response', component: 'ai-generate', level: 'info', duration_ms: Date.now() - t0,
        message: `Paid fallback succeeded for ${backend}/${requestModel}`,
        data: { model: requestModel, backend, fallback: 'paid', delayMs: 3000, responseLength: result.text?.length ?? 0 },
      });
      // t/3110 (t/3274): the record() above is FR-ring only — never reaches stdout/Log Analytics, so
      // DevOps's overflow-cost alert (#1733) that keys on "Paid fallback succeeded" could never fire.
      // Emit the same marker to Pino/stdout too (record() kept for forensics). Pattern: log.api.warn @659.
      log.api.info({ component: 'ai-generate', model: requestModel, backend, fallback: 'paid' }, `Paid fallback succeeded for ${backend}/${requestModel}`);
      return result;
    } catch (fallbackErr) {
      getGlobalRecorder()?.record({
        type: 'ai.error', component: 'ai-generate', level: 'warn',
        message: 'Paid fallback also failed',
        data: { model: requestModel, backend, fallback: 'paid', delayMs: 3000 },
        error: { name: (fallbackErr as Error).name ?? 'Error', message: String(fallbackErr), stack: (fallbackErr as Error).stack },
      });
      throw genErr; // both pools exhausted → outer catch maps to a 429 for the client
    }
  }
}

/** t/1132: surface the crossed daily-budget milestone (50/80/95) via response headers
 *  so the renderer can show a dismissable quota banner. No-op without token usage. */
function applyTokenBudgetHeaders(res: http.ServerResponse, result: Awaited<ReturnType<typeof ai.generateText>>, limitKey: string, tier: ResolvedTier): void {
  if (!result.tokenUsage) return;
  const milestone = rateLimiter.recordTokenUsage(limitKey, result.tokenUsage.inputTokens, result.tokenUsage.outputTokens, tier.limits.tokensPerDay);
  if (milestone != null) {
    res.setHeader('X-Token-Budget-Warning', String(milestone));
    res.setHeader('X-Token-Budget-Resets', rateLimiter.nextDailyResetUtc());
  }
}

/** Search-grounded generation (server.search usage) + success record.
 *  t/3175: full parity with generateWithPaidFallback — the in-backend fix routes the
 *  grounded-search provider call through key rotation + retry; this adds the same
 *  route-level paid-overflow safety net: on a free-tier 429 with the whole free pool
 *  exhausted, retry ONCE with the admin paid key after a 3s throttle (the paid key never
 *  enters the free rotation). No-op until GEMINI_PAID_KEY is set (t/3143). */
export async function generateWithSearch(
  prompt: string,
  effectiveModel: string | undefined,
  explicitKey: string | string[] | undefined,
  ctx: { isFree: boolean; backend: AIBackend; requestModel: string; t0: number },
): Promise<Awaited<ReturnType<typeof ai.generateTextWithSearchByUsage>>> {
  const { isFree, backend, requestModel, t0 } = ctx;
  const overrides = effectiveModel ? { model: effectiveModel } : undefined;
  const recordSuccess = (result: Awaited<ReturnType<typeof ai.generateTextWithSearchByUsage>>, fallback?: 'paid') => {
    getGlobalRecorder()?.record({
      type: 'ai.response', component: 'ai-generate', level: 'info',
      duration_ms: Date.now() - t0,
      // t/3110: paid-success carries the shared "Paid fallback succeeded" marker DevOps's
      // overflow-cost alert (#1733) keys on — the same token the non-search
      // generateWithPaidFallback path emits — so the alert also counts debate-search overflow.
      // Marker is on the SUCCESS record only (billed overflow), never the attempt/failure logs.
      message: fallback === 'paid'
        ? `Paid fallback succeeded (search) ${backend}/${requestModel}`
        : `generate+search success ${backend}/${requestModel}`,
      data: { model: requestModel, backend, responseLength: result.text?.length ?? 0, search: true, ...(fallback ? { fallback } : {}) },
    });
    // t/3110 (t/3274): the record() above is FR-ring only. On the PAID branch (billed overflow), also emit
    // the "Paid fallback succeeded" marker to Pino/stdout so DevOps's overflow-cost alert (#1733) can fire —
    // it can't see the FR ring. Paid branch only (never the non-fallback success), matching the record().
    if (fallback === 'paid') {
      log.api.info({ component: 'ai-generate', model: requestModel, backend, fallback: 'paid', search: true }, `Paid fallback succeeded (search) ${backend}/${requestModel}`);
    }
  };
  try {
    const result = await ai.generateTextWithSearchByUsage('server.search', { prompt }, overrides, explicitKey);
    recordSuccess(result);
    return result;
  } catch (searchErr) {
    const paidKey = (ai.is429Error(searchErr) && isFree) ? await getPaidGeminiFallbackKey() : null;
    if (!paidKey) throw searchErr; // non-free, non-429, or no paid key → outer catch maps to 429
    // t/3175 (TL GV): WARN, not info — free-pool exhaustion is the second-front signal we
    // want visible (Fallback-Path Logging rule, docs/error-handling.md); at info it's below
    // the detectable threshold. Records THAT the paid fallback fired and WHY (free 429).
    getGlobalRecorder()?.record({
      type: 'ai.fallback', component: 'ai-generate', level: 'warn',
      message: 'Free-tier search keys exhausted (429) — falling back to paid key after 3s throttle',
      data: { model: requestModel, backend, fallback: 'paid', delayMs: 3000, search: true, freeKeyCount: proxyTiers.freeTierKeyCount() },
    });
    await new Promise(r => setTimeout(r, 3000));
    try {
      const result = await ai.generateTextWithSearchByUsage('server.search:paid-fallback', { prompt }, overrides, paidKey);
      recordSuccess(result, 'paid');
      return result;
    } catch (fallbackErr) {
      getGlobalRecorder()?.record({
        type: 'ai.error', component: 'ai-generate', level: 'warn',
        message: 'Paid search fallback also failed',
        data: { model: requestModel, backend, fallback: 'paid', search: true },
        error: { name: (fallbackErr as Error).name ?? 'Error', message: String(fallbackErr), stack: (fallbackErr as Error).stack },
      });
      throw searchErr; // both exhausted → outer catch maps to a client 429
    }
  }
}

/** t/997: Gemini surfaces a too-long context window as RESOURCE_EXHAUSTED — a 400-class
 *  error retrying won't help. Map it to a context_too_long 400 (record + respond).
 *  Returns true if it handled `err`. */
function respondIfContextTooLong(res: http.ServerResponse, err: unknown, modelLabel: string): boolean {
  if (!ai.isContextTooLongError(err)) return false;
  log.server.warn({ component: 'ai-generate', model: modelLabel }, 'AI generate input exceeds model context window');
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'ai-generate', level: 'warn',
    message: 'AI generate input too long for model context window',
    data: { model: modelLabel, source: 'context_overflow' },
  });
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'context_too_long', message: 'Input exceeds the model context window — try a shorter prompt or a model with a larger context window' }));
  return true;
}

/** t/920: an upstream provider rate-limit was collapsing into an opaque non-retryable
 *  500. Map it to a retryable 429 with Retry-After (record + respond) so the debate
 *  flow backs off + retries. Returns true if it handled `err`. */
function respondIfUpstream429(res: http.ServerResponse, err: unknown, modelLabel: string): boolean {
  if (!ai.is429Error(err)) return false;
  const retry = ai.retryAfterMs(err);
  log.server.warn({ component: 'ai-generate', model: modelLabel, retryAfterMs: retry }, 'AI generate upstream rate-limited — returning 429');
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'ai-generate', level: 'warn',
    message: 'AI generate upstream rate-limited',
    data: { model: modelLabel, retryAfterMs: retry, source: 'upstream', rate_limit_source: 'api_key_exhausted' },
  });
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retry / 1000))));
  res.writeHead(429, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Upstream AI provider rate limit — retry shortly', limitType: 'upstream_rate_limit', rate_limit_source: 'api_key_exhausted', rate_limit_type: 'api_call', retryAfterMs: retry, retryable: true }));
  return true;
}

/** Map an /api/ai/search generation error to its HTTP response (t/2625 — the non-recording
 *  tail extracted from the handler catch per ADR-003; the catch records, this only responds). */
function respondAiSearchError(res: http.ServerResponse, err: unknown): void {
  if (ai.isContextTooLongError(err)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'context_too_long', message: 'Input exceeds the model context window — try a shorter prompt or a model with a larger context window' }));
    return;
  }
  if (ai.is429Error(err)) {
    const retry = ai.retryAfterMs(err);
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retry / 1000))));
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upstream AI provider rate limit — retry shortly', limitType: 'upstream_rate_limit', rate_limit_source: 'api_key_exhausted', rate_limit_type: 'api_call', retryAfterMs: retry, retryable: true }));
    return;
  }
  error(res, String(err), 500, err);
}

export function registerAiRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post } = r;

  // t/897: Easy Auth's /.auth/logout left AppServiceAuthSession valid, so "Sign
  // Out" didn't terminate the session (next browser user inherited it). This GET
  // (browser navigates here) expires every Easy Auth session cookie present, then
  // hands off to /.auth/logout with a post-logout redirect home. Provider-agnostic
  // (same session cookie for GitHub/Google). The client links here, not /.auth/logout.
  get('/api/auth/logout', (req, res) => {
    res.writeHead(302, {
      'Set-Cookie': expiredAuthCookies(Object.keys(parseCookies(req))),
      'Location': '/.auth/logout?post_logout_redirect_uri=/',
    });
    res.end();
  });

  // t/1032: defense-in-depth fresh sign-in. The Workbox service worker serves the
  // cached SPA for navigations to '/', so t/940's stale-cookie clearing in the
  // server-rendered login page never runs for returning users. Routing the SPA's
  // sign-in links through here expires any stale Easy Auth session cookie BEFORE
  // initiating OAuth, so every attempt starts from a clean state regardless of SW
  // cache. Provider is allowlisted — it's interpolated into the redirect target.
  const FRESH_LOGIN_PROVIDERS = new Set(['github', 'google', 'aad']);
  get('/api/auth/fresh-login/:provider', (req, res) => {
    const provider = param(req, 'provider', '/api/auth/fresh-login/:provider');
    const location = FRESH_LOGIN_PROVIDERS.has(provider)
      ? `/.auth/login/${provider}?post_login_redirect_uri=/`
      : '/'; // unknown provider → land on the login page rather than an open redirect
    res.writeHead(302, {
      'Set-Cookie': expiredAuthCookies(Object.keys(parseCookies(req))),
      'Location': location,
    });
    res.end();
  });


  // ── AI generation ──

  post('/api/ai/generate', async (req, res, body) => {
    const { prompt, model, timeout, apiKey: clientKey, search, debateId } = body as { prompt: string; model?: string; timeout?: number; apiKey?: string; search?: boolean; debateId?: string };
    // Capture synchronously before any await — ALS context is available here but not
    // guaranteed across the await boundary in all Node versions.
    const userId = getCurrentUserId();
    // t/966: stamp the debate client's debateId onto the request context so it lands
    // in the request-completion log (and every log line for this request) — debate
    // sessions become filterable in one query instead of correlating by user+time.
    if (typeof debateId === 'string' && debateId) {
      const rc = getRequestContext();
      if (rc) rc.debateId = debateId.slice(0, 64);
    }
    // t/2510: cancel the in-flight provider request when the client disconnects
    // mid-generate. `finished` is the clean-arm — a 'close' that fires AFTER the
    // response has been sent (normal completion) must NOT abort. abort() is
    // idempotent, so a duplicate 'close' is harmless.
    //
    // t/2522: listen on `res`, NOT `req`. Node ≥15 fires IncomingMessage 'close' at
    // message-complete (nodejs/node#33035), and the body is parsed before this
    // handler runs — so `req.on('close')` had already missed and never fired on a
    // real mid-generate disconnect (dead code). ServerResponse 'close' fires when the
    // connection actually terminates; the writableEnded guard filters the normal-
    // completion 'close'.
    const t0 = Date.now();
    const abort = new AbortController();
    let finished = false;
    // t/4485: a no-op tracker until resolveExplicitAiKey resolves a real reservationId below.
    // `finally` always calls releaseIfUnsettled() — covers every early-return/catch path
    // without duplicating release() calls at each one.
    let freePoolBudget = trackFreePoolReservation(null);
    res.on('close', () => { if (shouldAbortOnClientClose(finished, res.writableEnded)) abort.abort(); });
    try {
      // Free-tier cost is bounded by tokensPerDay + per-IP rate limits; the redundant
      // per-prompt char cap was removed in t/812 (broke long debate prompts).
      const { tier, isFree, limitKey, effectiveModel, backend } = resolveGenerationContext(req, model);
      // t/3230: a single anonymous debate drains the shared free Gemini key pool (K=4) → 429 storm
      // → ~485s retry → user-facing 500. Block free-tier debate generation (reversible via the
      // `anon-debates` flag) BEFORE any key/provider call — covers debate rounds AND the fact-check
      // `search` calls (both carry debateId). Authenticated debates + non-debate free-tier untouched.
      if (enforceAnonDebateGate(res, isFree, debateId)) return; // 403 when anon debates disabled
      if (enforceBackendAllowed(res, tier, backend)) return; // 403 if backend not on tier

      // Rate limiting: per-IP RPM (free tier) / per-user RPM + daily token budget (429 on breach).
      if (enforceAiRateLimits(res, isFree, limitKey, tier, backend)) return;

      // Key injection: free tier → server FREE_TIER_GEMINI_KEY, geo-gated (t/4486, 403 if no
      // keys or restricted region); platform → server-side keys; BYOK → client key, with a
      // free-tier Gemini fallback (t/945).
      // t/4485#5: the debate-admission requester scope — the signed-in principal, or the
      const keyResult = await resolveExplicitAiKey(req, res, tier, clientKey, backend, debateId);
      if (!keyResult.ok) return;
      let explicitKey = keyResult.key;
      freePoolBudget = trackFreePoolReservation(keyResult.reservationId, keyResult.debateReservationId);

      // t/3498 (t/3495 epic): an allowlisted user running Gemini with no personal
      // key gets the admin's registered paid key injected server-side — never
      // echoed to the client. Membership is keyed on the derived storage userId
      // (SO cond 4, t/3495#2) — the same id `/api/user/profile` exposes as
      // `userId` and t/3497's allowlistStore expects. Falls through to the
      // existing 422 below if the admin hasn't registered a key yet — no
      // special-cased error for that edge (t/3498#1).
      const noExplicitKey = !explicitKey || (Array.isArray(explicitKey) && explicitKey.length === 0);
      if (backend === 'gemini' && noExplicitKey && allowlistStore.isAllowlisted(getStorageUserId())) {
        const allowlistKey = await getPaidGeminiFallbackKey();
        if (allowlistKey) {
          explicitKey = allowlistKey;
          // SO-required audit event (financial accountability + forensic trail, e/169#3).
          log.server.info(
            { userId: getStorageUserId(), timestamp: new Date().toISOString(), model: effectiveModel ?? DEFAULT_MODEL },
            'allowlist-key-used',
          );
        }
      }

      // t/896: fail fast with a clear 422 when there's no usable key for the target
      // backend — before the request reaches the AI adapter (opaque upstream 401/403).
      // Free tier (server-provided) is exempt; t/945 resolved a BYOK Gemini fallback above.
      if (await enforceKeyPresent(res, backend, tier, explicitKey)) return;

      // t/839: record the AI request/response on the happy path so the web-mode
      // retry timeline is visible in the flight recorder (mirrors lib/debate
      // aiAdapter). Prompt content is never recorded — only its length.
      const requestModel = effectiveModel ?? DEFAULT_MODEL;
      getGlobalRecorder()?.record({
        type: 'ai.request', component: 'ai-generate', level: 'info',
        message: `generate ${backend}/${requestModel}`,
        data: { model: requestModel, backend, tier: tier.level, promptLength: prompt?.length ?? 0, debateId },
      });

      const usageOverrides = {
        ...(effectiveModel ? { model: effectiveModel } : {}),
        ...(timeout ? { timeoutMs: timeout } : {}),
      };

      if (search) {
        // generateWithSearch returns { text, searchQueries?, citations? } — no servedModel.
        // Speaker turns never use search=true; servedModel is not required on this path (t/4125 AC).
        const searchResult = await generateWithSearch(prompt, effectiveModel, explicitKey, { isFree, backend, requestModel, t0 });
        await freePoolBudget.commit((searchResult as { tokenUsage?: { inputTokens: number; outputTokens: number } }).tokenUsage);
        json(res, searchResult);
      } else {
        const result = await generateWithPaidFallback(prompt, usageOverrides, explicitKey, {
          isFree, backend, requestModel, t0,
          onRetry: (p) => ctx.emitToUser(userId, 'generate-text-progress', p),
          signal: abort.signal, // t/2510: client disconnect → abort the provider fetch
        });

        getGlobalRecorder()?.record({
          type: 'ai.response', component: 'ai-generate', level: 'info',
          duration_ms: Date.now() - t0,
          message: `generate success ${backend}/${requestModel}`,
          data: { model: requestModel, backend, responseLength: result.text?.length ?? 0, usage: result.tokenUsage },
        });

        // t/4485: commit() records actual usage unconditionally (t/4484's own contract) —
        // reconciles the upfront estimate to the real token count now that it's known.
        await freePoolBudget.commit(result.tokenUsage);

        applyTokenBudgetHeaders(res, result, limitKey, tier);
        json(res, { text: result.text, tokenUsage: result.tokenUsage, servedModel: result.servedModel }); // t/4125: forward registry id so the renderer can track failover
      }
    } catch (err) {
      const modelLabel = model ?? 'default';
      // t/2510: client disconnected mid-generate → the provider fetch was aborted.
      // Not a failure: log ai.cancelled at info (correlate via x-request-id), skip the
      // failure mappings + 500, and write nothing (the socket is already gone). The
      // retry attempt count lives in the ai-client ladder's ai.retry events (same
      // requestId), so it is not re-surfaced here.
      if (isAbortError(err)) {
        getGlobalRecorder()?.record({
          type: 'ai.cancelled', component: 'ai-generate', level: 'info',
          duration_ms: Date.now() - t0,
          message: `generate cancelled (client disconnect): ${modelLabel}`,
          data: { model: modelLabel, requestId: String(req.headers['x-request-id'] ?? ''), reason: 'client_disconnect' },
        });
        return;
      }
      if (respondIfContextTooLong(res, err, modelLabel)) return; // t/997 → context_too_long 400
      if (respondIfUpstream429(res, err, modelLabel)) return;    // t/920 → retryable 429
      // t/1362: also log at error level via Pino so the 500 is visible in
      // `az containerapp logs show` — the FR record alone requires a browser-
      // triggered dump, which may be impossible if the UI is broken.
      log.server.error({ component: 'ai-generate', model: modelLabel, err }, 'AI generate failed');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'ai-generate', level: 'error',
        message: `AI generate failed: ${String(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { model: modelLabel, promptLength: prompt?.length },
      });
      error(res, String(err), 500, err);
    } finally {
      finished = true; // clean-arm: any later 'close' (normal completion) won't abort
      // t/4485: a no-op if commit() already settled it (or there was never a reservation) —
      // otherwise returns the unused budget (early return, abort, or any error path above).
      await freePoolBudget.releaseIfUnsettled();
    }
  });

  post('/api/ai/search', async (req, res, body) => {
    const { prompt, model } = body as { prompt: string; model?: string };
    try {
      // t/2625: gate the user-supplied model through the shared entitlement path (pins free tier).
      const { tier, effectiveModel, backend } = resolveGenerationContext(req, model);
      if (enforceBackendAllowed(res, tier, backend)) return;
      json(res, await ai.generateTextWithSearchByUsage('server.search', { prompt }, effectiveModel ? { model: effectiveModel } : undefined));
    } catch (err) {
      // ADR-003: record literally in the catch; the (non-recording) err→HTTP mapping is extracted.
      const expected = ai.isContextTooLongError(err) || ai.is429Error(err);
      getGlobalRecorder()?.record({
        type: 'ai.error', component: 'ai-search', level: expected ? 'warn' : 'error',
        message: `AI search failed: ${String(err)}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { model: model ?? 'default', promptLength: prompt?.length, source: ai.isContextTooLongError(err) ? 'context_overflow' : ai.is429Error(err) ? 'upstream' : 'error', ...(ai.is429Error(err) ? { rate_limit_source: 'api_key_exhausted', retryAfterMs: ai.retryAfterMs(err) } : {}) },
      });
      if (ai.isContextTooLongError(err)) log.server.warn({ component: 'ai-search', model: model ?? 'default' }, 'AI search input exceeds model context window');
      else if (ai.is429Error(err)) log.server.warn({ component: 'ai-search', model: model ?? 'default', retryAfterMs: ai.retryAfterMs(err) }, 'AI search upstream rate-limited — returning 429');
      // e/134 #5: an UNEXPECTED failure is a genuine 500 — always log at error level to Pino/stdout so
      // it's visible in `az containerapp logs show` (the FR record above is ring-buffer only). Mirrors
      // the /api/ai/generate catch. The two expected sub-cases above already log their own WARN.
      else log.server.error({ component: 'ai-search', model: model ?? 'default', err }, 'AI search failed');
      respondAiSearchError(res, err);
    }
  });

  // ── Proxy info endpoints ──

  // t/772: backends that are BOTH key-configured AND tier-authorized. The
  // multi-provider debate UI uses this instead of per-backend /api/keys/has, which
  // only checks key presence and let it assign models to backends that 403 at
  // generation time. Cheap: tier config is cached (proxyTiers), the model registry
  // is static, and keyStore.get is cached with bust-on-write — no new cache needed.
  get('/api/backends/available', async (_req, res) => {
    try {
      const { principalName, idp } = callerIdentity(); // t/848: verified context, not raw headers
      const tier = proxyTiers.resolveTier(principalName, idp);
      const registry = await fileIO.loadAIModels() as { backends?: { id: string }[]; models?: { id: string; backend: string }[] };
      const ids = (registry.backends ?? []).map(b => b.id);
      const keyPresence: Record<string, boolean> = {};
      await Promise.all(ids.map(async (id) => { keyPresence[id] = await hasApiKey(id as AIBackend); }));
      json(res, { backends: ai.computeAvailableBackends(registry, tier.allowedBackends, keyPresence) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to compute backend availability',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  get('/api/proxy/tier', async (_req, res) => {
    const { principalName, idp } = callerIdentity(); // t/848: verified context, not raw headers
    const tier = proxyTiers.resolveTier(principalName, idp);
    // t/4485 item 4: the free-pool headroom gauge. 'not-enforced' while the budget-enforcement
    // flag is off (today's default); 'unknown' — never a zeroed number — when enforcement is on
    // but the store can't be read. Also fires the once-a-day 80% WARN as a side effect.
    const freePoolHeadroom = await getFreePoolHeadroomSnapshot();
    json(res, { ...tier, principalName: principalName || null, freePoolHeadroom });
  });

  get('/api/proxy/usage', (_req, res) => {
    const { principalName, idp } = callerIdentity(); // t/848: verified context, not raw headers
    const userId = principalName || '_anonymous';
    const tier = proxyTiers.resolveTier(principalName, idp);
    const usage = rateLimiter.getUsage(userId);
    json(res, { tier: tier.level, limits: tier.limits, usage });
  });

  post('/api/ai/temperature', (_req, res, body) => {
    const { temp } = body as { temp: number | null };
    const previous = ai.getDebateTemperature();
    ai.setDebateTemperature(temp);
    log.api.info({ component: 'ai-config', previous, temp }, 'Debate temperature changed');
    getGlobalRecorder()?.record({
      type: 'lifecycle', component: 'ai-config', level: 'info',
      message: 'Debate temperature changed',
      data: { previous, temp },
    });
    json(res, { ok: true });
  });

  // ── Embeddings & NLI ──

  // t/1062 / t/1171: shared free-tier gate for the embeddings + NLI routes.
  // t/3061 (corrected): embeddings/NLI use LOCAL ONNX / Python — zero Gemini API calls.
  // Applying the API per-IP RPM bucket here starved embeddings whenever generate calls
  // exhausted it. Fix: use a SEPARATE "embed:<ip>" bucket at LOCAL_EMBED_RPM_PER_IP
  // (generous vs API RPM, bounded to prevent CPU-abuse). No token check — no quota consumed.
  // Non-free callers pass through immediately (no bucket to hit).
  // NLI note: when the local Python encoder is unavailable, classifyNli falls back to
  // generateTextByUsage which routes through the generate chokepoint (#1586) — the
  // hosted-LLM path is quota-paced there; no double-wrapping needed here.
  function freeTierEmbeddingGate(req: http.IncomingMessage, res: http.ServerResponse): { blocked: boolean } {
    const { principalName, idp } = callerIdentity();
    const tier = proxyTiers.resolveTier(principalName, idp);
    if (tier.level !== 'free') return { blocked: false };
    const limitKey = `embed:${getClientIp(req)}`;
    const rpmCheck = rateLimiter.checkRate(limitKey, proxyTiers.LOCAL_EMBED_RPM_PER_IP, 60_000);
    if (!rpmCheck.allowed) {
      res.writeHead(429); res.end(JSON.stringify({ error: 'Rate limit exceeded', limitType: 'embed_requests_per_minute', rate_limit_source: 'per_ip_rpm', rate_limit_type: 'local_compute', retryAfterMs: rpmCheck.retryAfterMs, limit: rpmCheck.limit, current: rpmCheck.current }));
      return { blocked: true };
    }
    return { blocked: false };
  }

  // Invariant: MAX_EMBED_BATCH must be ≥ the client's chunk size (currently 512 per t/3072).
  // A server cap below the client chunk size would 413 every legitimate request.
  const MAX_EMBED_BATCH = 512;
  // t/3165: a fully-recomputed batch at/above this size is flagged as a volume event (novel
  // no-ids text). ≥64 catches the ~200/792 debate grounding batches; below it, small ad-hoc
  // computes stay silent (TL p/522#111 threshold guidance).
  // TIERED with aiBackends' NOVEL_TEXT_DEMAND_BASELINE=256 (t/3183, TL p/522#134) — NOT redundant:
  // 64 here = "notable volume, a large recompute happened" (expected under cold cache); 256 there =
  // "demand baseline exceeded — the demand ITSELF may be the bug" (the novel-text class's failure
  // mode). Two rungs of the same ladder, different meanings.
  const LARGE_RECOMPUTE_WARN_ITEMS = 64;

  post('/api/embeddings/compute', (req, res, body) => {
    // t/4287: chunks run SEQUENTIALLY inside resolveEmbeddingsChunked, not in parallel — a
    // flat single-chunk endpoint timeout guarantees a 504 for any batch needing more than one
    // EMBEDDING_COMPUTE_CHUNK-sized chunk once a chunk's wall time approaches its own
    // EMBEDDINGS_REQUEST_TIMEOUT_MS budget under concurrent load (canary finding: a 128-text
    // chunk took ~45s at 2 vCPU). Scale the endpoint guard by the chunk count this batch will
    // need instead. For itemCount within one chunk this is exactly today's flat 50_000
    // (1×45_000 + 5_000 margin) — no behavior change for the common case.
    const preview = (body as { texts?: unknown } | null)?.texts;
    const itemCount = Array.isArray(preview) ? preview.length : 0;
    const numChunks = Math.max(1, Math.ceil(itemCount / EMBEDDING_COMPUTE_CHUNK));
    const endpointTimeoutMs = numChunks * EMBEDDINGS_REQUEST_TIMEOUT_MS + 5_000;
    return withEndpointTimeout(res, endpointTimeoutMs, 'embeddings-compute', async () => {
    const { texts, ids } = body as { texts: string[]; ids?: string[] };
    // t/3074 Gap 1: reject oversized batches before they enter the compute path.
    // Client (t/3072) chunks to ≤MAX_EMBED_BATCH; this is the server-side backstop.
    if (!Array.isArray(texts) || texts.length > MAX_EMBED_BATCH) {
      const count = Array.isArray(texts) ? texts.length : 'non-array';
      error(res, `Batch too large (${count}) — max ${MAX_EMBED_BATCH} texts per request`, 413);
      return;
    }
    try {
      const gate = freeTierEmbeddingGate(req, res);
      if (gate.blocked) return;
      // t/2904: emit the pre-freeze load signals (event-loop delay + heap + rss +
      // in-flight count) at INFO so a liveness-probe kill under concurrent embedding
      // load is diagnosable in the ACA container logs — the 2026-08-21 crash had none.
      // t/3079: requestId added so Get-DebateRateLimitSummary-style cmdlets can
      // correlate a client 504/500 to the server-side cause.
      log.api.info(
        { ...embeddingLoadSnapshot(), item_count: Array.isArray(texts) ? texts.length : 0, request_id: getRequestId() },
        'embeddings.compute: entry',
      );
      // t/2905: load-shed to prevent the GC event-loop freeze that SIGKILL'd the
      // container. Sheds when in-flight computes hit the concurrency cap OR the
      // event-loop delay is already high. Warn-first by default (logs + proceeds);
      // EMBEDDINGS_LOAD_SHED_MODE=block returns a typed 503 so the client circuit
      // breaker retries instead of tripping on an opaque crash.
      const shedDecision = evaluateEmbeddingLoadShed();
      if (shedDecision.shed) {
        if (shedDecision.mode === 'block') {
          log.api.warn({ ...embeddingLoadSnapshot(), reason: shedDecision.reason }, 'embeddings.compute: load-shed 503');
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(shedDecision.retryAfterMs / 1000)) });
          res.end(JSON.stringify({ error: 'Embedding service is at capacity; retry shortly.', retryable: true, reason: shedDecision.reason, retryAfterMs: shedDecision.retryAfterMs }));
          return;
        }
        log.api.warn({ ...embeddingLoadSnapshot(), reason: shedDecision.reason }, 'embeddings.compute: WOULD load-shed (warn-first; not blocking)');
      }
      const modelWarm = isEmbeddingModelWarm();
      const t0 = Date.now();
      const inFlightAtEntry = embeddingLoadSnapshot().in_flight_embedding_computes;
      beginEmbeddingCompute();
      try {
        // t/3061: local ONNX — no Gemini call, no key needed.
        // t/3183: name the caller so a worker-queue shed WARN (offload on) / demand-baseline WARN
        // attributes the drop to this route rather than 'unknown'.
        const { vectors, cacheHits, cacheMisses } = await ai.computeEmbeddings(texts, ids, undefined, { requester: 'embeddings-compute' });
        markEmbeddingModelWarm();
        // t/3079: item_count; t/3086: cache_hits/cache_misses (sustained 0% hit = t/3085 condition).
        getGlobalRecorder()?.record({
          type: 'system.info', component: 'embeddings-compute', level: 'info',
          message: 'embedding.compute',
          data: { duration_ms: Date.now() - t0, item_count: texts.length, model_cold_start: !modelWarm, in_flight_at_entry: inFlightAtEntry, cache_hits: cacheHits, cache_misses: cacheMisses },
        });
        // t/3166 item 2 / t/3165: a boot-only "loaded N nodes" signal (t/3081) can't see a
        // MID-LIFE cache miss — the exact shape of t/3165 (present-but-non-resolving cache
        // re-embedding keyed corpus texts). Emit a WARN when KEYED texts (ids provided) fail to
        // resolve, so a re-embed is directly greppable instead of inferred from latency. Gated on
        // `ids` because ad-hoc query embeds pass none (cacheHits=0 by construction) and would spam.
        if (ids && cacheMisses > 0) {
          const missMsg = `embeddings.compute: cache miss — re-computing ${cacheMisses} of ${texts.length} keyed texts (resolved ${cacheHits} from cache)`;
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'embeddings-compute', level: 'warn',
            message: missMsg,
            data: { cache_hits: cacheHits, cache_misses: cacheMisses, item_count: texts.length, request_id: getRequestId() },
          });
          log.api.warn({ component: 'embeddings-compute', cache_hits: cacheHits, cache_misses: cacheMisses, item_count: texts.length, request_id: getRequestId() }, missMsg);
        }
        // t/3165 (TL p/522#111): the keyed-miss WARN above is ids-gated, so it MISSES the actual
        // t/3165 mechanism — a large batch of NOVEL, no-ids text (frames/paras/claims) that
        // legitimately re-computes (correct-miss → VOLUME, ties t/2977). Flag that volume case:
        // a big batch (≥ LARGE_RECOMPUTE_WARN_ITEMS) that fully re-computes (cacheHits==0),
        // regardless of ids. Threshold ≥64 catches the ~200/792 debate batches but stays silent
        // on small legit ad-hoc computes (both arms — TL GV condition).
        if (texts.length >= LARGE_RECOMPUTE_WARN_ITEMS && cacheHits === 0) {
          const volMsg = `embeddings.compute: large no-cache recompute — ${texts.length} texts, 0 cache hits (${ids ? 'keyed but unresolved' : 'novel no-ids text — volume, not a cache miss'})`;
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'embeddings-compute', level: 'warn',
            message: volMsg,
            data: { item_count: texts.length, cache_hits: 0, has_ids: !!ids, request_id: getRequestId() },
          });
          log.api.warn({ component: 'embeddings-compute', item_count: texts.length, cache_hits: 0, has_ids: !!ids, request_id: getRequestId() }, volMsg);
        }
        // t/3165: expose cacheHits/cacheMisses + corpusNodeCount so the t/3091 resolution gate
        // (DevOps 2) can (1) assert a canary keyed lookup actually HITS the cache — presence≠resolution —
        // and (2) disambiguate a DEAD cache from a bad canary id: cacheHits==0 && corpusNodeCount==0 →
        // cache dead (rollback); cacheHits==0 && corpusNodeCount>0 → id not in corpus (config error, no rollback).
        const corpusNodeCount = ai.getEmbeddingsCacheStatus?.()?.nodeCount ?? 0;
        json(res, { vectors, cacheHits, cacheMisses, corpusNodeCount });
      } finally {
        endEmbeddingCompute();
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to compute embeddings', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      // t/3074 Sub-change B: per-chunk timeout is transient (server under load) → retryable 503
      // so the client backs off instead of receiving an opaque 500. Branch on the typed
      // .timeout marker set by resolveEmbeddingsChunked (not fragile-prose — t/2952).
      // Deterministic errors (bad input, init failure) have no .timeout → remain 500.
      if ((err as { timeout?: boolean }).timeout === true) {
        // t/3079: log at warn (not error — this is a transient backpressure signal, not a fault)
        // with requestId so the client 503 is correlatable to the server-side stall.
        log.api.warn({ request_id: getRequestId(), item_count: Array.isArray(texts) ? texts.length : 0 }, 'embeddings.compute: chunk timeout → 503');
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
        res.end(JSON.stringify({ error: 'Embedding compute timed out — retry after backoff', retryable: true, retryAfterMs: 5000 }));
        return;
      }
      error(res, String(err), 500, err);
    }
    });
  });

  // t/1171: same free-tier exemption + rate limiting + key as /compute, so anonymous
  // semantic search finishes the cheap query-embedding step (not just the corpus one).
  post('/api/embeddings/query', (req, res, body) => withEndpointTimeout(res, 35_000, 'embeddings-query', async () => {
    const { text } = body as { text: string };
    try {
      const gate = freeTierEmbeddingGate(req, res);
      if (gate.blocked) return;
      const vector = await ai.computeQueryEmbedding(text, undefined);
      json(res, { vector });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to compute query embedding', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  }));

  post('/api/embeddings/update-nodes', async (_req, res, body) => {
    const { nodes } = body as { nodes: { id: string; text: string; pov: string; exclusionText?: string }[] };
    try {
      await ai.updateNodeEmbeddings(nodes);
      json(res, { ok: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to update node embeddings', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  post('/api/nli/classify', (req, res, body) => withEndpointTimeout(res, 35_000, 'nli-classify', async () => {
    const { pairs } = body as { pairs: { text_a: string; text_b: string }[] };
    try {
      // t/3061: embed gate for RPM (separate "embed:<ip>" bucket, not the API bucket).
      // t/1650: classifyNli needs the free-tier key pool because the local Python venv was
      // removed (t/1642) — the hosted-LLM fallback is the ACTIVE prod path; without a key
      // anon callers get [] → fail. Embeddings stay key-free (true local ONNX, no fallback).
      const gate = freeTierEmbeddingGate(req, res);
      if (gate.blocked) return;
      // t/4486: the ONLY other injection site besides resolveExplicitAiKey — must go through
      // the same geo-gated accessor (TL review, t/4486#2: this route bypassed
      // resolveGenerationContext entirely, so a guard placed only there would miss it).
      let nliKeys: string[] | undefined;
      if (proxyTiers.freeTierEnabled()) {
        const poolResult = await getFreePoolKeys(req, res);
        if (!poolResult.ok) return; // 403 free_pool_region already written
        nliKeys = poolResult.keys;
      }
      const results = await ai.classifyNli(pairs, nliKeys && nliKeys.length > 0 ? nliKeys : undefined);
      json(res, { results });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to classify NLI pairs', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  }));
}

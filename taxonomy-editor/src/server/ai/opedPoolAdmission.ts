// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/616 (t/501, TL p/16#374 and p/16#376, Security p/93#69 and p/93#71): an op-ed run on the free key pool is
// admitted against the shared daily pool budget BEFORE its SSE stream opens, then draws the pool down per call.
//
//   - Admission is sized from the run's own worst case: calls x (prompt bound + maxTokens), calls = voices x 7
//     (8 with source, the reflection retry) + 1 source brief, capped at the
//     tokens $5 can buy on the run's model (ANON_OPED_PER_RUN_CAP_USD). If the pool can't hold it, the run is
//     refused with 429 free_pool_exhausted before any provider call (Security p/93#71 (a)).
//   - Each call draws down against the admission (the debate design, t/4485). Past 2x the admission, a call falls
//     back to a per-call reserve that CAN refuse. Mid-stream there is no HTTP status left to send, so a refusal
//     throws, and the adapter then refuses every later call of the run: the remaining voices stop.
//   - The store key is `oped:<requester>:<runId>`, with at most OPED_MAX_OPEN_PER_REQUESTER live admissions per
//     requester (the debate guard against minting a fresh id per call to drain the pool).
//   - Enforcement off (the free-pool-budget-enforced flag) changes nothing: admission and draw-down are no-ops.

import type http from 'http';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { resolvePricingKey, type ModelRegistry } from '../../../../lib/ai-client/registry.js';
import { isFreePoolBudgetEnforced } from '../featureFlags.js';
import { getFreePoolBudget } from '../storage/freePoolBudget.js';
import { ANON_OPED_PER_RUN_CAP_USD } from '../storage/anonOpEdSpend.js';
import {
  FREE_POOL_CALL_TOKEN_ESTIMATE, FREE_POOL_EXHAUSTED_MESSAGE, FREE_POOL_UNAVAILABLE_MESSAGE, DEBATE_OVERDRAFT_MULTIPLIER,
  reserveFreePoolCallInBand, reconcileDebateDrawDown, commitFreePoolCall,
} from './freePoolBudgetGate.js';

/** Provider calls one voice can make in lib/oped/generate.ts: generation, coherence judge, rewrite and re-judge,
 *  readability edit and its one retry, grounding reflection. Keep in step with generate.ts's callStage sites
 *  (opedAdmissionSizing.test.ts counts them). */
export const OPED_MAX_CALLS_PER_VOICE = 7;
/** t/616 (SO p/252#54): with source material, a voice can make one more: the reflection retry (generate.ts
 *  runReflection(0), t/2919), taken when the first reflection returns no claims but the source brief has key claims.
 *  Without source there are no key claims, so the retry can't happen. */
export const OPED_SOURCE_EXTRA_CALLS_PER_VOICE = 1;
/** The set-level source brief, made once when the run has source material. */
export const OPED_SET_CALLS_WITH_SOURCE = 1;
/** The largest maxTokens any op-ed stage asks for, outside generation (reflection's floor is 4000; it grows with
 *  the grounding refs, which the template bound below covers). */
export const OPED_STAGE_MAX_TOKENS_FLOOR = 8000;
/** Prompt bytes per call beyond the source material: the system template, voice block, grounding and situation
 *  nodes, and the essay a later stage quotes. Generous on purpose: an over-sized admission only holds pool budget
 *  until the run's TTL releases the remainder, while an under-sized one leans on the overdraft fallback. */
export const OPED_PROMPT_TEMPLATE_BOUND_BYTES = 120_000;
/** Live op-ed admissions per requester. One run at a time is already enforced by the route; 2 tolerates a
 *  finished run whose admission hasn't expired yet. */
export const OPED_MAX_OPEN_PER_REQUESTER = 2;

export interface OpEdRunShape {
  voices: number;
  /** UTF-8 bytes of the source material (0 when none). */
  sourceBytes: number;
  /** The generation stage's maxTokens (generate.ts: ceil(targetWords * 3) + 5000). */
  generationMaxTokens: number;
}

/** Tokens that $5 can buy on `model` at its cheapest rate (so the cap is an upper bound on what a $5 run can
 *  consume). Undefined for an unpriced model. */
export function tokensForRunCap(registry: ModelRegistry, model: string): number | undefined {
  const key = resolvePricingKey(registry, model);
  if (!key) return undefined;
  const p = registry.pricing![key];
  const cheapestPer1M = Math.min(p.inputPer1M, p.outputPer1M);
  if (!(cheapestPer1M > 0)) return undefined;
  return Math.floor((ANON_OPED_PER_RUN_CAP_USD / cheapestPer1M) * 1_000_000);
}

/** The run's worst case in calls and tokens, with tokens capped at what $5 buys. Tokens are bounded by bytes
 *  (every token covers at least one byte), as in opedAdapter's per-call ceiling. */
export function opedAdmissionEstimate(shape: OpEdRunShape, capTokens: number | undefined): { calls: number; tokens: number } {
  const hasSource = shape.sourceBytes > 0;
  const voiceCalls = shape.voices * (OPED_MAX_CALLS_PER_VOICE + (hasSource ? OPED_SOURCE_EXTRA_CALLS_PER_VOICE : 0));
  const calls = voiceCalls + (hasSource ? OPED_SET_CALLS_WITH_SOURCE : 0);
  const promptBound = shape.sourceBytes + OPED_PROMPT_TEMPLATE_BOUND_BYTES;
  const maxOut = Math.max(shape.generationMaxTokens, OPED_STAGE_MAX_TOKENS_FLOOR);
  const worst = calls * (promptBound + maxOut);
  return { calls, tokens: capTokens === undefined ? worst : Math.min(worst, capTokens) };
}

export function opedRequesterKeyPrefix(requesterId: string): string {
  return `oped:${requesterId}:`;
}

export type OpEdAdmission = { ok: true; reservationId: string | null } | { ok: false };

function refuse(res: http.ServerResponse, status: number, body: Record<string, unknown>): OpEdAdmission {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return { ok: false };
}

/** The flight-recorder half of a store failure; the WARN stays literally in each catch (ADR-003). */
function recordStoreError(message: string, err: unknown): void {
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'free-pool-budget', level: 'warn', message,
    error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
  });
}

/** Admit a whole op-ed run before its SSE stream opens. On refusal the response is already written (429
 *  free_pool_exhausted or free_pool_oped_limit, or 503 free_pool_unavailable); the caller must return. */
export async function admitOpEdRun(
  res: http.ServerResponse, requesterId: string, runId: string, estimate: { calls: number; tokens: number },
): Promise<OpEdAdmission> {
  if (!isFreePoolBudgetEnforced()) return { ok: true, reservationId: null };
  const store = getFreePoolBudget();
  if (!store) return refuse(res, 503, { error: 'free_pool_unavailable', message: FREE_POOL_UNAVAILABLE_MESSAGE });
  try {
    const r = await store.reserveForKey({
      key: `${opedRequesterKeyPrefix(requesterId)}${runId}`, calls: estimate.calls, tokens: estimate.tokens,
      maxOpenForPrefix: { prefix: opedRequesterKeyPrefix(requesterId), max: OPED_MAX_OPEN_PER_REQUESTER },
    });
    if (r.ok) return { ok: true, reservationId: r.reservationId };
    if (r.reason === 'daily_cap') {
      log.api.info({ component: 'free-pool-budget', calls: estimate.calls, tokens: estimate.tokens }, 'Op-ed run refused before the stream: admission exceeds the remaining free pool (t/616)');
      return refuse(res, 429, { error: 'free_pool_exhausted', message: FREE_POOL_EXHAUSTED_MESSAGE, resetsAt: r.resetsAt });
    }
    if (r.reason === 'debate_limit') {
      return refuse(res, 429, { error: 'free_pool_oped_limit', message: 'You already have an op-ed using free AI capacity. Wait for it to finish, or add your own key in Settings → API Keys.' });
    }
    log.api.warn({ component: 'free-pool-budget', reason: r.reason }, 'Free-pool budget store unavailable at op-ed admission — refusing (fail closed)');
    return refuse(res, 503, { error: 'free_pool_unavailable', message: FREE_POOL_UNAVAILABLE_MESSAGE });
  } catch (err) {
    log.api.warn({ component: 'free-pool-budget', err }, 'FreePoolBudget.reserveForKey() threw at op-ed admission (t/616, fail closed)');
    recordStoreError('FreePoolBudget.reserveForKey() threw at op-ed admission', err);
    return refuse(res, 503, { error: 'free_pool_unavailable', message: FREE_POOL_UNAVAILABLE_MESSAGE });
  }
}

/** One call's settlement handle: reconcile the admission's draw-down, or commit the fallback reservation. */
export interface OpEdCallSettlement { settle(actualTokens: number): Promise<void> }

const NOOP_SETTLEMENT: OpEdCallSettlement = { settle: async () => {} };

function poolRefusal(reason: 'daily_cap' | 'storage_unavailable'): ActionableError {
  return new ActionableError({
    goal: 'Keep a free-pool op-ed run within the shared daily budget',
    problem: reason === 'daily_cap' ? FREE_POOL_EXHAUSTED_MESSAGE : FREE_POOL_UNAVAILABLE_MESSAGE,
    location: 'opedPoolAdmission.drawDownOpEdCall',
    nextSteps: ['Try again tomorrow, or add your own key in Settings → API Keys.'],
    code: reason === 'daily_cap' ? 'FREE_POOL_EXHAUSTED' : 'FREE_POOL_UNAVAILABLE',
    httpStatus: reason === 'daily_cap' ? 429 : 503,
  });
}

async function fallbackCall(key: string): Promise<OpEdCallSettlement> {
  const r = await reserveFreePoolCallInBand(key);
  if (!r.ok) throw poolRefusal(r.reason);
  const id = r.reservationId;
  return { settle: (actualTokens: number) => commitFreePoolCall(id, { calls: 1, tokens: actualTokens }) };
}

/** Draw one call down against the run's admission, before the call is sent. Throws (ActionableError
 *  FREE_POOL_EXHAUSTED / FREE_POOL_UNAVAILABLE) when the call can't be covered; nothing is sent then. */
export async function drawDownOpEdCall(reservationId: string | null, key: string): Promise<OpEdCallSettlement> {
  if (!reservationId || !isFreePoolBudgetEnforced()) return NOOP_SETTLEMENT;
  const store = getFreePoolBudget();
  if (!store) throw poolRefusal('storage_unavailable');
  let d: Awaited<ReturnType<typeof store.drawDown>>;
  try {
    d = await store.drawDown(reservationId, { calls: 1, tokens: FREE_POOL_CALL_TOKEN_ESTIMATE });
  } catch (err) {
    log.api.warn({ component: 'free-pool-budget', err }, 'FreePoolBudget.drawDown() threw for an op-ed call; falling back to a per-call reserve (t/616)');
    recordStoreError('FreePoolBudget.drawDown() threw for an op-ed call; falling back to a per-call reserve', err);
    return fallbackCall(key);
  }
  if (!d) return fallbackCall(key); // the admission expired: the call must still land in the budget
  const over = d.drawnCalls > d.estimateCalls * DEBATE_OVERDRAFT_MULTIPLIER || d.drawnTokens > d.estimateTokens * DEBATE_OVERDRAFT_MULTIPLIER;
  if (over) return fallbackCall(key);
  return { settle: (actualTokens: number) => reconcileDebateDrawDown(reservationId, actualTokens) };
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4485 (t/4410 items 3b + 6) — wires the persistent daily free-pool budget (t/4484's
// FreePoolBudget interface) into every free-pool generate call: reserve an estimate before the
// provider call, commit the actual usage after, release on an aborted attempt. Never a 500 —
// a `daily_cap` refusal is 429 `free_pool_exhausted` (+ `resetsAt`); `storage_unavailable`
// (including the store not being wired up yet) is 503 `free_pool_unavailable`, distinct because
// an outage is an infra problem, not a routine "today's budget is spent" (TL, t/4485#1).
//
// Gated behind the `free-pool-budget-enforced` flag (default OFF, t/4485#3): decouples this
// module's merge from Server Storage's blob-backed implementation (t/4484) landing. While the
// flag is off, nothing here touches the store at all — free-pool calls behave exactly as before
// this ticket. `resolveStore()` is the one swap-point for wiring in the real
// `getFreePoolBudget()` once t/4484's implementation PR lands (currently always null, since the
// implementation doesn't exist on `main` yet).
//
// Debate admission control (reserving a whole debate's budget up front, held across rounds) is
// NOT in this module — it needs a cross-role decision (round-tripping the reservation id
// through the client) and is tracked separately, t/4485#3 phase 2.

import type http from 'http';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { isFreePoolBudgetEnforced } from '../featureFlags.js';
import type { FreePoolBudget, FreePoolBudgetReserveResult, FreePoolBudgetHeadroom } from '../storage/freePoolBudget.js';

/** Conservative per-call token estimate for the upfront reserve, true-up happens at commit()
 *  with the real usage. Deliberately rough — reserve() only needs to not systematically
 *  under-count, not be exact; commit() is what makes the books accurate. Revisit against real
 *  usage data once the budget is live (t/4410#6 has per-call token distributions). */
export const FREE_POOL_CALL_TOKEN_ESTIMATE = 2000;

export const FREE_POOL_EXHAUSTED_MESSAGE =
  "Today's free AI capacity is used up. Add your own key in Settings → API Keys to keep going.";
export const FREE_POOL_UNAVAILABLE_MESSAGE =
  'Free AI capacity tracking is temporarily unavailable. Try again shortly, or add your own key in Settings → API Keys.';

/** TEMPORARY: always null until t/4484's blob-backed implementation lands on `main` and exports
 *  `getFreePoolBudget()` from storage/freePoolBudget.ts. Swap this body for that import then —
 *  everything else in this module is already written against the real interface and needs no
 *  other change. Harmless while `isFreePoolBudgetEnforced()` is false (the only caller path),
 *  since nothing calls this until the flag is on. */
function resolveStore(): FreePoolBudget | null {
  return null;
}

export type FreePoolGateResult =
  | { ok: true; reservationId: string | null }
  | { ok: false };

function writeRefusal(res: http.ServerResponse, result: { reason: 'daily_cap'; resetsAt: string } | { reason: 'storage_unavailable' }): void {
  if (result.reason === 'daily_cap') {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'free_pool_exhausted', message: FREE_POOL_EXHAUSTED_MESSAGE, resetsAt: result.resetsAt }));
    return;
  }
  // storage_unavailable: alertable separately from the 80%-headroom WARN (TL, t/4485#1) — this
  // means the budget store itself couldn't be reached, not that it's merely full.
  log.api.warn({ component: 'free-pool-budget', reason: 'storage_unavailable' }, 'Free-pool budget store unavailable — refusing (fail closed)');
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'free-pool-budget', level: 'warn',
    message: 'Free-pool budget store unavailable — refusing (fail closed)',
    data: { reason: 'storage_unavailable' },
  });
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'free_pool_unavailable', message: FREE_POOL_UNAVAILABLE_MESSAGE }));
}

/** Reserve estimated usage for ONE free-pool call. `key` is a correlation id for the store's own
 *  logs (t/4484's `FreePoolBudgetRequest.key`) — the caller's debate id, or a short tag for a
 *  non-debate call. Returns `{ ok: true, reservationId: null }` when enforcement is off (the
 *  common case today) — callers treat a null reservationId as "nothing to commit or release."
 *  On refusal, the response is already written (429 or 503); the caller must return. */
export async function reserveFreePoolCall(res: http.ServerResponse, key: string): Promise<FreePoolGateResult> {
  if (!isFreePoolBudgetEnforced()) return { ok: true, reservationId: null };
  const store = resolveStore();
  if (!store) {
    writeRefusal(res, { reason: 'storage_unavailable' });
    return { ok: false };
  }
  let result: FreePoolBudgetReserveResult;
  try {
    result = await store.reserve({ calls: 1, tokens: FREE_POOL_CALL_TOKEN_ESTIMATE, key });
  } catch (err) {
    // Defensive only — the interface documents reserve() as refusing, never throwing (t/4484).
    log.api.warn({ component: 'free-pool-budget', err }, 'FreePoolBudget.reserve() threw unexpectedly — refusing (fail closed)');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-pool-budget', level: 'warn',
      message: 'FreePoolBudget.reserve() threw unexpectedly',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    writeRefusal(res, { reason: 'storage_unavailable' });
    return { ok: false };
  }
  if (!result.ok) {
    writeRefusal(res, result);
    return { ok: false };
  }
  return { ok: true, reservationId: result.reservationId };
}

/** Reconcile a reservation to its actual usage. No-op when `reservationId` is null (enforcement
 *  was off at reserve time, or the store isn't wired) or the underlying call throws — a failure
 *  to commit must never surface as a user-facing error for a call that already succeeded. */
export async function commitFreePoolCall(reservationId: string | null, actual: { calls: number; tokens: number }): Promise<void> {
  if (!reservationId) return;
  const store = resolveStore();
  if (!store) return;
  try {
    await store.commit(reservationId, actual);
  } catch (err) {
    log.api.warn({ component: 'free-pool-budget', reservationId, err }, 'FreePoolBudget.commit() failed — usage may be under-counted');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-pool-budget', level: 'warn',
      message: 'FreePoolBudget.commit() failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Return a reservation's budget unused — the call never happened (e.g. a downstream 422/500
 *  before the provider was reached). Same no-op/never-throws contract as `commitFreePoolCall`. */
export async function releaseFreePoolCall(reservationId: string | null): Promise<void> {
  if (!reservationId) return;
  const store = resolveStore();
  if (!store) return;
  try {
    await store.release(reservationId);
  } catch (err) {
    log.api.warn({ component: 'free-pool-budget', reservationId, err }, 'FreePoolBudget.release() failed — budget may be under-returned');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-pool-budget', level: 'warn',
      message: 'FreePoolBudget.release() failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

export type FreePoolHeadroomSnapshot = FreePoolBudgetHeadroom | 'unknown' | 'not-enforced';

/** t/4485 day boundary: the first UTC-day string a crossing was already WARNed for, so the WARN
 *  fires at most once per day per process (replicas may each log their own — same trade-off as
 *  authPresenceDiag.ts's per-process dedupe, not a shared counter). */
let warnedForDay: string | null = null;

/** Exported for direct unit testing (t/4485): the real store doesn't exist on `main` yet
 *  (resolveStore() always returns null), so this is otherwise unreachable through the public
 *  getFreePoolHeadroomSnapshot() API until t/4484's implementation lands and is wired in. */
export function maybeWarnHeadroom(h: FreePoolBudgetHeadroom): void {
  const callsPct = h.callsCap > 0 ? (h.callsUsed / h.callsCap) * 100 : 0;
  const tokensPct = h.tokensCap && h.tokensCap > 0 ? (h.tokensUsed / h.tokensCap) * 100 : 0;
  if (Math.max(callsPct, tokensPct) < 80) return;
  if (warnedForDay === h.day) return;
  warnedForDay = h.day;
  // Stable literal marker `FREE-POOL-HEADROOM pct=80` — DevOps greps/alerts on this exact text
  // (t/4485 item 4), structured fields carry the real numbers for the log line itself.
  log.api.warn(
    { component: 'free-pool-budget', day: h.day, callsUsed: h.callsUsed, callsCap: h.callsCap, tokensUsed: h.tokensUsed, tokensCap: h.tokensCap, callsPct: Math.round(callsPct), tokensPct: Math.round(tokensPct) },
    'FREE-POOL-HEADROOM pct=80',
  );
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'free-pool-budget', level: 'warn',
    message: 'FREE-POOL-HEADROOM pct=80',
    data: { day: h.day, callsUsed: h.callsUsed, callsCap: h.callsCap, tokensUsed: h.tokensUsed, tokensCap: h.tokensCap },
  });
}

/** Test seam: reset the once-per-day WARN dedupe. */
export function _resetHeadroomWarnForTest(): void { warnedForDay = null; }

/** The headroom gauge for `/api/proxy/tier`. `'not-enforced'` when the flag is off (the common
 *  case today — there's no real budget being tracked, so there's nothing to report); `'unknown'`
 *  when enforcement is on but `headroom()` throws (store unreachable) or isn't wired yet — NEVER
 *  a zeroed/sentinel numeric result, so the gauge can't be mistaken for real headroom (t/4484's
 *  own contract on `headroom()`). Also fires the 80% WARN as a side effect of a real read. */
export async function getFreePoolHeadroomSnapshot(): Promise<FreePoolHeadroomSnapshot> {
  if (!isFreePoolBudgetEnforced()) return 'not-enforced';
  const store = resolveStore();
  if (!store) return 'unknown';
  try {
    const h = await store.headroom();
    maybeWarnHeadroom(h);
    return h;
  } catch (err) {
    log.api.warn({ component: 'free-pool-budget', err }, 'FreePoolBudget.headroom() threw — reporting unknown, not zero');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'free-pool-budget', level: 'warn',
      message: 'FreePoolBudget.headroom() threw',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return 'unknown';
  }
}

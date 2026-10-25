// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * FreePoolBudget — the free Gemini pool's global daily spending cap (t/4410
 * item 3), shared across every user and every replica, persisted across
 * restarts. In t/3230, one anonymous debate drained the pool mid-run with no
 * global accounting to stop it.
 *
 * Interface only (t/4484 AC1) — the blob-backed implementation is a
 * follow-up PR against this contract, so ServerAPI's t/4485 can build
 * against it in parallel.
 *
 * Lifecycle: `reserve()` before a call is made (an estimate), `commit()`
 * once the real usage is known (reconciling the estimate to actual),
 * `release()` if the call never happens (e.g. the debate ends early and
 * returns its unused budget). An uncommitted reservation that is never
 * committed or released expires on its own TTL, so a crashed holder never
 * leaks budget forever (AC4).
 */
export interface FreePoolBudget {
  /** Reserve estimated usage before making a call. Refuses (does not throw)
   *  when the cap would be exceeded or the store can't be reached — the
   *  pool fails CLOSED, never open (t/3230). */
  reserve(req: FreePoolBudgetRequest): Promise<FreePoolBudgetReserveResult>;

  /** Reconcile a reservation's estimate to its actual usage once the call
   *  has completed. A reservation unknown to the store (already expired, or
   *  an invalid id) is a no-op, not an error — the caller has nothing left
   *  to reconcile either way. */
  commit(reservationId: string, actual: FreePoolBudgetUsage): Promise<void>;

  /** Return a reservation's budget unused (the call never happened). Same
   *  no-op-on-unknown-id contract as `commit`. */
  release(reservationId: string): Promise<void>;

  /** Current usage against today's caps. Read-only, no side effects. */
  headroom(): Promise<FreePoolBudgetHeadroom>;
}

export interface FreePoolBudgetRequest {
  /** Estimated call count this reservation will consume (usually 1). */
  calls: number;
  /** Estimated token count (prompt + completion) this reservation will consume. */
  tokens: number;
  /** Caller-supplied correlation id (e.g. a debate id) — logged on refusal
   *  or TTL expiry for diagnosis. Never parsed or validated by the store. */
  key: string;
}

export interface FreePoolBudgetUsage {
  calls: number;
  tokens: number;
}

export type FreePoolBudgetReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: FreePoolBudgetRefusalReason; resetsAt: string };

/**
 * `'daily_cap'` — the request would push usage past today's cap; routine,
 * expected to happen under load, try again after `resetsAt`.
 * `'storage_unavailable'` — the budget store couldn't be reached, so the
 * pool fails closed (t/3230: never fail open) rather than let an
 * unaccountable call through. Distinct from `'daily_cap'` because the two
 * mean different things to a human reading logs or an alert: the pool being
 * out of budget is routine, but not being able to tell whether it is is an
 * infrastructure problem worth paging on.
 */
export type FreePoolBudgetRefusalReason = 'daily_cap' | 'storage_unavailable';

export interface FreePoolBudgetHeadroom {
  callsUsed: number;
  callsCap: number;
  tokensUsed: number;
  /** `null` when no token cap is configured — the call cap binds first. */
  tokensCap: number | null;
  /** The UTC calendar day this headroom covers, `YYYY-MM-DD`. */
  day: string;
}

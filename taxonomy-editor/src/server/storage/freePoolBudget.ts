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
 * committed, released, or renewed expires on its own TTL, so a crashed
 * holder never leaks budget forever (AC4).
 *
 * **Long-running holders (TL p/538#197 point 1):** t/4485 reserves a whole
 * debate's budget up front, and prod debates run p50 3.4 min, p90 187 min,
 * max 516 min (t/4410#6). A TTL short enough to recover a crashed holder
 * quickly would expire a live debate's reservation long before it's done,
 * leaving its remaining calls unaccounted. `renew()` is the heartbeat a
 * long-running holder calls periodically (well under the TTL) to keep its
 * reservation alive — implementations must document their TTL and the
 * renewal cadence that stays safely under it.
 */
export interface FreePoolBudget {
  /** Reserve estimated usage before making a call. Refuses (does not throw)
   *  when the cap would be exceeded or the store can't be reached — the
   *  pool fails CLOSED, never open (t/3230). */
  reserve(req: FreePoolBudgetRequest): Promise<FreePoolBudgetReserveResult>;

  /** Extend a reservation's TTL — the heartbeat a long-running holder (a
   *  multi-hour debate) calls periodically to keep its reservation from
   *  expiring mid-run. Returns `false` if the reservation is already gone
   *  (expired, committed, or released) — the caller must then stop or
   *  re-reserve, since its budget is no longer held. Never throws for a
   *  missing reservation; only a genuine store failure throws. */
  renew(reservationId: string): Promise<boolean>;

  /** Reconcile a reservation's estimate to its actual usage once the call
   *  has completed. A reservation unknown to the store (already expired, or
   *  an invalid id) is a no-op, not an error — the caller has nothing left
   *  to reconcile either way.
   *
   *  **Actual usage is always recorded, even past the cap (TL p/538#197
   *  point 4):** the call already happened, so usage is never under-counted
   *  to make the books look clean — `commit` records the real numbers
   *  unconditionally, and the *next* `reserve` is what refuses once that
   *  pushes the day over its cap. */
  commit(reservationId: string, actual: FreePoolBudgetUsage): Promise<void>;

  /** Return a reservation's budget unused (the call never happened). Same
   *  no-op-on-unknown-id contract as `commit`. */
  release(reservationId: string): Promise<void>;

  /** Current usage against today's caps.
   *
   *  **When the store is unreachable, this throws** (an `ActionableError`),
   *  never a zeroed or sentinel result — t/4485's gauge and its 80% alert
   *  read off this value, and a silent zero would display as "plenty left"
   *  when the truth is "unknown." A caller that wants to degrade gracefully
   *  (e.g. hide the gauge) catches the throw explicitly; nothing here can be
   *  mistaken for real headroom. */
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

/**
 * A discriminated union (TL p/538#197 point 2) — `resetsAt` only has meaning
 * for `'daily_cap'`, so it only exists on that variant. A caller showing
 * "try again at 00:00 UTC" for a `'storage_unavailable'` refusal would be
 * showing a made-up time for an outage that has no reset schedule at all.
 *
 * `'daily_cap'` — the request would push usage past today's cap; routine,
 * expected to happen under load, try again after `resetsAt`.
 * `'storage_unavailable'` — the budget store couldn't be reached, so the
 * pool fails closed (t/3230: never fail open) rather than let an
 * unaccountable call through. Distinct from `'daily_cap'` because the two
 * mean different things to a human reading logs or an alert: the pool being
 * out of budget is routine, but not being able to tell whether it is is an
 * infrastructure problem worth paging on.
 */
export type FreePoolBudgetReserveResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: 'daily_cap'; resetsAt: string }
  | { ok: false; reason: 'storage_unavailable' };

export interface FreePoolBudgetHeadroom {
  callsUsed: number;
  callsCap: number;
  tokensUsed: number;
  /** `null` when no token cap is configured — the call cap binds first. */
  tokensCap: number | null;
  /** The UTC calendar day this headroom covers, `YYYY-MM-DD`. */
  day: string;
}

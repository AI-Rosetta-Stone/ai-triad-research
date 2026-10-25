// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { randomUUID } from 'crypto';
import { BlobServiceClient, type ContainerClient, type BlockBlobClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

/**
 * FreePoolBudget — the free Gemini pool's global daily spending cap (t/4410
 * item 3), shared across every user and every replica, persisted across
 * restarts. In t/3230, one anonymous debate drained the pool mid-run with no
 * global accounting to stop it.
 *
 * `BlobFreePoolBudget` below is the blob-backed implementation (t/4484
 * AC2-6), built against this contract so ServerAPI's t/4485 could build
 * its consumer in parallel against the interface alone.
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
 *
 * **Debate admission control (TL p/538#199, decision on t/4485#5):**
 * `reserveForKey`/`drawDown`/`openCountForPrefix` are a second lifecycle, key
 * rather than id driven, for admitting a whole debate once and tracking its
 * usage across every round without a client-round-tripped reservation id.
 * `reserveForKey`-created reservations follow the same TTL-expiry contract as
 * `reserve()`'s — except that on expiry, the store releases only the *unused
 * remainder* (the gap between the held estimate and whatever `drawDown`
 * actually recorded), WARN-logged, never the already-happened usage itself.
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

  /** Idempotent-per-live-key reservation (t/4485 phase 2 debate admission).
   *  If a live (unexpired, uncommitted) reservation already exists for
   *  `req.key`, returns it unchanged — same `reservationId`, same TTL,
   *  `existing: true`. This call does NOT renew it (call `drawDown` or
   *  `renew` for that) — `reserveForKey` only decides "is there already one
   *  of these", not "keep this one alive". Otherwise reserves the full
   *  estimate as a new reservation (`existing: false`), same fail-closed
   *  refusal contract as `reserve`. **Must be safe across replicas:** two
   *  replicas calling this for the same key at the same moment must agree
   *  on one reservation, never create two. */
  reserveForKey(req: FreePoolBudgetKeyRequest): Promise<FreePoolBudgetReserveForKeyResult>;

  /** Record actual usage against an open reservation and renew its TTL in
   *  the same call — the per-round heartbeat for a running debate.
   *
   *  **Usage accumulates additively across calls** (unlike `commit`, which
   *  replaces the estimate once with a final total) — a real call's usage
   *  is never dropped by a later `drawDown`. **Never refuses, even past the
   *  reservation's original estimate** — overdraft is recorded in full; the
   *  *next admission* (`reserveForKey`) is what refuses once the day is
   *  over its cap, same principle as `commit` recording actual usage past
   *  the cap. A reservation unknown to the store (already expired) is a
   *  no-op, same contract as `commit`. */
  drawDown(reservationId: string, actual: FreePoolBudgetUsage): Promise<void>;

  /** Count currently-open (unexpired, uncommitted) reservations whose key
   *  starts with `prefix` — the per-requester open-debate limit (t/4485#5:
   *  max 2, refuse the 3rd). Callers scope `prefix` to the requester (e.g.
   *  `"debate:<principal-or-ip>:"`), never to a single debate. */
  openCountForPrefix(prefix: string): Promise<number>;
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

export interface FreePoolBudgetKeyRequest {
  /** Caller-scoped correlation key, e.g. `"debate:<principal-or-ip>:<debateId>"`.
   *  Never parsed or validated by the store — the caller owns its structure
   *  and uses it for `openCountForPrefix`'s prefix matching. */
  key: string;
  /** Estimated call count the FULL reservation will consume (the whole
   *  debate's estimate, not one round). */
  calls: number;
  /** Estimated token count the full reservation will consume. */
  tokens: number;
}

/** Same shape as `FreePoolBudgetReserveResult`, plus `existing` on the `ok`
 *  branch — `reserveForKey` is idempotent per live key, so a caller needs to
 *  know whether this is the reservation it just created or one that was
 *  already there (e.g. so it knows whether to run first-round admission
 *  logic again). */
export type FreePoolBudgetReserveForKeyResult =
  | { ok: true; reservationId: string; existing: boolean }
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

// ── Blob-backed implementation (t/4484 AC2-6) ───────────────────────────────

/** One reservation's bookkeeping inside a day's budget document. */
interface ReservationRecord {
  calls: number;
  tokens: number;
  key: string;
  createdAt: string;
  /** Absent once `committed` — a committed reservation is final accounting
   *  for the day and never expires. */
  expiresAt: string | null;
  committed: boolean;
}

/** One UTC day's budget ledger — the entire contents of one blob. */
interface BudgetDoc {
  day: string;
  callsCap: number;
  tokensCap: number | null;
  reservations: Record<string, ReservationRecord>;
}

export interface BlobFreePoolBudgetOptions {
  /** e.g. https://<account>.blob.core.windows.net — from AZURE_STORAGE_ACCOUNT_URL. */
  accountUrl: string;
  /** Default `'user-content'` — reuses the existing container (no new
   *  resource, no bicep change) under a path no user content ever uses. */
  container?: string;
  /** Default `'_system/free-pool-budget'`. */
  blobPrefix?: string;
  /** The day's call cap. TL p/538#195: starts at 1,500/day — the caller
   *  resolves this from config/env; this class takes a plain number. */
  callsCap: number;
  /** Unset (`null`/`undefined`) when the call cap binds first. */
  tokensCap?: number | null;
  /** How long an uncommitted reservation survives without a `renew()`.
   *  Default 2 minutes. This is a field in a document we control, not an
   *  Azure Blob lease, so it is NOT bound by Blob's 15-60s lease-duration
   *  limit — callers of long operations (a multi-hour debate) must call
   *  `renew()` well under this, not at the lease-duration ceiling. */
  reservationTtlMs?: number;
  /** Bounded retries on an ETag CAS conflict (412) before giving up as
   *  `'storage_unavailable'`. Default 5. */
  maxCasRetries?: number;
  /** Test seam: inject a pre-built client (e.g. an Azurite shared-key client). */
  serviceClient?: BlobServiceClient;
}

const DEFAULT_CONTAINER = 'user-content';
const DEFAULT_BLOB_PREFIX = '_system/free-pool-budget';
const DEFAULT_RESERVATION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_MAX_CAS_RETRIES = 5;

function isNotFound(err: unknown): boolean {
  return err instanceof RestError ? (err.statusCode === 404 || err.code === 'BlobNotFound') : false;
}

function isPreconditionFailed(err: unknown): boolean {
  return err instanceof RestError && err.statusCode === 412;
}

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function nextUtcMidnightIso(now: Date = new Date()): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

function freshDoc(day: string, callsCap: number, tokensCap: number | null): BudgetDoc {
  return { day, callsCap, tokensCap, reservations: {} };
}

function wrapBudgetError(err: unknown, op: string, blobName: string): ActionableError {
  return new ActionableError({
    goal: `Free pool budget ${op}`,
    problem: `Budget operation "${op}" failed for "${blobName}": ${(err as Error)?.message ?? String(err)}`,
    location: `BlobFreePoolBudget.${op}`,
    nextSteps: [
      'Verify the storage account is reachable and the managed identity has data-plane access',
      'Check Azure Blob service health and retry',
    ],
    innerError: err,
  });
}

/**
 * `BlobFreePoolBudget` — the blob-backed `FreePoolBudget`. One JSON blob per
 * UTC day (`{blobPrefix}/{day}.json`), ETag-conditional read-modify-write for
 * cross-replica atomicity (AC2) — optimistic CAS, not `BlobLease`'s exclusive
 * lease: each call here is one atomic RMW, not a held critical section, so
 * concurrent reservations for *different* amounts don't serialize against
 * each other the way an exclusive lease would.
 *
 * Day-keying makes the 00:00 UTC rollover free (AC6) — a new day is simply a
 * blob that doesn't exist yet, seeded on first use via `ifNoneMatch: '*'`.
 *
 * `reservationId` is `"{day}:{uuid}"` — the interface treats it as opaque, so
 * `renew`/`commit`/`release` can find the right day's blob without a
 * cross-day search or a second index.
 */
export class BlobFreePoolBudget implements FreePoolBudget {
  private readonly containerClient: ContainerClient;
  private readonly blobPrefix: string;
  private readonly callsCap: number;
  private readonly tokensCap: number | null;
  private readonly reservationTtlMs: number;
  private readonly maxCasRetries: number;

  constructor(opts: BlobFreePoolBudgetOptions) {
    const service = opts.serviceClient
      ?? new BlobServiceClient(opts.accountUrl, new DefaultAzureCredential());
    this.containerClient = service.getContainerClient(opts.container ?? DEFAULT_CONTAINER);
    this.blobPrefix = opts.blobPrefix ?? DEFAULT_BLOB_PREFIX;
    this.callsCap = opts.callsCap;
    this.tokensCap = opts.tokensCap ?? null;
    this.reservationTtlMs = opts.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.maxCasRetries = opts.maxCasRetries ?? DEFAULT_MAX_CAS_RETRIES;
  }

  private blobClientFor(day: string): BlockBlobClient {
    return this.containerClient.getBlockBlobClient(`${this.blobPrefix}/${day}.json`);
  }

  private dayOf(reservationId: string): string {
    const i = reservationId.indexOf(':');
    return i < 0 ? reservationId : reservationId.slice(0, i);
  }

  /** Download + parse a day's doc and its ETag. `null` if the blob doesn't
   *  exist yet (a fresh day). Throws `ActionableError` on a genuine failure. */
  private async download(day: string): Promise<{ doc: BudgetDoc; etag: string } | null> {
    const client = this.blobClientFor(day);
    try {
      const resp = await client.download();
      const chunks: Buffer[] = [];
      for await (const chunk of resp.readableStreamBody ?? []) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string));
      }
      const doc = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as BudgetDoc;
      if (!resp.etag) {
        throw wrapBudgetError(new Error('download succeeded but returned no ETag'), 'download', client.name);
      }
      return { doc, etag: resp.etag };
    } catch (err) {
      if (isNotFound(err)) return null;
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'error',
        message: `download failed: ${client.name}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapBudgetError(err, 'download', client.name);
    }
  }

  /** Sweep expired, uncommitted reservations out of `doc` in place. Returns
   *  the number swept (for WARN logging by the caller). */
  private sweepExpired(doc: BudgetDoc, now: Date): string[] {
    const expired: string[] = [];
    const nowMs = now.getTime();
    for (const [id, r] of Object.entries(doc.reservations)) {
      if (!r.committed && r.expiresAt !== null && new Date(r.expiresAt).getTime() <= nowMs) {
        expired.push(id);
      }
    }
    for (const id of expired) delete doc.reservations[id];
    return expired;
  }

  private usage(doc: BudgetDoc): { calls: number; tokens: number } {
    let calls = 0, tokens = 0;
    for (const r of Object.values(doc.reservations)) { calls += r.calls; tokens += r.tokens; }
    return { calls, tokens };
  }

  /**
   * Read-modify-write a day's doc with a bounded CAS retry on 412. `mutate`
   * returns the result to hand back to the caller, or `undefined` to signal
   * "don't write, nothing changed" (an RMW the caller decided to skip after
   * seeing the current state, e.g. `commit`/`release` on an unknown id).
   * Throws on a genuine failure or CAS-retry exhaustion — callers translate
   * that into their own fail-closed contract (reserve/renew vs. commit/
   * release vs. headroom all differ, per the interface doc comments).
   */
  private async rmw<T>(day: string, mutate: (doc: BudgetDoc) => { result: T } | undefined): Promise<T> {
    const client = this.blobClientFor(day);
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      const current = await this.download(day);
      const doc = current?.doc ?? freshDoc(day, this.callsCap, this.tokensCap);
      const now = new Date();
      const expired = this.sweepExpired(doc, now);
      for (const id of expired) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'free-pool-budget', level: 'warn',
          message: `Reservation expired without commit/release: ${id}`,
          data: { reservationId: id },
        });
      }
      const outcome = mutate(doc);
      if (outcome === undefined) return undefined as unknown as T; // nothing to write
      const body = JSON.stringify(doc);
      try {
        await client.upload(body, Buffer.byteLength(body), {
          conditions: current ? { ifMatch: current.etag } : { ifNoneMatch: '*' },
        });
        return outcome.result;
      } catch (err) {
        if (isPreconditionFailed(err)) { lastErr = err; continue; } // lost the race — re-download and retry
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'free-pool-budget', level: 'error',
          message: `upload failed: ${client.name}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw wrapBudgetError(err, 'upload', client.name);
      }
    }
    throw wrapBudgetError(lastErr ?? new Error('CAS retries exhausted'), 'rmw', client.name);
  }

  async reserve(req: FreePoolBudgetRequest): Promise<FreePoolBudgetReserveResult> {
    const day = todayUtc();
    try {
      return await this.rmw<FreePoolBudgetReserveResult>(day, (doc) => {
        const used = this.usage(doc);
        const overCalls = used.calls + req.calls > doc.callsCap;
        const overTokens = doc.tokensCap !== null && used.tokens + req.tokens > doc.tokensCap;
        if (overCalls || overTokens) {
          return { result: { ok: false, reason: 'daily_cap', resetsAt: nextUtcMidnightIso() } };
        }
        const reservationId = `${day}:${randomUUID()}`;
        const now = new Date();
        doc.reservations[reservationId] = {
          calls: req.calls, tokens: req.tokens, key: req.key,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.reservationTtlMs).toISOString(),
          committed: false,
        };
        return { result: { ok: true, reservationId } };
      });
    } catch (err) {
      // reserve() never throws (interface contract) — a genuine store
      // failure or CAS-retry exhaustion both fail CLOSED (t/3230).
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'error',
        message: 'reserve failed; refusing (fail closed)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return { ok: false, reason: 'storage_unavailable' };
    }
  }

  async renew(reservationId: string): Promise<boolean> {
    const day = this.dayOf(reservationId);
    try {
      return await this.rmw<boolean>(day, (doc) => {
        const r = doc.reservations[reservationId];
        if (!r || r.committed) return { result: false };
        r.expiresAt = new Date(Date.now() + this.reservationTtlMs).toISOString();
        return { result: true };
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'error',
        message: `renew failed: ${reservationId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err; // renew() throws on a genuine store failure (interface contract)
    }
  }

  async commit(reservationId: string, actual: FreePoolBudgetUsage): Promise<void> {
    const day = this.dayOf(reservationId);
    try {
      await this.rmw<void>(day, (doc) => {
        const r = doc.reservations[reservationId];
        if (!r || r.committed) return undefined; // unknown/already-resolved id — no-op
        r.calls = actual.calls; r.tokens = actual.tokens; r.committed = true; r.expiresAt = null;
        return { result: undefined };
      });
    } catch (err) {
      // commit() never throws — the call already happened; a storage
      // failure here can't undo it, so it's best-effort, WARN-logged.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'warn',
        message: `commit failed — usage not recorded for this reservation: ${reservationId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  }

  async release(reservationId: string): Promise<void> {
    const day = this.dayOf(reservationId);
    try {
      await this.rmw<void>(day, (doc) => {
        const r = doc.reservations[reservationId];
        if (!r || r.committed) return undefined; // unknown/already-resolved id — no-op
        delete doc.reservations[reservationId];
        return { result: undefined };
      });
    } catch (err) {
      // Same best-effort contract as commit(): never throws.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'warn',
        message: `release failed — reservation left staged, will expire on its own TTL: ${reservationId}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  }

  async headroom(): Promise<FreePoolBudgetHeadroom> {
    const day = todayUtc();
    try {
      const current = await this.download(day);
      const doc = current?.doc ?? freshDoc(day, this.callsCap, this.tokensCap);
      this.sweepExpired(doc, new Date());
      const used = this.usage(doc);
      return { callsUsed: used.calls, callsCap: doc.callsCap, tokensUsed: used.tokens, tokensCap: doc.tokensCap, day };
    } catch (err) {
      // headroom() throws on a genuine failure (interface contract) —
      // never a zeroed result that could misread as "plenty left".
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'free-pool-budget', level: 'error',
        message: 'headroom failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw err instanceof ActionableError ? err : wrapBudgetError(err, 'headroom', day);
    }
  }

  // t/4491 AC1: types land first, same split as t/4484's #3798/#3808. These
  // three stubs exist only so BlobFreePoolBudget keeps satisfying the
  // interface — ServerAPI's t/4485 phase 2 can compile and unit-test its own
  // consumer (DI'd against the interface, per p/541#132) without waiting on
  // the real implementation. A real caller hitting one of these before the
  // follow-up lands gets a clear, loud failure, never a silent no-op.
  async reserveForKey(_req: FreePoolBudgetKeyRequest): Promise<FreePoolBudgetReserveForKeyResult> {
    throw new ActionableError({
      goal: 'reserveForKey', problem: 'reserveForKey is not yet implemented (t/4491 AC1 is types-only)',
      location: 'BlobFreePoolBudget.reserveForKey', nextSteps: ['Land the t/4491 implementation PR before calling this in production'],
    });
  }

  async drawDown(_reservationId: string, _actual: FreePoolBudgetUsage): Promise<void> {
    throw new ActionableError({
      goal: 'drawDown', problem: 'drawDown is not yet implemented (t/4491 AC1 is types-only)',
      location: 'BlobFreePoolBudget.drawDown', nextSteps: ['Land the t/4491 implementation PR before calling this in production'],
    });
  }

  async openCountForPrefix(_prefix: string): Promise<number> {
    throw new ActionableError({
      goal: 'openCountForPrefix', problem: 'openCountForPrefix is not yet implemented (t/4491 AC1 is types-only)',
      location: 'BlobFreePoolBudget.openCountForPrefix', nextSteps: ['Land the t/4491 implementation PR before calling this in production'],
    });
  }
}

let globalFreePoolBudget: FreePoolBudget | null = null;

export function initFreePoolBudget(opts: BlobFreePoolBudgetOptions): FreePoolBudget {
  globalFreePoolBudget = new BlobFreePoolBudget(opts);
  return globalFreePoolBudget;
}

export function getFreePoolBudget(): FreePoolBudget | null {
  return globalFreePoolBudget;
}

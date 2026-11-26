// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/731: the per-user DAILY token allowance, held in shared storage so it survives a restart and is one
 * count across replicas (TL rulings t/721#6, t/731#5, t/731#7; design t/731#6).
 *
 * Reserve, then settle:
 *   - `reserve` runs BEFORE the provider call. One conditional read-modify-write on the caller's document
 *     adds a HOLD for the call's worst case and refuses if the day's total plus every live hold plus this
 *     one would pass the allowance. Holds are admitted atomically by the store's compare-and-swap, so
 *     calls in flight on several replicas can't all pass the same check.
 *   - `settle` runs AFTER the call. A second conditional write removes the hold and adds what the
 *     provider really used. A failed or aborted call settles with zeros, which releases the hold.
 *
 * A hold is the call's own worst case: prompt bytes / MIN_BYTES_PER_TOKEN, plus the output cap sent to
 * the provider. A call whose worst case is above the per-call ceiling is refused before any provider
 * call, so one call can't cost more than its hold.
 *
 * What the allowance can still miss (the bound, t/731#6):
 *   - a process that dies mid-call: its holds expire after HOLD_TTL_MS and are released, so the real
 *     usage of those in-flight calls (each at most the ceiling) is not counted;
 *   - a call that runs longer than HOLD_TTL_MS: its hold is released while it runs; its usage is still
 *     added when it settles;
 *   - a settle whose write fails: the amount stays pending in this process and is applied with the next
 *     write to that document; it is lost only if the process dies first.
 *
 * Privacy: the limit key can hold an email address or an IP. Only its SHA-256 goes into the document
 * name, and the document never holds the key. Log lines carry the first 12 hex of the hash, never the key.
 *
 * Storage failure: a pool-funded call (our keys pay) is refused: fail closed, with a WARN. A call on the
 * caller's own key is counted in this process's memory instead, with a WARN.
 */

import crypto from 'crypto';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

/** How long a hold lives without being settled. The free pool's reservation uses the same value. */
export const HOLD_TTL_MS = 2 * 60 * 1000;

/**
 * PROVISIONAL per-call ceiling, in tokens (TL t/731#7: not final until t/746 measures real chat and debate
 * prompts). 128,000 is the op-ed admission's bound (120,000 prompt + 8,000 output, t/721#2).
 */
export const PROVISIONAL_PER_CALL_CEILING_TOKENS = 128_000;

/**
 * The fewest bytes one token can stand for. 1 makes prompt bytes a true upper bound on prompt tokens
 * (a token is at least one byte), the rule the op-ed admission uses. Raising it makes holds smaller and
 * turns the upper bound into an estimate.
 */
export const MIN_BYTES_PER_TOKEN = 1;

/** Daily-allowance thresholds (percent) reported once per key per day, across replicas. */
export const TOKEN_MILESTONES = [50, 80, 95] as const;

const DOC_PREFIX = '_system/daily-tokens';

/** One caller's document for one UTC day. */
export interface DailyTokenDoc {
  day: string;
  inputTokens: number;
  outputTokens: number;
  total: number;
  /** Calls admitted and not yet settled. */
  holds: Record<string, { tokens: number; expiresAt: string }>;
  milestones: number[];
}

/**
 * The storage this module needs: a JSON document read, and a compare-and-swap read-modify-write
 * (ServerStorage, t/744). `read` returns null only when the document doesn't exist; both throw on a real
 * failure, and `rmw` throws when its retries are exhausted.
 */
export interface TokenDocStore {
  read<T>(name: string): Promise<{ doc: T; etag: string } | null>;
  rmw<T, R>(name: string, fresh: () => T, mutate: (doc: T) => { result: R; skipWrite?: boolean }): Promise<R>;
}

export interface CallShape {
  /** UTF-8 bytes of everything sent to the model as input. */
  promptBytes: number;
  /** The output cap actually sent to the provider, in tokens. */
  outputCapTokens: number;
  /** True when our keys pay for the call (free pool or platform tier). False for the caller's own key. */
  poolFunded: boolean;
}

/** What `reserve` hands back for `settle`. Opaque to callers. */
export interface TokenHold {
  id: string;
  docName: string;
  keyTag: string;
  reserved: number;
  limit: number;
  /** True when the store was unavailable and this hold is counted in process memory (own-key callers only). */
  inMemory: boolean;
}

export type ReserveResult =
  | { ok: true; hold: TokenHold; used: number; limit: number }
  | { ok: false; reason: 'daily_limit'; used: number; limit: number; reserved: number }
  | { ok: false; reason: 'per_call_ceiling'; reserved: number; ceiling: number }
  | { ok: false; reason: 'unavailable' };

export interface DailyTokenBudgetOptions {
  now?: () => Date;
  holdTtlMs?: number;
  perCallCeilingTokens?: number;
  minBytesPerToken?: number;
}

interface PendingSettle { holdId: string; inputTokens: number; outputTokens: number }

function dayOf(now: Date): string { return now.toISOString().slice(0, 10); }

function freshDoc(day: string): DailyTokenDoc {
  return { day, inputTokens: 0, outputTokens: 0, total: 0, holds: {}, milestones: [] };
}

function keyHash(limitKey: string): string {
  return crypto.createHash('sha256').update(limitKey, 'utf8').digest('hex');
}

/** The document name for a limit key on a day. Holds no part of the key. */
export function dailyTokenDocName(limitKey: string, day: string): string {
  return `${DOC_PREFIX}/${day}/${keyHash(limitKey)}.json`;
}

function whole(n: number): number { return Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0; }

/**
 * A single-process TokenDocStore with real compare-and-swap semantics: a write is refused when the
 * document changed since it was read, and `rmw` retries a bounded number of times. Used when no shared
 * store is configured (desktop, dev) and as the in-memory fallback for own-key callers. Tests share one
 * instance between several DailyTokenBudget objects to stand in for replicas.
 */
export class InMemoryTokenDocStore implements TokenDocStore {
  private readonly docs = new Map<string, { body: string; etag: number }>();
  constructor(private readonly maxCasRetries = 8) {}

  async read<T>(name: string): Promise<{ doc: T; etag: string } | null> {
    const cur = this.docs.get(name);
    return cur ? { doc: JSON.parse(cur.body) as T, etag: String(cur.etag) } : null;
  }

  async rmw<T, R>(name: string, fresh: () => T, mutate: (doc: T) => { result: R; skipWrite?: boolean }): Promise<R> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      const cur = this.docs.get(name);
      const seen = cur?.etag ?? 0;
      const doc = cur ? JSON.parse(cur.body) as T : fresh();
      await Promise.resolve(); // a read and its write are separate steps, as they are against a real store
      const outcome = mutate(doc);
      if (outcome.skipWrite) return outcome.result;
      if ((this.docs.get(name)?.etag ?? 0) !== seen) continue; // lost the race: read again
      this.docs.set(name, { body: JSON.stringify(doc), etag: seen + 1 });
      return outcome.result;
    }
    throw new ActionableError({
      goal: 'Update a daily token document',
      problem: `Compare-and-swap retries were exhausted for "${name}"`,
      location: 'dailyTokenBudget.InMemoryTokenDocStore.rmw',
      nextSteps: ['Retry the request', 'Check for a caller writing the same document in a tight loop'],
    });
  }
}

export class DailyTokenBudget {
  private readonly now: () => Date;
  private readonly holdTtlMs: number;
  private readonly ceiling: number;
  private readonly minBytesPerToken: number;
  /** Own-key callers are counted here when the shared store fails. Never used for pool-funded calls. */
  private readonly fallback = new InMemoryTokenDocStore();
  /** Settles whose write failed, by document name; applied with the next write to that document. */
  private readonly pending = new Map<string, PendingSettle[]>();

  constructor(private readonly store: TokenDocStore, opts: DailyTokenBudgetOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.holdTtlMs = opts.holdTtlMs ?? HOLD_TTL_MS;
    this.ceiling = opts.perCallCeilingTokens ?? PROVISIONAL_PER_CALL_CEILING_TOKENS;
    this.minBytesPerToken = opts.minBytesPerToken ?? MIN_BYTES_PER_TOKEN;
    if (!(this.ceiling > 0) || !(this.minBytesPerToken > 0) || !(this.holdTtlMs > 0)) {
      throw new ActionableError({
        goal: 'Create the daily token budget',
        problem: 'perCallCeilingTokens, minBytesPerToken and holdTtlMs must all be positive',
        location: 'dailyTokenBudget.DailyTokenBudget.constructor',
        nextSteps: ['Fix the options passed to DailyTokenBudget'],
      });
    }
  }

  /** The worst case of a call, in tokens: what its hold will be. */
  worstCaseTokens(call: Pick<CallShape, 'promptBytes' | 'outputCapTokens'>): number {
    return whole(call.promptBytes / this.minBytesPerToken) + whole(call.outputCapTokens);
  }

  /**
   * Drop expired holds from `doc`, in place. With `applied` (shared-store documents only), also apply this
   * process's pending settles and list them there; pending settles never go into the in-memory fallback.
   */
  private tidy(doc: DailyTokenDoc, docName: string, keyTag: string, applied: PendingSettle[] | null): void {
    const nowMs = this.now().getTime();
    for (const [id, h] of Object.entries(doc.holds)) {
      if (new Date(h.expiresAt).getTime() > nowMs) continue;
      delete doc.holds[id];
      log.server.warn({ component: 'daily-token-budget', keyTag, tokens: h.tokens },
        'Daily token hold expired without a settle: released (the call was abandoned, its process died, or it ran past the hold TTL)');
    }
    if (applied === null) return;
    for (const p of this.pending.get(docName) ?? []) {
      delete doc.holds[p.holdId];
      this.add(doc, p.inputTokens, p.outputTokens);
      applied.push(p);
    }
  }

  private add(doc: DailyTokenDoc, inputTokens: number, outputTokens: number): void {
    doc.inputTokens += inputTokens;
    doc.outputTokens += outputTokens;
    doc.total += inputTokens + outputTokens;
  }

  private clearApplied(docName: string, applied: PendingSettle[]): void {
    if (applied.length === 0) return;
    const left = (this.pending.get(docName) ?? []).filter((p) => !applied.includes(p));
    if (left.length) this.pending.set(docName, left); else this.pending.delete(docName);
  }

  private used(doc: DailyTokenDoc): number {
    let held = 0;
    for (const h of Object.values(doc.holds)) held += h.tokens;
    return doc.total + held;
  }

  /**
   * Admit one call against `limit` (the caller's tokens-per-day), or refuse it. Call before the provider.
   * Every `ok: true` result must be passed to `settle`, on every path out of the handler.
   */
  async reserve(limitKey: string, limit: number, call: CallShape): Promise<ReserveResult> {
    const reserved = this.worstCaseTokens(call);
    if (reserved > this.ceiling) return { ok: false, reason: 'per_call_ceiling', reserved, ceiling: this.ceiling };

    const now = this.now();
    const docName = dailyTokenDocName(limitKey, dayOf(now));
    const keyTag = keyHash(limitKey).slice(0, 12);
    const id = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + this.holdTtlMs).toISOString();

    const attempt = async (store: TokenDocStore, inMemory: boolean): Promise<ReserveResult> => {
      const applied: PendingSettle[] = [];
      const result = await store.rmw<DailyTokenDoc, ReserveResult>(docName, () => freshDoc(dayOf(now)), (doc) => {
        applied.length = 0;
        this.tidy(doc, docName, keyTag, inMemory ? null : applied);
        const used = this.used(doc);
        if (used + reserved > limit) {
          // Still write when pending settles were applied, so they are not lost with this refusal.
          return { result: { ok: false, reason: 'daily_limit', used, limit, reserved }, skipWrite: applied.length === 0 };
        }
        doc.holds[id] = { tokens: reserved, expiresAt };
        return { result: { ok: true, hold: { id, docName, keyTag, reserved, limit, inMemory }, used: used + reserved, limit } };
      });
      if (!inMemory) this.clearApplied(docName, applied);
      return result;
    };

    try {
      return await attempt(this.store, false);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'daily-token-budget', level: 'error',
        message: 'reserve failed: the daily token store is unavailable',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if (call.poolFunded) {
        log.server.warn({ component: 'daily-token-budget', keyTag, err: String(err) },
          'Daily token store unavailable: refusing a pool-funded call (fail closed, t/731)');
        return { ok: false, reason: 'unavailable' };
      }
      log.server.warn({ component: 'daily-token-budget', keyTag, err: String(err) },
        'Daily token store unavailable: counting an own-key call in this process only (fallback, t/731)');
      return attempt(this.fallback, true);
    }
  }

  /**
   * Close a hold with what the call really used. Pass zeros for a call that failed or was aborted.
   * Never throws. Returns the highest daily milestone (50/80/95) this settle crossed, or null.
   */
  async settle(hold: TokenHold, actual: { inputTokens: number; outputTokens: number }): Promise<number | null> {
    const inputTokens = whole(actual.inputTokens);
    const outputTokens = whole(actual.outputTokens);
    if (inputTokens + outputTokens > hold.reserved) {
      log.server.warn({ component: 'daily-token-budget', keyTag: hold.keyTag, reserved: hold.reserved, actual: inputTokens + outputTokens },
        'A call used more tokens than its hold: the hold was not an upper bound for this call (the actual amount is recorded)');
    }
    const store = hold.inMemory ? this.fallback : this.store;
    const mine: PendingSettle = { holdId: hold.id, inputTokens, outputTokens };
    try {
      const applied: PendingSettle[] = [];
      const crossed = await store.rmw<DailyTokenDoc, number | null>(hold.docName, () => freshDoc(hold.docName.split('/')[2]), (doc) => {
        applied.length = 0;
        this.tidy(doc, hold.docName, hold.keyTag, hold.inMemory ? null : applied);
        delete doc.holds[hold.id]; // absent when it already expired: the usage is still real and still added
        this.add(doc, inputTokens, outputTokens);
        return { result: this.crossMilestones(doc, hold.limit) };
      });
      if (!hold.inMemory) this.clearApplied(hold.docName, applied);
      if (crossed !== null) this.reportMilestone(hold, crossed);
      return crossed;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'daily-token-budget', level: 'error',
        message: 'settle failed: the usage is kept pending in this process',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.server.warn({ component: 'daily-token-budget', keyTag: hold.keyTag, tokens: inputTokens + outputTokens, err: String(err) },
        'Daily token settle failed: the usage stays pending in this process and is applied with the next write (fallback, t/731)');
      this.pending.set(hold.docName, [...(this.pending.get(hold.docName) ?? []), mine]);
      return null;
    }
  }

  /** Mark and return the highest milestone newly crossed in `doc`, or null. */
  private crossMilestones(doc: DailyTokenDoc, limit: number): number | null {
    if (!(limit > 0)) return null;
    const pct = (doc.total / limit) * 100;
    let crossed: number | null = null;
    for (const m of TOKEN_MILESTONES) {
      if (pct >= m && !doc.milestones.includes(m)) { doc.milestones.push(m); crossed = m; }
    }
    return crossed;
  }

  private reportMilestone(hold: TokenHold, milestone: number): void {
    log.server.warn({ component: 'daily-token-budget', type: 'token_milestone', keyTag: hold.keyTag, milestone: `${milestone}%`, limit: hold.limit },
      `Daily token usage at ${milestone}%`);
    if (milestone >= 80) {
      getGlobalRecorder()?.record({
        type: 'ai.error', component: 'daily-token-budget', level: 'warn',
        message: `Daily token usage at ${milestone}%`,
        data: { type: 'token_milestone', keyTag: hold.keyTag, milestone: `${milestone}%`, limit: hold.limit },
      });
    }
  }

  /**
   * Today's count for a key: settled tokens plus live holds, and this process's pending settles.
   * Throws when the store can't be read; the caller decides what to show.
   */
  async usage(limitKey: string): Promise<{ tokensToday: number; heldTokens: number }> {
    const now = this.now();
    const docName = dailyTokenDocName(limitKey, dayOf(now));
    const cur = await this.store.read<DailyTokenDoc>(docName);
    const nowMs = now.getTime();
    let held = 0;
    for (const h of Object.values(cur?.doc.holds ?? {})) if (new Date(h.expiresAt).getTime() > nowMs) held += h.tokens;
    let pending = 0;
    for (const p of this.pending.get(docName) ?? []) pending += p.inputTokens + p.outputTokens;
    return { tokensToday: (cur?.doc.total ?? 0) + pending, heldTokens: held };
  }
}

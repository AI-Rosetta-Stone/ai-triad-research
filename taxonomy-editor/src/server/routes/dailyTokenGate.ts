// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/746 part 2 (spend control, T2): the call-site side of the durable per-caller daily token allowance
// (security/dailyTokenBudget.ts, t/731). A route RESERVES the call's worst case before the provider call and
// SETTLES with the provider's real usage on every way out of the handler (success with the reported usage; a
// failure, abort or refusal with zeros, which releases the hold). One process-wide budget over one document
// store; the limit key is the SAME one the rate limiter uses, and it is never logged (only the returned keyTag).

import type { ServerResponse } from 'http';
import { DailyTokenBudget, type CallShape, type ReserveResult, type TokenHold, type TokenDocStore } from '../security/dailyTokenBudget.js';
import { createJsonDocStore } from '../storage/jsonDocStore.js';
import { getConfig } from '../runtimeConfig.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { nextDailyResetUtc } from '../security/rateLimiter.js';

const DOC_PREFIX = '_system/daily-tokens';

type StoreKind = 'azure-blob' | 'memory';
let budget: DailyTokenBudget | null = null;
let storeKind: StoreKind | 'unused' = 'unused';

/** A hosted profile on the in-memory store is not durable: log an ERROR (and a recorder entry) and never call it durable. */
function noteStoreKind(kind: StoreKind): void {
  if (kind !== 'memory') return;
  const hosted = process.env.AUTH_DISABLED !== '1';
  if (hosted) {
    log.server.error({ component: 'daily-token-gate', kind }, 'The daily token allowance is on the IN-MEMORY store on a hosted profile: it resets on every restart and is per replica. Set AZURE_STORAGE_ACCOUNT_URL (t/746)');
    getGlobalRecorder()?.record({ type: 'system.error', component: 'daily-token-gate', level: 'error', message: 'Daily token allowance is in memory on a hosted profile (not durable)', data: { kind } });
  } else {
    log.server.warn({ component: 'daily-token-gate', kind }, 'The daily token allowance is in memory (local run): per process, lost on restart');
  }
}

/** The process-wide budget. Built on first use so a test or a boot that never reserves builds nothing. */
export function getDailyTokenBudget(): DailyTokenBudget {
  if (!budget) {
    const { store, kind } = createJsonDocStore({ prefix: DOC_PREFIX });
    storeKind = kind;
    noteStoreKind(kind);
    budget = new DailyTokenBudget(store as unknown as TokenDocStore, { perCallCeilingTokens: getConfig().sessions.dailyTokenPerCallCeilingTokens });
  }
  return budget;
}

/** For /health: which store the allowance is on. 'unused' until the first reserve. `durable` is true only on Blob. */
export function dailyTokenBudgetHealth(): { store: StoreKind | 'unused'; durable: boolean } {
  return { store: storeKind, durable: storeKind === 'azure-blob' };
}

/** Test seam: replace (or clear) the process-wide budget. */
export function _setDailyTokenBudgetForTest(b: DailyTokenBudget | null): void { budget = b; storeKind = b ? 'memory' : 'unused'; }

/** The output cap to hold for a call: the cap actually sent, or for a call that sends none the configured assumed provider maximum. */
export function assumedOutputCapTokens(requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) return Math.floor(requested);
  return getConfig().sessions.dailyTokenDefaultOutputCapTokens;
}

export function reserveDailyTokens(limitKey: string, limit: number, call: CallShape): Promise<ReserveResult> {
  return getDailyTokenBudget().reserve(limitKey, limit, call);
}

/** Writes the refusal for a failed reservation (429 daily limit, 413 per-call ceiling, 503 store unavailable on a
 *  pool-funded call). True once written. Carries no other caller's numbers and never the limit key. */
export function refuseDailyReserve(res: ServerResponse, r: Extract<ReserveResult, { ok: false }>): true {
  if (r.reason === 'daily_limit') {
    const retryAfter = Math.max(1, Math.ceil((Date.parse(nextDailyResetUtc()) - Date.now()) / 1000));
    log.server.warn({ component: 'daily-token-gate', reason: 'daily_limit', limit: r.limit }, 'AI request refused: daily token allowance reached');
    getGlobalRecorder()?.record({ type: 'ai.error', component: 'rate-limiter', level: 'warn', message: 'Daily token limit reached', data: { type: 'tokens_per_day', rate_limit_source: 'daily_token', limit: r.limit } });
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: 'Daily token limit exceeded', limitType: 'tokens_per_day', rate_limit_source: 'daily_token', rate_limit_type: 'api_call', limit: r.limit, current: r.used, retryAfterMs: retryAfter * 1000 }));
    return true;
  }
  if (r.reason === 'per_call_ceiling') {
    log.server.warn({ component: 'daily-token-gate', reason: 'per_call_ceiling', reserved: r.reserved, ceiling: r.ceiling }, 'AI request refused: its worst case is over the per-call ceiling');
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'This request is too large for the daily token allowance', code: 'per_call_ceiling', limitType: 'per_call_ceiling', ceiling: r.ceiling }));
    return true;
  }
  res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
  res.end(JSON.stringify({ error: 'The usage allowance is temporarily unavailable; retry shortly.', retryable: true, retryAfterMs: 5000 }));
  return true;
}

/** Settles a hold. Never throws: a failed settle is logged by the budget and applied with the next write. */
export async function settleDailyTokens(hold: TokenHold | null, usage: { inputTokens: number; outputTokens: number } | null): Promise<void> {
  if (!hold) return;
  try { await getDailyTokenBudget().settle(hold, usage ?? { inputTokens: 0, outputTokens: 0 }); }
  catch (err) { log.server.warn({ component: 'daily-token-gate', keyTag: hold.keyTag, err: String(err) }, 'Daily token settle failed; the hold lapses after its TTL'); }
}

/** Books one finished call's real usage into the durable daily document (op-ed runs, whose admission is the run-level
 *  estimate in opedAdmission and which have no per-call hook before the provider call). It reserves a zero-size call
 *  and settles it with the real tokens, so the count is shared across replicas and survives a restart. A booking that
 *  cannot be made (store down, or the caller is already over the allowance) is logged and dropped, never thrown. */
export async function bookDailyTokens(limitKey: string, limit: number, usage: { inputTokens: number; outputTokens: number }, poolFunded: boolean): Promise<void> {
  try {
    const r = await getDailyTokenBudget().reserve(limitKey, limit, { promptBytes: 0, outputCapTokens: 0, poolFunded });
    if (!r.ok) {
      log.server.warn({ component: 'daily-token-gate', reason: r.reason }, 'Daily token booking skipped: the allowance could not take it (t/746)');
      return;
    }
    await settleDailyTokens(r.hold, usage);
  } catch (err) {
    log.server.warn({ component: 'daily-token-gate', err: String(err) }, 'Daily token booking failed (t/746)');
  }
}

/** Estimated usage for a call whose provider reported none, so a success is never counted as zero: about 4 bytes a token. */
export function estimateUsage(promptBytes: number, outputText: string | undefined): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil(promptBytes / 4), outputTokens: Math.ceil(Buffer.byteLength(outputText ?? '', 'utf8') / 4) };
}

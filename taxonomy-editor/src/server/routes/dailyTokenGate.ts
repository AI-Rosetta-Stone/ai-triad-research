// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/746 part 2 (spend control, T2): the call-site side of the durable per-caller daily token allowance
// (security/dailyTokenBudget.ts, t/731). A route RESERVES the call's worst case before the provider call and
// SETTLES with the provider's real usage on every way out of the handler (success with the reported usage; a
// failure, abort or refusal with zeros, which releases the hold). One process-wide budget over one document
// store; the limit key is the SAME one the rate limiter uses, and it is never logged (only the returned keyTag).
//
// Sizing: a hold is prompt bytes / sessions.dailyTokenBytesPerToken (3.5; measured about 4.0 on real English chat
// prompts) plus the output cap. At 1 byte per token a real chat turn (569,000 to
// 695,000 characters, about 140,000 to 175,000 tokens) would hold 4x its real size and be refused 413 at any sane ceiling.
// 3.5 is an ESTIMATE, not an upper bound (Security p/93#156, SO p/252#83). Text with fewer bytes per token than English
// prose can cost more than its hold: digits or random characters tokenise at about 1 byte per token, so one call can
// use up to about 3.5 times the ceiling in real tokens. The daily TOTAL stays correct because settle records the real
// usage; the exposure is a per-call overshoot, bounded by the per-IP RPM limiter and the free pool's call cap. The ratio
// is capped at 4 in the config bounds (4 is the measured value), so it can never be set above it.
//
// What this allowance can still miss (Security p/93#150; the rest of the bound is in dailyTokenBudget.ts):
//   - The routes send NO output cap to the provider, so a call's hold is its prompt bytes plus an ASSUMED output cap
//     (sessions.dailyTokenDefaultOutputCapTokens). A call whose real output exceeds that cap overshoots its hold by
//     up to (the provider's real maximum output minus the assumed cap): about 57,000 tokens a call when the assumed
//     cap is 8,192 and the provider maximum is 65,536. The overshoot is recorded when the call settles, and is
//     bounded by the per-IP RPM limit and the free pool's daily calls cap, not by this allowance.
//   - A provider-level retry made inside one request is counted once, at the usage the final attempt reports, so
//     retries are UNDER-counted.
//   - Op-ed runs are RECORDED durably (bookDailyTokens) but ENFORCED in-process (the run-level admission estimate):
//     do not describe the op-ed allowance as durable until a run-level reserve exists (follow-up).

import type { ServerResponse } from 'http';
import { DailyTokenBudget, type CallShape, type ReserveResult, type TokenHold, type TokenDocStore } from '../security/dailyTokenBudget.js';
import { createJsonDocStore } from '../storage/jsonDocStore.js';
import { getConfig } from '../runtimeConfig.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { nextDailyResetUtc } from '../security/rateLimiter.js';
import { isAuthDisabledMode } from '../security/userContext.js';

const DOC_PREFIX = '_system/daily-tokens';
/** The runtime config's maximum for sessions.dailyTokenPerCallCeilingTokens: the module's own check can never fire before ours. */
const MODULE_CEILING_TOKENS = 2_000_000;

type StoreKind = 'azure-blob' | 'memory';
let budget: DailyTokenBudget | null = null;
let storeKind: StoreKind | 'unused' = 'unused';

/** A hosted profile on the in-memory store is not durable: log an ERROR (and a recorder entry) and never call it durable. */
function noteStoreKind(kind: StoreKind): void {
  if (kind !== 'memory') return;
  const hosted = !isAuthDisabledMode(); // single-operator local mode is AUTH_DISABLED=1 outside production (Security p/93#150)
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
    // The module's own ceiling is set to the config maximum so it never refuses first: the live ceiling, the output cap and
    // the bytes-per-token ratio are read from config on EVERY reserve below (TL p/16#489), so a config reload takes effect
    // without a restart and /health reports exactly what is enforced.
    budget = new DailyTokenBudget(store as unknown as TokenDocStore, { perCallCeilingTokens: MODULE_CEILING_TOKENS });
  }
  return budget;
}

/** The three enforced numbers, read from the live runtime config on every call. The reserve below and /health both read
 *  them HERE, so /health can never show a value that is not the one enforced. */
export function enforcedBudgetSettings(): { perCallCeilingTokens: number; defaultOutputCapTokens: number; bytesPerToken: number } {
  const s = getConfig().sessions;
  return { perCallCeilingTokens: s.dailyTokenPerCallCeilingTokens, defaultOutputCapTokens: s.dailyTokenDefaultOutputCapTokens, bytesPerToken: s.dailyTokenBytesPerToken };
}

/** For /health: which store the allowance is on ('unused' until the first reserve; `durable` is true only on Blob) and
 *  the enforced settings, so a rollout can be checked without a sign-in (no secrets here). */
export function dailyTokenBudgetHealth(): { store: StoreKind | 'unused'; durable: boolean; perCallCeilingTokens: number; defaultOutputCapTokens: number; bytesPerToken: number } {
  return { store: storeKind, durable: storeKind === 'azure-blob', ...enforcedBudgetSettings() };
}

/** Test seam: replace (or clear) the process-wide budget. */
export function _setDailyTokenBudgetForTest(b: DailyTokenBudget | null): void { budget = b; storeKind = b ? 'memory' : 'unused'; }

/** The output cap to hold for a call: the cap actually sent, or for a call that sends none the configured assumed provider maximum. */
export function assumedOutputCapTokens(requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) return Math.floor(requested);
  return getConfig().sessions.dailyTokenDefaultOutputCapTokens;
}

/** t/811: the same worst-case token estimate the daily gate holds for a call (prompt bytes / the configured ratio, plus the
 *  output cap, read live), for the free pool's token-weighted daily cap: a pool reservation of this size, not a flat 2,000,
 *  stops calls in flight from overshooting the cap by their real size (a chat turn is about 150,000 tokens). */
export function estimateCallTokens(promptBytes: number, outputCapTokens: number = assumedOutputCapTokens()): number {
  const { bytesPerToken } = enforcedBudgetSettings();
  return Math.ceil(Math.max(0, promptBytes) / bytesPerToken) + Math.ceil(Math.max(0, outputCapTokens));
}

/** Reserves a call's worst case: its prompt BYTES converted to tokens at the configured ratio (an estimate, see
 *  the header), plus its output cap. The per-call ceiling is checked here against the live config; the budget is then handed
 *  the already-converted token count (1 'byte' per token) so it adds nothing of its own. */
export async function reserveDailyTokens(limitKey: string, limit: number, call: CallShape): Promise<ReserveResult> {
  const { perCallCeilingTokens, bytesPerToken } = enforcedBudgetSettings();
  const promptTokens = Math.ceil(Math.max(0, call.promptBytes) / bytesPerToken);
  const reserved = promptTokens + Math.ceil(Math.max(0, call.outputCapTokens));
  if (reserved > perCallCeilingTokens) return { ok: false, reason: 'per_call_ceiling', reserved, ceiling: perCallCeilingTokens };
  return getDailyTokenBudget().reserve(limitKey, limit, { promptBytes: promptTokens, outputCapTokens: call.outputCapTokens, poolFunded: call.poolFunded });
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

/** The limit key of the ONE shared document that counts paid-key fallback tokens for the UTC day (t/811). */
export const PAID_FALLBACK_LIMIT_KEY = '_system:paid-fallback';
let paidCapUnsetWarned = false;

/** t/811: the paid Gemini key may serve a free-tier caller's retry after a pool 429 (routes/ai.ts). This reserves that
 *  retry against the day's paid-fallback token cap BEFORE the paid call, on the same durable reserve/settle path.
 *  `sessions.paidFallbackDailyTokens` 0 (the default) means no cap: the retry proceeds as it does today, with a WARN once
 *  per process saying so. Over the cap, the budget's per-call ceiling, or a store outage: `proceed: false` (fail closed:
 *  the paid key is NOT called and the caller's original 429 stands). Settle the returned hold with the real usage. */
export async function reservePaidFallback(promptBytes: number): Promise<{ proceed: true; hold: TokenHold | null } | { proceed: false; reason: string }> {
  const cap = getConfig().sessions.paidFallbackDailyTokens;
  if (!(cap > 0)) {
    if (!paidCapUnsetWarned) {
      paidCapUnsetWarned = true;
      log.server.warn({ component: 'daily-token-gate', setting: 'sessions.paidFallbackDailyTokens' }, 'The paid-key fallback has NO daily cap (sessions.paidFallbackDailyTokens is unset or 0); set it before anonymous debates go on (t/811)');
    }
    return { proceed: true, hold: null };
  }
  const r = await reserveDailyTokens(PAID_FALLBACK_LIMIT_KEY, cap, { promptBytes, outputCapTokens: assumedOutputCapTokens(), poolFunded: true });
  if (r.ok) return { proceed: true, hold: r.hold };
  log.server.warn({ component: 'daily-token-gate', reason: r.reason, cap }, 'Paid-key fallback refused: the day\'s paid-fallback token cap is reached (or its store is unavailable); the original 429 stands (t/811)');
  getGlobalRecorder()?.record({ type: 'ai.fallback', component: 'ai-generate', level: 'warn', message: 'Paid fallback refused by the daily cap', data: { reason: r.reason, cap } });
  return { proceed: false, reason: r.reason };
}

/** Test seam: forget that the no-cap WARN was shown. */
export function _resetPaidCapWarnForTest(): void { paidCapUnsetWarned = false; }

/** Estimated usage for a call whose provider reported none, so a success is never counted as zero: about 4 bytes a token. */
export function estimateUsage(promptBytes: number, outputText: string | undefined): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Math.ceil(promptBytes / 4), outputTokens: Math.ceil(Buffer.byteLength(outputText ?? '', 'utf8') / 4) };
}

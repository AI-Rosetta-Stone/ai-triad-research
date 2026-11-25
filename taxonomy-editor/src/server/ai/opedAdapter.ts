// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2610 (parent epic t/2604): the server-side AIAdapter injected into the shared
// `lib/oped` generation core (`generateOpEdSet`) for the web build. It delegates to
// the server's key-managed, fallback-chained provider path (`aiBackends.generateText`)
// so hosted op-ed generation uses the same backend selection, retry, and
// cancellation machinery as every other server AI call — the web container never
// holds a raw API key.
//
// Structured-output parity (TL gap 2, Shared Lib-confirmed p/116#29): the core passes
// `responseSchema`/`maxTokens` to `generateText`; `aiBackends.generateText` now threads
// those to `callProvider` → gemini.ts native constrained decoding, IDENTICAL to the
// Electron/CLI adapter's schema-enforced path. No prompt-instructed divergence.
//
// t/616 (t/501, Security p/93#69): a run funded by the free key pool (hosted anonymous, or signed in with no key
// of their own) passes ONLY the pool keys, explicitly, with noFallback, on every call. Each call draws down the
// run's pool admission first (opedPoolAdmission.ts). A pool refusal stops the whole run: every later call is
// refused before its provider call, so the remaining voices stop too. The $5 per-run check covers every
// pool-funded run; the anonymous $10/$50 ledger is booked for anonymous runs only (TL p/16#376 answer 3).

import type { AIAdapter, GenerateOptions } from '../../../../lib/debate/aiAdapter.js';
import type { TokenUsage as LibTokenUsage } from '../../../../lib/ai-client/types.js';
import * as ai from './aiBackends.js';
import { estimateCost, resolvePricingKey } from '../../../../lib/ai-client/registry.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { isAnonymousUser } from '../security/userContext.js';
import { recordAnonOpEdSpend, ANON_OPED_PER_RUN_CAP_USD } from '../storage/anonOpEdSpend.js';
import { drawDownOpEdCall } from './opedPoolAdmission.js';
import { log } from '../logger.js';

/** t/616 (TL p/16#376 answer 2, the PI's chat ruling on t/494): a call that reports no usage is NOT charged to a
 *  person's own daily token bucket. It IS charged, as an estimate, to the shared controls (the anonymous ledger
 *  and the free pool). Same rule and value as chat's CHARGE_TURNS_WITHOUT_USAGE (#5413). */
export const OPED_CHARGE_USER_BUCKET_WITHOUT_USAGE = false;

/** How a run is funded by the free key pool. Absent for a run on the caller's own (or the owner's) keys. */
export interface OpEdPoolFunding {
  /** The free-pool keys from getFreePoolKeys (geo-gated). Passed explicitly on every call. */
  keys: string | string[];
  /** The run's admission reservation (null when budget enforcement is off). */
  reservationId: string | null;
  /** Correlation key for a fallback per-call reserve, e.g. `oped:<requester>:<runId>`. */
  budgetKey: string;
}

export interface WebOpEdAdapterOptions {
  pool?: OpEdPoolFunding;
  /** Book a call's reported usage to the caller's own daily token bucket (signed-in pool runs). */
  bookUserTokens?: (inputTokens: number, outputTokens: number) => void;
}

type ServerUsage = NonNullable<Awaited<ReturnType<typeof ai.generateText>>['tokenUsage']>;

/** t/616 (Security p/93#73): the only usage shape this adapter prices. Both token counts are REQUIRED, so the
 *  server's {inputTokens, outputTokens} shape no longer compiles where a priced usage is expected. (Passing it to
 *  estimateCost, whose lib type has only optional fields, priced every call at $0.) */
export interface PricedUsage extends LibTokenUsage { promptTokens: number; completionTokens: number }

/** The one conversion from the server's usage shape to the priced shape. */
export function toPricedUsage(u: ServerUsage): PricedUsage {
  return { promptTokens: u.inputTokens, completionTokens: u.outputTokens, totalTokens: u.totalTokens };
}

/** One run's mutable state, shared by its calls. */
interface RunState {
  opts: WebOpEdAdapterOptions;
  recordSpend: boolean; // anonymous: books the shared anonymous ledger
  capped: boolean;      // the $5 per-run check, priced model only, no fallback
  runSpendUsd: number;
  stopped: Error | null; // t/616: set by a pool refusal; every later call of the run is refused
}

type Settlement = Awaited<ReturnType<typeof drawDownOpEdCall>>;

/** Everything before the provider call. Throws (nothing sent) when the run is stopped, over its ceiling, or the pool
 *  refuses the call; a pool refusal also stops the run. */
async function admitCall(st: RunState, prompt: string, model: string, maxTokens: number | undefined): Promise<Settlement | undefined> {
  if (st.stopped) throw st.stopped;
  // t/467 (TL p/16#221): refuse a call if this run's total plus this call's worst case would exceed the ceiling.
  if (st.capped) assertCallWithinRunCeiling(prompt, model, maxTokens, st.runSpendUsd);
  const pool = st.opts.pool;
  if (!pool) return undefined;
  try {
    return await drawDownOpEdCall(pool.reservationId, pool.budgetKey);
  } catch (err) {
    st.stopped = err as Error;
    log.server.warn({ component: 'oped', model, code: (err as ActionableError).code }, 'Free-pool op-ed run stopped: the pool refused a call; the remaining calls are refused too (t/616)');
    throw err;
  }
}

/** t/467 (TL p/16#211, p/16#216): the price check is on the SERVED model, not the requested one: a reroute below this
 *  layer must not escape pricing. */
function assertServedModelPriced(served: string): void {
  if (resolvePricingKey(ai.getModelRegistry(), served)) return;
  throw new ActionableError({
    goal: 'Refuse a capped op-ed run whose served model has no price',
    problem: `The served model '${served}' has no price on file, so its spend cannot be counted toward the run's ceilings.`,
    location: 'opedAdapter.generateText',
    nextSteps: ['Choose a priced model, or sign in to run with your own key.'],
    code: 'ANON_UNPRICED_SERVED_MODEL',
    httpStatus: 403,
  });
}

/** Everything after the provider call: the pool reconcile, the user's own bucket, the run's spend and the ledger. */
async function bookCall(st: RunState, settlement: Settlement | undefined, result: Awaited<ReturnType<typeof ai.generateText>>, prompt: string, model: string, maxTokens: number | undefined): Promise<void> {
  const served = result.servedModel || model;
  if (st.capped) assertServedModelPriced(served);
  const usage = result.tokenUsage ? toPricedUsage(result.tokenUsage) : estimatedUsage(prompt, maxTokens, served);
  await settlement?.settle(usage.promptTokens + usage.completionTokens);
  if (result.tokenUsage || OPED_CHARGE_USER_BUCKET_WITHOUT_USAGE) st.opts.bookUserTokens?.(usage.promptTokens, usage.completionTokens);
  if (st.capped) st.runSpendUsd += await priceCall(usage, served, st.recordSpend);
}

/** Build the web op-ed AIAdapter. `generateText` is the only method the `lib/oped`
 *  core requires (t/2608#3). One adapter is built per run (oped.ts createOpEdRun), so its state is that run's. */
export function createWebOpEdAdapter(opts: WebOpEdAdapterOptions = {}): AIAdapter {
  const recordSpend = isAnonymousUser(); // read per request, inside the request's async context
  // Security p/93#69 item 3: $5 a run for every pool-funded run, signed-in keyless included.
  const st: RunState = { opts, recordSpend, capped: recordSpend || opts.pool !== undefined, runSpendUsd: 0, stopped: null };
  return {
    async generateText(prompt: string, model: string, options?: GenerateOptions): Promise<string> {
      const settlement = await admitCall(st, prompt, model, options?.maxTokens);
      const result = await ai.generateText(
        prompt,
        model,
        undefined,            // onRetry — retry progress isn't surfaced on the op-ed SSE stream for P1
        options?.timeoutMs,
        opts.pool?.keys,      // t/616: pool-funded runs use only the pool keys; otherwise the server resolves keys
        {
          temperature: options?.temperature,
          signal: options?.signal,           // client-disconnect cancellation → provider fetch abort
          responseSchema: options?.responseSchema,
          maxTokens: options?.maxTokens,
          // t/467 (TL p/16#215), t/616: a capped run uses only its price-checked model, so the spend counted
          // is the spend made. No fallback model can serve it.
          noFallback: st.capped,
        },
      );
      await bookCall(st, settlement, result, prompt, model, options?.maxTokens);
      return result.text;
    },
    // t/3614: required AIAdapter member — host-loaded registry data (cached via getModelRegistry).
    // This adapter never runs the debate engine, but the interface requires it uniformly.
    registry: ai.getModelRegistry(),
  };
}

/** t/616 (Security t/501#2 item 2, t/616#5 answer 2): a call that reports no usage is booked as an estimate, never
 *  $0: prompt characters / 4 for input, plus the call's maxTokens for output. WARN-logged with the model. */
function estimatedUsage(prompt: string, maxTokens: number | undefined, model: string): PricedUsage {
  const est = { promptTokens: Math.ceil(prompt.length / 4), completionTokens: maxTokens ?? 0 };
  log.server.warn({ component: 'oped', model, reason: 'oped-call-no-usage', ...est }, 'Op-ed call reported no usage; booking an estimate to the shared spend controls (t/616)');
  return est;
}

/** t/467 (TL p/16#221, p/16#224): the worst-case cost of ONE call before it is sent. Input tokens are bounded by the
 *  prompt's UTF-8 byte length: every token covers at least one byte, so tokens ≤ bytes. (A character count is not
 *  an upper bound, since one character can be several bytes.) Output tokens are bounded by the call's maxTokens.
 *  Undefined when the model has no price. */
function worstCallUsd(model: string, prompt: string, maxTokens: number): number | undefined {
  return estimateCost(ai.getModelRegistry(), model, { promptTokens: Buffer.byteLength(prompt, 'utf8'), completionTokens: maxTokens });
}

/** Refuse (throw, before any provider call) a capped call that could take this run past the per-run ceiling,
 *  or that cannot be bounded: no maxTokens, or an unpriced model. Each refusal names its reason. */
function assertCallWithinRunCeiling(prompt: string, model: string, maxTokens: number | undefined, runSpendUsd: number): void {
  const refuse = (code: string, problem: string): never => {
    log.server.warn({ component: 'oped', model, reason: code, runSpendUsd }, `Op-ed call refused: ${problem}`);
    throw new ActionableError({
      goal: 'Keep a free-pool op-ed run within the per-run cost ceiling',
      problem,
      location: 'opedAdapter.assertCallWithinRunCeiling',
      nextSteps: ['Shorten the request, or add your own key in Settings → API Keys.'],
      code,
      httpStatus: 403,
    });
  };
  if (maxTokens === undefined) refuse('ANON_UNBOUNDED_CALL', 'this call sets no output limit, so its worst-case cost cannot be bounded for a free-pool run.');
  const worst = worstCallUsd(model, prompt, maxTokens as number);
  if (worst === undefined) refuse('ANON_UNPRICED_MODEL', `model '${model}' has no price on file, so a free-pool run cannot use it.`);
  if (runSpendUsd + (worst as number) > ANON_OPED_PER_RUN_CAP_USD) {
    refuse('ANON_RUN_COST_CEILING', `this call could take the run past the $${ANON_OPED_PER_RUN_CAP_USD} per-run ceiling (spent $${runSpendUsd.toFixed(4)}, worst case for this call $${(worst as number).toFixed(4)}).`);
  }
}

/** Price one call and return it; an anonymous run also adds it to the anonymous spend ledger (t/467). A failed
 *  ledger write is logged (the run continues, but that spend is then not counted). An unpriced call is logged. */
export async function priceCall(usage: PricedUsage, model: string, bookAnonLedger: boolean): Promise<number> {
  const usd = estimateCost(ai.getModelRegistry(), model, usage);
  if (usd == null) {
    log.server.warn({ component: 'oped', model, reason: 'oped-unpriced-call' }, 'Op-ed call has no price; not counted toward the spend ceiling');
    return 0;
  }
  if (bookAnonLedger) {
    try { await recordAnonOpEdSpend(usd); }
    catch (err) { log.server.warn({ component: 'oped', model, err: String(err), reason: 'anon-oped-spend-record-failed' }, 'Anonymous op-ed spend could not be recorded'); }
  }
  return usd;
}

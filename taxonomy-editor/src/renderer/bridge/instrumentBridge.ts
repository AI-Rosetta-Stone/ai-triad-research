// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Bridge instrumentation — wraps every AppAPI method with flight recorder
 * events so all backend calls (IPC or REST) are automatically captured.
 *
 * Records:
 *   bridge.call  (level: info)  — on invocation, with method name
 *   bridge.call  (level: info)  — on success, with duration_ms
 *   bridge.call  (level: error) — on failure, with duration_ms and error
 */

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { trackAICall } from '../lib/analyticsEmitter';
import { utf8ByteLength } from '@lib/ai-client/index';
import type { AppAPI } from './types';

/** Truncate an argument for logging. Keeps strings short, summarizes objects. */
function truncateArg(arg: unknown, maxLen = 200): unknown {
  if (arg === null || arg === undefined) return arg;
  if (typeof arg === 'string') return arg.length > maxLen ? arg.slice(0, maxLen) + '…' : arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return arg;
  if (Array.isArray(arg)) return `[Array(${arg.length})]`;
  if (typeof arg === 'object') {
    const keys = Object.keys(arg as object);
    return `{${keys.slice(0, 5).join(',')}}${keys.length > 5 ? `…+${keys.length - 5}` : ''}`;
  }
  return String(arg).slice(0, maxLen);
}

/** Redact secret-bearing arguments before logging. Key = method name, value = arg indices to redact. */
const REDACT_ARGS: Record<string, number[]> = {
  setApiKey: [0],                // arg 0 is the raw API key
  exportKeysForSharing: [0],     // arg 0 is the passphrase
  importKeysFromSharing: [0, 1], // arg 0 is encrypted payload, arg 1 is passphrase
};

function redactSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) return '[REDACTED]';
  return value.slice(0, 4) + '…' + value.slice(-2);
}

/** Summarize args array for flight recorder (max 3 args logged). */
function summarizeArgs(args: unknown[], method?: string): unknown[] {
  const redactIndices = method ? REDACT_ARGS[method] : undefined;
  return args.slice(0, 3).map((a, i) =>
    redactIndices?.includes(i) ? redactSecret(a) : truncateArg(a),
  );
}

/**
 * Named `batch_size` fragment for embedding requests (t/3071). The e8760507 incident's failing
 * call was [Array(2587)] vs prior good 643/792 — as a first-class field (not just a truncated arg
 * preview) the outlier jumps out in the dump. This is the *bridge-level* size, i.e. the full
 * requested batch before web-bridge's chunker splits it into ≤EMBEDDINGS_MAX_BATCH sequential
 * POSTs (t/3072). `computeQueryEmbedding` takes a single text, so its batch is always 1. Returns a
 * spreadable object (`{}` when N/A) so the call site can splat it without adding a branch there.
 */
function embeddingBatchData(method: string, args: unknown[]): { batch_size?: number } {
  if (method === 'computeEmbeddings') return Array.isArray(args[0]) ? { batch_size: args[0].length } : {};
  if (method === 'computeQueryEmbedding') return typeof args[0] === 'string' ? { batch_size: 1 } : {};
  return {};
}

/**
 * Bidirectional type equality — true only when `A` and `B` are mutually assignable. Unlike
 * `A extends B`, which is one-way and would accept a *widened* `B`, this catches a widening in
 * either direction. Standard TS type-level-equals trick (distributes over a bare function-type
 * comparison to dodge variance quirks a plain conditional would miss).
 */
type _Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/**
 * Compile-time pin on `AppAPI.generateText`'s parameter shape (t/3528, TL ruling t/3528#5). The
 * positional reads in `aiCallMeta` below (`args[1]`, `args[2]`, `args[4]`) assume this exact
 * order and these exact types. Runtime `unknown[]` args can't self-verify that, so a reorder
 * (or a param swapping type, e.g. two adjacent `number | undefined`s) used to misattribute
 * model/timeoutMs/maxTokens in the very ai.request/ai.response/ai.error telemetry added (t/3519)
 * to diagnose incidents — silently, with no test catching it (t/3518 traced an incident partly
 * blind because of exactly this class of gap). This assertion turns that into a build failure:
 * if `AppAPI['generateText']`'s params ever change shape, `_Equal<...>` evaluates to `false` and
 * `satisfies true` below stops compiling. `Parameters<>` narrowing was considered and rejected
 * (t/3528#5) — a same-typed adjacent-param swap (e.g. model↔timeoutMs) still type-checks under
 * narrowing and would silently yield `undefined` forever.
 */
type _PinnedGenerateTextParams = Parameters<AppAPI['generateText']>;
type _ExpectedGenerateTextParams = [
  prompt: string,
  model?: string,
  timeoutMs?: number,
  temperature?: number,
  opts?: import('./types').GenerateTextOptions,
];
true satisfies _Equal<_PinnedGenerateTextParams, _ExpectedGenerateTextParams>;

/**
 * `model`/`timeoutMs`/`purpose`/`maxTokens`/`promptBytes` for the ai.request/ai.response/ai.error
 * FR events (t/3519, maxTokens added t/3524, promptBytes added t/3568). The t/3518 triage found
 * all 20 ai.error/ai.request events for a PI debate failure carried only
 * `{method, category, _origin}` — the model had to be inferred from unrelated debate.lifecycle
 * events, and the decisive fact (60s budget vs 180s expected) only surfaced because the thrown
 * ActionableError happened to mention elapsed ms. maxTokens joins the same event for the analogous
 * reason: t/3524's Fable 5 truncation was diagnosable only via a raw FR field (discarded_tail),
 * with no first-class record of the ceiling that caused it. promptBytes closes the same gap on
 * the REQUEST side: `extractResultMeta`'s `prompt_chars` only fires on the response path, so a
 * timed-out call (no response) lost prompt size exactly when it mattered — t/3568 found this after
 * t/3566's instrumentation landed in `lib/debate/aiAdapter.ts` (the Node/CLI path) while every
 * `ai.*` FR event for a desktop debate is emitted here instead. This is a positional read of each
 * AI method's PARAMETER LIST — pinned to the current `AppAPI` (bridge/types.ts) signatures below.
 *   generateText(prompt, model, timeoutMs, temperature, opts: GenerateTextOptions) — pinned above;
 *     a reorder or type change fails the build (t/3528).
 *   generateTextWithSearch(prompt, model)
 *   startChatStream(systemInstruction, messages, model, temperature, urlContext, context)
 * All other "ai"-category methods (computeEmbeddings, computeQueryEmbedding, updateNodeEmbeddings,
 * nliClassify) call a fixed server-side model with no per-call selection — nothing to extract.
 */
function aiCallMeta(method: string, args: unknown[]): { model?: string; timeoutMs?: number; purpose?: string; maxTokens?: number; promptBytes?: number } {
  if (method === 'generateText') {
    const opts = args[4] as { purpose?: string; maxTokens?: number } | undefined;
    return {
      model: typeof args[1] === 'string' ? args[1] : undefined,
      timeoutMs: typeof args[2] === 'number' ? args[2] : undefined,
      purpose: typeof opts?.purpose === 'string' ? opts.purpose : undefined,
      maxTokens: typeof opts?.maxTokens === 'number' ? opts.maxTokens : undefined,
      // t/3568: on the ai.request emit specifically — a timeout has no response, so
      // prompt_chars (extractResultMeta, response-path only) is lost exactly when this is
      // needed most. Byte length (not .length) to match the provider-side promptBytes/
      // requestBytes fields from t/3566 and be correct for multi-byte content.
      promptBytes: typeof args[0] === 'string' ? utf8ByteLength(args[0]) : undefined,
    };
  }
  if (method === 'generateTextWithSearch') {
    return { model: typeof args[1] === 'string' ? args[1] : undefined };
  }
  if (method === 'startChatStream') {
    return { model: typeof args[2] === 'string' ? args[2] : undefined };
  }
  return {};
}

/** Extract result metadata for data-loading methods to enrich completion events. */
function extractResultMeta(method: string, args: unknown[], value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (method.startsWith('loadTaxonomyFile')) { // + loadTaxonomyFileForEdit (t/4187); one branch for the complexity budget
    const nodes = v.nodes;
    return { pov: args[0], node_count: Array.isArray(nodes) ? nodes.length : undefined };
  }
  if (method === 'loadSituations') {
    const nodes = v.nodes;
    return { node_count: Array.isArray(nodes) ? nodes.length : undefined };
  }
  if (method === 'loadConflicts') {
    return { count: Array.isArray(v) ? (v as unknown[]).length : Array.isArray(v.conflicts) ? (v.conflicts as unknown[]).length : undefined };
  }
  if (method === 'loadEdges') {
    const edges = v.edges;
    return { edge_count: Array.isArray(edges) ? edges.length : undefined };
  }
  if (method === 'listDebateSessionsMeta') {
    // Log returned debate IDs so a 404 dump can distinguish an orphaned index
    // from user navigation: was the missing ID actually in the list? (t/2365)
    if (!Array.isArray(v)) return undefined;
    const ids = (v as Array<{ id?: unknown }>)
      .map((s) => s?.id)
      .filter((id): id is string => typeof id === 'string');
    return { count: v.length, ids: ids.slice(0, 20) };
  }
  if (method === 'listOpEdSets') {
    // Record the RESULT SHAPE, not just the count, so a summary-vs-full regression is
    // visible in the dump alone (t/2606). The t/2605 crash was listOpEdSets returning a
    // full OpEdSet[] where the caller expected OpEdSetSummary[] (no `opeds`); result_type
    // makes a repeat diagnosable without re-reading source. Empty list → 'summary' (the
    // expected default). `has_opeds` is the same signal at the per-row level.
    if (!Array.isArray(v)) return undefined;
    const first = (v as unknown[])[0] as Record<string, unknown> | undefined;
    const has_opeds = !!first && 'opeds' in first;
    return { count: (v as unknown[]).length, result_type: has_opeds ? 'full' : 'summary', has_opeds };
  }
  if (method === 'loadOpEdSet') {
    // Record grounding presence on the loaded set so a "grounding No data" report is
    // diagnosable from the dump alone — distinguishes "grounding absent in the payload"
    // from "present but not rendering" (which previously needed the on-disk JSON). t/2621.
    const opeds = Array.isArray(v.opeds) ? (v.opeds as Array<{ grounding?: unknown[] }>) : [];
    const grounded_member_count = opeds.filter(m => (m.grounding?.length ?? 0) > 0).length;
    return { member_count: opeds.length, has_grounding: grounded_member_count > 0, grounded_member_count };
  }
  if (method === 'generateText' || method === 'generateTextWithSearch') {
    const text = v.text;
    const meta: Record<string, unknown> = {};
    if (typeof text === 'string') {
      meta.response_chars = text.length;
      meta.response_preview = text.slice(0, 300) + (text.length > 300 ? '…' : '');
    }
    // t/3544: prompt length reveals whether the context window (not the response cap) is the
    // binding constraint — the maxTokens half of this picture already rides aiCallMeta (t/3524).
    if (typeof args[0] === 'string') {
      meta.prompt_chars = args[0].length;
    }
    const usage = v.tokenUsage as Record<string, unknown> | undefined;
    if (usage) {
      meta.input_tokens = usage.inputTokens;
      meta.output_tokens = usage.outputTokens;
    }
    // t/3568 item 2: provider diagnostics (requestBytes/httpStatus/headersMs/bodyReadMs/
    // responseBytes, +ttftMs/e2eMs on xAI) threaded across IPC by t/3569. Only rides the
    // SUCCESS path — see the doc comment on AppAPI['generateText'] (bridge/types.ts) for why
    // there is nothing to attach here on a rejected call yet.
    const diagnostics = v.diagnostics;
    if (diagnostics && typeof diagnostics === 'object') {
      meta.diagnostics = diagnostics;
    }
    return Object.keys(meta).length > 0 ? meta : undefined;
  }
  return undefined;
}

/** Methods that should NOT be wrapped. */
const SKIP = new Set([
  // Event listeners return unsubscribe functions, not promises
  'onChatStreamChunk', 'onChatStreamDone', 'onChatStreamError', 'onChatStreamUrlMetadata',
  'onDiagnosticsStateUpdate', 'onDiagnosticsPopoutClosed', 'onReExtractClaims',
  'onDebateWindowLoad', 'onDebatePopoutClosed',
  'onGenerateTextProgress', 'onReloadTaxonomy', 'onFocusNode', 'onTaxonomyUpdated',
  'onTerminalData', 'onTerminalExit',
  // Sync methods
  'sendDiagnosticsState', 'requestReExtractClaims',
  'focusNodeInMainWindow',
  // Avoid recursion — dump calls the bridge itself
  'dumpFlightRecorder',
  // High-frequency polling — noise that evicts useful diagnostic events
  'adminReviewStats', 'adminReviewConfigured',
]);

/**
 * Bridge methods where a specific HTTP status is an EXPECTED, non-error outcome —
 * the caller handles it gracefully (e.g. returns a default). Such rejections are
 * recorded at `debug` instead of `error`, so flight-recorder dumps aren't polluted
 * by a false alarm on every session, while ADR-003 is honored (the event is still
 * recorded; only the LEVEL drops). Keep this narrow and PER-METHOD: a blanket
 * status downgrade would mask a real authorization bug on some other call
 * (TL optionality-aware condition, t/1339 / t/1340).
 */
const EXPECTED_STATUS: Record<string, ReadonlySet<number>> = {
  // 403 for non-admin/anonymous users; App.tsx catches it and returns '' (t/2395).
  getDataRoot: new Set([403]),
};

/** True when `httpStatus` is a known non-error outcome for `method` (see EXPECTED_STATUS). */
function isExpectedStatus(method: string, httpStatus: number | undefined): boolean {
  return httpStatus !== undefined && (EXPECTED_STATUS[method]?.has(httpStatus) ?? false);
}

/**
 * Structured 429 cooldown for FR `ai.error` events (t/3054). web-bridge attaches
 * `retryAfterS` to the thrown ActionableError; surface it as `retry_after_s` so a
 * consumer can honor the cooldown without regex-parsing the message string.
 */
function retryAfterSFromError(err: unknown, httpStatus: number | undefined): number | undefined {
  if (httpStatus !== 429) return undefined;
  const v = (err as { retryAfterS?: unknown }).retryAfterS;
  return typeof v === 'number' ? v : undefined;
}

/**
 * 429 rate-limit discriminators for FR `ai.error` events (t/3107). web-bridge attaches the
 * parsed 429 body fields to the thrown error; surface them as named fields so a CLIENT-ONLY dump
 * (all an anonymous free-tier user can produce — server dumps are gated to authed sessions) can
 * tell a per-IP front-door 429 (`per_ip_rpm`) from a key-rotation-exhaustion 429
 * (`api_key_exhausted`) without any server correlation.
 */
function rateLimitFieldsFromError(err: unknown, httpStatus: number | undefined): Record<string, unknown> {
  if (httpStatus !== 429) return {};
  const e = err as { rateLimitSource?: unknown; limit?: unknown; current?: unknown };
  const out: Record<string, unknown> = {};
  if (typeof e.rateLimitSource === 'string') out.rate_limit_source = e.rateLimitSource;
  if (typeof e.limit === 'number') out.limit = e.limit;
  if (typeof e.current === 'number') out.current = e.current;
  return out;
}

/** Categorize bridge methods for the recorder. */
function inferCategory(method: string): string {
  if (method.startsWith('generate') || method.startsWith('startChat') || method === 'nliClassify') return 'ai';
  if (method.startsWith('compute') || method.startsWith('updateNode')) return 'ai';
  if (method.startsWith('load') || method.startsWith('save') || method.startsWith('list')) return 'data';
  if (method.startsWith('delete') || method.startsWith('create')) return 'data';
  if (method.startsWith('harvest')) return 'harvest';
  if (method.startsWith('terminal')) return 'terminal';
  if (method.includes('Key') || method.includes('Model')) return 'config';
  if (method.includes('Window') || method.includes('grow') || method.includes('shrink')) return 'window';
  return 'bridge';
}

/**
 * Wrap an AppAPI instance so every async method is recorded by the flight
 * recorder. The original api object is not mutated.
 */
export function instrumentBridge(raw: AppAPI): AppAPI {
  const wrapped = { ...raw };

  for (const key of Object.keys(raw) as Array<keyof AppAPI>) {
    if (SKIP.has(key)) continue;
    const original = raw[key];
    if (typeof original !== 'function') continue;

    (wrapped as Record<string, unknown>)[key] = (...args: unknown[]) => {
      const recorder = getGlobalRecorder();
      const category = inferCategory(key);
      const startTs = performance.now();

      const isAI = category === 'ai';
      // Self-gating by method name (see aiCallMeta doc) — returns {} for any non-AI method, so no
      // extra isAI branch is needed here (keeps this closure's complexity flat).
      const aiMeta = aiCallMeta(key, args);

      // Record call start (only if recorder is initialized)
      recorder?.record({
        type: isAI ? 'ai.request' : 'lifecycle',
        component: recorder.intern('component', 'bridge') as string | number,
        level: 'debug',
        message: `bridge.${key}`,
        data: { method: key, category, arg_count: args.length, args: summarizeArgs(args, key), ...embeddingBatchData(key, args), ...aiMeta },
      });

      let result: unknown;
      try {
        result = (original as (...a: unknown[]) => unknown).apply(raw, args);
      } catch (err) {
        // Sync throw (rare for bridge methods)
        const duration_ms = Math.round(performance.now() - startTs);
        const httpStatus = typeof (err as { httpStatus?: unknown }).httpStatus === 'number'
          ? (err as { httpStatus: number }).httpStatus
          : undefined;
        const expected = !isAI && isExpectedStatus(key, httpStatus);
        const retryAfterS = retryAfterSFromError(err, httpStatus);
        getGlobalRecorder()?.record({
          type: isAI ? 'ai.error' : 'system.error',
          component: recorder?.intern('component', 'bridge') as string | number,
          level: expected ? 'debug' : 'error',
          message: expected ? `bridge.${key} expected ${httpStatus} (sync)` : `bridge.${key} failed (sync)`,
          duration_ms,
          error: normalizeError(err),
          data: { method: key, category, ...(httpStatus !== undefined && { http_status: httpStatus }), ...(retryAfterS !== undefined && { retry_after_s: retryAfterS }), ...rateLimitFieldsFromError(err, httpStatus), ...aiMeta },
        });
        throw err;
      }

      // If not a Promise, return as-is (shouldn't happen for non-skipped methods)
      if (!result || typeof (result as Promise<unknown>).then !== 'function') {
        return result;
      }

      // Wrap the promise to record completion/failure
      return (result as Promise<unknown>).then(
        (value) => {
          const duration_ms = Math.round(performance.now() - startTs);
          const resultMeta = extractResultMeta(key, args, value);
          recorder?.record({
            type: isAI ? 'ai.response' : 'lifecycle',
            component: recorder.intern('component', 'bridge') as string | number,
            level: 'info',
            message: `bridge.${key} ok`,
            duration_ms,
            data: { method: key, category, ...resultMeta, ...aiMeta },
          });
          if (isAI) {
            const model = typeof args[1] === 'string' ? args[1] : 'unknown';
            trackAICall(model, duration_ms, resultMeta ? {
              tokens_in: resultMeta.input_tokens as number | undefined,
              tokens_out: resultMeta.output_tokens as number | undefined,
            } : undefined);
          }
          return value;
        },
        (err) => {
          const duration_ms = Math.round(performance.now() - startTs);
          const httpStatus = typeof (err as { httpStatus?: unknown }).httpStatus === 'number'
            ? (err as { httpStatus: number }).httpStatus
            : undefined;
          const expected = !isAI && isExpectedStatus(key, httpStatus);
          const retryAfterS = retryAfterSFromError(err, httpStatus);
          recorder?.record({
            type: isAI ? 'ai.error' : 'system.error',
            component: recorder.intern('component', 'bridge') as string | number,
            level: expected ? 'debug' : 'error',
            message: expected ? `bridge.${key} expected ${httpStatus}` : `bridge.${key} failed`,
            duration_ms,
            error: normalizeError(err),
            data: { method: key, category, ...(httpStatus !== undefined && { http_status: httpStatus }), ...(retryAfterS !== undefined && { retry_after_s: retryAfterS }), ...rateLimitFieldsFromError(err, httpStatus), ...aiMeta },
          });
          throw err;
        },
      );
    };
  }

  return wrapped;
}

function normalizeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) };
  }
  return { name: 'Error', message: String(err) };
}

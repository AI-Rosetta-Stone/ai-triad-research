// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * GitHubRestClient — the resilient HTTP transport seam for GitHubAPIBackend (t/1698).
 *
 * Extracted verbatim from GitHubAPIBackend so the "adapter to GitHub" is a
 * swappable, independently-mockable unit: request plumbing + retry/backoff +
 * 401→refresh + Retry-After + adaptive circuit breaker + rate-limit tracking.
 *
 * It owns ONLY transport state (rate limit + circuit). Everything GitHub-semantic
 * (creds resolution/caching, the manifest/etag store, the flight-recorder error
 * buffer, the file/blob/tree helpers) stays in GitHubAPIBackend and is threaded
 * back in through three callbacks:
 *   - record(input)      → backend.recordEvent (keeps the errorBuffer in the backend)
 *   - getEtag(pathQuery) → backend.getCachedEtag (conditional-request etag from manifest)
 *   - refreshCreds()     → backend invalidates its creds cache and re-resolves (401 path)
 *
 * Callers pass `creds` into request() unchanged, so the mid-batch credential
 * threading (a 401 refreshes this call's creds while siblings keep the outer
 * value) is byte-for-byte preserved. No behavior change — see githubApi.test.ts.
 */

import crypto from 'crypto';
import { createRequire } from 'module';
import { Agent } from 'undici';
import { type SyncCredentials } from '../security/githubAppAuth.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import type { RecordInput } from '../../../../lib/flight-recorder/index.js';
import { getRequestId, log } from '../logger.js';
import { assertUndiciMajorInvariant } from './undiciInvariant.js';
export { assertUndiciMajorInvariant } from './undiciInvariant.js';

// ── Transport constants (moved with the transport) ─────────────────────────
const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'ai-triad-taxonomy-editor';
const API_VERSION = '2022-11-28';

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = [100, 300, 900];
const BACKOFF_JITTER_MS = 100;
// t/4202 SO C2: GitHub's secondary-rate-limit Retry-After is attacker/server-controlled
// input — cap how long a single 403 retry will wait regardless of what the header claims.
const MAX_REFUSAL_RETRY_DELAY_MS = 60_000;

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_PROBE_SCHEDULE_MS = [30_000, 60_000, 120_000, 300_000]; // 30s→1m→2m→5m cap

// Explicit undici Agent: disables TLS session caching (maxCachedSessions:0) so the
// CVE-2026-58040 session-reuse identity check in undici 6.28.0+ (node 22.23.2) cannot
// silently break GitHub API connections on startup. Per-call dispatcher — does not affect
// urlFetch.ts, healthProbe.ts, or other fetch sites. (t/2053)
// t/3267: explicit timeouts prevent OS-level TCP hang (~90-120s) on slow/unresponsive
// GitHub API connections. connectTimeout: 10s (TCP handshake); headersTimeout: 60s
// (allows large-body uploads before GitHub starts sending a response);
// bodyTimeout: 120s (full response body including large tree/blob responses).
const githubAgent = new Agent({
  connect: {
    rejectUnauthorized: true,
    maxCachedSessions: 0,
    timeout: 10_000,       // TCP connect timeout: 10s
  },
  headersTimeout: 60_000,  // Server must begin responding within 60s (covers large uploads)
  bodyTimeout: 120_000,    // Full response body within 120s
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 4_000,
  maxRequestsPerClient: 100,
});

// ── Types ──────────────────────────────────────────────────────────────────
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface RateLimitInfo {
  remaining: number;
  limit: number;
  resetsAt: number;   // epoch ms
}

export interface ApiResult {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
  etag?: string;
}

/** Backend-owned collaborators the transport calls back into. */
export interface GitHubRestClientDeps {
  /** Forward a flight-recorder event (backend.recordEvent — also fills the error buffer). */
  record: (input: RecordInput) => void;
  /** Conditional-request etag for a Contents-API path/query, from the backend manifest. */
  getEtag: (pathAndQuery: string) => string | null;
  /** Invalidate the backend's cached creds and re-resolve (used on a 401). */
  refreshCreds: () => Promise<SyncCredentials | null>;
}

export function normalizeErrorForEvent(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack?.slice(0, 500) };
  }
  return { name: 'Error', message: String(err) };
}

type NonOkOutcome =
  | { action: 'return'; result: ApiResult }
  | { action: 'retry'; newCreds?: SyncCredentials; delayMs?: number };

export class GitHubRestClient {
  // Rate limit tracking
  private rateLimit: RateLimitInfo = { remaining: 5000, limit: 5000, resetsAt: 0 };

  // t/4307: since-boot outbound-call counter by route class, counted at the
  // one place every fetch (including retries) actually goes out — unlike
  // getColdCacheMissCount(), which only instruments one of several
  // miss-then-fetch code paths in githubAPIBackend.ts (t/4300#18).
  private requestCountsByRouteClass: Record<string, number> = {};

  private static classifyRoute(pathAndQuery: string): string {
    const path = pathAndQuery.split('?')[0];
    if (/\/git\/trees/.test(path)) return 'trees';
    if (/\/git\/commits/.test(path)) return 'commits';
    if (/\/git\/refs/.test(path)) return 'refs';
    if (/\/git\/blobs/.test(path)) return 'blobs';
    if (/\/contents\//.test(path)) return 'contents';
    if (/\/pulls/.test(path)) return 'pulls';
    if (/\/commits\//.test(path)) return 'commits-compare';
    if (/\/rate_limit/.test(path)) return 'rate_limit';
    return 'other';
  }

  private countRequest(pathAndQuery: string): void {
    const routeClass = GitHubRestClient.classifyRoute(pathAndQuery);
    this.requestCountsByRouteClass[routeClass] = (this.requestCountsByRouteClass[routeClass] ?? 0) + 1;
  }

  /** t/4307: since-boot request count by route class, plus the latest
   *  `x-ratelimit-remaining` seen. Supersedes GitHubAPIBackend.getColdCacheMissCount(). */
  getRequestMetrics(): { totalRequests: number; byRouteClass: Record<string, number>; rateLimitRemaining: number } {
    const byRouteClass = { ...this.requestCountsByRouteClass };
    const totalRequests = Object.values(byRouteClass).reduce((sum, n) => sum + n, 0);
    return { totalRequests, byRouteClass, rateLimitRemaining: this.rateLimit.remaining };
  }

  // Circuit breaker state
  private circuitState: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private circuitOpenedAt = 0;
  private probeIndex = 0;

  constructor(private readonly deps: GitHubRestClientDeps) {
    assertUndiciMajorInvariant(
      (createRequire(import.meta.url)('undici/package.json') as { version: string }).version,
      process.versions.undici,
    );
  }

  async request(
    creds: SyncCredentials,
    method: string,
    pathAndQuery: string,
    body?: unknown,
    callId?: string,
    apiOpts?: { optional?: boolean; raw?: boolean },
  ): Promise<ApiResult> {
    // t/803: correlate GitHub API calls to the originating HTTP request. Never
    // embed the user's email/principal in the id (it was PII in every log line).
    const requestId = getRequestId() ?? `req-${crypto.randomUUID()}`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startMs = Date.now();
      this.recordAttempt(method, pathAndQuery, attempt, callId, requestId);

      try {
        const url = `${GITHUB_API}${pathAndQuery}`;
        // t/4286: pass apiOpts through as-is (not `apiOpts?.x` here) — each distinct
        // optional-chain read is its own branch for local/complexity-budget, and
        // request() is already at its budget; buildRequestHeaders/parseAndLogResponse
        // read the fields themselves instead.
        const headers = this.buildRequestHeaders(creds, method, pathAndQuery, body, requestId, apiOpts);
        // t/4307: counted here, the one spot every outbound call (incl. retries)
        // passes through, regardless of which backend method initiated it.
        this.countRequest(pathAndQuery);
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          dispatcher: githubAgent,
        } as RequestInit);

        const durationMs = Date.now() - startMs;
        this.updateRateLimit(res.headers);
        const responseEtag = res.headers.get('etag') ?? undefined;

        if (res.status === 304) {
          return this.handleNotModified(durationMs, method, pathAndQuery, callId, requestId, responseEtag);
        }

        const { data, text } = await this.parseAndLogResponse(
          res, method, pathAndQuery, durationMs, callId, requestId, apiOpts,
        );

        if (res.ok) {
          this.onApiSuccess();
          return { ok: true, status: res.status, data, etag: responseEtag };
        }

        const outcome = await this.handleNonOkStatus(res, data, text, attempt);
        if (outcome.action === 'return') return outcome.result;
        if (outcome.newCreds) creds = outcome.newCreds;
        if (outcome.delayMs) await this.sleep(outcome.delayMs);

      } catch (err: unknown) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'github-api',
          level: 'error',
          message: 'Operation failed',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        const networkResult = await this.handleNetworkError(
          err, startMs, method, pathAndQuery, attempt, callId, requestId,
        );
        if (networkResult !== null) return networkResult;
      }
    }

    // Should not reach here, but just in case
    return { ok: false, status: 0, data: null, error: 'Max retries exceeded' };
  }

  private recordAttempt(
    method: string, pathAndQuery: string, attempt: number,
    callId: string | undefined, requestId: string,
  ): void {
    this.deps.record({
      type: 'github.api.request',
      component: 'github-api',
      level: 'debug',
      message: `${method} ${pathAndQuery}`,
      call_id: callId,
      request_id: requestId,
      data: { method, endpoint: pathAndQuery, attempt },
    });
  }

  private buildRequestHeaders(
    creds: SyncCredentials, method: string, pathAndQuery: string,
    body: unknown, requestId: string, apiOpts: { raw?: boolean } | undefined,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      // t/4286: raw asks the Contents API for the file's bytes directly — no JSON
      // envelope, no base64. Only meaningful on a 2xx; GitHub always returns a
      // normal JSON error body regardless of Accept on a non-2xx response.
      Accept: apiOpts?.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      Authorization: `Bearer ${creds.token}`,
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': API_VERSION,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['X-Request-ID'] = requestId;
    const cachedEtag = this.deps.getEtag(pathAndQuery);
    if (cachedEtag && method === 'GET') headers['If-None-Match'] = cachedEtag;
    return headers;
  }

  private handleNotModified(
    durationMs: number, method: string, pathAndQuery: string,
    callId: string | undefined, requestId: string, responseEtag: string | undefined,
  ): ApiResult {
    this.deps.record({
      type: 'github.api.response',
      component: 'github-api',
      level: 'debug',
      duration_ms: durationMs,
      call_id: callId,
      request_id: requestId,
      data: { status: 304, method, endpoint: pathAndQuery, cache_hit: true,
              rate_remaining: this.rateLimit.remaining },
    });
    this.onApiSuccess();
    return { ok: true, status: 304, data: null, etag: responseEtag };
  }

  private async parseAndLogResponse(
    res: Response, method: string, pathAndQuery: string,
    durationMs: number, callId: string | undefined, requestId: string,
    apiOpts: { optional?: boolean; raw?: boolean } | undefined,
  ): Promise<{ data: unknown; text: string }> {
    // t/4286: a raw 2xx response IS the file's bytes — res.text()+JSON.parse below
    // would be a second synchronous full-body pass on top of fetch's own buffering,
    // and for a binary file res.text() would additionally corrupt it via UTF-8
    // decoding. arrayBuffer() is the only safe read here. A non-2xx response is
    // unaffected: GitHub always returns JSON on error regardless of Accept, so it
    // falls through to the normal parse below (kept in one function, rather than a
    // branch in request(), so this stays the only place response bytes are read —
    // local/complexity-budget).
    if (apiOpts?.raw && res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      this.deps.record({
        type: 'github.api.response', component: 'github-api', level: 'debug',
        duration_ms: durationMs, call_id: callId, request_id: requestId,
        data: { status: res.status, method, endpoint: pathAndQuery, bytes: buf.length, rate_remaining: this.rateLimit.remaining },
      });
      return { data: buf, text: '' };
    }

    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* telemetry — silent by design */ data = text; }

    const is404Optional = !res.ok && res.status === 404 && !!apiOpts?.optional;
    this.deps.record({
      type: res.ok ? 'github.api.response' : (is404Optional ? 'github.api.miss' : 'github.api.error'),
      component: 'github-api',
      level: res.ok ? 'debug' : (is404Optional ? 'debug' : 'error'),
      duration_ms: durationMs,
      call_id: callId,
      request_id: requestId,
      data: {
        status: res.status, method, endpoint: pathAndQuery,
        rate_remaining: this.rateLimit.remaining,
        ...(res.ok ? {} : { error: text?.slice(0, 500) }),
      },
    });
    return { data, text };
  }

  private extractApiMessage(data: unknown, fallback: string): string {
    return (data && typeof data === 'object' && 'message' in data)
      ? String((data as { message: unknown }).message)
      : fallback;
  }

  /** t/4202: capture + log a GitHub 403 refusal's headers, and decide the retry
   * outcome in one place — extracted out of handleNonOkStatus to keep that method's
   * branching complexity in budget (local/complexity-budget). deps.record() alone is
   * NOT console-visible — it only writes to FlightRecorder's in-memory ring buffer —
   * so this also logs via Pino (log.github.warn) so the refusal shows up in
   * ContainerAppConsoleLogs_CL and the alert-github-api-refused rule (main.bicep) can
   * actually fire on it. */
  private handleGithubRefusal(res: Response, data: unknown, attempt: number): NonOkOutcome | null {
    const retryAfterHeader = res.headers.get('retry-after');
    const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    const refusalData = {
      retryAfterSec,
      remaining: res.headers.get('x-ratelimit-remaining'),
      limit: res.headers.get('x-ratelimit-limit'),
      resetAt: res.headers.get('x-ratelimit-reset'),
      apiMessage: this.extractApiMessage(data, 'Forbidden'),
    };
    log.github.warn(refusalData, 'github-api-refused-403');
    this.deps.record({
      type: 'github.api.refused',
      component: 'github-api',
      level: 'warn',
      message: 'Refused by GitHub API (403)',
      data: refusalData,
    });
    // t/4202 SO C2: `retryAfterSec && ...` treated Retry-After: 0 ("retry immediately" per
    // spec) as falsy and skipped the retry. Check for a valid non-negative number instead,
    // and cap the resulting delay (MAX_REFUSAL_RETRY_DELAY_MS) against a malformed or
    // absurdly large header value.
    const hasValidRetryAfter = retryAfterSec !== null && !Number.isNaN(retryAfterSec) && retryAfterSec >= 0;
    if (!hasValidRetryAfter || attempt >= MAX_RETRIES) return null;
    return { action: 'retry', delayMs: Math.min(retryAfterSec * 1000, MAX_REFUSAL_RETRY_DELAY_MS) };
  }

  private async handleNonOkStatus(
    res: Response, data: unknown, text: string, attempt: number,
  ): Promise<NonOkOutcome> {
    if (res.status === 404) {
      return { action: 'return', result: { ok: false, status: 404, data, error: 'Not found' } };
    }
    if (res.status === 401 && attempt === 0) {
      const freshCreds = await this.deps.refreshCreds();
      if (freshCreds) return { action: 'retry', newCreds: freshCreds };
    }
    if (res.status === 409) {
      return { action: 'return', result: { ok: false, status: 409, data,
        error: 'Conflict — file was modified concurrently' } };
    }
    if (res.status === 422) {
      return { action: 'return', result: { ok: false, status: 422, data,
        error: this.extractApiMessage(data, 'Validation error') } };
    }
    if (res.status === 429) {
      this.deps.record({
        type: 'github.api.rate_limit',
        component: 'github-api',
        level: 'warn',
        message: 'Rate limited by GitHub API',
        data: { remaining: this.rateLimit.remaining, resetsAt: this.rateLimit.resetsAt },
      });
      // t/4258/t/4281: see updateRateLimit — deps.record() alone is console-invisible.
      // alert-github-rate-limit-critical's second OR-clause matches "github.api.rate_limit"
      // + "degraded"; this is the primary-429 arm of that alert.
      log.github.warn(
        { remaining: this.rateLimit.remaining, resetsAt: this.rateLimit.resetsAt },
        'github.api.rate_limit: degraded (429 rate limited by GitHub API)',
      );
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter && attempt < MAX_RETRIES) {
        return { action: 'retry', delayMs: parseInt(retryAfter, 10) * 1000 };
      }
    }
    // t/4202: GitHub's 403 is its own refusal class — secondary rate limit / abuse
    // detection, distinct from the primary 429 above — and until now fell through to
    // the generic handler below with none of its refusal headers captured. Logged
    // separately (not folded into github.api.rate_limit) so an alert can target this
    // specific refusal class without conflating it with ordinary primary-limit 429s.
    if (res.status === 403) {
      const outcome = this.handleGithubRefusal(res, data, attempt);
      if (outcome) return outcome;
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      this.onApiFailure();
      return { action: 'retry', delayMs: this.backoffMs(attempt) };
    }
    this.onApiFailure();
    return { action: 'return', result: { ok: false, status: res.status, data,
      error: this.extractApiMessage(data, text || `HTTP ${res.status}`) } };
  }

  private async handleNetworkError(
    err: unknown, startMs: number, method: string, pathAndQuery: string,
    attempt: number, callId: string | undefined, requestId: string,
  ): Promise<ApiResult | null> {
    const durationMs = Date.now() - startMs;
    this.deps.record({
      type: 'github.api.error',
      component: 'github-api',
      level: 'error',
      duration_ms: durationMs,
      call_id: callId,
      request_id: requestId,
      error: normalizeErrorForEvent(err),
      data: { method, endpoint: pathAndQuery, attempt, network_error: true },
    });
    this.onApiFailure();
    if (attempt < MAX_RETRIES) {
      await this.sleep(this.backoffMs(attempt));
      return null; // signal retry
    }
    return { ok: false, status: 0, data: null,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
  }

  private backoffMs(attempt: number): number {
    const base = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)];
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);
    return base + jitter;
  }

  private onApiSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.circuitState !== 'closed') {
      this.deps.record({
        type: 'github.api.circuit_break',
        component: 'github-api',
        level: 'info',
        message: `Circuit breaker: ${this.circuitState} → closed`,
        data: { previousState: this.circuitState },
      });
      this.circuitState = 'closed';
      this.probeIndex = 0;
    }
  }

  private onApiFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && this.circuitState === 'closed') {
      this.circuitState = 'open';
      this.circuitOpenedAt = Date.now();
      this.probeIndex = 0;
      // t/4202: FlightRecorder.record() only writes to an in-memory ring buffer — it
      // never reaches Pino/stdout, so it's invisible to ContainerAppConsoleLogs_CL and
      // any alert built on it would never fire (confirmed: 0 hits during the 10-13
      // outage, vs githubAPIBackend.ts's separate circuit-breaker-open Pino warn, which
      // had 31,747). This is the one circuit-breaker transition worth a console-visible
      // signal — fires once per open transition, not once per blocked call.
      log.github.warn({ consecutiveFailures: this.consecutiveFailures }, 'circuit-breaker-open-transition: closed → open');
      this.deps.record({
        type: 'github.api.circuit_break',
        component: 'github-api',
        level: 'warn',
        message: `Circuit breaker: closed → open (${this.consecutiveFailures} consecutive failures)`,
        data: { failures: this.consecutiveFailures },
      });
    }
  }

  private shouldProbe(): boolean {
    if (this.circuitState === 'closed') return true;

    const probeDelay = CIRCUIT_PROBE_SCHEDULE_MS[
      Math.min(this.probeIndex, CIRCUIT_PROBE_SCHEDULE_MS.length - 1)
    ];
    const elapsed = Date.now() - this.circuitOpenedAt;

    if (elapsed >= probeDelay) {
      this.circuitState = 'half-open';
      this.circuitOpenedAt = Date.now(); // Reset for next probe interval
      this.probeIndex = Math.min(this.probeIndex + 1, CIRCUIT_PROBE_SCHEDULE_MS.length - 1);

      this.deps.record({
        type: 'github.api.circuit_break',
        component: 'github-api',
        level: 'info',
        message: `Circuit breaker: probing (attempt ${this.probeIndex})`,
        data: { probeIndex: this.probeIndex, probeDelay },
      });
      return true;
    }

    return false;
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    const limit = headers.get('x-ratelimit-limit');
    const reset = headers.get('x-ratelimit-reset');

    if (remaining !== null) this.rateLimit.remaining = parseInt(remaining, 10);
    if (limit !== null) this.rateLimit.limit = parseInt(limit, 10);
    if (reset !== null) this.rateLimit.resetsAt = parseInt(reset, 10) * 1000;

    if (this.rateLimit.remaining < 1000) {
      // t/4258/t/4281: deps.record() alone writes only to FlightRecorder's
      // in-memory ring buffer — never console. alert-github-rate-limit-warning/
      // -critical (main.bicep) query ContainerAppConsoleLogs_CL for exactly
      // "github.api.rate_limit"/"remaining"/"degraded", so without the matching
      // log.github.warn below those alerts silently never fire (same class as
      // handleGithubRefusal's github-api-refused-403, which already does both).
      const degraded = this.rateLimit.remaining < 500;
      this.deps.record({
        type: 'github.api.rate_limit',
        component: 'github-api',
        level: degraded ? 'warn' : 'info',
        message: `Rate limit: ${this.rateLimit.remaining}/${this.rateLimit.limit} remaining`,
        data: { ...this.rateLimit },
      });
      log.github.warn(
        { ...this.rateLimit, degraded },
        `github.api.rate_limit: ${this.rateLimit.remaining}/${this.rateLimit.limit} remaining${degraded ? ' (degraded)' : ''}`,
      );
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** True when the circuit is open and not yet due for a probe — callers short-circuit. */
  isTripped(): boolean {
    return this.circuitState === 'open' && !this.shouldProbe();
  }

  // ── Diagnostics (GitHubAPIBackend delegates its accessors here) ────────────
  getRateLimitRemaining(): number { return this.rateLimit.remaining; }
  getRateLimitResetsAt(): string { return new Date(this.rateLimit.resetsAt).toISOString(); }
  getCircuitState(): CircuitState { return this.circuitState; }
}

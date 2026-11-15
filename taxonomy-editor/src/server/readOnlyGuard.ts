// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4296: rejects every mutating `/api/*` route for a read-only principal (e.g. the
// ai-triad-smoke test account). Kept out of server.ts (which boots an HTTP server at
// import, so it can't be imported by tests) so isMutatingApiRoute + enforceReadOnlyGuard
// are directly unit-testable, including an enumeration over the full route table
// (extractRoutes.ts) proving no mutating route can bypass this choke point.

import type { IncomingMessage, ServerResponse } from 'http';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { log } from './logger.js';
import * as proxyTiers from './ai/proxyTiers.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * t/4296 SO review (e/323#2, G1): `proxy-tiers.json` lives on the Azure Files share
 * both environments mount (t/4264). Its read/parse failure no longer fails open: an
 * unseen principal is read-only while it is down (t/183), and a seen one keeps its cached
 * flag. The env list is still the one source that needs no I/O: `READ_ONLY_PRINCIPALS` is a static, deploy-time, no-I/O list (set in
 * main.bicep baseEnv, verified by deploy-azure.yml's ExpectedEnvVars drift check) that
 * CANNOT fail open: it's parsed once from process.env at import, not read per-request.
 * Format: comma-separated `idp:principalName` pairs, e.g. `github:ai-triad-smoke`.
 * The effective flag is envList ∪ proxyTiers.readOnly (isReadOnly below) — either
 * source blocking is enough; neither source LIFTS a block the other imposes.
 */
function parseReadOnlyPrincipals(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).map(s => s.toLowerCase()),
  );
}
const READ_ONLY_PRINCIPALS = parseReadOnlyPrincipals(process.env.READ_ONLY_PRINCIPALS);

/** t/183: last-known-value cache for tier read-only flags, keyed by `${idp}:${principalName}`.
 *  Written on every successful resolve; read only when a resolve throws. In-memory, so it is
 *  empty after a restart. Known gap (accepted, t/183 TL decision): a principal made read-only
 *  after its last successful resolve keeps the cached `false` until the next successful resolve. */
const TIER_READ_ONLY_CACHE = new Map<string, boolean>();

/** t/4505: the parsed `idp:name` set, for the boot reachability check — no re-parse. */
export function getReadOnlyPrincipalEntries(): ReadonlySet<string> {
  return READ_ONLY_PRINCIPALS;
}

/** t/183: test-only. Empties the last-known-value cache so a test can start from a cold cache.
 *  Refuses outside vitest, so no production code path can clear it. */
export function clearReadOnlyCacheForTesting(): void {
  if (!process.env.VITEST) {
    throw new ActionableError({
      goal: 'Keep the read-only cache intact outside tests',
      problem: 'clearReadOnlyCacheForTesting was called outside a vitest run',
      location: 'readOnlyGuard.clearReadOnlyCacheForTesting',
      nextSteps: ['Call this only from a test file. Production code must not clear the read-only cache.'],
      code: 'READ_ONLY_CACHE_TEST_ONLY',
      httpStatus: 500,
    });
  }
  TIER_READ_ONLY_CACHE.clear();
}

/** Pure, I/O-free, cannot throw — the fail-closed half of the read-only flag. */
export function isEnvReadOnlyPrincipal(principalName: string, idp: string): boolean {
  if (!principalName || !idp) return false;
  return READ_ONLY_PRINCIPALS.has(`${idp}:${principalName}`.toLowerCase());
}

/** Same predicate shape as server.ts's enforceWriteRateLimit — a matched route, a
 *  mutating method, under `/api/*`. `routeMatched` stands in for `route` truthiness:
 *  an unmatched path (404) never reaches here regardless of tier. */
export function isMutatingApiRoute(method: string | undefined, reqPath: string, routeMatched: boolean): boolean {
  return routeMatched && !!method && MUTATING_METHODS.has(method) && reqPath.startsWith('/api/');
}

/** Resolves the caller's read-only flag from proxy-tiers.json (t/183).
 *  On success: cache the result.
 *  On failure: serve the cached value if this process has one (last-known-value).
 *  On failure with no cached value (a principal not yet seen since start, or during an outage):
 *  fail CLOSED, read-only, with a WARN that gives the reason. Replaces the earlier fail-open
 *  default (t/183 TL decision, Security concurred). */
function resolveConfigReadOnlyFlag(principalName: string, idp: string): boolean {
  const cacheKey = `${idp}:${principalName}`.toLowerCase();
  try {
    const resolved = proxyTiers.resolveTier(principalName, idp).readOnly ?? false;
    // Cache the successful result.
    TIER_READ_ONLY_CACHE.set(cacheKey, resolved);
    return resolved;
  } catch (err) {
    // Tier resolution failed. Try the cache first (last-known-value).
    const cached = TIER_READ_ONLY_CACHE.get(cacheKey);
    if (cached !== undefined) {
      log.server.warn({ component: 'read-only-guard', err, principalName, cached }, 'Tier resolution failed — serving cached read-only flag');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'read-only-guard', level: 'warn',
        message: 'resolveTier failed in resolveConfigReadOnlyFlag — serving cached value',
        data: { cached, principalName },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return cached;
    }

    // Not cached: this principal has not resolved in this process. Fail closed (read-only).
    log.server.warn({ component: 'read-only-guard', err, principalName, reason: 'tier-resolve-failed-no-cache' },
      'Tier resolution failed and no cached value — failing closed (read-only) for this principal');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'read-only-guard', level: 'warn',
      message: 'resolveTier failed in resolveConfigReadOnlyFlag — no cached value, failing closed (read-only)',
      data: { principalName, reason: 'tier-resolve-failed-no-cache' },
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return true;
  }
}

/** The effective read-only flag: the env list OR the config source (cached on outage, fail-closed
 *  when unseen). A proxy-tiers.json outage never lifts an env-listed principal's block. */
export function resolveReadOnlyFlag(principalName: string, idp: string): boolean {
  return isEnvReadOnlyPrincipal(principalName, idp) || resolveConfigReadOnlyFlag(principalName, idp);
}

/** Single choke point called from server.ts's dispatch — same call site as
 *  enforceWriteRateLimit, so a new route is covered automatically, never per-route.
 *  Returns true (and has already written the 403) when the caller is blocked. */
export function enforceReadOnlyGuard(
  req: IncomingMessage, res: ServerResponse,
  routeMatched: boolean, reqPath: string,
  principalName: string, idp: string,
): boolean {
  if (!isMutatingApiRoute(req.method, reqPath, routeMatched)) return false;
  if (!resolveReadOnlyFlag(principalName, idp)) return false;

  log.server.warn({ component: 'read-only-guard', method: req.method, path: reqPath, principalName }, 'Read-only account blocked from mutating route');
  res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'read_only' });
  res.end(JSON.stringify({ error: 'read_only', message: 'This account is read-only and cannot write.' }));
  return true;
}

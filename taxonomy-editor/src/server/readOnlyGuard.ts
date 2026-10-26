// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4296: rejects every mutating `/api/*` route for a read-only principal (e.g. the
// ai-triad-smoke test account). Kept out of server.ts (which boots an HTTP server at
// import, so it can't be imported by tests) so isMutatingApiRoute + enforceReadOnlyGuard
// are directly unit-testable, including an enumeration over the full route table
// (extractRoutes.ts) proving no mutating route can bypass this choke point.

import type { IncomingMessage, ServerResponse } from 'http';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { log } from './logger.js';
import * as proxyTiers from './ai/proxyTiers.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * t/4296 SO review (e/323#2, G1): `proxy-tiers.json` lives on the Azure Files share
 * both environments mount (t/4264) and `resolveReadOnlyFlag`'s own catch fails OPEN
 * on a read/parse failure — fine for an AI-quota setting, not fine for a containment
 * control. `READ_ONLY_PRINCIPALS` is a static, deploy-time, no-I/O list (set in
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

/** t/4505: the parsed `idp:name` set, for the boot reachability check — no re-parse. */
export function getReadOnlyPrincipalEntries(): ReadonlySet<string> {
  return READ_ONLY_PRINCIPALS;
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

/** Resolves the caller's read-only flag from proxy-tiers.json. A tier-resolution error
 *  defaults to NOT read-only (fail-open on THIS source only — see isEnvReadOnlyPrincipal
 *  above for the fail-closed source) with a WARN, rather than 500ing every write for
 *  every user on a transient proxy-tiers.json read failure. */
function resolveConfigReadOnlyFlag(principalName: string, idp: string): boolean {
  try {
    return proxyTiers.resolveTier(principalName, idp).readOnly ?? false;
  } catch (err) {
    log.server.warn({ component: 'read-only-guard', err, principalName }, 'Tier resolution failed — defaulting to not-read-only');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'read-only-guard', level: 'warn',
      message: 'resolveTier failed in resolveConfigReadOnlyFlag — defaulting to not-read-only',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

/** The effective read-only flag: the fail-closed env list OR the fail-open config
 *  source. A proxy-tiers.json outage never lifts an env-listed principal's block. */
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

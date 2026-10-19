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

/** Same predicate shape as server.ts's enforceWriteRateLimit — a matched route, a
 *  mutating method, under `/api/*`. `routeMatched` stands in for `route` truthiness:
 *  an unmatched path (404) never reaches here regardless of tier. */
export function isMutatingApiRoute(method: string | undefined, reqPath: string, routeMatched: boolean): boolean {
  return routeMatched && !!method && MUTATING_METHODS.has(method) && reqPath.startsWith('/api/');
}

/** Resolves the caller's read-only flag. A tier-resolution error defaults to NOT
 *  read-only (fail-open on this axis only — the account's actual AI tier/limits still
 *  gate it elsewhere) with a WARN, rather than 500ing every write for every user on a
 *  transient proxy-tiers.json read failure. */
export function resolveReadOnlyFlag(principalName: string, idp: string): boolean {
  try {
    return proxyTiers.resolveTier(principalName, idp).readOnly ?? false;
  } catch (err) {
    log.server.warn({ component: 'read-only-guard', err, principalName }, 'Tier resolution failed — defaulting to not-read-only');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'read-only-guard', level: 'warn',
      message: 'resolveTier failed in resolveReadOnlyFlag — defaulting to not-read-only',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
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

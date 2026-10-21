// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type http from 'http';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

// t/2532 (sec M12): dev-mode network-exposure hardening for the taxonomy-editor
// REST server. Extracted here as pure, import-safe functions (server.ts boots the
// HTTP server on import, so its logic can't be unit-tested directly — same pattern
// as publicPaths.ts). In the default non-production config the server previously
// bound 0.0.0.0, answered CORS with `*`, and did no Origin check — a drive-by web
// page could hit the dev's REST API. These functions bind loopback in dev, keep CORS
// to an explicit allowlist (never `*`), and gate cross-origin mutating requests.

/** The Vite dev-server origins the renderer legitimately calls the API from.
 *  Electron renderers use the IPC bridge (not REST), so no Electron origin is needed
 *  (TL t/2532#2). Vite's `strictPort: true` keeps this at 5173 — a silent bump to
 *  5174 would otherwise 403 every dev mutation. */
export const VITE_DEV_ORIGINS: readonly string[] = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

type Env = { NODE_ENV?: string; HOST?: string; ALLOWED_ORIGINS?: string };

/**
 * Interface to bind the HTTP server to. Loopback (`127.0.0.1`) in dev so the REST
 * API is unreachable from the LAN/remote; `0.0.0.0` in production (the container
 * must accept traffic on all interfaces). An explicit `HOST` lets a dev opt into
 * LAN exposure deliberately (surfaced by a startup warning via isNonLoopbackDevBind).
 */
export function resolveBindHost(env: Env): string {
  if (env.HOST) return env.HOST;
  return env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';
}

/** True when a dev run binds a non-loopback interface via HOST — worth a loud
 *  startup log because it exposes the otherwise-loopback dev API to the network. */
export function isNonLoopbackDevBind(env: Env): boolean {
  return env.NODE_ENV !== 'production' && !!env.HOST && !LOOPBACK_HOSTS.has(env.HOST);
}

/**
 * The CORS/WS origin allowlist — ALWAYS a concrete array (never null/`*`). Explicit
 * `ALLOWED_ORIGINS` wins in any mode; otherwise production yields `[]` (caller warns —
 * cross-origin rejected) and development defaults to the Vite dev origins.
 */
export function resolveAllowedOrigins(env: Env): string[] {
  if (env.ALLOWED_ORIGINS) {
    return env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  if (env.NODE_ENV === 'production') return [];
  return [...VITE_DEV_ORIGINS];
}

/** The value for `Access-Control-Allow-Origin`: the request origin when allowlisted,
 *  else the first allowlisted origin (or ''). NEVER `'*'`. */
export function corsOriginFor(origin: string, allowlist: readonly string[]): string {
  return allowlist.includes(origin) ? origin : (allowlist[0] ?? '');
}

/** True when `origin`'s host:port equals the request `Host` header — i.e. genuinely
 *  same-origin. Browser fetch/WebSocket always send Origin (even same-origin), so
 *  when the server serves the renderer itself (web / local prod at localhost:3000)
 *  every legitimate request is same-origin and must bypass the allowlist (TL t/2532#2). */
export function isSameOrigin(origin: string, host: string): boolean {
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { /* telemetry — silent by design; a malformed Origin is not same-origin */ return false; }
}

/**
 * The drive-by defense: true when a MUTATING request (POST/PUT/DELETE/PATCH) carries
 * a browser `Origin` that is neither same-origin nor allowlisted → reject (403).
 * Loopback binding alone doesn't stop a malicious page in the dev's own browser from
 * POSTing to `localhost:PORT`; this server-side check does. Absent Origin (curl,
 * same-origin navigations, non-browser) and non-mutating methods pass.
 */
export function isDisallowedCrossOriginMutation(
  method: string, origin: string | undefined, host: string | undefined, allowlist: readonly string[],
): boolean {
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  if (!origin) return false;
  if (host && isSameOrigin(origin, host)) return false;
  return !allowlist.includes(origin);
}

/** WebSocket-upgrade origin check (S-WS-ORIGIN + t/2532 same-origin): allow when
 *  same-origin or allowlisted; block otherwise. WS bypasses CORS, so this is enforced
 *  at the upgrade. */
export function isWebSocketOriginAllowed(origin: string, host: string | undefined, allowlist: readonly string[]): boolean {
  if (host && isSameOrigin(origin, host)) return true;
  return allowlist.includes(origin);
}

/**
 * Request-pipeline guard: if this is a disallowed cross-origin mutation (and not a
 * public path), send `403` and return true (caller must `return`); else return false.
 * Kept here (not inline in server.ts) to hold the core HTTP file under its line budget.
 */
export function enforceCrossOriginMutationGuard(
  req: http.IncomingMessage, res: http.ServerResponse, isPublicPath: boolean, allowlist: readonly string[],
): boolean {
  if (isPublicPath || !isDisallowedCrossOriginMutation(req.method || 'GET', req.headers.origin, req.headers.host, allowlist)) {
    return false;
  }
  // t/4406: the 403 used to be visible only in the response, so a log search for
  // cross_origin_blocked always came back empty. Origin and Host are not secrets.
  const data = { method: req.method, path: (req.url ?? '').split('?')[0], origin: req.headers.origin, host: req.headers.host };
  log.security.warn({ component: 'cross-origin-guard', ...data }, 'cross_origin_blocked: cross-origin mutation rejected');
  getGlobalRecorder()?.record({ type: 'system.error', component: 'cross-origin-guard', level: 'warn', message: 'cross_origin_blocked', data });
  res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'cross_origin_blocked' });
  res.end(JSON.stringify({ error: 'Cross-origin request blocked', reason: 'cross_origin_blocked' }));
  return true;
}

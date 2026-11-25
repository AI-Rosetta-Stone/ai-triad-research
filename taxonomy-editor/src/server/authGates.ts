// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/616 (TL p/16#376, Security p/93#69): the auth gate and the anonymous route guard, MOVED VERBATIM out of server.ts
// so a test can drive them over real HTTP (server.ts listens on import). Behaviour is unchanged: same order, same
// early returns, same status codes, headers and bodies. The only change is that the authorized-users lookups, which
// server.ts also uses elsewhere, are passed in as `deps` instead of being module functions here.

import type http from 'http';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { parseCookies } from './httpCookies.js';
import { anonRouteDecision } from './anonAiRoutes.js';
import { isAnonAllowedRoute } from './security/accessControl.js';
import * as proxyTiers from './ai/proxyTiers.js';
import { buildLoginPage, FORBIDDEN_PAGE, loginPageHeaders } from './loginPage.js';

/** The authorized-users lookups (server.ts owns the file cache). */
export interface AuthGateDeps {
  getAuthorizedUsers: () => unknown;
  isUserAuthorized: (principalName: string, idp: string) => boolean;
}

// ── Anonymous route guard ──
// When AUTH_OPTIONAL is enabled, anonymous users get read-only, non-AI access.
// Auth-gate 403 rejection reason codes, surfaced in the response and the flight
// recorder so a 403 can be triaged without reading the auth code (t/763).
export type AuthDenyReason = 'anon_route_blocked' | 'no_auth_header' | 'user_not_in_allowlist' | 'no_session';

export function recordAuthDenied(reason: AuthDenyReason, method: string, urlPath: string): void {
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'auth',
    level: 'warn',
    message: `Auth gate 403 (${reason}): ${method} ${urlPath}`,
  });
}

/** Read-mostly context shared by the auth-gate helpers. */
export interface AuthGateCtx {
  urlPath: string;
  isPublicPath: boolean;
  authDisabled: boolean;
  authOptional: boolean;
  principalName: string;
  idp: string;
}

/** AUTH_OPTIONAL mode gate: show login page / 401 unless signed in or anonymous. */
export function enforceOptionalAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  const { principalName, urlPath } = ctx;
  // Optional mode: show login page unless user signed in or chose anonymous
  if (principalName) return false;
  const isAnonymousSession = parseCookies(req).get('auth_anonymous') === '1';
  if (isAnonymousSession) return false;
  // t/1473: API clients can't act on an HTML login page — anonymous /api/*
  // calls (no auth_anonymous cookie) were getting 200 text/html, which the
  // client mis-parsed as "corrupted data" and got permanently stuck. Return
  // a structured 401 so the client can re-establish an anonymous session and
  // retry (client recovery is the child ticket). Mirrors the required-mode
  // /api/ check (t/763) but 401 (a session CAN be established here) not 403.
  // t/1501: skip 401 for routes that don't need a session — isAnonAllowedRoute
  // and freeTierRoute are designed for truly cookie-less anonymous access.
  if (urlPath.startsWith('/api/')) {
    const m = req.method || 'GET';
    // t/475: the one anonymous-route decision (anonRouteDecision), shared with the guard below.
    if (!anonRouteDecision(m, urlPath, proxyTiers.freeTierEnabled(), isAnonAllowedRoute)) {
      recordAuthDenied('no_session', m, urlPath);
      res.writeHead(401, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_session' });
      res.end(JSON.stringify({ error: 'Anonymous session required', reason: 'no_session' }));
      return true;
    }
  }
  res.writeHead(200, loginPageHeaders(req));
  res.end(buildLoginPage(true));
  return true;
}

/** Required-auth mode gate: must sign in and be in the allowlist. */
export function enforceRequiredAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx, deps: AuthGateDeps): boolean {
  const { principalName, idp, urlPath } = ctx;
  // Required mode: must sign in and be in the allowlist
  if (!principalName) {
    // API clients can't act on an HTML login page — return a structured 403
    // with a machine-readable reason (t/763). Browser routes keep the login
    // page so the sign-in flow is unchanged.
    if (urlPath.startsWith('/api/')) {
      recordAuthDenied('no_auth_header', req.method || 'GET', urlPath);
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_auth_header' });
      res.end(JSON.stringify({ error: 'Sign in required', reason: 'no_auth_header' }));
      return true;
    }
    res.writeHead(200, loginPageHeaders(req));
    res.end(buildLoginPage(false));
    return true;
  }

  if (!deps.isUserAuthorized(principalName, idp)) {
    recordAuthDenied('user_not_in_allowlist', req.method || 'GET', urlPath);
    // Browser-facing forbidden page; reason exposed via header for triage.
    res.writeHead(403, { 'Content-Type': 'text/html', 'X-Auth-Reason': 'user_not_in_allowlist' });
    res.end(FORBIDDEN_PAGE(principalName));
    return true;
  }
  return false;
}

/** Auth gate. Same control flow as before: public / kill-switch paths fall through;
 *  AUTH_OPTIONAL takes the optional gate; else the required gate runs iff authorized-users.json
 *  is present (original `else if (getAuthorizedUsers())`). Returns true when a response was sent. */
export function enforceAuthGate(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx, deps: AuthGateDeps): boolean {
  if (ctx.isPublicPath || ctx.authDisabled) return false;
  if (ctx.authOptional) return enforceOptionalAuthGate(req, res, ctx);
  if (deps.getAuthorizedUsers()) return enforceRequiredAuthGate(req, res, ctx, deps);
  return false;
}

/** Anonymous route guard: in AUTH_OPTIONAL mode, block AI + write routes. */
export function enforceAnonRouteGuard(req: http.IncomingMessage, res: http.ServerResponse, ctx: AuthGateCtx): boolean {
  const { authOptional, principalName, isPublicPath, urlPath } = ctx;
  // Anonymous route guard: in AUTH_OPTIONAL mode, block AI + write routes
  if (authOptional && !principalName && !isPublicPath) {
    const method = req.method || 'GET';
    // Free tier (t/793): when configured, keyless users may reach AI generation;
    // the handler enforces the free-tier model pin, per-IP limits, and key. Inert
    // until FREE_TIER_GEMINI_KEY is set, so the AI block otherwise stands.
    // t/475: the one anonymous-route decision (anonRouteDecision), shared with the optional-auth gate above.
    if (!anonRouteDecision(method, urlPath, proxyTiers.freeTierEnabled(), isAnonAllowedRoute)) {
      recordAuthDenied('anon_route_blocked', method, urlPath);
      res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'anon_route_blocked' });
      res.end(JSON.stringify({ error: 'Sign in required', reason: 'anon_route_blocked', detail: 'AI features and editing require authentication. Sign in at /.auth/login/github to unlock full access.' }));
      return true;
    }
  }
  return false;
}

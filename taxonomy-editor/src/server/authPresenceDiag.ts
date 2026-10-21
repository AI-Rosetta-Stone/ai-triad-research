// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4406 (TEMPORARY, TL p/806#11/#13): sign-ins reach Easy Auth's LoginComplete, but the app
// then sees the caller as `_local`. This tells the two failure shapes apart on /api/auth/me:
//   - session cookie present, principal headers absent → the sidecar is dropping it;
//   - no session cookie → the cookie isn't persisting in the browser.
// Presence only (yes/no and a chunk count) — never a cookie value, never a principal name.
// REMOVE after the t/4406 re-test (t/4409).
//
// Enablement (TL decision (a), p/806#20/#22) — on by default while hosted, so it ships with the
// next PI-approved deploy with no env var, CLI drift or Bicep change:
//   - past AUTH_PRESENCE_DIAG_EXPIRES_AT → off, always (one WARN), so it can't outlive t/4409;
//   - AUTH_PRESENCE_DIAG=0 → off (kill switch);  =1 → on (e.g. local);
//   - otherwise on when WEBSITE_AUTH_ENABLED is true (hosted, Easy Auth in front).

import type { IncomingMessage } from 'http';
import { log } from './logger.js';
import { parseCookies } from './httpCookies.js';

const PRINCIPAL_HEADERS = [
  'x-ms-client-principal',
  'x-ms-client-principal-name',
  'x-ms-client-principal-id',
  'x-ms-client-principal-idp',
] as const;

export interface AuthPresence {
  /** Easy Auth can chunk the session cookie (AppServiceAuthSession, AppServiceAuthSession1, …). */
  sessionCookieChunks: number;
  principalHeaders: Record<(typeof PRINCIPAL_HEADERS)[number], boolean>;
}

export function authPresence(req: IncomingMessage): AuthPresence {
  const names = [...parseCookies(req).keys()];
  const principalHeaders = Object.fromEntries(
    PRINCIPAL_HEADERS.map(h => [h, typeof req.headers[h] === 'string' && req.headers[h] !== '']),
  ) as AuthPresence['principalHeaders'];
  return {
    sessionCookieChunks: names.filter(n => n.startsWith('AppServiceAuthSession')).length,
    principalHeaders,
  };
}

/** Hard-coded expiry (TL p/806#20): today 2026-10-21 + the next PI-approved deploy (expected
 *  within ~7 days) + 7 days of logging. If that deploy slips, the logging window shrinks rather
 *  than the diagnostic outliving t/4409 — the intended trade-off. */
export const AUTH_PRESENCE_DIAG_EXPIRES_AT = Date.parse('2026-11-04T00:00:00Z');

type DiagEnv = { AUTH_PRESENCE_DIAG?: string; WEBSITE_AUTH_ENABLED?: string };

export function isAuthPresenceDiagEnabled(env: DiagEnv, now: number): boolean {
  if (now >= AUTH_PRESENCE_DIAG_EXPIRES_AT) return false;
  if (env.AUTH_PRESENCE_DIAG === '0') return false;
  if (env.AUTH_PRESENCE_DIAG === '1') return true;
  return env.WEBSITE_AUTH_ENABLED === 'true' || env.WEBSITE_AUTH_ENABLED === 'True';
}

let expiryWarned = false;

export function logAuthPresenceIfEnabled(req: IncomingMessage, now: number = Date.now()): void {
  if (now >= AUTH_PRESENCE_DIAG_EXPIRES_AT) {
    if (!expiryWarned) {
      expiryWarned = true;
      log.server.warn({ component: 'auth-presence-diag', expiredAt: new Date(AUTH_PRESENCE_DIAG_EXPIRES_AT).toISOString() },
        'auth-presence diagnostic expired and is now off — remove it (t/4409)');
    }
    return;
  }
  if (!isAuthPresenceDiagEnabled(process.env, now)) return;
  const p = authPresence(req);
  log.server.info({
    component: 'auth-presence-diag',
    sessionCookie: p.sessionCookieChunks > 0,
    sessionCookieChunks: p.sessionCookieChunks,
    ...p.principalHeaders,
  }, 'auth presence on /api/auth/me (t/4406, temporary)');
}

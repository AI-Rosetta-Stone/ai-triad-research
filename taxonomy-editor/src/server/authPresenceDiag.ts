// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4406 (TEMPORARY, TL p/806#11/#13): sign-ins reach Easy Auth's LoginComplete, but the app
// then sees the caller as `_local`. This tells the two failure shapes apart on /api/auth/me:
//   - session cookie present, principal headers absent → the sidecar is dropping it;
//   - no session cookie → the cookie isn't persisting in the browser.
// Presence only (yes/no and a chunk count) — never a cookie value, never a principal name.
// Off unless AUTH_PRESENCE_DIAG=1. REMOVE after the t/4406 re-test.

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

export function logAuthPresenceIfEnabled(req: IncomingMessage): void {
  if (process.env.AUTH_PRESENCE_DIAG !== '1') return;
  const p = authPresence(req);
  log.server.info({
    component: 'auth-presence-diag',
    sessionCookie: p.sessionCookieChunks > 0,
    sessionCookieChunks: p.sessionCookieChunks,
    ...p.principalHeaders,
  }, 'auth presence on /api/auth/me (t/4406, temporary)');
}

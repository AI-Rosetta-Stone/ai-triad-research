// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The two endpoints that start an anonymous session, MOVED out of server.ts (t/666; SO p/252#59) so they can be tested
// over HTTP. Behaviour is unchanged when the signing secret is loaded: GET /.auth/anonymous sets the cookies and 302s to
// the app; POST /api/auth/anonymous (the bridge's session-recovery path) sets them and returns JSON 200.
// New: with no `anon-session-hmac` secret, minting a signed cookie throws (t/664 fails closed). That throw used to escape
// the request handler as an unhandled rejection, so the response was never written and both endpoints HUNG, leaving no
// way in for a new anonymous visitor. It is now caught here: 503 with a short HTML page for the GET link, 503 JSON
// `anon_session_unavailable` for the POST, plus a WARN. No cookie is set.

import type http from 'http';
import { anonSessionCookiesWithCreated } from './routes/session.js';
import { log } from './logger.js';
import { getClientIp } from './httpKit.js';
import { checkRate } from './security/rateLimiter.js';
import { getConfig } from './runtimeConfig.js';
import { parseCookies } from './httpCookies.js';
import { verifyAnonSessionCookie } from './security/anonSessionSigning.js';

const UNAVAILABLE_MESSAGE = 'Anonymous sessions are temporarily unavailable. Sign in to continue, or try again later.';

function refuseUnavailable(res: http.ServerResponse, asJson: boolean, err: unknown): void {
  log.server.warn({ component: 'anon-session', reason: 'anon_session_unavailable', err: (err as Error)?.name ?? String(err) }, 'Anonymous session refused: signing unavailable (t/664 fail closed)');
  if (res.headersSent) { res.end(); return; }
  if (asJson) {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'anon_session_unavailable', message: UNAVAILABLE_MESSAGE }));
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '60' });
  res.end(`<!doctype html><meta charset="utf-8"><title>Unavailable</title><p>${UNAVAILABLE_MESSAGE}</p><p><a href="/">Back</a></p>`);
}

const MINT_WINDOW_MS = 3_600_000;

/** t/818: a request that carries a VALID signed session cookie is not a mint (it keeps its session), so only a request that
 *  would create a NEW id counts against the per-IP limit; the parallel 401-recovery POSTs of one page load keep the first
 *  cookie and are never counted. True when the request was refused (429 written). The IP is never logged. */
function refuseOverMintLimit(req: http.IncomingMessage, res: http.ServerResponse, asJson: boolean): boolean {
  if (verifyAnonSessionCookie(parseCookies(req).get('anon_session_id'))) return false;
  const limit = getConfig().sessions.anonMintPerIpPerHour;
  const r = checkRate(`anon-mint:${getClientIp(req)}`, limit, MINT_WINDOW_MS);
  if (r.allowed) return false;
  const retryAfter = Math.max(1, Math.ceil((r.retryAfterMs ?? MINT_WINDOW_MS) / 1000));
  log.server.warn({ component: 'anon-session', reason: 'anon_mint_rate_limited', limit, retryAfterSeconds: retryAfter }, 'Anonymous session mint refused: too many new sessions from this address in the last hour (t/818)');
  if (res.headersSent) { res.end(); return true; }
  if (asJson) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
    res.end(JSON.stringify({ error: 'anon_session_rate_limited', message: 'Too many new sessions from this address. Try again later, or sign in.', retryAfter }));
    return true;
  }
  res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': String(retryAfter) });
  res.end('<!doctype html><meta charset="utf-8"><title>Too many sessions</title><p>Too many new sessions from this address. Try again later, or sign in.</p><p><a href="/">Back</a></p>');
  return true;
}

/** Handle GET /.auth/anonymous and POST /api/auth/anonymous. True when a response was written. Never throws. */
export function handleAnonAuthEndpoints(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, authOptional: boolean): boolean {
  // /.auth/anonymous: sets a session cookie and redirects to the app (browser link on the login page).
  // POST /api/auth/anonymous below is the JSON sibling.
  if (urlPath === '/.auth/anonymous' && authOptional) {
    if (refuseOverMintLimit(req, res, false)) return true;
    try {
      const cookies = anonSessionCookiesWithCreated(req); // t/2464 (id) + t/2493 (created marker on fresh mint)
      res.writeHead(302, { 'Location': '/', 'Set-Cookie': cookies });
      res.end();
    } catch (err) { log.server.warn({ component: 'anon-session' }, 'GET /.auth/anonymous: could not mint a session'); refuseUnavailable(res, false, err); }
    return true;
  }

  // POST /api/auth/anonymous: JSON sibling of GET /.auth/anonymous (t/1483, follow-up from t/1476). Establishes an
  // anonymous session for programmatic callers (the web-bridge session-recovery path) with the same two cookies but a
  // JSON 200 instead of a 302 + ~2KB HTML round-trip. Must run before the auth gate: the caller has no session yet.
  // POST-only so a stray GET still falls through to the 302 link / login page. The session id stays in the HttpOnly
  // cookie and is never echoed in the body.
  if (urlPath === '/api/auth/anonymous' && req.method === 'POST' && authOptional) {
    if (refuseOverMintLimit(req, res, true)) return true;
    try {
      const cookies = anonSessionCookiesWithCreated(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookies });
      res.end(JSON.stringify({ ok: true, anonymous: true }));
    } catch (err) { log.server.warn({ component: 'anon-session' }, 'POST /api/auth/anonymous: could not mint a session'); refuseUnavailable(res, true, err); }
    return true;
  }
  return false;
}

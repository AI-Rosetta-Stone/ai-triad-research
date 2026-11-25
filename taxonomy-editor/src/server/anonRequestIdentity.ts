// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/500 (t/666; Security p/93#110): the anonymous half of the per-request identity, extracted from server.ts's
// resolveRequestUserContext (server.ts listens on import) so it can be tested through a real HTTP request.
//   - storageUserId: from the RAW signed cookie, via anonymousStorageUserId (which verifies it): `anon-<uuid>` for a
//     valid signature, `_local` for anything else.
//   - anonymousSessionId: the VERIFIED uuid (or undefined), never the raw cookie, so getAnonymousSessionId() and the
//     keys built on it can't trust an unverified value.
// The bug this fixes: passing the already-verified uuid to anonymousStorageUserId re-verified a bare uuid, which never
// verifies, so every anonymous visitor got `_local`.

import type { IncomingMessage, ServerResponse } from 'http';
import { parseCookies } from './httpCookies.js';
import { anonymousStorageUserId, isAuthDisabledMode } from './security/userContext.js';
import { verifyAnonSessionCookie } from './security/anonSessionSigning.js';

export function anonRequestIdentity(req: IncomingMessage): { storageUserId: string; anonymousSessionId: string | undefined } {
  const rawAnon = parseCookies(req).get('anon_session_id');
  return { storageUserId: anonymousStorageUserId(rawAnon), anonymousSessionId: verifyAnonSessionCookie(rawAnon) };
}

/**
 * t/500 (TL p/16#417): at the signed-cookie cutover, every existing anonymous visitor's bare-uuid cookie stops verifying,
 * so their storage id becomes `_local`, the local owner's store. Until the client re-mints a signed cookie, a
 * per-visitor read (chats, debates, op-ed sets, preferences, ...) could then serve the owner's data. So a HOSTED anonymous
 * `/api/` request with no verified session is refused before any handler runs: 401 `no_session` (the optional-auth
 * gate's body), which the client's fetchWithSessionRecovery answers by minting a signed session and retrying.
 * One central check, so no per-visitor route can be missed.
 * Not refused: signed-in requests; local AUTH_DISABLED mode (every request is `_local` by design); required-auth mode
 * (no anonymous requests); public paths; non-API paths (the SPA shell); and GET /api/auth/me, the client's identity probe,
 * which reads no per-visitor store. The mint endpoints run before this (anonAuthEndpoints.ts). True when written.
 */
export function refuseUnkeyedHostedAnonymous(
  req: IncomingMessage, res: ServerResponse,
  opts: { urlPath: string; isPublicPath: boolean; principalName: string; authOptional: boolean },
): boolean {
  if (opts.principalName || !opts.authOptional || isAuthDisabledMode() || opts.isPublicPath) return false;
  if (!opts.urlPath.startsWith('/api/') || opts.urlPath === '/api/auth/me') return false;
  if (anonRequestIdentity(req).storageUserId !== '_local') return false;
  res.writeHead(401, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_session' });
  res.end(JSON.stringify({ error: 'Anonymous session required', reason: 'no_session' }));
  return true;
}

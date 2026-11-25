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

import type { IncomingMessage } from 'http';
import { parseCookies } from './httpCookies.js';
import { anonymousStorageUserId } from './security/userContext.js';
import { verifyAnonSessionCookie } from './security/anonSessionSigning.js';

export function anonRequestIdentity(req: IncomingMessage): { storageUserId: string; anonymousSessionId: string | undefined } {
  const rawAnon = parseCookies(req).get('anon_session_id');
  return { storageUserId: anonymousStorageUserId(rawAnon), anonymousSessionId: verifyAnonSessionCookie(rawAnon) };
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/677 (TL p/16#435, PI: sign-in only, t/574#13): source snapshots and source-document files are for signed-in users.
// A hosted anonymous caller gets the standard sign-in-required 403, the same shape as the gate's anon_route_blocked, so
// the renderer (t/678) shows its sign-in prompt for either. Local AUTH_DISABLED mode (the operator, every request
// anonymous by design) is not hosted and is unaffected.

import type { ServerResponse } from 'http';
import { isHostedAnonymousRequest } from '../security/userContext.js';

/** Refuse a hosted anonymous caller with 403 anon_route_blocked. True when the response was written. */
export function refuseAnonymousSignInRequired(res: ServerResponse): boolean {
  if (!isHostedAnonymousRequest()) return false;
  res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'anon_route_blocked' });
  res.end(JSON.stringify({ error: 'Sign in required', reason: 'anon_route_blocked', detail: 'Source documents require authentication. Sign in at /.auth/login/github to read them.' }));
  return true;
}

/** t/677 (Rosetta Stone p/74#30, TL p/10#315): what a hosted anonymous caller may know about a source document:
 *  whether it exists and its type, and that signing in is required. Never content, path or any other text field. */
export function anonSourceDocumentView(doc: { available?: unknown; type?: unknown }): { available: boolean; type: unknown; signInRequired: true } {
  return { available: doc.available === true, type: doc.type ?? null, signInRequired: true };
}

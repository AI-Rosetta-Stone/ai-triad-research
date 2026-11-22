// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (TL p/16#209, SO): the two anonymous-only checks on POST /api/oped-sets. Kept out of
// routes/oped.ts so that file stays under its complexity threshold.

import type { IncomingMessage, ServerResponse } from 'http';
import { json, error, getClientIp } from '../httpKit.js';
import { checkRate } from '../security/rateLimiter.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';

/** Anonymous URL-source fetches allowed per client per hour (each one is an outbound request). */
const ANON_URL_FETCH_LIMIT = 5;
const ANON_URL_FETCH_WINDOW_MS = 60 * 60_000;

/** Refuses (403, nothing written) an anonymous caller whose storage key is the shared '_local' store,
 *  i.e. one with no anon_session_id cookie. Returns true when the response has been written. */
export function refuseUnkeyedAnonymousOpEd(res: ServerResponse): boolean {
  if (!(isAnonymousUser() && getStorageUserId() === '_local')) return false;
  error(res, 'Start an anonymous session to create op-eds: reload the page, or sign in.', 403);
  return true;
}

/** Limits anonymous URL-source fetches per client IP. Returns true (429 written) when over the limit.
 *  A signed-in caller, or a request with no URL, is never limited here. */
export function refuseAnonymousUrlFetch(req: IncomingMessage, res: ServerResponse, url: string | undefined): boolean {
  if (!url || !isAnonymousUser()) return false;
  const rl = checkRate(`oped-url-anon:${getClientIp(req)}`, ANON_URL_FETCH_LIMIT, ANON_URL_FETCH_WINDOW_MS);
  if (rl.allowed) return false;
  json(res, { error: 'rate_limited', message: 'Too many URL sources from this client; try again later.' }, 429);
  return true;
}

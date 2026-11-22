// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (TL p/16#209, SO): the two anonymous-only checks on POST /api/oped-sets. Kept out of
// routes/oped.ts so that file stays under its complexity threshold.

import type { IncomingMessage, ServerResponse } from 'http';
import { json, error, getClientIp } from '../httpKit.js';
import { checkRate } from '../security/rateLimiter.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { anonOpEdCeilingBreach } from '../storage/anonOpEdSpend.js';
import { log } from '../logger.js';

/** Anonymous URL-source fetches allowed per client per hour (each one is an outbound request). */
const ANON_URL_FETCH_LIMIT = 5;
const ANON_URL_FETCH_WINDOW_MS = 60 * 60_000;

/** t/467 (TL p/16#211): the one pre-start gate for anonymous op-ed creation, run before the run is
 *  registered. Refuses (403) a caller with no session key, and (429) any run once the daily or monthly
 *  spend ceiling is reached, with a WARN giving the ceiling. Returns true when the response was written. */
export async function refuseAnonymousOpEdGate(res: ServerResponse): Promise<boolean> {
  if (refuseUnkeyedAnonymousOpEd(res)) return true;
  if (!isAnonymousUser()) return false;
  const ceiling = await anonOpEdCeilingBreach();
  if (ceiling === null) return false;
  log.server.warn({ component: 'oped', reason: 'anon-oped-spend-ceiling', ceiling }, `Anonymous op-ed refused: ${ceiling} spend ceiling reached`);
  json(res, { error: 'spend_ceiling', ceiling, message: 'Anonymous op-ed creation is paused: the spend limit has been reached. Sign in or try again later.' }, 429);
  return true;
}

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

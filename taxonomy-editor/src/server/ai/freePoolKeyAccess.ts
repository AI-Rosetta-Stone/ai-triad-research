// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4486 (t/4410 item 2) — the ONLY request-path reader of FREE_TIER_GEMINI_KEY for key
// INJECTION (as opposed to counting/diagnostics — see proxyTiers.freeTierKeyCount()). Every
// route that injects the free-tier key pool into an AI call MUST go through `getFreePoolKeys`
// here, so the geo restriction (freePoolGeoGuard.ts) applies uniformly. TL review (t/4486#2)
// found a route (`/api/nli/classify`) that read the pool directly and never touched
// `generationContext.ts`'s resolveGenerationContext/enforceBackendAllowed gate — a guard placed
// there alone would have missed it. Putting the guard at the injection point instead closes that
// class for good: __tests__/freePoolKeyAccessSoleReader.test.ts fails if a fourth call site
// starts reading the pool directly.
//
// Allowlisted readers of FREE_TIER_GEMINI_KEY / parseFreeTierKeys OUTSIDE this file (boot +
// count-only, never injection — see the sole-reader test for the enforced list):
//   - ai/proxyTiers.ts        (defines parseFreeTierKeys + its own count/rpm helpers)
//   - ai/keyRotator.ts:50     (boot-time pool membership set)
//   - server.ts               (boot diagnostics log line)
//   - routes/meta.ts          (via proxyTiers.freeTierKeyCount(), not a direct read)

import type http from 'http';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getClientIp } from '../httpKit.js';
import * as proxyTiers from './proxyTiers.js';
import { checkFreePoolGeo } from './freePoolGeoGuard.js';

export const FREE_POOL_REGION_ERROR = 'free_pool_region';
const FREE_POOL_REGION_MESSAGE =
  "Free AI access isn't available in your region. Add your own key (from a billing-enabled Google project) in Settings → API Keys.";

export type FreePoolKeyResult = { ok: true; keys: string[] } | { ok: false };

/** Log a geo refusal: country + reason only (AC3) — never the IP. */
function logGeoRefusal(country: string | null, reason: string | undefined): void {
  log.api.warn(
    { component: 'free-pool-geo', country, reason },
    'Free-pool key request refused by region',
  );
  getGlobalRecorder()?.record({
    type: 'ai.error', component: 'free-pool-geo', level: 'warn',
    message: 'Free-pool key request refused by region',
    data: { country, reason },
  });
}

/** Resolve the free-tier key pool for THIS request, after the geo gate. Writes a 403
 *  `free_pool_region` and returns `{ ok: false }` when the caller's region is restricted or
 *  its IP can't be resolved (fail-closed). On `{ ok: true }`, `keys` may still be an empty
 *  array — callers keep their existing "pool not configured" (503) handling for that case;
 *  this function only ever adds the geo 403 in front of it. */
export async function getFreePoolKeys(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<FreePoolKeyResult> {
  const geo = await checkFreePoolGeo(getClientIp(req));
  if (!geo.allowed) {
    logGeoRefusal(geo.country, geo.reason);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: FREE_POOL_REGION_ERROR, message: FREE_POOL_REGION_MESSAGE }));
    return { ok: false };
  }
  return { ok: true, keys: proxyTiers.parseFreeTierKeys(process.env.FREE_TIER_GEMINI_KEY) };
}

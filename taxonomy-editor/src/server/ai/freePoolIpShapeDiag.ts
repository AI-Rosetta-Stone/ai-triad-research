// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4486#4 (TEMPORARY). The TL's review asked to either ship full IPv6 range support or prove
// the IPv6 client share is near-zero from prod logs before shipping IPv4-only. Azure checked:
// no client IP reaches the app's own request logs today, and Easy Auth's sidecar never proxies
// /api/ai/* or /api/nli/classify — so there's no existing data to pull (p/793#46). This is the
// one log line that creates it: the derived IP's SHAPE only (never the IP itself), once per
// free-pool request, so Azure can pull real counts after a representative window (p/793#48).
//
// Shapes: 'ipv4' | 'ipv4-mapped-ipv6' | 'ipv6-genuine' | 'no-public-ip'. REMOVE after Azure has
// pulled a representative window's counts and the IPv4-only-vs-ship-IPv6 decision is made.
//
// Deliberately self-contained (does NOT import ai/freePoolGeoGuard.ts's classifier) — this file
// is called FROM that module, so importing back would be circular. The shape logic here is a
// small, independent duplicate; drifting from the real classifier only costs a mis-shaped log
// line in a temporary diagnostic, never a wrong refusal (that decision stays solely in
// freePoolGeoGuard.ts).

import { log } from '../logger.js';

export type IpShape = 'ipv4' | 'ipv4-mapped-ipv6' | 'ipv6-genuine' | 'no-public-ip';

function looksLikeIpv4(s: string): boolean {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s)
    && s.split('.').every(p => Number(p) <= 255);
}

export function classifyIpShape(ip: string): IpShape {
  let s = ip.trim();
  const bracketed = s.match(/^\[(.+)\]:\d+$/);
  if (bracketed) s = bracketed[1];
  s = s.split('%')[0];
  const mapped = s.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return looksLikeIpv4(mapped[1]) ? 'ipv4-mapped-ipv6' : 'no-public-ip';
  if (looksLikeIpv4(s)) return 'ipv4';
  if (s.includes(':')) return 'ipv6-genuine';
  return 'no-public-ip';
}

/** Hard-coded expiry: ~3 weeks from ship, enough for Azure's "representative window" ask
 *  (p/793#46) without this outliving its purpose. Past it, the function becomes a one-WARN
 *  no-op rather than logging forever — same pattern as authPresenceDiag.ts (t/4406). */
export const FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT = Date.parse('2026-11-15T00:00:00Z');

let expiryWarned = false;

/** Log the shape of `ip` (as `getClientIp` returned it) — once per free-pool request, both
 *  allowed and refused. Called from `ai/freePoolGeoGuard.ts`'s `checkFreePoolGeo`, the one
 *  choke point every free-pool request already passes through. */
export function logIpShapeIfEnabled(ip: string, now: number = Date.now()): void {
  if (now >= FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT) {
    if (!expiryWarned) {
      expiryWarned = true;
      log.api.warn(
        { component: 'free-pool-ip-shape-diag', expiredAt: new Date(FREE_POOL_IP_SHAPE_DIAG_EXPIRES_AT).toISOString() },
        'free-pool IP-shape diagnostic expired and is now off — remove it (t/4486#4)',
      );
    }
    return;
  }
  log.api.info({ component: 'free-pool-ip-shape-diag', shape: classifyIpShape(ip) }, 'free-pool client IP shape (t/4486#4, temporary)');
}

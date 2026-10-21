// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4410 item 1 (TEMPORARY, TL p/806#30): the getClientIp() fix must be based on the header the
// app actually receives behind ACA ingress + the Easy Auth sidecar (Azure p/806#25), not on an
// assumed hop count. This echoes the caller's own forwarding headers back to them so a curl with a
// forged X-Forwarded-For shows exactly what arrives.
//
// Guards (TL p/806#30):
//   1. STAGING ONLY — isStagingIdentity() keys on CONTAINER_APP_NAME, which the platform injects;
//      anywhere else this answers 404, as if the route didn't exist.
//   2. ALLOWLIST ONLY — X-Forwarded-*, X-Real-IP, Forwarded, and the socket peer. Never cookies,
//      Authorization, or x-ms-* principal/token headers: anything not on the allowlist is dropped.
// REMOVE after the getClientIp() fix lands (tracked on t/4410).

import type { IncomingMessage } from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { isStagingIdentity } from '../config.js';

export const DIAG_FORWARDED_PATH = '/api/diag/forwarded-headers';

export function forwardingHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const n = name.toLowerCase();
    const allowed = n.startsWith('x-forwarded-') || n === 'x-real-ip' || n === 'forwarded';
    if (allowed && value !== undefined) out[n] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export function registerDiagForwardedRoutes(r: Router, _ctx: ServerCtx): void {
  const { get } = r;
  // Literal path, not DIAG_FORWARDED_PATH: extractRoutes.ts (routeTable.test.ts) reads it statically.
  get('/api/diag/forwarded-headers', (req, res) => {
    if (!isStagingIdentity()) { error(res, 'Not found', 404); return; }
    json(res, {
      headers: forwardingHeaders(req),
      socketRemoteAddress: req.socket?.remoteAddress ?? null,
    });
  });
}

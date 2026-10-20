// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4300 (TL ruling, p/538#101/p/522#436): measures what the GitHub call budget actually
// counts — outbound REST requests by route class + the latest x-ratelimit-remaining — not
// cache misses (getColdCacheMissCount() instruments only 1 of 4 fetch paths and misses
// session-branch reads entirely, Server Storage t/4300#18). Kept out of server.ts (which
// boots an HTTP server at import, so it can't be imported by tests) so
// logRequestMetrics is directly unit-testable.

import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import type { GitHubAPIBackend } from './storage/githubAPIBackend.js';

/** ~10min past the typical warm-up window — see coldCacheMissLog.ts's prior rationale
 *  (this replaces that approach; same delay shape). */
export const REQUEST_METRICS_LOG_DELAY_MS = 10 * 60_000;

/** Logs GitHubAPIBackend's outbound-request metrics once, tagged with `context` (e.g.
 *  '10min-post-boot' or 'shutdown') so the two call sites are distinguishable in Log
 *  Analytics. No-op in filesystem mode (no GitHubAPIBackend, nothing to measure). */
export function logRequestMetrics(backend: GitHubAPIBackend | null, context: string): void {
  if (!backend) return;
  const { totalRequests, byRouteClass, rateLimitRemaining } = backend.getRequestMetrics();
  const message = `GitHub request metrics (${context}): ${totalRequests} total, ${rateLimitRemaining} rate-limit remaining`;
  log.server.info({ component: 'storage', context, totalRequests, byRouteClass, rateLimitRemaining }, message);
  getGlobalRecorder()?.record({
    type: 'lifecycle', component: 'storage', level: 'info', message,
    data: { context, totalRequests, byRouteClass, rateLimitRemaining },
  });
}

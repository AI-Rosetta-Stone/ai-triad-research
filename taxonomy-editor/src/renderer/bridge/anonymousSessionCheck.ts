// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Extracted from web-bridge.ts (t/4116 CI: web-bridge.ts was at the 1500-line cap) — own
// module per the TL's "move the t/4628 logic" instruction, rather than raising the limit.
//
// Uses bare fetch() intentionally, same as web-bridge.ts's own isAnonymous() it mirrors — this
// hits the same /api/auth/me endpoint with the same no-bridge-helper shape, just relocated for
// the line budget. Not yet in AGENTS.md's bare-fetch exception list (that list names files, and
// this one didn't exist when it was written) — flagging for a doc update rather than silently
// extending the exception list myself.

import { getGlobalRecorder } from '@lib/flight-recorder/index';

/**
 * t/4628: model/backend selection needs the opposite fail-safe from web-bridge.ts's own
 * isAnonymous()'s other callers. isAnonymous() caches `true` on a non-OK response or a network
 * error — a reasonable restrictive default for the things it already gates, but wrong here: if
 * a signed-in user's /api/auth/me check fails on a flaky load, treating them as anonymous would
 * strip their saved model AND stop persisting their in-visit choice. So this resolves `false`
 * (signed-in behavior) on any failure, with its own WARN, and only shares the memoized
 * `_authAnonymous` cache (passed in via getCached/setCached, since it lives in web-bridge.ts)
 * on a successful response — never writes `true` to it on failure, so isAnonymous()'s own
 * fail-safe stays untouched. TL condition, t/4628#2 item 1.
 */
export async function checkAnonymousSessionForModelSelection(
  getCached: () => boolean | null,
  setCached: (value: boolean) => void,
): Promise<boolean> {
  const cached = getCached();
  if (cached !== null) return cached;
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      const anonymous = !!data.anonymous;
      setCached(anonymous);
      return anonymous;
    }
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: `Auth check returned ${res.status}; treating session as signed-in for model selection`, error: { name: 'AuthCheckNonOk', message: `status ${res.status}`, stack: '' } });
    return false;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: 'Auth check failed; treating session as signed-in for model selection', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    return false;
  }
}

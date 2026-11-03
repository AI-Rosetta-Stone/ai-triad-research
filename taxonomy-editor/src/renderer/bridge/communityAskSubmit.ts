// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Mechanical extraction from web-bridge.ts (ADR-007 §2 — cohesive split, no behavior change) to
// make room for t/4746's new AppAPI method without exceeding the file's max-lines ceiling (1500,
// no baseline entry). Built directly on resilience.ts's public resilientFetch rather than
// web-bridge.ts's private post() — this endpoint (POST /api/community/submit/draft) is
// deliberately unauthenticated (t/4612 F1), so post()'s session-recovery wrapper doesn't apply.

import { resilientFetch, categorizeEndpoint } from './resilience';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

// Matches web-bridge.ts's own DEFAULT_MUTATION_TIMEOUT_MS (documented independently in
// embeddingsBatch.ts) — kept as a local literal rather than importing a private const.
const MUTATION_TIMEOUT_MS = 180_000;

/** Upload the full InquiryResult to the unauthenticated community draft endpoint (t/4746,
 *  t/4612) — a desktop Ask result has no server-side counterpart to load (t/4611), so this is
 *  the only way it can ever be published. Never auto-approved; always lands in the moderation
 *  queue. A non-ok response's server-supplied error message is thrown verbatim (t/4611: every
 *  failure must reach the renderer, never swallowed). */
export async function submitAskToCommunityRest(
  result: unknown,
  note: string,
): Promise<{ draftId: string; link: string }> {
  const path = '/api/community/submit/draft';
  let res: Response;
  try {
    res = await resilientFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, note }),
    }, {
      timeoutMs: MUTATION_TIMEOUT_MS,
      maxRetries: 0, // non-idempotent POST
      critical: true,
      category: categorizeEndpoint(path, 'POST'),
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'web-bridge', level: 'error',
      message: `POST ${path} network error`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

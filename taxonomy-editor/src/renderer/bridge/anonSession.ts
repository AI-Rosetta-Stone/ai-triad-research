// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/467 (Design p/25#196 b): what the anonymous-session mint (POST /api/auth/anonymous) answered. Without the
// signing secret the server refuses with 503 { error: 'anon_session_unavailable' } and Retry-After 60
// (server/anonAuthEndpoints.ts). The bridge hands that refusal to the caller in place of the 401 no_session it
// was recovering from, so the caller can say why instead of 'Anonymous session required'.
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export const ANON_SESSION_UNAVAILABLE = 'anon_session_unavailable';

export type AnonMintOutcome = 'ok' | 'failed' | 'unavailable';

/** Classify the mint's response. Anything but a 2xx or the named 503 is a plain failure. */
export async function anonMintOutcome(res: Response): Promise<AnonMintOutcome> {
  if (res.ok) return 'ok';
  if (res.status !== 503) return 'failed';
  try {
    const data = await res.clone().json() as Record<string, unknown>;
    if (data.error !== ANON_SESSION_UNAVAILABLE) return 'failed';
  } catch { /* telemetry — silent by design: a non-JSON 503 is simply not the named refusal */
    return 'failed';
  }
  getGlobalRecorder()?.record({
    type: 'auth.session-recovery', component: 'web-bridge', level: 'warn',
    message: 'WARN: the server cannot start anonymous sessions right now (503 anon_session_unavailable); the request that needed one gets this refusal in place of its 401',
  });
  return 'unavailable';
}

/** The refusal handed to a caller whose request needed a session that couldn't be started. */
export function anonSessionUnavailableResponse(): Response {
  return new Response(JSON.stringify({ error: ANON_SESSION_UNAVAILABLE }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
  });
}

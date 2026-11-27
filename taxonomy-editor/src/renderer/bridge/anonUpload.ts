// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (TL p/16#466, #477; TaxonomyServer p/74#45, #49): the server keeps no `diagnostics`, `dialectical_diagnostics`
// or `turn_validations[*].attempts[*].stage_diagnostics` on an anonymous visitor's debate save (about 305 KB per
// validated statement of stage_diagnostics alone). The server strip is the control; this is the matching renderer
// half, so an anonymous visitor doesn't upload megabytes the server throws away. It strips the OUTGOING copy only:
// the in-memory debate keeps its diagnostics for this tab, and a reload simply has none.
//
// Fail open: the strip applies only when the server has said the caller is anonymous. A failed or non-OK auth check
// strips nothing (the server strips anyway), so a signed-in user is never stripped by a hiccup.

import type { DebateSession, DebateDelta } from '@lib/debate/types';
import { resilientFetch, categorizeEndpoint } from './resilience';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

type Attempt = Record<string, unknown> & { stage_diagnostics?: unknown };
type Trail = { attempts?: Attempt[] } & Record<string, unknown>;

function trailsWithoutStageDiagnostics(trails: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [id, trail] of Object.entries(trails)) {
    const t = trail as Trail;
    if (!Array.isArray(t?.attempts) || !t.attempts.some(a => a && 'stage_diagnostics' in a)) { out[id] = trail; continue; }
    out[id] = { ...t, attempts: t.attempts.map(({ stage_diagnostics: _dropped, ...rest }) => rest) };
  }
  return out;
}

/** A copy of the session (or a partial of it) without the fields the server won't keep for an anonymous visitor.
 *  Returns the argument itself when there is nothing to strip. */
export function stripAnonymousFields<T extends Partial<DebateSession>>(session: T): T {
  const { diagnostics: _d, dialectical_diagnostics: _dd, ...rest } = session as Partial<DebateSession> & Record<string, unknown>;
  const hadTop = 'diagnostics' in session || 'dialectical_diagnostics' in session;
  const trails = (session as Partial<DebateSession>).turn_validations as Record<string, unknown> | undefined;
  const strippedTrails = trails ? trailsWithoutStageDiagnostics(trails) : undefined;
  const trailsChanged = !!trails && Object.entries(trails).some(([id, t]) => strippedTrails![id] !== t);
  if (!hadTop && !trailsChanged) return session;
  return { ...rest, ...(strippedTrails ? { turn_validations: strippedTrails } : {}) } as unknown as T;
}

/** A delta whose generic overlay (`changedFields`) carries none of those fields. */
export function stripAnonymousDelta(delta: DebateDelta): DebateDelta {
  if (!delta.changedFields) return delta;
  const changedFields = stripAnonymousFields(delta.changedFields);
  return changedFields === delta.changedFields ? delta : { ...delta, changedFields };
}

let anonymousConfirmed: Promise<boolean> | null = null;

/** True only when `/api/auth/me` answered and said anonymous. Cached once it has answered; a failure is not cached. */
export function isConfirmedAnonymous(): Promise<boolean> {
  if (!anonymousConfirmed) {
    anonymousConfirmed = (async () => {
      const res = await resilientFetch('/api/auth/me', { method: 'GET' }, { timeoutMs: 10_000, maxRetries: 0, critical: false, category: categorizeEndpoint('/api/auth/me', 'GET') });
      if (!res.ok) return false;
      return ((await res.json()) as { anonymous?: unknown }).anonymous === true;
    })().catch((err: unknown) => {
      anonymousConfirmed = null; // try again on the next save
      getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: 'WARN: auth check for the anonymous upload strip failed; the save goes out unstripped (the server strips anyway)', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      return false;
    });
  }
  return anonymousConfirmed;
}

/** Test seam: forget the cached auth answer. */
export function resetAnonymousUploadCache(): void { anonymousConfirmed = null; }

/** The session as it should go up: stripped when the caller is confirmed anonymous. Typed on `unknown` because the
 *  bridge's `saveDebateSession` takes one; a non-object is passed through untouched. */
export async function sessionForUpload<T>(session: T): Promise<T> {
  if (!session || typeof session !== 'object') return session;
  return (await isConfirmedAnonymous()) ? stripAnonymousFields(session as Partial<DebateSession>) as T : session;
}

export async function deltaForUpload(delta: DebateDelta): Promise<DebateDelta> {
  return (await isConfirmedAnonymous()) ? stripAnonymousDelta(delta) : delta;
}

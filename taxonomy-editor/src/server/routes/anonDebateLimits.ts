// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/723 / t/724 (PI decision 2026-11-26; design rev 2, t/724#4; Security t/724#3 and #5): a hosted ANONYMOUS visitor
// may run Quick Take debates only. The debate loop runs in the renderer and the server never sees a preset id, so the
// control is three checks, all for hosted anonymous callers only (signed-in users and the desktop are untouched):
//
//   B1. The shared '_local' arm (no cookie, or an unsigned, forged or rotated-out one) is refused before any read or
//       write: every such caller would otherwise share one saved session.
//   A.  A saved session must be Quick Take shaped. A positive allow-list: anything the check doesn't recognise is
//       refused, not ignored (Security B4).
//   B.  A debate AI call must belong to a saved Quick Take session under the CALLER'S OWN storage. The lookup is only
//       ever under the caller's own key, so another visitor's id, a signed-in user's id and a missing id all take the
//       same path and get the same answer (no existence leak).
//
// The per-debate call ceiling and the per-day debate limit (check C) are a separate, server-owned record and are not
// in this file yet. They are NOT the spend control: a client can leave `debateId` off. The per-visitor spend control
// is the daily token bucket (t/731) plus the free pool's daily cap.

import type { ServerResponse } from 'http';
import { getStorageUserId, isHostedAnonymousRequest } from '../security/userContext.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { applyDebateDelta } from '../../../../lib/debate/applyDebateDelta.js';
import type { DebateDelta, DebateSession } from '../../../../lib/debate/types/session.js';

/** The only protocol a Quick Take uses (NewDebateDialog PRESET_DEFAULTS.quick). */
export const ANON_DEBATE_PROTOCOL = 'structured';
/** Rounds per phase a Quick Take may ask for (confrontation / argumentation / concluding). */
export const ANON_DEBATE_MAX_ROUNDS_PER_PHASE = 1;
/** The AI debaters. The visitor may also take a seat ('user' in active_povers); their own entries are not AI turns. */
const AI_DEBATERS: ReadonlySet<string> = new Set(['accelerationist', 'safetyist', 'skeptic']);
/** Every transcript entry type the debate code writes (lib/debate/types/session.ts TranscriptEntry.type). */
const KNOWN_ENTRY_TYPES: ReadonlySet<string> = new Set([
  'clarification', 'answer', 'opening', 'statement', 'question', 'concluding', 'probing', 'fact-check', 'reflection',
  'system', 'intervention',
]);
const NON_DEBATER_SPEAKERS: ReadonlySet<string> = new Set(['user', 'system', 'moderator']);

/** The most transcript entries the AI debaters may have between them: the OBSERVED maximum of a finished Quick Take,
 *  not one more (TL p/16#455). Measured on saved Quick Take shaped debates (structured, rounds 1/1/1; t/724): with
 *  three debaters 24 of 29 finished at 12 and the longest at 13 (3 openings + 10 statements); with two debaters the
 *  longest was 10 (2 + 8). 3 x debaters + 4 gives exactly those two maxima; one debater (7) is extrapolated.
 *  This caps length; it does not by itself tell a Quick Take from a Deep dive (several Deep dives finish at 13).
 *  The declared protocol and rounds do that. */
export function anonDebateMaxDebaterEntries(debaters: number): number {
  return 3 * debaters + 4;
}
/** PROVISIONAL until the staging measurement (t/724#7): total transcript entries. The largest measured Quick Take
 *  shaped debate had 35 entries; Deep dive shaped ones reached 56. */
export const ANON_DEBATE_MAX_TOTAL_ENTRIES = 45;

/** True for the only callers these limits apply to. Synchronous, so a route can skip the async checks (and their
 *  extra await) for everyone else. */
export function anonDebateLimitsApply(): boolean {
  return isHostedAnonymousRequest();
}

export type AnonDebateLimitCode = 'anon_debate_kind' | 'anon_debate_turns' | 'anon_debate_unsaved' | 'anon_oped_voices';
export interface AnonDebateViolation { code: AnonDebateLimitCode; detail: string; limit?: number }

const MESSAGES: Record<AnonDebateLimitCode, string> = {
  anon_debate_kind: 'Without an account you can run Quick Take debates. Sign in to use Deep dive and Socratic.',
  anon_debate_turns: 'This debate is longer than a Quick Take. Sign in to continue it.',
  anon_debate_unsaved: 'This debate is not available to continue. Start a new Quick Take, or sign in.',
  anon_oped_voices: 'Without an account an op-ed has one voice. Sign in to write with more.',
};

function kind(detail: string): AnonDebateViolation { return { code: 'anon_debate_kind', detail }; }

function roundsViolation(session: Record<string, unknown>): AnonDebateViolation | null {
  const staging = session.adaptive_staging as { step_mode?: unknown; phase_bounds_override?: Record<string, unknown> } | undefined;
  if (staging?.step_mode === true) return kind('step_mode');
  const override = staging?.phase_bounds_override;
  if (!override || typeof override !== 'object') return kind('rounds_missing');
  for (const key of ['maxConfrontationRounds', 'maxArgumentationRounds', 'maxConcludingRounds']) {
    const n = override[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > ANON_DEBATE_MAX_ROUNDS_PER_PHASE) return kind(`rounds_${key}`);
  }
  return null;
}

/** The AI debaters named in active_povers, or null when the list is malformed, repeats a seat, names an unknown
 *  speaker, or has no AI debater at all. */
function debatersOf(session: Record<string, unknown>): string[] | null {
  const povers = session.active_povers;
  if (!Array.isArray(povers) || povers.length === 0) return null;
  const seen = new Set<string>();
  for (const p of povers) {
    if (typeof p !== 'string' || !(AI_DEBATERS.has(p) || p === 'user') || seen.has(p)) return null;
    seen.add(p);
  }
  seen.delete('user');
  return seen.size > 0 ? [...seen] : null;
}

function transcriptViolation(session: Record<string, unknown>, debaters: string[]): AnonDebateViolation | null {
  const transcript = session.transcript ?? [];
  if (!Array.isArray(transcript)) return kind('transcript_not_array');
  const maxDebaterEntries = anonDebateMaxDebaterEntries(debaters.length);
  if (transcript.length > ANON_DEBATE_MAX_TOTAL_ENTRIES) return { code: 'anon_debate_turns', detail: 'total_entries', limit: ANON_DEBATE_MAX_TOTAL_ENTRIES };
  let debaterEntries = 0;
  for (const entry of transcript as Array<{ type?: unknown; speaker?: unknown }>) {
    if (!entry || typeof entry !== 'object') return kind('entry_not_object');
    if (typeof entry.type !== 'string' || !KNOWN_ENTRY_TYPES.has(entry.type)) return kind('entry_type');
    const speaker = entry.speaker;
    if (typeof speaker !== 'string') return kind('entry_speaker');
    // Any entry spoken by a debater counts as a turn, whatever its type, so a turn can't hide under another label.
    if (debaters.includes(speaker)) debaterEntries++;
    else if (!NON_DEBATER_SPEAKERS.has(speaker)) return kind('entry_speaker');
  }
  if (debaterEntries > maxDebaterEntries) return { code: 'anon_debate_turns', detail: 'debater_entries', limit: maxDebaterEntries };
  return null;
}

/** Check A, pure: why `session` is not a Quick Take an anonymous visitor may save or continue, or null when it is. */
export function anonDebateShapeViolation(session: unknown): AnonDebateViolation | null {
  if (!session || typeof session !== 'object') return kind('not_object');
  const s = session as Record<string, unknown>;
  if (s.protocol_id !== ANON_DEBATE_PROTOCOL) return kind('protocol');
  // Security p/93#142: the Talmudic and Socratic moderators are a moderator MODE, not a protocol, so a client could pair
  // protocol 'structured' with moderator_mode 'talmudic'. The renderer writes 'standard' (debateEngine.ts:974) or nothing.
  if (s.moderator_mode !== undefined && s.moderator_mode !== 'standard') return kind('moderator_mode');
  const debaters = debatersOf(s);
  if (!debaters) return kind('debaters');
  return roundsViolation(s) ?? transcriptViolation(s, debaters);
}

/** Writes the one refusal shape for an anonymous limit (t/724 rev 2 code table). The log line carries the code and a
 *  fixed route pattern, never the raw path (it holds a debate id). */
export function refuseAnonLimit(res: ServerResponse, routePattern: string, v: AnonDebateViolation): true {
  log.api.warn({ component: 'anon-limits', route: routePattern, code: v.code, detail: v.detail }, 'Anonymous request refused: over the anonymous limits (t/723)');
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'anon-limits', level: 'warn',
    message: `Anonymous request refused: ${v.code}`, data: { route: routePattern, code: v.code, detail: v.detail },
  });
  res.writeHead(403, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'anon_limit' });
  res.end(JSON.stringify({
    error: MESSAGES[v.code], reason: 'anon_limit', code: v.code, signInRequired: true, retryable: false,
    ...(v.limit !== undefined ? { limit: v.limit } : {}),
  }));
  return true;
}

/** TL ruling p/16#466 (data minimisation): a hosted anonymous save does not keep `diagnostics` (the raw prompts, raw
 *  responses and taxonomy context of each AI call: developer data that holds more of the visitor's text than the
 *  24-hour promise needs, and about 74 KB per entry). Removed in place from a PUT body (the session) or a PATCH body
 *  (`meta.diagnostics` and `changedFields.diagnostics`) BEFORE the shape check and the write. Logs once per save at
 *  DEBUG with the byte count, never the content. Not stripped: argument_network, topic.suggested_critique (the next
 *  largest fields; the TL decides those). Returns the bytes removed. */
export function stripAnonDiagnostics(payload: unknown, route: string): number {
  if (!isHostedAnonymousRequest() || !payload || typeof payload !== 'object') return 0;
  const p = payload as Record<string, unknown>;
  let bytes = 0;
  const dropKey = (holder: unknown, key: string): void => {
    if (!holder || typeof holder !== 'object') return;
    const h = holder as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(h, key)) return;
    bytes += Buffer.byteLength(JSON.stringify(h[key] ?? null));
    delete h[key];
  };
  const drop = (holder: unknown): void => dropKey(holder, 'diagnostics');
  drop(p);
  drop(p.meta);
  drop(p.changedFields);
  dropKey(p, 'dialectical_diagnostics'); // Security p/93#142: Talmudic per-round records (model prose); a hostile client could send them
  dropKey(p.meta, 'dialectical_diagnostics');
  dropKey(p.changedFields, 'dialectical_diagnostics');
  if (bytes > 0) log.api.debug({ component: 'anon-limits', route, stripped_bytes: bytes }, 'Anonymous debate save: diagnostics stripped (t/723)');
  return bytes;
}

/** B1: a hosted anonymous caller on the shared '_local' store is refused (401 no_session) before any read or write.
 *  True when the response was written. */
export function refuseUnkeyedAnonDebate(res: ServerResponse, routePattern: string): boolean {
  if (!(isHostedAnonymousRequest() && getStorageUserId() === '_local')) return false;
  log.api.warn({ component: 'anon-limits', route: routePattern, code: 'no_session' }, 'Anonymous debate request refused: no valid anonymous session (t/723)');
  res.writeHead(401, { 'Content-Type': 'application/json', 'X-Auth-Reason': 'no_session' });
  res.end(JSON.stringify({ error: 'Anonymous session required', reason: 'no_session' }));
  return true;
}

// ── Check B's cache: what the caller's own saved session looked like ────────────────────────────────────────────
// Keyed by storage id + debate id. A positive entry lives at most 60 s, because an invalidation only reaches the
// replica that served the write (Security t/724#5). A negative lives 2 s, so the first AI call after the first save
// is not refused for long on another replica.

type ShapeVerdict = AnonDebateViolation | null;
interface CacheEntry { verdict: ShapeVerdict; expiresAt: number }
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 2_000;
const MAX_CACHE_ENTRIES = 5_000;
const shapeCache = new Map<string, CacheEntry>();

function cacheKey(debateId: string): string { return `${getStorageUserId()}\u0000${debateId}`; }

/** Drop the caller's cached verdict for `debateId`. Call after every PUT, PATCH and DELETE of it. */
export function invalidateAnonDebateShape(debateId: string | undefined): void {
  if (debateId) shapeCache.delete(cacheKey(debateId));
}

/** Test seam. */
export function _resetAnonDebateShapeCacheForTest(): void { shapeCache.clear(); }

function remember(key: string, verdict: ShapeVerdict, now: number): void {
  if (shapeCache.size >= MAX_CACHE_ENTRIES) shapeCache.clear(); // bounded; a cleared cache only costs a re-read
  shapeCache.set(key, { verdict, expiresAt: now + (verdict === null ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
}

const UNSAVED: AnonDebateViolation = { code: 'anon_debate_unsaved', detail: 'no_own_session' };

/** Loads a debate from the CALLER'S OWN storage only (fileIO.loadDebateSession resolves the caller from the request
 *  context). Null when the caller has no such debate. */
export type LoadOwnDebate = (debateId: string) => Promise<unknown>;

/** Check A on a full save (PUT /api/debates). True when the response was written; nothing may be stored then. */
export function refuseAnonDebateSave(res: ServerResponse, session: unknown): boolean {
  if (!isHostedAnonymousRequest()) return false;
  if (refuseUnkeyedAnonDebate(res, 'PUT /api/debates')) return true;
  const v = anonDebateShapeViolation(session);
  return v ? refuseAnonLimit(res, 'PUT /api/debates', v) : false;
}

/** True when the delta changes nothing but the title: the one write still allowed on an over-limit debate. */
function isTitleOnlyDelta(delta: DebateDelta): boolean {
  const empty = (a: unknown): boolean => a === undefined || (Array.isArray(a) && a.length === 0);
  const d = delta as unknown as Record<string, unknown>;
  const allowedKeys = new Set(['debateId', 'baseVersion', 'newTranscriptEntries', 'changedNodes', 'changedEdges', 'removedNodeIds', 'removedEdgeIds', 'newMutations', 'meta']);
  if (Object.keys(d).some(k => !allowedKeys.has(k))) return false;
  if (!['newTranscriptEntries', 'changedNodes', 'changedEdges', 'removedNodeIds', 'removedEdgeIds', 'newMutations'].every(k => empty(d[k]))) return false;
  const meta = d.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return false;
  const keys = Object.keys(meta);
  return keys.length > 0 && keys.every(k => k === 'title' || k === 'updated_at') && typeof meta.title === 'string';
}

/** Check A on a delta save (PATCH /api/debates/:id): the check runs on the server's own merge of the caller's stored
 *  session and the delta, before the write. A missing session or a stale base version is left to the storage layer,
 *  which answers 409 version_conflict as before. True when the response was written. */
export async function refuseAnonDebatePatch(res: ServerResponse, delta: DebateDelta, loadOwn: LoadOwnDebate): Promise<boolean> {
  if (!isHostedAnonymousRequest()) return false;
  const route = 'PATCH /api/debates/:id';
  if (refuseUnkeyedAnonDebate(res, route)) return true;
  const existing = await loadOwn(delta.debateId) as DebateSession | null;
  if (!existing) return false;
  if ((existing._saveVersion ?? 0) !== delta.baseVersion) return false;
  if (isTitleOnlyDelta(delta)) return false;
  const v = anonDebateShapeViolation(applyDebateDelta(existing, delta));
  return v ? refuseAnonLimit(res, route, v) : false;
}

/** Checks B1 and B on a debate AI call (POST /api/ai/generate with a debateId). True when the response was written;
 *  nothing may be reserved, counted or sent then. */
export async function refuseAnonDebateCall(res: ServerResponse, debateId: string | undefined, loadOwn: LoadOwnDebate, now: number = Date.now()): Promise<boolean> {
  if (!debateId || !isHostedAnonymousRequest()) return false;
  const route = 'POST /api/ai/generate';
  if (refuseUnkeyedAnonDebate(res, route)) return true;
  const key = cacheKey(debateId);
  const cached = shapeCache.get(key);
  let verdict: ShapeVerdict;
  if (cached && cached.expiresAt > now) {
    verdict = cached.verdict;
  } else {
    let own: unknown = null;
    try {
      own = await loadOwn(debateId);
    } catch (err) {
      // An unsafe id, or a storage failure: refuse (fail closed), exactly as for a debate that isn't there.
      log.api.warn({ component: 'anon-limits', route, err }, 'Anonymous debate call refused: the saved session could not be read (fail closed, t/723)');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'anon-limits', level: 'warn', message: 'Anonymous debate session read failed; refusing the call',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    verdict = own ? anonDebateShapeViolation(own) : UNSAVED;
    remember(key, verdict, now);
  }
  return verdict ? refuseAnonLimit(res, route, verdict) : false;
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Op-Ed create streaming (SSE) transport for the web bridge (t/2614). Extracted as a leaf
 * module (like chatStream.ts) so web-bridge.ts stays under the max-lines cap and the SSE
 * parse/dispatch is unit-testable in isolation.
 *
 * Shape-identical to the Electron IPC (opedHandlers.ts): createOpEdSet resolves `{set_id}`
 * or rejects with an ActionableError; onOpEdProgress callbacks fire per voice as the run
 * streams. The per-voice stage mapping matches Electron EXACTLY so desktop and web render
 * the same live panel.
 *
 * Server contract (POST /api/oped-sets, t/2610 — SSE):
 *   200 text/event-stream, each frame: data: {runId, seq, event}
 *     event {type:'run_started', runId}
 *     event {type:'voice_start'|'voice_complete'|'voice_failed'|'voice_cancelled', pov, ...}
 *     event {type:'grounding_done'|'grounding_failed', ...}   (set-level — not per-voice)
 *     event {type:'complete', set}                            → resolve {set_id: set.set_id}
 *     event {type:'error', message}                           → reject
 *   Pre-SSE failures (403 anon / 429 quota|concurrency / 400 / 403 entitlement) arrive
 *   instead as a non-200 JSON body BEFORE the stream headers.
 * Recovery (t/2610): a dropped stream re-fetches GET /api/oped-runs/:runId — a terminal
 * status resolves with the durable set_id (the set is finalized server-side); the run never
 * orphans the UI.
 */

import { ActionableError } from '@lib/debate/errors';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { categorizeEndpoint, type ResilientFetchOptions } from './resilience';
import type { CreateOpEdPayload, OpEdProgressEvent } from './types';
import { preStreamFreePoolCode, midStreamFreePoolCode, freePoolError, type FreePoolCode } from './opedFreePool';

type OpEdProgressCb = (event: OpEdProgressEvent) => void;
const progressCbs = new Set<OpEdProgressCb>();

/** Subscription surface exposed via the bridge's onOpEdProgress method. */
export const opedProgressBus = {
  onProgress: (cb: OpEdProgressCb): (() => void) => { progressCbs.add(cb); return () => { progressCbs.delete(cb); }; },
};

// A web build runs at most one create at a time (mirrors the server's per-user concurrency
// cap of 1). Cancel = abort the in-flight POST → the server's res.on('close') cancels the
// in-flight voices and still finalizes the partial set (t/2610 gap 1).
let activeAbort: AbortController | null = null;

/** Abort the in-flight web op-ed run, if any (bridge cancelOpEdSet on web). */
export function cancelActiveOpEdRun(): void {
  activeAbort?.abort();
}

const OPED_STREAM_TIMEOUT_MS = 300_000; // multi-voice generation: 30s–2min per voice × N

function errShape(err: unknown): { name: string; message: string; stack?: string } {
  return { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack };
}

function emitProgress(event: OpEdProgressEvent): void {
  for (const cb of progressCbs) {
    try { cb(event); } catch { /* telemetry — silent by design */ }
  }
}

/** Parse an SSE byte stream, invoking `onEvent` once per `data:` JSON payload. */
async function consumeSse(res: Response, onEvent: (evt: Record<string, unknown>) => void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s?/, '')).join('\n');
      if (!data) continue; // heartbeat ': ping' comment or blank
      try { onEvent(JSON.parse(data) as Record<string, unknown>); }
      catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'warn', message: 'oped-stream: malformed SSE data frame', error: errShape(err) }); }
    }
  }
}

/** Plain-language copy for the server's document-source 400s (routes/oped.ts). Wording is Design's
 *  (t/276, p/25#110). Returns null for any other message, so the server's text is kept. */
export function documentSourceProblem(serverMessage: string): string | null {
  if (serverMessage.startsWith('documentText exceeds')) {
    return 'This document is too long. Use a shorter document. Documents can be up to 500,000 characters of text.';
  }
  if (serverMessage.startsWith('sourceName exceeds')) {
    return 'The file name is too long. Shorten the file name, then choose the file again.';
  }
  if (serverMessage.startsWith('sourceName must be a bare file name')) {
    return 'This file name contains a slash or "..". Rename the file to remove them, then choose it again.';
  }
  if (serverMessage.includes('is required with')) {
    return "We couldn't read this document. It may be empty or in a format we can't read. Choose the file again.";
  }
  return null;
}

/** t/467: the anonymous ceilings and URL-fetch limit answer with their own server text. Those are shown as
 *  sent, not as the plan-limit copy, which would mislabel a spend pause as a plan limit. */
function anonLimitError(goal: string, data: Record<string, unknown>): ActionableError {
  const problem = (data.message as string) || 'Too many requests. Try again later.';
  // The spend-ceiling text already ends with the sign-in advice, so the next step says only to wait.
  const nextSteps = data.error === 'spend_ceiling'
    ? ['Try again later']
    : ['Try again later', 'Use a topic instead of a web page'];
  return new ActionableError({ goal, problem, location: 'opedStream.runOpEdCreate', nextSteps });
}

/** The user's next step for a refused create. An unpriced model (403, t/467) needs a different model, not sign-in. */
function createNextSteps(status: number, problem: string): string[] {
  if (status !== 403) return ['Check your topic and selected voices, then try again'];
  if (/no price on file/.test(problem)) return ['Choose a different model in Settings'];
  if (/anonymous session/.test(problem)) return ['Reload the page, or sign in with GitHub or Google'];
  return ['Sign in with GitHub or Google to create op-eds'];
}

/** A refused create that is not a rate limit (400, 403, other). Split out of buildHttpError to keep it
 *  inside the complexity budget. */
function refusedCreateError(goal: string, data: Record<string, unknown>, status: number, isDocument: boolean): ActionableError {
  const serverProblem = (typeof data.error === 'string' && data.error) || (typeof data.message === 'string' && data.message) || `Create failed with HTTP ${status}`;
  // t/276: a document-source 400 gets Design's plain-language copy; anything else keeps the server's text.
  const problem = (isDocument && status === 400 && documentSourceProblem(serverProblem)) || serverProblem;
  // t/475: the auth gate's refusal carries its own user text in `detail`; show it instead of the bare error.
  const detail = data.reason === 'anon_route_blocked' && typeof data.detail === 'string' ? data.detail : undefined;
  return new ActionableError({ goal, problem, location: 'opedStream.runOpEdCreate', nextSteps: detail ? [detail] : createNextSteps(status, problem) });
}

/** Build a user-readable ActionableError from a non-200 create response (JSON error emitted
 *  before the SSE headers: 403 anon, 400 bad request, 403 entitlement, 429 quota/concurrency).
 *  `isDocument` is set for a document-source create, so its 400s get the plain-language copy. */
async function buildHttpError(res: Response, isDocument: boolean): Promise<ActionableError> {
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  // t/467: free-pool and anonymous-limit refusals carry a code the dialog maps to Design's copy.
  const pool = preStreamFreePoolCode(res.status, data);
  if (pool) return freePoolError({ code: pool, midStream: false }, { status: res.status, body: data });
  const goal = 'Op-Ed Studio: create an op-ed';
  const anonLimit = res.status === 429 && (data.error === 'spend_ceiling' || data.error === 'rate_limited');
  let err: ActionableError;
  if (anonLimit) {
    err = anonLimitError(goal, data);
  } else if (res.status === 429) {
    const concurrency = data.error === 'concurrency_limit';
    err = new ActionableError({
      goal,
      problem: concurrency ? (data.message as string) || 'You already have an op-ed generating — wait for it to finish.' : 'You have reached your op-ed limit. Delete an op-ed or try again later.',
      location: 'opedStream.runOpEdCreate',
      nextSteps: concurrency ? ['Wait for the current op-ed to finish, then try again'] : ['Delete an existing op-ed to free a slot', 'Try again later'],
    });
  } else {
    err = refusedCreateError(goal, data, res.status, isDocument);
  }
  (err as ActionableError & { httpStatus: number }).httpStatus = res.status;
  return err;
}

/** Map a lib/oped generator event → the bridge's per-voice {set_id, voice, stage, error}
 *  shape, matching Electron opedHandlers exactly. Returns null for non-per-voice events
 *  (grounding breadcrumbs / run_started / complete are handled by the caller). */
function toProgress(event: Record<string, unknown>): OpEdProgressEvent | null {
  const pov = typeof event.pov === 'string' ? event.pov : '';
  switch (event.type) {
    case 'voice_start': return { set_id: '', voice: pov, stage: 'generating' };
    case 'voice_complete': return { set_id: '', voice: pov, stage: 'complete' };
    // t/467: a pool refusal's raw text isn't shown; the dialog says why once the run ends.
    case 'voice_failed': return { set_id: '', voice: pov, stage: 'failed', error: typeof event.error === 'string' && !midStreamFreePoolCode(event.code) ? event.error : undefined };
    case 'voice_cancelled': return { set_id: '', voice: pov, stage: 'cancelled' };
    default: return null; // grounding_done/failed (set-level) + run_started/complete
  }
}

/** The run's 'error' frame as a create error: a free-pool code (t/467) or the frame's own text. `setId` is the
 *  one run_started gave (t/703; optional until that server change is deployed), so the dialog can check the set. */
function streamErrorFor(event: Record<string, unknown>, setId: string | undefined): ActionableError {
  const pool = midStreamFreePoolCode(event.code);
  if (pool) return freePoolError({ code: pool, midStream: true, ...(setId ? { setId } : {}) }, event);
  const evtProblem = typeof event.problem === 'string' ? event.problem : (typeof event.message === 'string' ? event.message : 'Op-ed generation failed on the server.');
  return new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: evtProblem, location: 'opedStream.runOpEdCreate', nextSteps: ['Try creating it again', 'Check My Op-Eds — a partial op-ed may have been saved'] });
}

/** A finished stream's outcome: the run's error, a pool stop (t/467: the core completed with whatever finished, and
 *  the dialog checks the set and says so), or the created set. Null when the stream gave no answer.
 *  t/741: a pool stop is reported even when the stream ended without 'complete'. The set id is then run_started's
 *  (t/703) when the server sent one; without it the dialog says some voices may have been saved. Run-status recovery
 *  would lose the pool code, and an anonymous visitor can't read the run status anyway. */
function settleRun(streamError: ActionableError | null, stoppedBy: FreePoolCode | null, setId: string | null, startedSetId: string | undefined): { set_id: string } | null {
  if (streamError) throw streamError;
  if (stoppedBy) {
    const id = setId ?? startedSetId;
    throw freePoolError({ code: stoppedBy, midStream: true, ...(id ? { setId: id } : {}) }, { setId: id ?? null, completeFrame: setId !== null });
  }
  return setId ? { set_id: setId } : null;
}

/** The web bridge's session-recovering fetch (injected to avoid a circular import). */
type OpEdFetch = (path: string, init: RequestInit, opts: ResilientFetchOptions) => Promise<Response>;

/** Recover a dropped stream: a terminal run resolves with the durable set_id; still-running
 *  or missing → surface as an interruption the user can retry (the set may exist in My Library). */
async function recoverFromRunStatus(fetchFn: OpEdFetch, runId: string): Promise<{ set_id: string }> {
  const path = `/api/oped-runs/${encodeURIComponent(runId)}`;
  const res = await fetchFn(path, { method: 'GET' }, { timeoutMs: 30_000, maxRetries: 1, critical: false, category: categorizeEndpoint(path, 'GET') });
  if (!res.ok) throw new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: 'The op-ed stream was interrupted and its run could not be recovered.', location: 'opedStream.recoverFromRunStatus', nextSteps: ['Check My Op-Eds — it may have finished', 'Try creating it again'] });
  const run = await res.json() as { setId?: string; status?: string };
  if ((run.status === 'complete' || run.status === 'cancelled') && typeof run.setId === 'string') return { set_id: run.setId };
  throw new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: run.status === 'error' ? 'Op-ed generation failed on the server.' : 'The op-ed stream was interrupted before it finished.', location: 'opedStream.recoverFromRunStatus', nextSteps: ['Check My Op-Eds — it may have finished', 'Try creating it again'] });
}

/** Drive one web op-ed create: POST → read SSE → map per-voice events to onOpEdProgress →
 *  resolve {set_id} on 'complete'. Rejects with an ActionableError (pre-SSE JSON error, a
 *  server 'error' frame, or an unrecoverable stream drop). */
export async function runOpEdCreate(fetchFn: OpEdFetch, payload: CreateOpEdPayload): Promise<{ set_id: string }> {
  // t/276: the server takes exactly one source. A document goes as documentText + sourceName (names must match
  // the server's contract, or the document is dropped); topic is left out, so there is no url+document 400.
  const source = payload.documentSource
    ? { documentText: payload.documentSource.text, sourceName: payload.documentSource.name }
    : { topic: payload.topic };
  const body = { ...source, povs: payload.voices, params: payload.params };
  const controller = new AbortController();
  activeAbort = controller;
  getGlobalRecorder()?.record({ type: 'ai.request', component: 'web-bridge', level: 'info', message: 'oped-create request', data: { voiceCount: payload.voices.length, model: payload.params.model } });

  const path = '/api/oped-sets';
  let res: Response;
  try {
    res = await fetchFn(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      { timeoutMs: OPED_STREAM_TIMEOUT_MS, maxRetries: 0, critical: true, category: categorizeEndpoint(path, 'POST'), signal: controller.signal });
  } catch (err) {
    activeAbort = null;
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'error', message: 'oped-create network error', error: errShape(err) });
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: 'Op-ed creation was cancelled.', location: 'opedStream.runOpEdCreate', nextSteps: ['Start a new op-ed when you are ready'] });
    }
    throw err;
  }

  if (!res.ok) { activeAbort = null; throw await buildHttpError(res, !!payload.documentSource); }

  let runId = '';
  let startedSetId: string | undefined;
  let resolvedSetId: string | null = null;
  let streamError: ActionableError | null = null;
  let poolCode: FreePoolCode | null = null;
  try {
    await consumeSse(res, (frame) => {
      const event = (frame.event ?? frame) as Record<string, unknown>; // frames wrap: {runId, seq, event}
      if (typeof frame.runId === 'string' && frame.runId) runId = frame.runId;
      if (event.type === 'run_started') {
        if (typeof event.runId === 'string') runId = event.runId;
        if (typeof event.setId === 'string' && event.setId) startedSetId = event.setId;
        return;
      }
      if (event.type === 'complete') {
        const set = event.set as { set_id?: unknown } | undefined;
        if (set && typeof set.set_id === 'string') resolvedSetId = set.set_id;
        return;
      }
      if (event.type === 'error') { streamError = streamErrorFor(event, startedSetId); return; }
      if (event.type === 'voice_failed') poolCode ??= midStreamFreePoolCode(event.code); // t/467 (t/668's code)
      const progress = toProgress(event);
      if (progress) emitProgress(progress);
    });
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'web-bridge', level: 'error', message: 'oped-create: reading the SSE body failed', error: errShape(err) });
    activeAbort = null;
    // Stream dropped mid-run — recover via the run-status GET rather than orphaning the UI.
    // recoverFromRunStatus throws its own ActionableError on failure, which propagates to the caller.
    if (runId) return recoverFromRunStatus(fetchFn, runId);
    throw new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: `The op-ed stream was interrupted: ${String(err)}`, location: 'opedStream.runOpEdCreate', nextSteps: ['Check your network connection and try again'] });
  }

  activeAbort = null;
  // Assigned inside the SSE callback, so TS can't see them change; widen explicitly.
  const settled = settleRun(streamError as ActionableError | null, poolCode as FreePoolCode | null, resolvedSetId as string | null, startedSetId as string | undefined);
  if (settled) return settled;
  // Stream ended cleanly but with no 'complete' frame (rare) — recover the terminal state.
  if (runId) return recoverFromRunStatus(fetchFn, runId);
  throw new ActionableError({ goal: 'Op-Ed Studio: create an op-ed', problem: 'The op-ed finished but no result was returned.', location: 'opedStream.runOpEdCreate', nextSteps: ['Check My Op-Eds — it may have been saved', 'Try creating it again'] });
}

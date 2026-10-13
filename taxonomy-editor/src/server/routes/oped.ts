// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2573 (parent epic t/2570, Op-Ed Studio spec §9): the /api/oped-sets route
// cluster — the REST *library* surface for the web build (list/load/delete),
// parallel to the debate-session set (routes/debates.ts). Backed by the
// personal oped-set store (storage/opedStore.ts, t/2572).
//
// v1 has NO create/generation route — New-OpEd is PowerShell and the web
// container can't run it (TL feasibility ruling, t/2573). The web UI surfaces a
// "create in the desktop app" affordance; generation stays Electron-only until a
// TS port is decided (separate epic-level call).
//
// Anonymous contract: opedStore returns []/null and no-ops for anonymous users
// (there is no anonymous oped tier). So GET is safe for anon (empty result) and
// DELETE is deliberately left anon-blocked by the default auth gate
// (isAnonAllowedRoute) — an anon caller has no oped-sets to delete.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { clientSafeMessage } from '../security/accessControl.js';
import { isSafeId, fetchUrlContent, upsertOpedRun, countRunningOpedRuns, getOpedRun } from '../storage/fileIO.js';
import type { RunControlRecord, VoiceState } from '../storage/opedRunStore.js';
import { log } from '../logger.js';
import { listOpedSets, loadOpedSet, deleteOpedSet, getOpedSetsQuotaStatus, finalizeOpedSet } from '../storage/opedStore.js';
import type { OpEdSet, OpEdMember, OpEdParams, PovKey } from '../../../../lib/oped/types.js';
import { parseOpEdRequest } from '../../../../lib/oped/schemas.js';
import type { GenerateOpEdRequest, OpEdGeneratorDeps, OpEdProgressEvent } from '../../../../lib/oped/generate.js';
import { getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { checkRate } from '../security/rateLimiter.js';
import { publishOpedShare, unpublishOpedShare } from '../storage/opedShareStore.js';
import { resolveGenerationContext, enforceBackendAllowed } from './generationContext.js';
import { resolveBackend, isRegisteredModel } from '../ai/aiBackends.js';
import { DEFAULT_MODEL } from '../../../../lib/ai-client/index.js';
import { getProjectRoot } from '../config.js';
import { createWebOpEdAdapter } from '../ai/opedAdapter.js';
import { OUTLET_BANDS } from '../../../../lib/oped/outletBands.js';
import { randomUUID } from 'crypto';
import path from 'path';

const ROUTE_ID = '/api/oped-sets/:id';

// Set-level topic cap — a short title, not an essay; rejects pathological payloads
// without rejecting legitimately long topic lines. Used by both create and rename.
const MAX_TOPIC_LEN = 2000;

// ── t/2610/t/2893: op-ed generation run registry — SHARED blob store ───────────
// Run-control state (status, per-voice, the per-user concurrency cap, the observational
// GET /api/oped-runs/:runId) lives in a per-user blob store (`opedRunStore`, re-exported via
// fileIO), NOT a per-process Map — so it survives across replicas (maxReplicas>1) and the
// t/2884-class race (an SSE/status request routed to a different replica than the running job)
// is gone. Completion stays authoritative via the durable finalized set (opedStore), NOT this
// store — a cross-replica reconnect / replica recycle recovers via the sets GET (TL Q2, t/2610#3).
// The store lazy-expires stale 'running' blobs (crashed-A protection); no local sweep needed.
// The in-memory job-store marker is removed — this ticket IS that migration.
const MAX_CONCURRENT_OPED_RUNS = 1;          // per user, P1 (TL Q1)
const OPED_HEARTBEAT_MS = 15_000;

// ── create-request parsing (FromTopic + FromSource-URL) ──
interface ParsedOpEdCreate { topic: string; povs: string[]; params: OpEdParams; url?: string }

// t/3858: outlet is OPTIONAL (absent/empty → band default), but if supplied it must be a known key.
// Extracted to keep parseOpEdCreate under the complexity budget.
function validateOutlet(outlet: string | undefined): string | null {
  if (!outlet) return null;
  if (OUTLET_BANDS[outlet]) return null;
  return `params.outlet "${outlet}" is not a known outlet. Valid: ${Object.keys(OUTLET_BANDS).join(', ')}`;
}

function parseOpEdCreate(body: unknown): { ok: true; value: ParsedOpEdCreate } | { ok: false; status: number; message: string } {
  const b = (body ?? {}) as { topic?: unknown; params?: OpEdParams; povs?: unknown; url?: unknown; source?: unknown };
  // t/2807: `url` sources are now supported on web — fetched via the SSRF-hardened
  // fileIO.fetchUrlContent (the same path debates use). `source` (file/PDF/DOCX
  // uploads) still requires the desktop DocConverters path — keep blocking it here
  // (remaining gap tracked as a follow-up; t/2604 P2/P3).
  if (b.source != null) return { ok: false, status: 400, message: 'File/PDF/DOCX sources require the desktop app — paste a URL, or use the desktop app for document uploads' };
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : undefined;
  const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
  const povs = Array.isArray(b.povs) ? b.povs.filter((p): p is string => typeof p === 'string') : [];
  const params = b.params;
  if (!topic || topic.length > MAX_TOPIC_LEN) return { ok: false, status: 400, message: 'topic is required (non-empty, ≤2000 chars)' };
  if (povs.length === 0) return { ok: false, status: 400, message: 'at least one voice (pov) is required' };
  if (!params || typeof params.model !== 'string') return { ok: false, status: 400, message: 'params.model is required' };
  const outletError = validateOutlet(params.outlet);
  if (outletError) return { ok: false, status: 400, message: outletError };
  // wordCount is OPTIONAL — the outlet band supplies the default (lib/oped/generate.ts resolveOutletBand;
  // New-OpEd.ps1 derives length from the outlet). A default create ("Use outlet band") sends no wordCount,
  // so requiring it 400'd every default web op-ed (t/2685). Coerce absent/invalid/≤0 to the band sentinel 0
  // (mirrors schemas.ts .optional().default(0); generate.ts treats `wordCount > 0 ? … : band.words`).
  const wordCount = typeof params.wordCount === 'number' && params.wordCount > 0 ? params.wordCount : 0;
  return { ok: true, value: { topic, povs, params: { ...params, wordCount }, url } };
}

/** Adapt the global FlightRecorder to OpEdGeneratorDeps.recorder's looser param type
 *  (t/2807). deps.recorder takes Record<string,unknown>; FlightRecorder.record takes the
 *  stricter RecordInput. generate.ts always passes a valid RecordInput shape, so the
 *  forward is safe. Module-level so it doesn't add branch-complexity to driveOpEdRun. */
function toOpEdRecorder(): OpEdGeneratorDeps['recorder'] {
  const r = getGlobalRecorder();
  return r ? { record: (e: Record<string, unknown>) => r.record(e as never) } : null;
}

function applyEventToRun(run: RunControlRecord, event: OpEdProgressEvent, completed: OpEdMember[]): void {
  if (event.type === 'voice_complete') { run.perVoice[event.pov] = 'complete'; completed.push(event.member); }
  else if (event.type === 'voice_failed') run.perVoice[event.pov] = 'failed';
  else if (event.type === 'voice_cancelled') run.perVoice[event.pov] = 'cancelled';
}

/** t/2687: a voice failure is streamed to the client but was NOT logged server-side, so a prod
 *  "voice failed — 0 words" left no diagnostic trail. Emit a structured error with the model/backend/
 *  underlying error so it's detectable, not invisible (silent-degradation rule). No-op for non-failures.
 *  Module-level so it doesn't add branch-complexity to driveOpEdRun. */
function logVoiceFailure(event: OpEdProgressEvent, model: string): void {
  if (event.type !== 'voice_failed') return;
  const evt = event as { pov: string; error?: string };
  const backend = resolveBackend(model || DEFAULT_MODEL);
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'oped', level: 'error',
    message: `Op-ed voice failed to generate (pov=${evt.pov}, model=${model}, backend=${backend})`,
    error: { name: 'VoiceGenerationError', message: String(evt.error ?? 'unknown') },
  });
}

/** Drive the shared lib/oped generator, streaming each event as an SSE frame and
 *  persisting the assembled set on 'complete' (full OR partial — the core includes
 *  completed members + cancelled markers, so a cancel after 2/3 voices keeps the 2,
 *  TL gap 1). A throw before the core's own 'complete' still persists whatever finished. */
async function driveOpEdRun(
  res: import('http').ServerResponse,
  run: RunControlRecord,
  request: GenerateOpEdRequest,
  writeFrame: (event: Record<string, unknown>) => void,
  heartbeat: ReturnType<typeof setInterval>,
  isClientGone: () => boolean,
): Promise<void> {
  const completed: OpEdMember[] = [];
  // t/2893: persist the run-control record to the shared store on each transition so the per-user
  // concurrency cap + the observational GET see current state cross-replica. BEST-EFFORT — a persist
  // failure must NOT error the run (the SSE stream + generation continue); it only means the
  // status-GET may lag. Never let a blob write mask a successful generation.
  const persist = async (): Promise<void> => {
    try { await upsertOpedRun(run); }
    catch (e) { log.server.warn({ runId: run.runId, status: run.status, err: String(e) }, 'oped run-control persist failed (best-effort; run continues)'); }
  };
  try {
    // 4-ups matches tsconfig.server rootDir=../ + outDir=dist/server: source
    // src/server/routes/oped.ts + lib/oped/generate.ts land at dist/server/taxonomy-editor/
    // src/server/routes/oped.js and dist/server/lib/oped/generate.js, so ../../../../lib
    // resolves in dist, tsc, AND vitest (a 3-ups path exists in none — it would 500 at runtime).
    const { generateOpEdSet } = await import('../../../../lib/oped/generate.js');
    const deps: OpEdGeneratorDeps = {
      adapter: createWebOpEdAdapter(),
      // t/2609 relocated the op-ed .prompt files from scripts/AITriad/Prompts to
      // lib/oped/prompts; New-OpEd (PS), the parity gate, and Electron main (#1015) already
      // read the new location. The container ships them at /app/lib/oped/prompts via the
      // companion Dockerfile COPY (Rosetta, repo-root-anchored). Repo-root anchor matches.
      promptsDir: path.join(getProjectRoot(), 'lib', 'oped', 'prompts'),
      repoRoot: getProjectRoot(),
      // t/2807: give the core a recorder so Step-0 can flag a supplied-but-unreadable
      // URL source (otherwise it silently degrades to a topic-only op-ed).
      recorder: toOpEdRecorder(),
    };
    for await (const event of generateOpEdSet(request, deps) as AsyncGenerator<OpEdProgressEvent>) {
      applyEventToRun(run, event, completed);
      writeFrame(event as unknown as Record<string, unknown>);
      logVoiceFailure(event, request.params.model);
      if (event.type === 'complete') {
        await finalizeOpedSet(event.set);
        run.status = Object.values(run.perVoice).some(s => s === 'cancelled') ? 'cancelled' : 'complete';
      }
      await persist(); // per-event: persist perVoice + status progress for the cross-replica status-GET
    }
    if (run.status === 'running') run.status = 'complete';
    await persist(); // terminal (generator ended without an explicit 'complete' event)
  } catch (err) {
    run.status = 'error';
    await persist(); // terminal: persist the error status for the status-GET
    const opedErrMsg = err instanceof ActionableError
      ? `Op-ed generation failed — goal: ${err.goal} | problem: ${err.problem}`
      : 'Op-ed generation failed';
    getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: opedErrMsg, error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    if (completed.length > 0) {
      try { await finalizeOpedSet({ schema_version: 1, set_id: request.set_id, topic: request.topic, params: request.params, created_at: new Date().toISOString(), opeds: completed } as OpEdSet); }
      catch { /* telemetry — silent by design (best-effort partial persist) */ }
    }
    writeFrame({
      type: 'error',
      ...(err instanceof ActionableError ? { goal: err.goal, problem: clientSafeMessage(err.problem, err) } : {}),
      message: clientSafeMessage(String(err), err),
    });
  } finally {
    clearInterval(heartbeat);
    // t/2893: no startedAt restart — that fed the removed in-process TTL sweep. The shared store
    // lazy-expires stale 'running' only; a TERMINAL record persists for the status-GET window (its
    // status is terminal → never counted toward the concurrency cap). Terminal state was persisted above.
    if (!isClientGone()) { try { res.end(); } catch { /* telemetry — silent by design (already closed) */ } }
  }
}

/** t/3993: validate tagSelection before SSE commits. Logs and returns the client-safe
 *  error message on failure, null on success. Extracted to keep the POST handler under
 *  the complexity budget (same pattern as validateOutlet). */
function tagSelectionError(body: unknown): string | null {
  try {
    parseOpEdRequest(body);
    return null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'oped', level: 'warn',
      message: 'Op-ed generate request rejected: invalid tagSelection',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return err instanceof ActionableError ? err.problem : clientSafeMessage(String(err));
  }
}

/** set_id validation at the route boundary (the audit class — t/2526 shared
 *  validator): reject a traversal/unsafe id with 400 before the store read. The
 *  store funcs also assertSafeId (defense-in-depth), but pre-validating here maps
 *  a bad id to 400 rather than the store's thrown 400-tagged ActionableError. */
function rejectUnsafeId(res: import('http').ServerResponse, id: string): boolean {
  if (!isSafeId(id)) { error(res, 'Invalid oped-set id', 400); return true; }
  return false;
}

export function registerOpedRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, post, put, del } = r;

  // t/2610 (parent epic t/2604): the web op-ed CREATE surface — an SSE stream that
  // runs the shared lib/oped core server-side (the desktop app runs New-OpEd; the web
  // container can't, so generation moved into the TS core). Mirrors routes/chat.ts:
  // POST opens text/event-stream; every JSON error must be sent BEFORE writeHead(200).
  post('/api/oped-sets', async (req, res, body) => {
    // ── Pre-start gate (JSON errors — must precede the SSE headers, TL condition 4) ──
    if (isAnonymousUser()) { error(res, 'Sign in to create op-eds', 403); return; }
    const parsed = parseOpEdCreate(body);
    if (!parsed.ok) { error(res, parsed.message, parsed.status); return; }
    const { topic, povs, params, url } = parsed.value;
    // Tier-backend entitlement via the shared helper (t/2635 — folds op-ed onto the ONE
    // entitlement path in routes/generationContext.ts, replacing the local resolveOpEdModel
    // mirror). Free tier's model is pinned; a free/restricted caller can't reach a premium
    // backend via params.model. Must precede any generation (JSON errors before the SSE headers).
    const { tier, effectiveModel, backend } = resolveGenerationContext(req, params.model);
    const model = effectiveModel || DEFAULT_MODEL;
    // t/2687: reject an UNREGISTERED model before committing the SSE stream — the shared helper
    // doesn't (resolveBackend only prefix-guesses unknown → 'gemini', so an unregistered id would
    // reach the provider and fail silently mid-generation, "voice failed — 0 words"). Free tier is
    // pinned to a registered model, so this only rejects a caller-chosen unregistered id.
    if (!isRegisteredModel(model)) { error(res, `Model '${model}' is not available — choose another model in Settings.`, 400); return; }
    if (enforceBackendAllowed(res, tier, backend)) return;
    // t/3993: validate tagSelection at the server boundary — unknown tag → 400 before SSE commits.
    const tagErr = tagSelectionError(body);
    if (tagErr) { error(res, tagErr, 400); return; }

    const userId = getStorageUserId();
    const quota = await getOpedSetsQuotaStatus();
    if (!quota.allowed) { json(res, { error: 'quota_exceeded', resource: quota.resource, current: quota.current, limit: quota.limit }, 429); return; }
    // Shared-store count (self-healing: lazy-expires stale 'running' blobs). No local sweep.
    if (await countRunningOpedRuns(userId) >= MAX_CONCURRENT_OPED_RUNS) {
      json(res, { error: 'concurrency_limit', message: 'You already have an op-ed generating; wait for it to finish.', limit: MAX_CONCURRENT_OPED_RUNS }, 429); return;
    }

    // ── URL source fetch (t/2807) ──
    // Reuse the SSRF-hardened fileIO.fetchUrlContent — the SAME path debates use
    // (t/720-hardened: HTTPS-only, no creds-in-URL, blocks IP-literals/localhost/
    // .local/.internal/.corp, timeout + size-cap + content-type + redirect re-validation).
    // NO second fetch path. Placed AFTER the auth/tier/quota/concurrency gate so an
    // unentitled or over-quota caller can never use this endpoint as a fetch trigger,
    // and BEFORE the SSE stream commits so a fetch failure returns a clean HTTP error
    // instead of a mid-stream frame — never proceed with empty sourceMaterial (t/2722). (TL MUST)
    let sourceMaterial: string | undefined;
    if (url) {
      const fetched = await fetchUrlContent(url);
      if (fetched.error || !fetched.content) {
        error(res, `Could not fetch that URL: ${fetched.error || 'no readable content returned'}`, 502);
        return;
      }
      sourceMaterial = fetched.content;
    }

    // ── Commit SSE — no JSON error responses after this point ──
    const runId = randomUUID();
    const setId = randomUUID();
    const ac = new AbortController();
    const run: RunControlRecord = { runId, userId, setId, status: 'running', perVoice: Object.fromEntries(povs.map(p => [p, 'pending' as VoiceState])), startedAt: Date.now() };
    await upsertOpedRun(run); // shared store (was opedRuns.set): persist BEFORE the SSE commits so the cap + status-GET see it cross-replica. Throws → httpKit 500 before writeHead (no partial SSE).

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    let seq = 0;
    let clientGone = false;
    const writeFrame = (event: Record<string, unknown>): void => {
      if (clientGone) return;
      try { res.write(`data: ${JSON.stringify({ runId, seq: seq++, event })}\n\n`); } catch { clientGone = true; /* telemetry — silent by design (socket closed) */ }
    };
    // Heartbeat so the ACA ingress idle-timeout can't sever a ~2-min multi-voice run.
    const heartbeat = setInterval(() => { if (!clientGone) { try { res.write(': ping\n\n'); } catch { clientGone = true; /* telemetry — silent by design (socket closed) */ } } }, OPED_HEARTBEAT_MS);
    // Cancel on client disconnect — res.on('close'), NOT req.on('close') (Node ≥15 trap,
    // t/2522). driveOpEdRun does NOT break the generator on abort: the core cancels
    // in-flight voices and still yields 'complete' with the PARTIAL set (TL gap 1).
    res.on('close', () => { clientGone = true; ac.abort(); });

    writeFrame({ type: 'run_started', runId });
    // Generate with the entitlement-resolved (free-tier-pinned) model, not the raw request.
    const request: GenerateOpEdRequest = { set_id: setId, topic, params: { ...params, model }, povs: povs as PovKey[], sourceMaterial, signal: ac.signal };
    await driveOpEdRun(res, run, request, writeFrame, heartbeat, () => clientGone);
  });

  // t/2610: observational run status — a dropped SSE stream re-fetches here instead of
  // orphaning the run. Own namespace (not /api/oped-sets/:id) to avoid the :id wildcard.
  // Completion truth is the durable set, so a reconnect that finds no run should fall back
  // to GET /api/oped-sets/:setId (client contract).
  get('/api/oped-runs/:runId', async (req, res) => {
    const runId = param(req, 'runId', '/api/oped-runs/:runId');
    if (rejectUnsafeId(res, runId)) return;
    // Shared store (was opedRuns.get). getOpedRun scopes to the caller's user dir, so another user's
    // run resolves to null → 404; the explicit userId check is defence-in-depth. A cross-replica
    // reconnect that finds no run falls back to GET /api/oped-sets/:setId (client contract, t/2610#3).
    const run = await getOpedRun(runId);
    if (!run || run.userId !== getStorageUserId()) { error(res, 'Run not found', 404); return; }
    json(res, { runId: run.runId, setId: run.setId, status: run.status, perVoice: run.perVoice });
  });

  // Row summaries only (topic/camps/voice_count/dates) — never full docs.
  // .inprogress blobs are invisible (store contract). Anonymous → [].
  get('/api/oped-sets', async (_req, res) => {
    try { json(res, await listOpedSets()); }
    catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to list oped-sets', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // t/2573: read-only quota pre-check (mirrors GET /api/debates/quota-status).
  // MUST be registered before /api/oped-sets/:id — the :id wildcard would otherwise
  // match "quota-status" (both GET, 3 segments; literal wins by first-match).
  // Delegates to getOpedSetsQuotaStatus() so the pre-check never diverges from the
  // cap the finalizeOpedSet path enforces (Shared Utility Rule).
  get('/api/oped-sets/quota-status', async (_req, res) => {
    try { json(res, await getOpedSetsQuotaStatus()); }
    catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to check oped quota', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // Load a finalized OpEdSet. Partial sets pass through UNTOUCHED — a member's
  // status ('failed'|'cancelled') is data the reader renders, not an error here.
  get('/api/oped-sets/:id', async (req, res) => {
    const id = param(req, 'id', ROUTE_ID);
    if (rejectUnsafeId(res, id)) return;
    try {
      const set = await loadOpedSet(id);
      if (set === null) { error(res, 'Op-ed set not found', 404); return; }
      json(res, set);
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'warn', message: 'Failed to load oped-set', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 404, err);
    }
  });

  del('/api/oped-sets/:id', async (req, res) => {
    const id = param(req, 'id', ROUTE_ID);
    if (rejectUnsafeId(res, id)) return;
    try {
      await deleteOpedSet(id);
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to delete oped-set', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // ── Op-ed public share (t/2727; design t/2723#3, SO-approved e/106#2) ──
  // Pattern A: publish-on-share to a user-agnostic public copy; the public read is
  // GET /api/public/oped/:shareId (routes/opedShare.ts). Owner-only: publishOpedShare
  // reads via the caller's getStorageUserId scope, so a non-owner/absent set is an
  // indistinguishable 404. 5-segment path → no collision with the :id wildcard.
  const SHARE_ROUTE = '/api/oped-sets/:setId/share';
  post('/api/oped-sets/:setId/share', async (req, res) => {
    const setId = param(req, 'setId', SHARE_ROUTE);
    if (rejectUnsafeId(res, setId)) return;
    // Modest per-user rate guard — this writes to a public container.
    if (!checkRate(`oped-share-write:${getStorageUserId()}`, 20, 60_000).allowed) {
      json(res, { error: 'rate_limited' }, 429); return;
    }
    try {
      const result = await publishOpedShare(setId);
      if (!result) { error(res, 'Op-ed set not found', 404); return; }
      json(res, { shareId: result.shareId, url: `/share/oped/${result.shareId}` });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to publish oped share', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  del('/api/oped-sets/:setId/share', async (req, res) => {
    const setId = param(req, 'setId', SHARE_ROUTE);
    if (rejectUnsafeId(res, setId)) return;
    try {
      const existed = await unpublishOpedShare(setId);
      json(res, { ok: existed });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to unpublish oped share', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // t/2594 (parent t/2592, TL-approved t/2576#14): rename an existing set — the
  // ONLY mutation on the web build. UPDATE-ONLY: it must never CREATE a set
  // (creation stays Electron-only, TL ruling). Design (p/256#6) fixed the editable
  // field to the set-level `topic`; member headlines/bodies are generated content
  // and are NEVER touched here, so we whitelist `topic` and overlay it onto the
  // STORED set rather than trusting the client's (possibly full-OpEdSet) body.
  put('/api/oped-sets/:id', async (req, res, body) => {
    const id = param(req, 'id', ROUTE_ID);
    if (rejectUnsafeId(res, id)) return;
    const topic = (body as { topic?: unknown } | null)?.topic;
    if (typeof topic !== 'string' || topic.trim() === '' || topic.length > MAX_TOPIC_LEN) {
      error(res, `topic is required and must be a non-empty string (≤${MAX_TOPIC_LEN} chars)`, 400);
      return;
    }
    try {
      // load-then-404 — the load-bearing guard: a PUT to an absent id is NOT a
      // create, it's a 404. Keeps op-ed creation Electron-only.
      const stored = await loadOpedSet(id) as OpEdSet | null;
      if (stored === null) { error(res, 'Op-ed set not found', 404); return; }
      // Existing set → finalizeOpedSet does NOT quota-check (verified: it gates
      // NEW sets only). Only `topic` changes; every member passes through intact.
      await finalizeOpedSet({ ...stored, topic });
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'oped', level: 'error', message: 'Failed to rename oped-set', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500, err);
    }
  });
}

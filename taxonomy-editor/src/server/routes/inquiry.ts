// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/3581 — inquiry REST routes (the transport leg of the "Ask a question" feature, t/3571):
//   POST /api/inquiry          → 202 { jobId }   (starts an async inquiry job)
//   GET  /api/inquiry/:jobId    → job state, or the InquiryResult when done
//
// AUTHENTICATED-ONLY, fail-closed (ADR-0002 #8; Server Auth confirmed p/601#10 — a straight gate
// application, not an accessControl change). An inquiry is a multi-minute debate + ~16 QBAF runs, so
// the anonAiRoutes precedent doesn't transfer. Rate-limited on the per-user request window at
// debate/brief-class sizing (Server Auth p/601#11), plus the 1/user concurrency cap.
//
// The job store (t/3578) owns lifecycle/persistence; the shared pipeline (t/3585) owns stage
// sequencing; this route is the single production wiring — it hands startInquiryJob the real
// runPipeline from buildInquiryRunPipeline() (server deps, inquiryPipelineDeps.ts). Self-cert
// /add-rest-endpoint (routes); the deps wiring is the only non-routine part and was TL-scoped (t/3581).

import type { IncomingMessage, ServerResponse } from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUser, getStorageUserId } from '../security/userContext.js';
import * as rateLimiter from '../security/rateLimiter.js';
import { resolveGenerationContext, enforceBackendAllowed } from './generationContext.js';
import { isRegisteredModel } from '../ai/aiBackends.js';
import { InquiryRequestSchema, type InquiryRequest, type InquiryResult } from '../../../../lib/inquiry/index.js';
import {
  startInquiryJob, getInquiryJob, hasInquiryJob, countRunningInquiryJobs,
  findIdempotentInquiryJob, deriveTruncation, markJobFailedIfStale, buildPollView,
  MAX_CONCURRENT_INQUIRY_JOBS, type InquiryJob,
} from '../inquiryJobs.js';
import { loadInquiryResult, listInquiryResults } from '../storage/inquiryResultStore.js';
import { publishInquiryShare, unpublishInquiryShare } from '../storage/inquiryShareStore.js';
import { isSafeId } from '../storage/fileIO.js';
import { buildInquiryRunPipeline } from '../inquiryPipelineDeps.js';

/** Map an in-memory job to the shared poll projection (tier-1 path for buildPollView). */
function jobProjection(job: InquiryJob) {
  const projection: any = {
    jobId: job.jobId, status: job.status, resultId: job.resultId,
    error: job.error, debateId: job.debateId,
    terminationReason: job.terminationReason ?? null,
  };
  if (job.currentStageDetail) projection.stageDetail = job.currentStageDetail;
  return projection;
}

/** Idempotency key from the standard header (kept OUT of the strict request body schema). */
function idempotencyKeyOf(req: IncomingMessage): string | undefined {
  const h = req.headers['idempotency-key'];
  return typeof h === 'string' && h.length > 0 ? h : undefined;
}

/** Validate any model override against ai-models.json at the boundary (t/3563; not a baked enum).
 *  Returns true when it has sent a 400 (caller must return). */
function rejectUnregisteredModel(res: ServerResponse, request: InquiryRequest): boolean {
  for (const m of [request.models?.debaters, request.models?.evaluator]) {
    if (m !== undefined && !isRegisteredModel(m)) { error(res, `Unknown model id: ${m}`, 400); return true; }
  }
  return false;
}

/** Per-user request-window rate limit at the resolved (debate/brief-class) tier — Server Auth p/601#11.
 *  Returns true when it has already responded (403 disallowed backend, or 429 rate-limited). */
function enforceInquiryRateLimit(req: IncomingMessage, res: ServerResponse, model: string | undefined): boolean {
  const { tier, limitKey, backend } = resolveGenerationContext(req, model);
  if (enforceBackendAllowed(res, tier, backend)) return true;
  const rpm = rateLimiter.checkRequestRate(limitKey, tier.limits.requestsPerMinute);
  if (!rpm.allowed) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded', limitType: 'requests_per_minute', retryAfterMs: rpm.retryAfterMs }));
    return true;
  }
  return false;
}

/** Reject a path-traversal-unsafe `:jobId` with a 400 before any store call (defense-in-depth;
 *  the store's loadInquiryResult also asserts, but a route-level guard returns a clean 400 not a 500). */
function rejectUnsafeJobId(res: ServerResponse, jobId: string): boolean {
  if (!isSafeId(jobId)) { error(res, 'Invalid job id', 400); return true; }
  return false;
}

export function registerInquiryRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, post, del } = r;

  // POST /api/inquiry — start an inquiry job. NB: string-literal path so extractRoutes.ts sees it.
  post('/api/inquiry', async (req, res, body) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { error(res, 'Authentication required to run an inquiry', 401); return; }
    try {
      // Strict validation (rejects unknown keys) — a mistyped field fails loudly rather than running
      // a subtly different inquiry (TL t/3574#2). Idempotency rides a header, not the body.
      const parsed = InquiryRequestSchema.safeParse(body);
      if (!parsed.success) { error(res, 'Invalid inquiry request: ' + parsed.error.message, 400); return; }
      const request: InquiryRequest = parsed.data;

      // Model override validated against ai-models.json at the boundary (t/3563; not a baked enum).
      if (rejectUnregisteredModel(res, request)) return;
      // Rate limit (debate/brief-class tier; authenticated, never the light chat tier) — Server Auth p/601#11.
      if (enforceInquiryRateLimit(req, res, request.models?.debaters)) return;

      const userId = getStorageUserId();
      const idempotencyKey = idempotencyKeyOf(req);

      // Idempotency: an in-window job for the same (user, key) returns its jobId (no second run).
      const existing = findIdempotentInquiryJob(userId, idempotencyKey);
      if (existing) { json(res, { jobId: existing.jobId }, 202); return; }

      // Per-user concurrency cap — an inquiry is expensive; one at a time.
      if (countRunningInquiryJobs(userId) >= MAX_CONCURRENT_INQUIRY_JOBS) {
        error(res, 'An inquiry is already running — wait for it to finish before starting another', 429);
        return;
      }

      const job = await startInquiryJob({ userId, request, idempotencyKey, runPipeline: buildInquiryRunPipeline() });
      getGlobalRecorder()?.record({
        type: 'inquiry.created', component: 'inquiry', level: 'info',
        message: `Inquiry job created: ${job.jobId}`,
        data: { jobId: job.jobId, fidelity: request.fidelity, hasIdempotencyKey: !!idempotencyKey },
      });
      json(res, { jobId: job.jobId }, 202);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'error', message: 'POST /api/inquiry failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // GET /api/inquiry — list the authenticated user's past inquiries (the "My Questions" surface, t/3619).
  // Bare `InquiryResultSummary[]`, mirroring the /api/debates + /api/chats list shape (t/3619 asks to mirror
  // those; they return a bare array, not an envelope). Registered before /api/inquiry/:jobId — the bare path
  // and the one-segment :jobId path don't unify, but list-before-detail matches the debates.ts convention.
  // Authenticated-only like the rest of this group (ADR-0002 #8): we fail closed at the gate even though
  // listInquiryResults is already per-user (anon → []) as defense in depth.
  get('/api/inquiry', async (_req, res) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { error(res, 'Authentication required', 401); return; }
    try {
      json(res, await listInquiryResults());
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'error', message: 'GET /api/inquiry failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // GET /api/inquiry/:jobId — poll job state; include the InquiryResult on a terminal job, and fall
  // back to the persisted result when the in-memory job is gone (cross-restart / post-sweep).
  get('/api/inquiry/:jobId', async (req, res) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { error(res, 'Authentication required', 401); return; }
    try {
      const jobId = param(req, 'jobId', '/api/inquiry/:jobId');
      const userId = getStorageUserId();

      const job = getInquiryJob(jobId, userId);
      if (job) {
        // Tier 1: in-memory job (this process).
        const view = buildPollView(jobProjection(job));
        if ((job.status === 'done' || job.status === 'done_truncated') && job.resultId) {
          const result = await loadInquiryResult(job.resultId);
          json(res, { ...view, result });
        } else {
          json(res, view);
        }
        return;
      }

      // Not in this process's map. If it's genuinely absent here (not just owned by another user),
      // serve the durable result — loadInquiryResult is scoped to the caller's own collection, so a
      // result owned by a different user returns null (no cross-user leak). Cross-restart durability
      // (not cross-replica — maxReplicas: 1). Tier 2: completed result. Tier 3 (t/3728): in-flight
      // jobs lost to restart → honest failed or live state via inquiryJobStore.
      if (!hasInquiryJob(jobId)) {
        // Tier 2: completed result (cross-restart durability — result was persisted before the terminal flip).
        const result: InquiryResult | null = await loadInquiryResult(jobId);
        if (result) {
          const { truncated, terminationReason } = deriveTruncation(result);
          json(res, {
            ...buildPollView({ jobId, status: truncated ? 'done_truncated' : 'done', resultId: jobId, error: null, debateId: null, terminationReason: terminationReason ?? null }),
            result,
          });
          return;
        }
        // Tier 3 (t/3728): check for a durable job record. Three verdicts from markJobFailedIfStale:
        //   failed  → serve the stored error descriptor (idempotent-content write made it durable — second poll gets same desc).
        //   live    → fresh heartbeat: another process owns this job (deploy overlap); serve "still running".
        //   null    → no record or past retention window → fall through to 404.
        // Response is independent of write outcome per SO condition 4.
        const tier3 = await markJobFailedIfStale(jobId);
        if (tier3?.verdict === 'failed') {
          json(res, buildPollView({ jobId, status: 'failed', resultId: null, error: tier3.error.message, debateId: null, terminationReason: null }));
          return;
        }
        if (tier3?.verdict === 'live') {
          // Fresh heartbeat — another process is still running this job (e.g. deploy overlap).
          json(res, buildPollView({ jobId, status: tier3.record.status, resultId: tier3.record.resultId, error: null, debateId: tier3.record.debateId, terminationReason: null }));
          return;
        }
        // t/3724: only on this branch — !hasInquiryJob(jobId) is genuine absence, not the
        // owned-by-other-user case (that skips this whole block and falls straight to the 404
        // below without a jobId in the event, since it's a different failure entirely).
        getGlobalRecorder()?.record({
          type: 'inquiry.not_found', component: 'inquiry', level: 'warn',
          message: 'Inquiry not found: not in Map and no persisted result',
          data: { jobId, fallback_attempted: true, fallback_outcome: tier3 ? 'stale_durable_record_expired' : 'no_persisted_result' },
        });
      }
      error(res, 'Inquiry not found', 404);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'error', message: 'GET /api/inquiry/:jobId failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // ── t/3626: owner-authed public-share mint/revoke for an inquiry result. Mirrors the oped pair
  // (routes/oped.ts /api/oped-sets/:setId/share POST+DELETE). publishInquiryShare is owner-scoped
  // (reads via the caller's getStorageUserId), so a non-owner or absent job is an indistinguishable
  // 404 — never leaks existence. The public read is GET /api/public/inquiry/:shareId
  // (routes/inquiryShare.ts, t/3653). 4-segment paths → no collision with the :jobId wildcard. ──
  post('/api/inquiry/:jobId/share', async (req, res) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { error(res, 'Authentication required', 401); return; }
    const jobId = param(req, 'jobId', '/api/inquiry/:jobId/share');
    if (rejectUnsafeJobId(res, jobId)) return;
    // Modest per-user write rate guard — this writes to a public container.
    if (!rateLimiter.checkRate(`inquiry-share-write:${getStorageUserId()}`, 20, 60_000).allowed) {
      json(res, { error: 'rate_limited' }, 429); return;
    }
    try {
      const result = await publishInquiryShare(jobId);
      if (!result) { error(res, 'Inquiry not found', 404); return; }
      json(res, { shareId: result.shareId, url: `/inquiries/${result.shareId}` });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'error', message: 'Failed to publish inquiry share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  del('/api/inquiry/:jobId/share', async (req, res) => {
    const user = getCurrentUser();
    if (!user || user.isAnonymous) { error(res, 'Authentication required', 401); return; }
    const jobId = param(req, 'jobId', '/api/inquiry/:jobId/share');
    if (rejectUnsafeJobId(res, jobId)) return;
    try {
      const existed = await unpublishInquiryShare(jobId);
      json(res, { ok: existed }); // idempotent: revoking a never-shared inquiry is a no-op { ok: false }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry', level: 'error', message: 'Failed to unpublish inquiry share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}

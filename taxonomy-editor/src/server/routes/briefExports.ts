// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Brief Export REST API (t/2804, T6 — spec §5/§6). Async export jobs over the shared
// lib/brief pipeline: POST enqueues (202 + jobId), GET polls, list/download/DELETE.
//
// BILLABLE surface (TL MUST t/2804#2 #5): narrate + optional checker call a model, so
// POST requires an authenticated identity (never anon) AND inherits the shared
// entitlement gate — resolveExportModel pins the free tier + validates the model id,
// enforceBackendAllowed 403s a premium backend on a restricted tier. skipNarration
// (zero model calls) still requires auth (identity-scoped storage).

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { isAnonymousUser, getStorageUserId } from '../security/userContext.js';
import { loadDebateSession } from '../storage/fileIO.js';
import { createWebOpEdAdapter } from '../ai/opedAdapter.js';
import { resolveExportModel, type ClientModelSource } from './exportModel.js';
import { enforceBackendAllowed } from './generationContext.js';
import {
  startExportJob, getExportJob, hasExportJob, sweepExportJobs, countRunningExportJobs,
  findIdempotentJob, MAX_CONCURRENT_EXPORT_JOBS, resolveBriefExportJobPoll, type ResolvedModels,
} from '../briefExportJobs.js';
import { listBriefExports, loadBriefExportRecord, loadBriefArtifact, deleteBriefExport, getBriefExportsQuotaStatus } from '../storage/briefExportStore.js';
import { BRIEF_ARTIFACTS, type BriefArtifactName, type BriefPreset } from '../../../../lib/brief/types.js';
import type { DebateSession } from '../../../../lib/debate/types.js';

const PRESETS: readonly BriefPreset[] = ['policymaker', 'conference', 'classroom'];
const ARTIFACT_NAMES: readonly string[] = Object.values(BRIEF_ARTIFACTS);
const TOOL_VERSIONS: Record<string, string> = { node: process.version, brief: '1.0' };

interface ExportPostBody {
  preset?: unknown; format?: unknown; model?: unknown; checkerModel?: unknown;
  template?: unknown; templateId?: unknown; modelSource?: unknown; framingMeta?: unknown;
  options?: { skipNarration?: unknown };
}

/** The static, request-shape gates that need no I/O — auth, preset, PDF-is-desktop-only,
 *  and the live-snapshot (allowOpen) block. Split out so the POST handler stays under the
 *  complexity ceiling; the I/O gates (debate load, model resolution) remain inline. */
type ExportPrecheck =
  | { ok: false; status: number; message: string }
  | { ok: true; preset: BriefPreset; skipNarration: boolean; allowOpen: boolean };

function precheckExportRequest(req: Parameters<Parameters<Router['post']>[1]>[0], b: ExportPostBody): ExportPrecheck {
  // Auth MUST (#5): export is billable — never anon.
  if (isAnonymousUser()) return { ok: false, status: 403, message: 'Sign in to export a debate brief' };

  const preset = b.preset as BriefPreset;
  if (!PRESETS.includes(preset)) return { ok: false, status: 400, message: `preset must be one of: ${PRESETS.join(', ')}` };

  // Format — PDF is Electron-only; never silently omit (TL MUST #3).
  const formats = Array.isArray(b.format) ? (b.format as string[]) : ['pptx'];
  if (formats.includes('pdf')) {
    return { ok: false, status: 400, message: 'PDF requires the desktop app: the server renders .pptx (and spec). Open the AITriad desktop app to export a PDF (printToPDF is Electron-only).' };
  }

  // allowOpen (t/2851): snapshot extract is supported now (lib #1269, snapshot-aware verify t/2841).
  // A non-closed debate exports a watermarked in-progress snapshot (meta.snapshot=true) with a
  // maturity warning; the closed-phase gate below only fails closed when allowOpen is NOT set.
  const url = new URL(req.url ?? '', 'http://localhost');
  const allowOpen = url.searchParams.get('allowOpen') === 'true';

  return { ok: true, preset, skipNarration: b.options?.skipNarration === true, allowOpen };
}

/** Resolve narrator + optional checker with the billable entitlement gate (MUST #5). Writes
 *  the 400/403 to `res` and returns null when it has already responded; otherwise returns the
 *  resolved pair. Extracted so the POST handler stays under the complexity ceiling. */
function resolveExportModels(
  req: Parameters<Parameters<Router['post']>[1]>[0],
  res: Parameters<Parameters<Router['post']>[1]>[1],
  b: ExportPostBody,
): ResolvedModels | null {
  const narrator = resolveExportModel(req, b.model as string | null, b.modelSource as ClientModelSource | undefined);
  if (!narrator.ok) { error(res, narrator.message, 400); return null; }
  if (enforceBackendAllowed(res, narrator.tier, narrator.backend)) return null;

  const models: ResolvedModels = { modelId: narrator.modelId, modelSource: narrator.modelSource };
  if (b.checkerModel) {
    const checker = resolveExportModel(req, b.checkerModel as string, 'explicit');
    if (!checker.ok) { error(res, checker.message, 400); return null; }
    if (enforceBackendAllowed(res, checker.tier, checker.backend)) return null;
    models.checkerModelId = checker.modelId;
    models.checkerModelSource = checker.modelSource;
  }
  return models;
}

export function registerBriefExportsRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, post, del } = r;

  // ── GET /api/brief-exports/quota-status (t/2831) ──
  // Registered first — no wildcard conflict risk in this namespace, but keep
  // the pattern consistent with oped-sets/quota-status (t/2573).
  get('/api/brief-exports/quota-status', async (_req, res) => {
    try { json(res, await getBriefExportsQuotaStatus()); }
    catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'brief-export', level: 'error', message: 'Failed to get brief-export quota status', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // ── POST /api/debates/:debateId/exports → 202 { jobId } ──
  post('/api/debates/:debateId/exports', async (req, res, body) => {
    const b = (body ?? {}) as ExportPostBody;
    const pre = precheckExportRequest(req, b);
    if (!pre.ok) { error(res, pre.message, pre.status); return; }
    const { preset, skipNarration, allowOpen } = pre;
    const debateId = param(req, 'debateId', '/api/debates/:debateId/exports');

    // Load debate + closed-phase gate.
    let session: DebateSession | null;
    try { session = await loadDebateSession(debateId) as DebateSession | null; }
    catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'brief-export', level: 'warn', message: 'Failed to load debate for export', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, 'Debate not found', 404); return;
    }
    if (!session) { error(res, 'Debate not found', 404); return; }
    if (session.phase !== 'closed' && !allowOpen) {
      error(res, 'Only closed debates can be exported. Close the debate first, or pass ?allowOpen=true to export a watermarked in-progress snapshot.', 409);
      return;
    }

    // Count-quota gate (t/2831): cap total exports before any model call.
    const quotaStatus = await getBriefExportsQuotaStatus();
    if (!quotaStatus.allowed) {
      json(res, { error: 'quota_exceeded', message: `Brief export quota reached (${quotaStatus.current}/${quotaStatus.limit}). Delete older exports to make room.`, current: quotaStatus.current, limit: quotaStatus.limit }, 429);
      return;
    }

    // Model resolution + entitlement gate (MUST #5). Narrator + checker resolved independently.
    const models = resolveExportModels(req, res, b);
    if (!models) return; // helper already wrote the 400/403

    // Idempotency + concurrency.
    sweepExportJobs();
    const userId = getStorageUserId();
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) || undefined;
    const existing = findIdempotentJob(userId, debateId, idempotencyKey);
    if (existing) { json(res, { jobId: existing.jobId }, 202); return; }
    if (countRunningExportJobs(userId) >= MAX_CONCURRENT_EXPORT_JOBS) {
      json(res, { error: 'concurrency_limit', message: 'An export is already running; wait for it to finish.', limit: MAX_CONCURRENT_EXPORT_JOBS }, 429);
      return;
    }

    const framingMeta = b.framingMeta === false ? false : undefined;
    const templateId = typeof b.templateId === 'string' ? b.templateId : undefined;
    const job = await startExportJob({
      userId, session, debateId, models,
      request: { preset, skipNarration, framingMeta, allowOpen, templateId },
      toolVersions: TOOL_VERSIONS, timestamp: new Date().toISOString(),
      idempotencyKey, adapter: createWebOpEdAdapter(),
    });
    json(res, { jobId: job.jobId }, 202);
  });

  // ── GET /api/export-jobs/:jobId ──
  get('/api/export-jobs/:jobId', async (req, res) => {
    const jobId = param(req, 'jobId', '/api/export-jobs/:jobId');
    const job = getExportJob(jobId, getStorageUserId());
    if (!job && !hasExportJob(jobId)) {
      // Tier-3 (t/4177): the job may be running, or have finished, on another replica. The durable
      // record is user-scoped, so another user's jobId simply reads as absent.
      let rec: Awaited<ReturnType<typeof resolveBriefExportJobPoll>> = null;
      try { rec = await resolveBriefExportJobPoll(jobId); } catch (err) {
        getGlobalRecorder()?.record({ type: 'system.error', component: 'brief-export', level: 'warn', message: 'export-job tier-3 lookup failed — answering 404', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      }
      if (rec) { json(res, { status: rec.status, progressPct: rec.progressPct, warnings: rec.warnings, error: rec.error, errorCode: rec.errorCode, exportId: rec.exportId }); return; }
    }
    if (!job) {
      // t/2887: record the miss so a poll 404 is diagnosable in server FR (was invisible, t/2884).
      // `inMap` distinguishes "not in THIS process's registry at all" — the cross-replica-404
      // signal (job created on another replica; see t/2885 cap) — from "present but wrong user".
      // We log the 404 (the failure) but NOT the frequent 200 polls, which would flood the FR
      // ring and evict this very event (deliberate deviation from the ticket's "every GET").
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'brief-export', level: 'warn',
        message: 'export-job poll 404',
        data: { jobId, status: 404, found: false, inMap: hasExportJob(jobId) },
      });
      error(res, 'Export job not found (it may have expired — check the debate exports list).', 404); return;
    }
    json(res, { status: job.status, progressPct: job.progressPct, warnings: job.warnings, error: job.error, errorCode: job.errorCode ?? null, exportId: job.exportId });
  });

  // ── GET /api/debates/:debateId/exports (list + records) ──
  get('/api/debates/:debateId/exports', async (req, res) => {
    const debateId = param(req, 'debateId', '/api/debates/:debateId/exports');
    try { json(res, await listBriefExports(debateId)); }
    catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'brief-export', level: 'error', message: 'Failed to list brief exports', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // ── GET /api/exports/:exportId/artifacts/:name (download) ──
  get('/api/exports/:exportId/artifacts/:name', async (req, res) => {
    const exportId = param(req, 'exportId', '/api/exports/:exportId/artifacts/:name');
    const name = param(req, 'name', '/api/exports/:exportId/artifacts/:name');
    if (!ARTIFACT_NAMES.includes(name)) { error(res, `Unknown artifact '${name}'`, 404); return; }
    try {
      const artifact = await loadBriefArtifact(exportId, name as BriefArtifactName);
      if (artifact === null) { error(res, 'Artifact not found', 404); return; }
      if ('bytes' in artifact) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': `attachment; filename="${name}"` });
        res.end(artifact.bytes);
      } else {
        const ct = name === BRIEF_ARTIFACTS.htmlDoc ? 'text/html; charset=utf-8' : 'application/json';
        res.writeHead(200, { 'Content-Type': ct, 'Content-Disposition': `attachment; filename="${name}"` });
        res.end(artifact.text);
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'brief-export', level: 'error', message: 'Failed to download brief artifact', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  // ── DELETE /api/exports/:exportId ──
  del('/api/exports/:exportId', async (req, res) => {
    if (isAnonymousUser()) { error(res, 'Sign in to manage exports', 403); return; }
    const exportId = param(req, 'exportId', '/api/exports/:exportId');
    const rec = await loadBriefExportRecord(exportId);
    if (!rec) { error(res, 'Export not found', 404); return; }
    await deleteBriefExport(exportId);
    json(res, { ok: true });
  });
}

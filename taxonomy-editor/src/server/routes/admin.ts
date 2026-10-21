// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1295 (route extraction, repo-review B-209): the /api/admin route cluster (35
// routes, 6 scattered runs), moved verbatim out of server.ts behind the
// registration seam. Handler bodies are byte-identical (no in-body imports).
// Server-local deps (serverRecorder, ensureSessionBranch, appendServerLogs) come
// through ServerCtx and are destructured once below (stable refs — read-only per
// the TL read-mostly condition; no ctx member is reassigned). Catches are moved
// verbatim per TL t/1323#9; their flight-recorder annotation is a follow-up.

import fs from 'fs';
import path from 'path';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, query } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';
import { getStateRoot, getProjectRoot, rotateApiKeyMaterial, STORAGE_MODE, getPaidGeminiFallbackKey, setPaidGeminiFallbackKey, deletePaidGeminiFallbackKey } from '../config.js';
import { loadUsageRegistry } from '../../../../lib/ai-client/usageTypes.js';
import { getConfig, getConfigState, writeConfig, forceReload as reloadRuntimeConfig, diffFromDefaults } from '../runtimeConfig.js';
import { requireAdmin, getReviewQueue, getReviewStats, getReviewDetail, executeReviewAction } from '../community/admin/reviewRegistry.js';
import type { ReviewAction } from '../community/admin/types.js';
import { listFlags, setFlag, deleteFlag, type FlagDef } from '../featureFlags.js';
import { getStorageUserId, getCurrentUserId } from '../security/userContext.js';
import { sanitizeUserText } from '../security/contentSanitizer.js';
import { getRollbackStatus } from '../rollbackStatus.js';
import { getErrorSummaryCached, type ErrorEntry } from '../errorAggregation.js';
import { writeDump, isValidDumpId } from '../flightRecorderDumps.js';
import * as community from '../community/community.js';
import * as fileIO from '../storage/fileIO.js';
import * as supportStore from '../support/supportStore.js';
import { isCaseStatus } from '../support/types.js';
import { FEEDBACK_CATEGORIES, isFeedbackCategory, paginateFeedback } from '../storage/feedbackStore.js';
import { backfillOwnOpedShares } from '../storage/opedShareStore.js';
import * as allowlistStore from '../storage/allowlistStore.js';
import type { AllowlistEntry, AdminAllowlistResponse } from '../../../../lib/allowlist/types.js';

// Small server.ts helpers the moved admin handlers call. server.ts keeps its own
// copies (used by the staying support-user endpoints / key-masking); duplicated
// here rather than threaded through ctx — both are near-pure. (t/1295)
function maskApiKey(key: string): string {
  const visible = getConfig().server.apiKeyMaskLength; // t/929: runtime-configurable (default 4)
  return key.length <= visible ? '••••' : `••••${key.slice(-visible)}`;
}
/** Validate an admin review-action body; returns an error message, or null if valid. */
function validateReviewAction(action: Partial<ReviewAction>): string | null {
  if (!action || typeof action.domain !== 'string' || !action.domain) return 'domain is required';
  if (typeof action.groupId !== 'string' || !action.groupId) return 'groupId is required';
  if (action.action !== 'promote' && action.action !== 'reject') return 'action must be "promote" or "reject"';
  if (!Array.isArray(action.itemIds) || action.itemIds.length === 0) return 'a non-empty itemIds[] is required';
  if (action.action === 'reject' && (!action.reason || typeof action.reason !== 'string')) return 'reason is required when rejecting';
  return null;
}

/** Validate feedback input fields; returns an error message, or null if valid. */
function validateFeedbackInput(rating: string, text: string | undefined, category: string | undefined): string | null {
  if (rating !== 'up' && rating !== 'down') return 'rating must be "up" or "down"';
  if (text && typeof text !== 'string') return 'text must be a string';
  if (text && text.length > 500) return 'text must be 500 characters or fewer';
  if (category !== undefined && !isFeedbackCategory(category)) return `category must be one of: ${FEEDBACK_CATEGORIES.join(', ')}`;
  return null;
}

/** Best-effort feedback webhook notification (FEEDBACK_WEBHOOK_URL); fire-and-forget. */
function notifyFeedbackWebhook(rating: string, userId: string, entry: { text: string | null; timestamp: string }): void {
  const webhookUrl = process.env.FEEDBACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: process.env.FEEDBACK_EMAIL || 'jsnover13@gmail.com', subject: `Taxonomy Editor Feedback: ${rating === 'up' ? '👍' : '👎'}`, body: `Rating: ${rating}\nUser: ${userId}\nText: ${entry.text || '(none)'}\nTime: ${entry.timestamp}` }),
  }).catch(() => { /* telemetry — silent by design: webhook delivery is best-effort */ });
}

export function registerAdminRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post, put, del } = r;
  const { serverRecorder, ensureSessionBranch, appendServerLogs } = ctx;

  // t/3484 (t/3483 arc): one-time backfill — mint shareIds + write public projections for ALL existing
  // community op-eds so GET /api/public/opeds (t/3481) lists every set and the count>0 deploy AC becomes
  // satisfiable. Admin-gated; idempotent + safe to re-run (Server Community's backfillCommunityOpedShares
  // skips malformed/empty items with a WARN, one stable shareId per item). Returns the run tally.
  post('/api/admin/community/opeds/backfill-shares', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, await community.backfillCommunityOpedShares());
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Community op-ed share backfill failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // t/3490: one-time backfill — re-project every existing own-share public op-ed
  // (users/{id}/oped-shares.json registries) so it picks up the schema_version 2
  // BDI grounding embed (t/3488). Admin-gated; idempotent (publishOpedShare fully
  // overwrites), safe to re-run. Returns the run tally + per-item skip reasons.
  post('/api/admin/opeds/backfill-own-shares', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, await backfillOwnOpedShares());
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Own op-ed share backfill failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // t/3498 (t/3495 epic — admin-managed shared Gemini key): admin CRUD for the
  // allowlist gating access to the admin's registered paid Gemini key. `userId`
  // is the authoritative membership key (SO cond 4, t/3495#2) — accepted
  // directly from the caller (TL t/3498#2/#4: server-side email→userId
  // derivation is wrong for GitHub principals, whose derived id doesn't match
  // their email in any way). `email` is audit-display only.
  get('/api/admin/allowlist', (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const response: AdminAllowlistResponse = { entries: allowlistStore.getEntries() };
      json(res, response);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to list admin allowlist',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  post('/api/admin/allowlist', async (_req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const { userId, email } = (body ?? {}) as { userId?: string; email?: string };
      if (!userId || typeof userId !== 'string') { error(res, 'userId is required', 400); return; }
      if (!email || typeof email !== 'string') { error(res, 'email is required', 400); return; }
      const entry: AllowlistEntry = { userId, email, addedAt: new Date().toISOString() };
      await allowlistStore.addEntry(entry);
      json(res, entry);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to add admin allowlist entry',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  del('/api/admin/allowlist/:userId', async (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const userId = param(req, 'userId', '/api/admin/allowlist/:userId');
      await allowlistStore.removeEntry(userId);
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to remove admin allowlist entry',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // Full flag definitions (admin only).
  get('/api/admin/flags', (_req, res) => {
    if (!requireAdmin(res)) return;
    try { json(res, { flags: listFlags() }); }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to list feature flags',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // Create/update a flag (admin only). Persists + audits.
  put('/api/admin/flags/:name', (req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const name = param(req, 'name', '/api/admin/flags/:name');
      const patch = (body ?? {}) as Partial<FlagDef>;
      if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') { error(res, 'enabled must be a boolean', 400); return; }
      if (patch.scope !== undefined && typeof patch.scope !== 'string') { error(res, 'scope must be a string', 400); return; }
      json(res, setFlag(name, patch, getStorageUserId()));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to set feature flag',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // Delete a flag (admin only). Persists + audits.
  del('/api/admin/flags/:name', (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const name = param(req, 'name', '/api/admin/flags/:name');
      json(res, { deleted: deleteFlag(name, getStorageUserId()) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to delete feature flag',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  post('/api/admin/rotate-keys', async (_req, res) => {
    if (!requireAdmin(res)) return; // t/809: rotating key material is admin-only
    try {
      const result = await rotateApiKeyMaterial();
      log.server.info({ ...result }, 'Key material rotation requested');
      json(res, { success: true, ...result });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Key material rotation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      json(res, { success: false, message: String(err) }, 500);
    }
  });

  // t/908: correlated server dump. The client fires this best-effort with the
  // dumpId it used for its own dump; we write the server ring buffer alongside as
  // server-{dumpId}.jsonl, joinable to client-{dumpId}.jsonl on requestId. Admin
  // only — the server recorder may hold other users' request internals.
  post('/api/admin/flight-recorder/dump', async (_req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const { dumpId } = (body ?? {}) as { dumpId?: string };
      if (!isValidDumpId(dumpId)) { error(res, 'dumpId must be a UUID-safe string', 400); return; }
      const ndjson = appendServerLogs(serverRecorder.buildDump('manual').ndjson);
      const filePath = await writeDump(getStateRoot(), 'server', dumpId, ndjson); // t/4372 (t/4264): class-A writable state, never getDataRoot()
      log.fr.info({ filePath, dumpId }, 'Correlated server dump written');
      json(res, { ok: true, filename: path.basename(filePath), dumpId });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Correlated server dump failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // ── Admin: Community submissions ──

  get('/api/admin/submissions', async (req, res) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      const url = new URL(req.url!, 'http://localhost');
      const status = url.searchParams.get('status') || undefined;
      json(res, await community.listSubmissions(status));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list community submissions',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/admin/submissions/:id/approve', async (req, res) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      json(res, await community.approveSubmission(param(req, 'id', '/api/admin/submissions/:id/approve')));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to approve community submission',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      json(res, { error: String(err) }, status);
    }
  });

  post('/api/admin/submissions/:id/reject', async (req, res) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      json(res, await community.rejectSubmission(param(req, 'id', '/api/admin/submissions/:id/reject')));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to reject community submission',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      json(res, { error: String(err) }, status);
    }
  });

  // ── Admin: Calibration curation (t/643) ──

  get('/api/admin/calibration/pending', async (_req, res) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      json(res, { groups: await fileIO.listPendingCalibration() });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'calibration pending failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/admin/calibration/promote', async (_req, res, body) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    const { source, entryIds, notes, edits } = body as {
      source?: string; entryIds?: string[]; notes?: string;
      edits?: Record<string, Record<string, unknown>>;
    };
    if (!source || !Array.isArray(entryIds) || entryIds.length === 0) {
      error(res, 'source and a non-empty entryIds[] are required', 400); return;
    }
    if (edits !== undefined && (typeof edits !== 'object' || edits === null || Array.isArray(edits))) {
      error(res, 'edits must be an object mapping debateId → field patch', 400); return;
    }
    try {
      await ensureSessionBranch();
      json(res, await fileIO.promoteCalibrationEntries(source, entryIds, getStorageUserId(), notes, edits));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'calibration promote failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/admin/calibration/reject', async (_req, res, body) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    const { source, entryIds, reason } = body as { source?: string; entryIds?: string[]; reason?: string };
    if (!source || !Array.isArray(entryIds) || entryIds.length === 0) {
      error(res, 'source and a non-empty entryIds[] are required', 400); return;
    }
    if (!reason || typeof reason !== 'string') { error(res, 'reason is required', 400); return; }
    try {
      await ensureSessionBranch();
      json(res, await fileIO.rejectCalibrationEntries(source, entryIds, getStorageUserId(), reason));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'calibration reject failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // ── Admin: Unified review panel (t/646) ──
  // Shared infrastructure delegating to per-domain ReviewDomainHandlers registered
  // at startup (calibration t/647, community t/650, taxonomy). Admin-gated via the
  // shared requireAdmin() middleware (reuses isAdmin() / ADMIN_USERS).

  // ── Runtime config (t/927, spec §4.4 + §8.2) ──

  get('/api/admin/config', (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, getConfigState());
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'error',
        message: 'GET /api/admin/config failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  put('/api/admin/config', (_req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      // Body may be the bare config or { config } (spec §4.4). updatedBy is the
      // verified caller; writeConfig validates before touching the file.
      const incoming = (body && typeof body === 'object' && 'config' in (body as Record<string, unknown>))
        ? (body as { config: unknown }).config
        : body;
      const result = writeConfig(incoming, getCurrentUserId());
      if (!result.ok) { json(res, { errors: result.errors }, 400); return; }
      json(res, { ok: true, errors: [] });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'error',
        message: 'PUT /api/admin/config failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  post('/api/admin/config/reload', (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const result = reloadRuntimeConfig();
      json(res, { ok: result.ok, reloadedAt: new Date().toISOString(), errors: result.errors ?? [] });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'error',
        message: 'POST /api/admin/config/reload failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  get('/api/admin/config/diff', (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, { diff: diffFromDefaults() });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'runtime-config', level: 'error',
        message: 'GET /api/admin/config/diff failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // t/948: admin CRUD for the paid Gemini fallback key (stored in the encrypted key
  // store `_system` partition). The key value is never logged — only a masked suffix.
  get('/api/admin/paid-fallback-key', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const key = await getPaidGeminiFallbackKey();
      json(res, { configured: !!key, masked: key ? maskApiKey(key) : null });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'paid-fallback', level: 'error', message: 'GET paid-fallback-key failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  post('/api/admin/paid-fallback-key', async (_req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const { key } = body as { key?: string };
      if (!key?.trim()) { error(res, 'key is required', 400); return; }
      await setPaidGeminiFallbackKey(key.trim());
      log.server.info({ component: 'paid-fallback' }, 'Paid Gemini fallback key set'); // never log the key itself
      json(res, { ok: true, masked: maskApiKey(key.trim()) });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'paid-fallback', level: 'error', message: 'POST paid-fallback-key failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  del('/api/admin/paid-fallback-key', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      await deletePaidGeminiFallbackKey();
      log.server.info({ component: 'paid-fallback' }, 'Paid Gemini fallback key removed');
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'paid-fallback', level: 'error', message: 'DELETE paid-fallback-key failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), 500, err);
    }
  });

  get('/api/admin/review/queue', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, { items: await getReviewQueue(query(_req, 'submitter') ?? undefined) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'admin review queue failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/admin/review/stats', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, await getReviewStats(query(_req, 'submitter') ?? undefined));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'admin review stats failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/admin/review/detail/:groupId', async (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const groupId = param(req, 'groupId', '/api/admin/review/detail/:groupId');
      json(res, await getReviewDetail(groupId));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'admin review detail failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/admin/review/action', async (_req, res, body) => {
    if (!requireAdmin(res)) return;
    const action = body as Partial<ReviewAction>;
    const invalid = validateReviewAction(action);
    if (invalid) { error(res, invalid, 400); return; }
    try {
      await ensureSessionBranch();
      await executeReviewAction(action as ReviewAction);
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: ((err as { statusCode?: number }).statusCode ?? 500) < 500 ? 'warn' : 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'admin review action failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // ── Admin: Feedback & Error reporting ──

  const serverStartTime = Date.now();

  post('/api/admin/feedback', async (_req, res, body) => {
    try {
      const { rating, text, context, category } = body as { rating: string; text?: string; context?: Record<string, unknown>; category?: string };
      const invalid = validateFeedbackInput(rating, text, category);
      if (invalid) { error(res, invalid, 400); return; }

      const userId = getCurrentUserId();
      const entry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId,
        rating,
        category: isFeedbackCategory(category) ? category : 'general',
        text: text?.trim() ? sanitizeUserText(text.trim()) : null, // t/856

        context: context ?? {},
      };

      // t/837: persist via the user-content backend (Azure Blob in prod) so
      // feedback survives container restarts instead of raw fs to ephemeral /tmp.
      await fileIO.saveFeedbackEntry(entry);
      serverRecorder.record({ type: 'lifecycle', component: 'server', level: 'info', message: `Feedback received: ${rating}`, data: { userId, rating } });

      // Email notification (best-effort, env var FEEDBACK_WEBHOOK_URL)
      notifyFeedbackWebhook(rating, userId, entry);

      json(res, { ok: true, id: entry.id });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to store feedback', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/admin/feedback', async (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      // t/837: read via the user-content backend (Blob in prod), then apply the
      // shared filter/sort/paginate logic.
      const { items: allItems, skipped } = await fileIO.listFeedbackEntries();
      const { items, total, hasMore } = paginateFeedback(allItems, {
        limit: parseInt(query(req, 'limit') ?? '', 10),
        offset: parseInt(query(req, 'offset') ?? '', 10),
        category: query(req, 'category'),
        rating: query(req, 'rating'),
      });
      for (const file of skipped) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'server',
          level: 'warn',
          message: 'Skipped unreadable feedback entry',
          error: { name: 'Error', message: 'parse failed' },
          data: { file },
        });
      }
      json(res, { items, total, hasMore });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to list feedback',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'admin feedback list failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/admin/errors', async (_req, res, body) => {
    try {
      const report = body as { error: Record<string, unknown>; context?: Record<string, unknown> };
      if (!report.error) { error(res, 'Missing error field', 400); return; }

      const userId = getCurrentUserId();
      const entry = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        userId,
        error: report.error,
        context: report.context ?? {},
      };

      // t/837: persist via the user-content backend so client error reports
      // survive container restarts (was raw fs to ephemeral /tmp).
      await fileIO.saveErrorReport(entry);
      serverRecorder.record({ type: 'system.error', component: 'server', level: 'warn', message: `Client error reported: ${report.error.message ?? 'unknown'}`, data: { userId, errorName: report.error.name, stack: report.error.stack } });

      json(res, { ok: true, id: entry.id });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to store error report', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/admin/health', async (_req, res) => {
    try {
      // t/837: read counts via the user-content backend (Blob in prod) — the same
      // store feedback/errors now persist to — not raw fs to ephemeral /tmp.
      const sortDesc = (a: Record<string, unknown>, b: Record<string, unknown>) =>
        String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? ''));
      const { items: errors } = await fileIO.listErrorEntries();
      const { items: feedback } = await fileIO.listFeedbackEntries();
      const recentErrors = [...errors].sort(sortDesc).slice(0, 5);
      const recentFeedback = [...feedback].sort(sortDesc).slice(0, 5);

      json(res, {
        status: 'ok',
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        errorCount: errors.length,
        recentErrors,
        feedbackCount: feedback.length,
        recentFeedback,
        storageMode: STORAGE_MODE,
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to build admin status report',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // t/1154: admin error dashboard — paginated, filterable error list. Admin-only.
  // Filters: since/until (ISO), userId, errorName; paged via limit (≤500) / offset.
  get('/api/admin/errors', async (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const since = query(req, 'since');
      const until = query(req, 'until');
      const userId = query(req, 'userId');
      const errorName = query(req, 'errorName');
      const limit = Math.min(Math.max(parseInt(query(req, 'limit') ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(parseInt(query(req, 'offset') ?? '0', 10) || 0, 0);

      const { items } = await fileIO.listErrorEntries();
      let rows = items as unknown as ErrorEntry[];
      if (since) { const s = Date.parse(since); if (!Number.isNaN(s)) rows = rows.filter(e => Date.parse(String(e.timestamp)) >= s); }
      if (until) { const u = Date.parse(until); if (!Number.isNaN(u)) rows = rows.filter(e => Date.parse(String(e.timestamp)) <= u); }
      if (userId) rows = rows.filter(e => String(e.userId ?? '') === userId);
      if (errorName) rows = rows.filter(e => String(e.error?.name ?? '') === errorName);
      rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

      const total = rows.length;
      json(res, { items: rows.slice(offset, offset + limit), total, hasMore: offset + limit < total });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to list error reports',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // t/1154: admin error dashboard — aggregated summary (period counts, top errors
  // grouped by normalizeMessage, byDay histogram). Cached 30s. Admin-only.
  // Note: `/api/admin/errors/summary` is registered before any future `:id` route
  // so the literal path wins under first-match routing.
  get('/api/admin/errors/summary', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const summary = await getErrorSummaryCached(async () => (await fileIO.listErrorEntries()).items as unknown as ErrorEntry[]);
      json(res, summary);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to build error summary',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // t/1154: admin error dashboard — full error detail + temporally correlated
  // flight-recorder dump IDs (±5 min). Admin-only. Registered after /summary so the
  // literal route wins under first-match routing.
  get('/api/admin/errors/:id', async (req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const id = param(req, 'id', '/api/admin/errors/:id');
      const entry = await fileIO.getErrorReport(id);
      if (!entry) { error(res, 'Error report not found', 404); return; }

      const errTs = Date.parse(String(entry.timestamp));
      const WINDOW_MS = 5 * 60 * 1000;
      const dumps = await fileIO.listFlightRecorderDumpIds();
      const relatedDumps = Number.isNaN(errTs) ? [] : dumps.filter(d => {
        const dts = Date.parse(d.timestamp);
        return !Number.isNaN(dts) && Math.abs(dts - errTs) <= WINDOW_MS;
      });

      json(res, { entry, relatedDumps });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to load error detail',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // Admin support endpoints
  get('/api/admin/support/cases', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try { json(res, { items: await supportStore.listAllCases() }); }
    catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'support', level: 'error', message: 'support: admin list cases failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  post('/api/admin/support/cases/:id/respond', async (req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const id = param(req, 'id', '/api/admin/support/cases/:id/respond');
      const text = typeof (body as { body?: unknown })?.body === 'string' ? (body as { body: string }).body.trim() : '';
      if (!text || text.length > 10_000) { error(res, 'body is required (≤10000 chars)', 400); return; }
      const c = await supportStore.addResponse(id, getStorageUserId(), text);
      if (!c) { error(res, 'Case not found', 404); return; }
      json(res, c);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'support', level: 'error', message: 'support: admin respond failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  put('/api/admin/support/cases/:id/status', async (req, res, body) => {
    if (!requireAdmin(res)) return;
    try {
      const id = param(req, 'id', '/api/admin/support/cases/:id/status');
      const status = (body as { status?: unknown })?.status;
      if (!isCaseStatus(status)) { error(res, 'invalid status (open|in-progress|resolved|closed)', 400); return; }
      const c = await supportStore.setStatus(id, status);
      if (!c) { error(res, 'Case not found', 404); return; }
      json(res, c);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'support', level: 'error', message: 'support: admin set status failed', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // t/871: deployment / rollback status — what's running, what to roll back to.
  // Admin-only; sources deploy identity from env (DEPLOY_SHA/DEPLOY_TAG +
  // ACA CONTAINER_APP_REVISION) and the known-good tag from GHCR (cached).
  get('/api/admin/rollback/status', async (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      json(res, await getRollbackStatus());
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to build rollback status',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // ── Admin: Usage telemetry ──

  post('/api/admin/telemetry', (_req, res, body) => {
    try {
      const event = body as { type?: string; view?: string; metadata?: Record<string, unknown> };
      if (!event.type || typeof event.type !== 'string') { error(res, 'Missing type field', 400); return; }

      const userId = getCurrentUserId();
      const date = new Date().toISOString().slice(0, 10);
      const telemetryDir = path.join(getStateRoot(), 'admin', 'telemetry'); // t/2643: class-A writable state
      fs.mkdirSync(telemetryDir, { recursive: true });

      const line = JSON.stringify({
        type: event.type,
        view: event.view ?? null,
        userId,
        timestamp: new Date().toISOString(),
        metadata: event.metadata ?? {},
      }) + '\n';

      fs.appendFileSync(path.join(telemetryDir, `${date}.jsonl`), line);
      json(res, { ok: true });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to write telemetry event', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // t/1265: UsageID registry browser — read-only view of ai-usages.json for the
  // admin panel. Returns the resolved registry (with _extends already merged).
  get('/api/admin/usages', (_req, res) => {
    if (!requireAdmin(res)) return;
    try {
      const registry = loadUsageRegistry(getProjectRoot());
      json(res, { usages: registry });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'GET /api/admin/usages failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  get('/api/admin/telemetry/summary', (req, res) => {
    if (!community.isAdmin()) { json(res, { error: 'Forbidden' }, 403); return; }
    try {
      const url = new URL(req.url!, 'http://localhost');
      const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10) || 7, 90);
      const telemetryDir = path.join(getStateRoot(), 'admin', 'telemetry'); // t/2643: class-A writable state

      const summaries: Record<string, Record<string, number>> = {};
      const now = new Date();

      for (let i = 0; i < days; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const date = d.toISOString().slice(0, 10);
        const filePath = path.join(telemetryDir, `${date}.jsonl`);

        const counts: Record<string, number> = {};
        try {
          const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const evt = JSON.parse(line) as { type: string };
              counts[evt.type] = (counts[evt.type] || 0) + 1;
            } catch { /* telemetry — silent by design: skip malformed lines */ }
          }
        } catch { /* telemetry — silent by design: file may not exist for this date */ }

        if (Object.keys(counts).length > 0) summaries[date] = counts;
      }

      json(res, { days, summaries });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to build telemetry summaries',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the conflicts / cruxes / policy-
// registry route run, moved verbatim out of server.ts behind the registration
// seam. This run sits between registerTaxonomyRoutes and registerOrganizations-
// Routes, so registration order — and the routeTable snapshot — is preserved by
// placing registerConflictsRoutes() at its former position.
//
// The module-local `conflictsCache` (read by the /api/conflicts GET, nulled by
// the conflict PUT/POST/DEL writes) moves in with these handlers. It is also
// nulled after a harvest write from routes/harvest.ts via
// ctx.invalidateConflictsCache; server.ts now wires that ctx field to the
// exported invalidateConflictsCache() below, so harvest keeps working with no
// new ServerCtx surface. Session-branch ensure comes through ctx.ensureSessionBranch.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getConfig } from '../runtimeConfig.js';
import * as fileIO from '../storage/fileIO.js';
import { appendCruxEvidence, removeCruxEvidence, type CruxEvidenceEntry } from '../cruxEvidence.js';

// Conflicts response cache (read/written by the /api/conflicts routes below).
// t/929: conflicts cache TTL is runtime-configurable — getConfig().server.conflictsCacheTtlMs (default 5m).
// t/1687: moved module-local out of server.ts; invalidateConflictsCache() below is
// wired into ctx.invalidateConflictsCache so routes/harvest.ts can null it after a write.
let conflictsCache: { data: unknown[]; ts: number } | null = null;

/** Null the conflicts cache — called by the conflict writes here and (via ctx) by routes/harvest.ts. */
export function invalidateConflictsCache(): void {
  conflictsCache = null;
}

/**
 * Warm the conflicts cache by reading all conflict files and populating the
 * module-local cache. Called from server.ts startup (post GitHub-backend init)
 * so the first user request doesn't pay the cold-start penalty. Returns the
 * number of conflicts loaded (for the caller's log line). t/1687: the cache is
 * module-local, so the warm path threads through this exported setter.
 */
export async function warmConflictsCache(): Promise<number> {
  const data = await fileIO.readAllConflictFiles();
  conflictsCache = { data, ts: Date.now() };
  return data.length;
}

export function registerConflictsRoutes(r: Router, ctx: ServerCtx): void {
  const { get, post, put, del } = r;
  const { ensureSessionBranch } = ctx;

  // ── Conflicts ──

  get('/api/conflicts', async (_req, res) => {
    if (conflictsCache && Date.now() - conflictsCache.ts < getConfig().server.conflictsCacheTtlMs) {
      json(res, conflictsCache.data);
      return;
    }
    const data = await fileIO.readAllConflictFiles();
    conflictsCache = { data, ts: Date.now() };
    json(res, data);
  });

  get('/api/conflicts/clusters', async (_req, res) => {
    json(res, await fileIO.readConflictClusters());
  });

  // ── Cruxes ──

  get('/api/cruxes', async (_req, res) => {
    json(res, await fileIO.readAggregatedCruxes());
  });

  // t/1541: reviewer-entered external_evidence write path (append-only). Persists to
  // aggregated-cruxes.json on the caller's session branch, like the /api/conflicts
  // writes above. external_evidence is CL-owned display-only metadata (never read by
  // scoring/sort code). Mutation logic is the pure cruxEvidence.ts helpers.
  post('/api/cruxes/:id/evidence', async (req, res, body) => {
    try {
      await ensureSessionBranch();
      const id = param(req, 'id', '/api/cruxes/:id/evidence');
      const { url, note, added_by } = (body ?? {}) as { url?: unknown; note?: unknown; added_by?: unknown };
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) { error(res, 'evidence url must be an http(s) URL', 400); return; }
      if (typeof added_by !== 'string' || added_by.trim() === '') { error(res, 'added_by is required', 400); return; }
      const data = await fileIO.readAggregatedCruxes();
      const entry: CruxEvidenceEntry = {
        url: url.trim(),
        ...(typeof note === 'string' && note.trim() ? { note: note.trim() } : {}),
        added_by: added_by.trim(),
        added_at: new Date().toISOString().slice(0, 10), // server-set date (YYYY-MM-DD)
      };
      const crux = appendCruxEvidence(data, id, entry);
      if (!crux) { error(res, `Crux not found: ${id}`, 404); return; }
      await fileIO.writeAggregatedCruxes(data);
      json(res, crux);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to add crux evidence', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // DELETE by array index — under concurrent edits to the same crux the index can
  // shift between read and delete (TL-accepted tradeoff for a low-concurrency
  // reviewer tool, t/1541; would switch to an added_at+url match if it ever bites).
  del('/api/cruxes/:id/evidence/:index', async (req, res) => {
    try {
      await ensureSessionBranch();
      const id = param(req, 'id', '/api/cruxes/:id/evidence/:index');
      const index = Number(param(req, 'index', '/api/cruxes/:id/evidence/:index'));
      const data = await fileIO.readAggregatedCruxes();
      const result = removeCruxEvidence(data, id, index);
      if (result === 'not_found') { error(res, `Crux not found: ${id}`, 404); return; }
      if (result === 'out_of_range') { error(res, `Evidence index out of range: ${index}`, 404); return; }
      await fileIO.writeAggregatedCruxes(data);
      json(res, result);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to remove crux evidence', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  put('/api/conflicts/:id', async (req, res, body) => {
    try {
      await ensureSessionBranch();
      const id = param(req, 'id', '/api/conflicts/:id');
      await fileIO.writeConflictFile(id, body);
      conflictsCache = null;
      json(res, { ok: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to write conflict', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  post('/api/conflicts/:id', async (req, res, body) => {
    try {
      await ensureSessionBranch();
      const id = param(req, 'id', '/api/conflicts/:id');
      await fileIO.createConflictFile(id, body);
      conflictsCache = null;
      json(res, { ok: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to create conflict', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  del('/api/conflicts/:id', async (req, res) => {
    try {
      await ensureSessionBranch();
      const id = param(req, 'id', '/api/conflicts/:id');
      await fileIO.deleteConflictFile(id);
      conflictsCache = null;
      json(res, { ok: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to delete conflict', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // ── Policy registry ──

  get('/api/policy-registry', async (_req, res) => {
    json(res, await fileIO.readPolicyRegistry());
  });
}

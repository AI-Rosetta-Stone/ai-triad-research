// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the lineage / edges / source-index /
// data-availability / feature-flags read run, moved verbatim out of server.ts
// behind the registration seam. This run sits between registerOrganizationsRoutes
// and registerAdminRoutes, so registration order — and the routeTable snapshot —
// is preserved by placing registerEdgesRoutes() at its former position. The
// module-local `edgesCache` (read/written only by these edges handlers) moves in
// with them; ServerCtx is threaded but unused (handlers depend only on imports).

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, query, statusForError, codeForError, requireBaseVersion } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import * as fileIO from '../storage/fileIO.js';
import { stripEdgeRationale, type EdgesData } from '../../../../lib/edges/stripEdgeRationale.js';
import { mergeEdgesPreservingRationale, type EdgeMergeWarn } from '../../../../lib/edges/mergeEdgesPreservingRationale.js';
import { getAllFlags } from '../featureFlags.js';

// Recorder-backed sink for the merge's "baseline twin matched no incoming edge" case: a real
// rationale isn't written, logged so a systematic tie-break mismatch is discoverable (CL Issue 4).
// The payload is IDs/counts only — no rationale content ever enters the recorder.
const onEdgeMergeWarn: EdgeMergeWarn = (e) =>
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'edges-route', level: 'warn',
    message: `${e.message} ${JSON.stringify(e.data)}`,
  });

export function registerEdgesRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, put } = r;

  // ── Lineage categories ──

  get('/api/lineage-categories', async (_req, res) => {
    json(res, await fileIO.readLineageCategories());
  });

  get('/api/lineage-info', async (_req, res) => {
    json(res, await fileIO.readLineageEnrichments());
  });

  // ── Edges ──

  let edgesCache: unknown = null;
  // t/4189: the version (git blob SHA) backing edgesCache — '' means "no file yet" or
  // "loaded through a path that didn't carry a version" (readEdgesForSaveBaseline/legacy
  // fallback), never a value a client's If-Match could spoof into passing.
  let edgesCacheVersion = '';

  get('/api/edges', async (req, res) => {
    const loaded = await fileIO.readEdgesFileWithVersion();
    edgesCache = loaded?.data ?? null;
    edgesCacheVersion = loaded?.version ?? '';
    if (!edgesCache) { json(res, null); return; }
    if (edgesCacheVersion) res.setHeader('ETag', `"${edgesCacheVersion}"`);
    // ?include=rationale returns the full payload (backwards-compat for scripts).
    if (query(req, 'include') === 'rationale') { json(res, edgesCache); return; }
    json(res, stripEdgeRationale(edgesCache));
  });

  get('/api/edges/:index', async (req, res) => {
    if (!edgesCache) {
      const loaded = await fileIO.readEdgesFileWithVersion();
      edgesCache = loaded?.data ?? null;
      edgesCacheVersion = loaded?.version ?? '';
    }
    const data = edgesCache as EdgesData | null;
    const index = parseInt(param(req, 'index', '/api/edges/:index'), 10);
    if (!data?.edges || isNaN(index) || index < 0 || index >= data.edges.length) {
      error(res, 'Edge not found', 404);
      return;
    }
    json(res, data.edges[index]);
  });

  // t/1816/t/1821: whole-file atomic save of the full EdgesFile (saveEdges bridge →
  // PUT /api/edges). Persists via the existing fileIO.writeEdgesFile (atomic
  // temp→rename; not reinvented), then refreshes the module cache. Session'd write,
  // same gating as the sibling /api/edges/* writes (not public). Mirrors swap below.
  put('/api/edges', async (req, res, body) => {
    const baseSha = requireBaseVersion(req, res);
    if (!baseSha) return;
    const data = body as EdgesData | null;
    if (!data || typeof data !== 'object' || !Array.isArray(data.edges)) {
      error(res, 'edges file must be an object with an edges array', 400);
      return;
    }
    // t/2957: the editor loads the edge list rationale-stripped, then saves the WHOLE file —
    // persisting the stripped set would wipe on-disk rationale. Re-merge it from the on-disk
    // baseline BEFORE the write. The baseline read discriminates genuine absence (first write →
    // write as-is) from a read/parse failure (throws → refuse, never a stripped write); an
    // indistinguishable-twin baseline also throws (refuse-and-log, never guesses).
    try {
      const baseline = await fileIO.readEdgesForSaveBaseline();
      const merged = mergeEdgesPreservingRationale(data, baseline, onEdgeMergeWarn);
      const { version } = await fileIO.writeEdgesFile(merged, { baseSha });
      edgesCache = merged;
      edgesCacheVersion = version;
      if (version) res.setHeader('ETag', `"${version}"`);
      json(res, stripEdgeRationale(edgesCache));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'edges-route', level: 'error',
        message: 'PUT /api/edges rationale-preserving save refused/failed',
        error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    }
  });

  put('/api/edges/status', async (req, res, body) => {
    const baseSha = requireBaseVersion(req, res);
    if (!baseSha) return;
    const { index, status: s } = body as { index: number; status: string };
    if (!edgesCache) {
      const loaded = await fileIO.readEdgesFileWithVersion();
      edgesCache = loaded?.data ?? null;
    }
    try {
      const result = await fileIO.updateEdgeStatus(edgesCache, index, s, { baseSha });
      edgesCache = result.data;
      edgesCacheVersion = result.version;
      if (result.version) res.setHeader('ETag', `"${result.version}"`);
      json(res, stripEdgeRationale(edgesCache));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'edges-route', level: 'error',
        message: 'PUT /api/edges/status save refused/failed',
        error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    }
  });

  put('/api/edges/swap', async (req, res, body) => {
    const baseSha = requireBaseVersion(req, res);
    if (!baseSha) return;
    const { index } = body as { index: number };
    if (!edgesCache) {
      const loaded = await fileIO.readEdgesFileWithVersion();
      edgesCache = loaded?.data ?? null;
    }
    try {
      const result = await fileIO.swapEdgeDirection(edgesCache, index, { baseSha });
      edgesCache = result.data;
      edgesCacheVersion = result.version;
      if (result.version) res.setHeader('ETag', `"${result.version}"`);
      json(res, stripEdgeRationale(edgesCache));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'edges-route', level: 'error',
        message: 'PUT /api/edges/swap save refused/failed',
        error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    }
  });

  put('/api/edges/bulk-status', async (req, res, body) => {
    const baseSha = requireBaseVersion(req, res);
    if (!baseSha) return;
    const { indices, status: s } = body as { indices: number[]; status: string };
    if (!edgesCache) {
      const loaded = await fileIO.readEdgesFileWithVersion();
      edgesCache = loaded?.data ?? null;
    }
    try {
      const result = await fileIO.bulkUpdateEdges(edgesCache, indices, s, { baseSha });
      edgesCache = result.data;
      edgesCacheVersion = result.version;
      if (result.version) res.setHeader('ETag', `"${result.version}"`);
      json(res, stripEdgeRationale(edgesCache));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'edges-route', level: 'error',
        message: 'PUT /api/edges/bulk-status save refused/failed',
        error: { name: (err as Error).name ?? 'Error', message: String((err as Error).message), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    }
  });

  // ── Source indexes ──

  let nodeSourceIndexCache: { value: unknown; builtAt: number } | null = null;
  const NODE_SOURCE_INDEX_TTL_MS = 60_000;

  get('/api/node-source-index', async (_req, res) => {
    const now = Date.now();
    const fromCache = nodeSourceIndexCache !== null && (now - nodeSourceIndexCache.builtAt) < NODE_SOURCE_INDEX_TTL_MS;
    if (!fromCache) nodeSourceIndexCache = { value: await fileIO.buildNodeSourceIndex(), builtAt: now };
    getGlobalRecorder()?.record({ type: 'system.info', component: 'node-source-index', level: 'info', message: 'node-source-index served', data: { source: fromCache ? 'cache' : 'compute' } });
    json(res, nodeSourceIndexCache!.value);
  });

  get('/api/policy-source-index', async (_req, res) => {
    json(res, await fileIO.buildPolicySourceIndex());
  });

  // ── Data management ──

  get('/api/data/available', async (_req, res) => {
    json(res, await fileIO.isDataAvailable());
  });

  // ── Feature flags (t/899) ──

  // Resolved flags for the current user (any caller). The UI gates features on these.
  get('/api/flags', (_req, res) => {
    try { json(res, getAllFlags()); }
    catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error', message: 'Failed to resolve feature flags',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}

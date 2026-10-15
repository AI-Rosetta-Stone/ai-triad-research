// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1383 (route extraction, t/1347 follow-up): the /api/taxonomy read/write +
// synthetic-corpus + node-edit-history routes, moved verbatim out of server.ts
// behind the registration seam. The only non-verbatim change is the PUT, whose
// session-branch ensure now comes through ctx.ensureSessionBranch. The
// synthetic-embeddings ⟷ :pov collision pair is internal and registered in
// source order (synthetic-embeddings first), so first-match routing is preserved
// (see routeTable.test.ts).

import type { IncomingMessage, ServerResponse } from 'http';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, jsonStringifyChunked, sendJsonBuffer, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import * as fileIO from '../storage/fileIO.js';
import { stampNodeAuthorship, diffNodes } from '../storage/editMeta.js';
import { isAnonymousUser } from '../security/userContext.js';
import { getFlag } from '../featureFlags.js';
import { enqueueGroundingReconcile } from '../groundingReconcileHook.js';
import { log } from '../logger.js';
import { findSituationBdiViolations } from '../../../../lib/debate/taxonomyTypes.js';
import type { SituationNode } from '../../../../lib/debate/taxonomyTypes.js';

// ── t/3165: serialize-once cache for /api/taxonomy/synthetic-embeddings ───────────────────────────
// The synthetic corpus (~4144 vectors, ~400MB) is STATIC, but loadSyntheticEmbeddings() rebuilds it on
// EVERY call (per-POV .npy network read + parseNpy + build) and the route re-JSON.stringify'd it — an
// un-yielded ~3s main-thread block + ~400MB GC churn, once PER DEBATE (taxonomyContext fetches the full
// corpus). Cache the SERIALIZED Buffer: the cold path builds+serializes once (chunk-yielded so even that
// doesn't block), every later GET serves the Buffer near-free. Promise-dedupe (cache the in-flight
// promise) so a cold-start BURST launches ONE build, not N (= DevOps's single-flight guard, subsumed).
//
// CACHE-INVALIDATION CONTRACT (Gate Co-Location): this process-lifetime cache is correct ONLY while the
// synthetic corpus is WRITE-FROZEN. No server route mutates it today (the client updateSyntheticEmbeddings
// POST is not wired server-side). IF a synth-mutation route is ever added it MUST call
// __invalidateSyntheticEmbeddingsCache() after the write, or GETs will serve a stale corpus.
// A generation counter guards the invalidate-during-in-flight-build race (t/3237): an invalidation that
// lands WHILE a cold build is running bumps _synthGen, so that build declines to publish its now-stale
// bytes to the cache and the next GET rebuilds against the new generation.
let _synthEmbeddingsBuffer: Buffer | null = null;
let _synthEmbeddingsInFlight: Promise<Buffer> | null = null;
let _synthGen = 0;

async function getSyntheticEmbeddingsBuffer(): Promise<Buffer> {
  if (_synthEmbeddingsBuffer) {
    // Warm hit — the serialize is skipped entirely (cached Buffer). Emit serialize_ms:0 so the deploy's
    // self-proof (serialize_ms cold-once → warm≈0, t/3165) is greppable on EVERY synth GET, not only the
    // single cold build — independent of which request first warmed the cache. cache:'hit' vs 'cold'.
    // t/3246: component is the established 'api' (a landing set proven to reach Log Analytics), with the
    // route identity in a `route` field — the earlier novel component:'synthetic-embeddings' was invisible.
    log.api.info({ component: 'api', route: 'synthetic-embeddings', cache: 'hit', serialize_ms: 0, bytes: _synthEmbeddingsBuffer.length }, 'synthetic-embeddings served from cache (warm)');
    return _synthEmbeddingsBuffer;
  }
  if (_synthEmbeddingsInFlight) return _synthEmbeddingsInFlight; // promise-dedupe: one cold build for a burst
  const gen = _synthGen; // the generation this build belongs to; a concurrent invalidate() bumps _synthGen
  _synthEmbeddingsInFlight = (async () => {
    const t0 = Date.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const data = await fileIO.loadSyntheticEmbeddings();
    const loadMs = Date.now() - t0;
    const t1 = Date.now();
    const buffer = await jsonStringifyChunked(data); // yields the loop during the cold serialize
    const serializeMs = Date.now() - t1;
    // Generation-guard (t/3237): publish to the cache ONLY if no invalidation landed mid-build. Else this
    // build's bytes are stale — still hand them to the current awaiters (they requested pre-invalidation),
    // but don't cache them, so the next GET rebuilds against the new generation.
    if (gen === _synthGen) _synthEmbeddingsBuffer = buffer;
    // t/3165 phase-timing (cold path only) → the next real synth GET proves load_ms vs serialize_ms +
    // heap; on a warm hit this line never runs (serve is near-zero) = the fix's self-proof.
    log.api.info({
      component: 'api', route: 'synthetic-embeddings', cache: 'cold', load_ms: loadMs, serialize_ms: serializeMs, bytes: buffer.length,
      node_count: data ? Object.keys(data).length : 0,
      heap_before: heapBefore, heap_after: process.memoryUsage().heapUsed,
    }, 'synthetic-embeddings built + serialized + cached (cold path)');
    return buffer;
  })();
  try {
    return await _synthEmbeddingsInFlight;
  } finally {
    // Clear the in-flight handle: on success _synthEmbeddingsBuffer now holds the result; on failure the
    // handle is dropped so the next request retries the build rather than re-throwing a stale rejection.
    _synthEmbeddingsInFlight = null;
  }
}

/** t/3165: drop the cached serialized synthetic-embeddings. MUST be called by any future
 *  synth-mutation route after it writes (see the write-frozen contract above). Exported for that + tests. */
export function __invalidateSyntheticEmbeddingsCache(): void { _synthEmbeddingsBuffer = null; _synthGen++; }

/** @internal t/3165 test hook — exercise the cache/dedupe path without the full Router harness. */
export const __getSyntheticEmbeddingsBufferForTest = getSyntheticEmbeddingsBuffer;

// t/3890: BDI gate helper — extracted to keep the PUT handler under complexity-15.
// Returns null on pass, or { status, message } to send as the response.
function situationsBdiGate(
  oldNodesErr: Error | null,
  oldNodes: unknown[],
  incomingNodes: unknown[],
): { status: 400 | 500; message: string } | null {
  const isEnoent = (oldNodesErr as NodeJS.ErrnoException)?.code === 'ENOENT';
  if (oldNodesErr !== null && !isEnoent) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'server', level: 'warn',
      message: 'situations PUT: baseline unreadable (non-ENOENT) — failing closed (t/3890)',
      data: { error: oldNodesErr.message },
    });
    return { status: 500, message: 'Baseline situations file is unreadable — write refused to prevent silent non-BDI data' };
  }
  let nodesToCheck: SituationNode[];
  if (oldNodesErr === null && oldNodes.length > 0) {
    const { added, modified } = diffNodes(
      oldNodes as Parameters<typeof diffNodes>[0],
      incomingNodes as Parameters<typeof diffNodes>[1],
    );
    const changedSet = new Set([...added, ...modified]);
    nodesToCheck = (incomingNodes as SituationNode[]).filter(n => changedSet.has(n.id));
  } else {
    nodesToCheck = incomingNodes as SituationNode[]; // ENOENT or empty baseline: validate all
  }
  const violations = findSituationBdiViolations(nodesToCheck);
  if (violations.length > 0) {
    const details = violations.map(v => `${v.id} (${v.pov}): ${v.reason}`).join('; ');
    return { status: 400, message: `BDI validation failed — ${violations.length} violation(s): ${details}` };
  }
  return null;
}

// t/4187: the If-Match precondition is required on every taxonomy save — a missing header means
// the client loaded the file before this contract existed (or skipped the ForEdit load path) and
// has no base version to protect against a lost update. Returns the unquoted baseSha on success,
// or undefined after already writing the 428 response.
function requireBaseVersion(req: IncomingMessage, res: ServerResponse): string | undefined {
  const ifMatch = req.headers?.['if-match'];
  const baseSha = typeof ifMatch === 'string' ? ifMatch.replace(/^"|"$/g, '') : undefined;
  if (!baseSha) {
    error(res, 'Save requires an If-Match header carrying the base version read before editing.', 428, undefined, { code: 'BASE_VERSION_REQUIRED' });
    return undefined;
  }
  return baseSha;
}

// Extracted from the PUT handler to keep its own complexity under budget (t/4185 CI gate): reads the
// prior nodes, runs the t/3890 BDI gate for situations, computes the t/3171 changed-id set for the
// inline grounding reconcile, and stamps authorship — all the branching that only applies when the
// body carries a `nodes` array. Mutates `incoming.nodes` in place (stamped) like the original inline code.
async function prepareTaxonomyNodeWrite(
  pov: string,
  incoming: { nodes?: unknown[] },
): Promise<{ gate: { status: 400 | 500; message: string } | null; changedNodeIds: string[] }> {
  let oldNodes: unknown[] = [];
  let oldNodesErr: Error | null = null;
  try {
    const existing = await fileIO.readTaxonomyFile(pov) as { nodes?: unknown[] };
    oldNodes = existing?.nodes ?? [];
  } catch (err) {
    oldNodesErr = err as Error;
    /* telemetry — silent by design: first write or missing file; situations handled in situationsBdiGate */
  }

  // t/3890: BDI gate — situations only, changed nodes only, fail-closed on unreadable baseline
  if (pov === 'situations') {
    const gate = situationsBdiGate(oldNodesErr, oldNodes, incoming.nodes as unknown[]);
    if (gate) return { gate, changedNodeIds: [] };
  }

  let changedNodeIds: string[] = [];
  if (getFlag('grounding_reconcile_inline')) {
    const { added, modified, deleted } = diffNodes(
      oldNodes as Parameters<typeof diffNodes>[0],
      incoming.nodes as Parameters<typeof diffNodes>[1],
    );
    changedNodeIds = [...added, ...modified, ...deleted]; // deleted → the reconciler purges their grounding
  }
  incoming.nodes = stampNodeAuthorship(
    oldNodes as Parameters<typeof stampNodeAuthorship>[0],
    incoming.nodes as Parameters<typeof stampNodeAuthorship>[1],
  );
  return { gate: null, changedNodeIds };
}

export function registerTaxonomyRoutes(r: Router, ctx: ServerCtx): void {
  const { get, put } = r;
  const { ensureSessionBranch } = ctx;

  // ── Synthetic corpus (must precede the :pov wildcard) ──

  get('/api/taxonomy/synthetic-embeddings', async (_req, res) => {
    // t/3246: unconditional handler-entry marker (established component 'api', token-clean fields) — the
    // getter's warm/cold serialize_ms lines weren't reaching Log Analytics; if THIS line also never lands
    // post-deploy, the deployed bundle ≠ source (build/artifact issue), if it lands but the getter lines
    // don't, the branch logs are the problem. Pinned via the next redeploy-from-main (TL p/522).
    log.api.info({ component: 'api', route: 'synthetic-embeddings', phase: 'entry' }, 'synthetic-embeddings handler entry');
    try {
      // t/3165: serve the serialize-once cached Buffer (near-free on a hit). The cold path builds +
      // chunk-yield-serializes once, promise-deduped for concurrent cold callers. See the cache-
      // invalidation (write-frozen) contract at the cache site above.
      const buffer = await getSyntheticEmbeddingsBuffer();
      sendJsonBuffer(res, buffer);
    } catch (err) {
      // t/3246 (Fallback-Path Logging, docs/error-handling.md): a synth-corpus load failure previously
      // recorded ONLY to the FR ring — invisible on stdout/Log Analytics. Emit an error line too so the
      // degraded path (500 to the caller) is greppable. No secrets in a corpus load error.
      log.api.error({ component: 'api', route: 'synthetic-embeddings', err: String(err) }, 'synthetic-embeddings load failed');
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load synthetic embeddings',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/taxonomy/synthetic/:pov', async (req, res) => {
    try {
      const pov = param(req, 'pov', '/api/taxonomy/synthetic/:pov');
      const data = await fileIO.loadSyntheticCorpus(pov);
      if (data === null) { json(res, null); return; }
      json(res, data);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to load synthetic corpus', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  // ── Taxonomy CRUD ──

  get('/api/taxonomy/:pov', async (req, res) => {
    try {
      const pov = param(req, 'pov', '/api/taxonomy/:pov');
      const { data, version } = await fileIO.readTaxonomyFileWithVersion(pov);
      if (version) res.setHeader('ETag', `"${version}"`);
      json(res, data);
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to read taxonomy file', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });

  put('/api/taxonomy/:pov', async (req, res, body) => {
    if (isAnonymousUser()) { error(res, 'Anonymous users cannot save taxonomy edits. Sign in to save.', 403); return; }
    const baseSha = requireBaseVersion(req, res);
    if (!baseSha) return;
    try {
      await ensureSessionBranch();
      const pov = param(req, 'pov', '/api/taxonomy/:pov');
      const incoming = body as { nodes?: unknown[] };
      // t/3171 (G8a): changed-node ids for the inline grounding reconcile, captured before stamping
      // (nodeContentHash excludes the stamp fields, so pre/post-stamp content diffs identically) and
      // while oldNodes is in scope. Only computed when the flag is on → flag-OFF adds one getFlag().
      let changedNodeIds: string[] = [];
      if (incoming.nodes && Array.isArray(incoming.nodes)) {
        const result = await prepareTaxonomyNodeWrite(pov, incoming);
        if (result.gate) { error(res, result.gate.message, result.gate.status); return; }
        changedNodeIds = result.changedNodeIds;
      }
      const { version } = await fileIO.writeTaxonomyFile(pov, body, { baseSha });
      // t/3267 Fix A: enqueue the debounced scoped grounding reconcile BEFORE responding. It's
      // synchronous + fire-and-forget/no-throw (Set.add + a debounce timer), so it can't delay or fail
      // the response — but placing it AFTER json(res) meant a response-write throw (ECONNRESET when the
      // client already timed out the ~100s git-sync write) jumped to the catch and SKIPPED the reconcile,
      // silently leaving grounding stale on exactly the large-write PUTs that need it. Enqueue-first
      // guarantees it runs; json still returns { ok: true } immediately after. Gated OFF above until the
      // tool-lock + PS lock (t/3203) land.
      if (changedNodeIds.length > 0) enqueueGroundingReconcile(changedNodeIds);
      if (version) res.setHeader('ETag', `"${version}"`);
      json(res, { ok: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to write taxonomy file', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  // ── Node Edit History ──

  get('/api/taxonomy/:pov/node/:nodeId/history', async (req, res) => {
    try {
      const pov = param(req, 'pov', '/api/taxonomy/:pov/node/:nodeId/history');
      const nodeId = param(req, 'nodeId', '/api/taxonomy/:pov/node/:nodeId/history');
      const data = await fileIO.readTaxonomyFile(pov) as { nodes?: Array<{ id: string; _edit_history?: unknown[]; _edit_meta?: unknown }> };
      const node = data?.nodes?.find(n => n.id === nodeId);
      if (!node) { error(res, `Node ${nodeId} not found in ${pov}`, 404); return; }
      json(res, { nodeId, history: node._edit_history ?? [], edit_meta: node._edit_meta ?? null });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to load node edit history', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), 500, err); }
  });
}

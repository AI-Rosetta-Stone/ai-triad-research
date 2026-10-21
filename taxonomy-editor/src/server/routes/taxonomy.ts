// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1383 (route extraction, t/1347 follow-up): the /api/taxonomy read/write +
// synthetic-corpus + node-edit-history routes, moved verbatim out of server.ts
// behind the registration seam. The only non-verbatim change is the PUT, whose
// session-branch ensure now comes through ctx.ensureSessionBranch. The
// synthetic-embeddings ⟷ :pov collision pair is internal and registered in
// source order (synthetic-embeddings first), so first-match routing is preserved
// (see routeTable.test.ts).

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, jsonStringifyChunked, sendJsonBuffer, statusForError, codeForError, requireBaseVersion, type SerializeStats } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import * as fileIO from '../storage/fileIO.js';
import { stampNodeAuthorship, diffNodes } from '../storage/editMeta.js';
import { isAnonymousUser, getCurrentUserId } from '../security/userContext.js';
import { getFlag } from '../featureFlags.js';
import { enqueueGroundingReconcile } from '../groundingReconcileHook.js';
import { log } from '../logger.js';
import { findSituationBdiViolations } from '../../../../lib/debate/taxonomyTypes.js';
import type { SituationNode } from '../../../../lib/debate/taxonomyTypes.js';
import { isAdmin } from '../community/community.js';
import { isLocalDeployment } from '../config.js';

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
    // t/4286: serializeStats names the slicing the same way extractNodeVectorsAsync's
    // ExtractStats does — item-count yielding alone let one slice run ~700ms unyielded on this
    // corpus's uneven node sizes (t/4286#35); serialize_max_slice_ms proves whether that's fixed,
    // instead of inferring it from the total like the canary had to before this.
    const serializeStats: SerializeStats = { slices: 0, maxSliceMs: 0 };
    const buffer = await jsonStringifyChunked(data, 256, serializeStats); // yields the loop during the cold serialize
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
      serialize_slices: serializeStats.slices, serialize_max_slice_ms: Math.round(serializeStats.maxSliceMs),
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

// t/4241: response-buffer cache for GET /api/taxonomy/:pov — the t/4241 load test found event-loop
// lag of 716ms-2.7s under reader concurrency, localized by local measurement to the read+parse
// phase (GC pressure from repeated concurrent large-object-graph allocation; see t/4241#4). Caches
// the fully-serialized response Buffer keyed by (pov, content hash, variant), content-hash-keyed so
// it's SELF-INVALIDATING — a write, an overlay change, a session-branch read (t/4215), or an
// out-of-band commit all change the hash, so no write hook is needed and a route enumeration can't
// miss a writer. Also correct per user: a session user's overlay content hashes differently from
// main's, so one user never sees another's cached bytes. One entry per (pov, variant) — the latest
// hash evicts whatever was there, bounding memory (not a growing history). Promise-dedupe: a second
// concurrent miss for the same key awaits the first build rather than starting a second parse (t/3165
// pattern — see getSyntheticEmbeddingsBuffer above for the sibling implementation of this idiom).
const TAXONOMY_GET_DEFAULT_VARIANT = 'default'; // no per-caller transform exists on this route today;
// the slot is here so one is never silently needed later without a cache key change (TL review, p/522#402).

interface TaxonomyGetCacheEntry {
  hash: string;
  bufferPromise: Promise<Buffer>;
}
const taxonomyGetCache = new Map<string, TaxonomyGetCacheEntry>();

/** @internal test hook — evict everything, so tests don't leak cache state across runs. */
export function __resetTaxonomyGetCacheForTest(): void { taxonomyGetCache.clear(); }

async function getTaxonomyResponseBuffer(
  pov: string, variant: string, rawContent: string, hash: string,
): Promise<{ buffer: Buffer; cacheHit: boolean }> {
  const cacheKey = `${pov}:${variant}`;
  // No cache for a backend that can't version content (empty-string fallback, t/4187) — correctness
  // over speed; an unversioned read would mean every write looks identical to the cache.
  if (!hash) return { buffer: await jsonStringifyChunked(JSON.parse(rawContent.replace(/^﻿/, ''))), cacheHit: false };

  const existing = taxonomyGetCache.get(cacheKey);
  if (existing && existing.hash === hash) return { buffer: await existing.bufferPromise, cacheHit: true };

  const bufferPromise = (async () => {
    const data = JSON.parse(rawContent.replace(/^﻿/, '')); // strips a PowerShell-written UTF-8 BOM, same as fileIO.ts's parse
    return jsonStringifyChunked(data);
  })();
  taxonomyGetCache.set(cacheKey, { hash, bufferPromise });
  bufferPromise.catch(() => {
    // A parse/stringify failure must not poison the cache for the NEXT (possibly fixed) read —
    // evict only if we're still the current entry for this key (a newer write may have replaced us).
    if (taxonomyGetCache.get(cacheKey)?.bufferPromise === bufferPromise) taxonomyGetCache.delete(cacheKey);
  });
  return { buffer: await bufferPromise, cacheHit: false };
}

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

// t/4229 (t/4167 part B): the hosted web app writes go through github-api; a prod rollback runbook
// can set STORAGE_MODE=filesystem on hosted prod, so mode alone would fail OPEN there. NODE_ENV
// pins this to genuine desktop/local-server use (TL review, p/522#390).
// t/4316: delegates to config.ts's isLocalDeployment() — same predicate, converged rather than
// re-derived, per t/4234's own callers-should-converge note.
function isPovTagsGateExempt(): boolean {
  return isLocalDeployment();
}

type PovTaggedNode = { id: string; pov_tags?: string[] };

function diffPovTagSets(oldTags: string[] | undefined, newTags: string[] | undefined): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldTags ?? []);
  const newSet = new Set(newTags ?? []);
  return {
    added: [...newSet].filter(t => !oldSet.has(t)),
    removed: [...oldSet].filter(t => !newSet.has(t)),
  };
}

// t/4229: only admins may change pov_tags in hosted mode (PI p/548#290). Compares each incoming
// node against its prior version (by id); a brand-new node may carry no tags. Deletions (an old id
// absent from incoming) are always allowed — nothing to check. Returns one violation per node so a
// multi-node save names every offending id, not just the first.
type TaxonomyWriteGate = { status: number; message: string; code?: string };

function checkPovTagsAdminGate(
  oldNodes: PovTaggedNode[],
  incomingNodes: PovTaggedNode[],
  callerIsAdmin: boolean,
): TaxonomyWriteGate | null {
  if (callerIsAdmin) return null;
  const oldById = new Map(oldNodes.map(n => [n.id, n]));
  const violations: string[] = [];
  for (const node of incomingNodes) {
    const old = oldById.get(node.id);
    const { added, removed } = diffPovTagSets(old?.pov_tags, node.pov_tags);
    if (added.length > 0 || removed.length > 0) {
      violations.push(`${node.id} (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'})`);
    }
  }
  if (violations.length === 0) return null;
  const callerId = getCurrentUserId();
  log.server.warn({ caller: callerId, violations }, 'PUT /api/taxonomy/:pov: non-admin pov_tags change refused (t/4229)');
  return { status: 403, message: `Only admins can change pov_tags. Refused for: ${violations.join('; ')}` };
}

// Extracted from the PUT handler to keep its own complexity under budget (t/4185 CI gate): reads the
// prior nodes, runs the t/3890 BDI gate for situations, computes the t/3171 changed-id set for the
// inline grounding reconcile, the t/4229 pov_tags admin gate, and stamps authorship — all the
// branching that only applies when the body carries a `nodes` array. Mutates `incoming.nodes` in
// place (stamped) like the original inline code.
async function prepareTaxonomyNodeWrite(
  pov: string,
  incoming: { nodes?: unknown[] },
  baseSha: string,
): Promise<{ gate: TaxonomyWriteGate | null; changedNodeIds: string[] }> {
  let oldNodes: unknown[] = [];
  let oldNodesErr: Error | null = null;
  let readVersion: string | null = null;
  try {
    const { data: existing, version } = await fileIO.readTaxonomyFileWithVersion(pov) as { data: { nodes?: unknown[] }; version: string };
    oldNodes = existing?.nodes ?? [];
    readVersion = version || null; // t/4229 SO C1 (e/303#2): an empty/falsy version counts as versionless too
  } catch (err) {
    oldNodesErr = err as Error;
    /* telemetry — silent by design: first write or missing file; situations handled in situationsBdiGate */
  }

  // t/3890: BDI gate — situations only, changed nodes only, fail-closed on unreadable baseline
  if (pov === 'situations') {
    const gate = situationsBdiGate(oldNodesErr, oldNodes, incoming.nodes as unknown[]);
    if (gate) return { gate, changedNodeIds: [] };
  }

  // t/4229: the pov_tags admin gate must FAIL CLOSED, not skip, when it can't establish the exact
  // base the client edited from (SO C1, e/303#2 — overriding the original TL review's "the write's
  // own precondition will 409 anyway" reasoning). baseSha is caller-supplied and the version is a
  // predictable git blob SHA, so a non-admin can deliberately engineer a stale-looking read whose
  // claimed baseSha later matches the real pre-write state, sliding an ungated change through the
  // write's own precondition. Never write when the gate couldn't run.
  if (!isPovTagsGateExempt() && incoming.nodes && Array.isArray(incoming.nodes)) {
    if (oldNodesErr) {
      return {
        gate: { status: statusForError(oldNodesErr, 503), message: 'Could not verify the base version for the pov_tags admin check — refusing to write.', code: 'VERSION_UNAVAILABLE' },
        changedNodeIds: [],
      };
    }
    if (readVersion !== baseSha) {
      return {
        gate: { status: 409, message: 'Base version mismatch — reload and retry.', code: 'WRITE_CONFLICT' },
        changedNodeIds: [],
      };
    }
    const gate = checkPovTagsAdminGate(oldNodes as PovTaggedNode[], incoming.nodes as PovTaggedNode[], isAdmin());
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
      // t/4241: per-phase timings (debug-level, cheap) — DevOps's load-test found event-loop lag of
      // 716ms-2.7s under light-to-moderate reader concurrency, CPU staying under 14% throughout.
      // Local measurement (TL review, p/522#402) localized the cost to "load" (storage read +
      // JSON.parse) — stringify stayed flat under the same concurrency. The cache below (t/4241
      // design) skips parse+stringify entirely on a hit, keyed by content hash so it's self-
      // invalidating; "load" below is now read-only (the parse moved inside the cache helper).
      const tLoadStart = process.hrtime.bigint();
      const { content: rawContent, version } = await fileIO.readTaxonomyFileRawWithVersion(pov);
      const tLoadEnd = process.hrtime.bigint();
      if (version) res.setHeader('ETag', `"${version}"`);
      if (res.writableEnded || res.headersSent) { // t/1515: mirrors httpKit.json()'s idempotent-write guard
        log.server.warn({ component: 'taxonomy-get', pov }, 'GET /api/taxonomy/:pov: response already sent — skipping duplicate write');
        return;
      }
      const tSerializeStart = process.hrtime.bigint();
      const { buffer, cacheHit } = await getTaxonomyResponseBuffer(pov, TAXONOMY_GET_DEFAULT_VARIANT, rawContent, version);
      const tSerializeEnd = process.hrtime.bigint();
      sendJsonBuffer(res, buffer);
      const tWriteEnd = process.hrtime.bigint();
      log.api.debug({
        component: 'api', route: 'taxonomy-get', pov, cacheHit,
        loadMs: Number(tLoadEnd - tLoadStart) / 1e6,
        serializeMs: Number(tSerializeEnd - tSerializeStart) / 1e6,
        writeMs: Number(tWriteEnd - tSerializeEnd) / 1e6,
        totalMs: Number(tWriteEnd - tLoadStart) / 1e6,
        bytes: buffer.length,
      }, 'GET /api/taxonomy/:pov phase timings (t/4241)');
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
        const result = await prepareTaxonomyNodeWrite(pov, incoming, baseSha);
        if (result.gate) { error(res, result.gate.message, result.gate.status, undefined, result.gate.code ? { code: result.gate.code } : undefined); return; }
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

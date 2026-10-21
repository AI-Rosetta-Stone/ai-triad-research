// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Node→source reverse index (t/4333/t/4334) — extracted from fileIO.ts
 * (ADR-007, same pattern as debateStore.ts/calibrationStore.ts/urlFetch.ts:
 * re-exported from fileIO.ts, so the public surface is unchanged).
 *
 * Scans all summary JSON files and builds nodeId → source reference list,
 * collapsing processing artifacts (split parts, re-ingested copies of the
 * same document) into one `canonicalDocId` per real document via the shared
 * tier 1-4 algorithm in `lib/sourceIndex/types.ts` (also used by Electron's
 * `src/main/fileIO.ts`, for parity). Built lazily, cached until the
 * summaries-dir listing changes — never a TTL.
 */

import path from 'path';
import { createHash } from 'crypto';
import { loadDataConfig, resolveDataPath } from '../config.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import {
  groupSourceIdentities, computeSourceContentHash,
  type SourceReference, type SourceCardMeta, type NodeSourceIndex, type SourceIdentityDoc, type SourceIdentityMeta,
  type SourceUrlConflict,
} from '../../../../lib/sourceIndex/types.js';
import { getBackend, getSourcesDir } from './fileIO.js';
import {
  type SnapshotHashCache, gitBlobSha, loadSnapshotHashCache, lookupCachedHash, recordHash, pruneAndSaveSnapshotHashCache,
} from './snapshotHashCache.js';

export type { SourceReference, SourceCardMeta, NodeSourceIndex };

type NodeSourceMeta = {
  title: string; url: string | null; sourceType: string; datePublished: string;
  authors: string[]; topicTags: string[]; oneLiner: string | null;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** t/4344: a doc with no *recorded* `content_sha256` (ingested before t/4337)
 *  gets a *computed* one from `snapshot.md`, per the shared spec (section
 *  4.0) — this can only ever make a hash edge, never veto a suffix edge
 *  (that needs a recorded hash on both sides), so a missing snapshot file or
 *  a read failure safely degrades to "no hash signal" rather than a wrong one.
 *
 *  t/4350: the normalize-and-hash step is the expensive part (BOM/line-ending/
 *  provenance-header stripping, Unicode NFC, per-line trim), not the file
 *  read itself (still needed every build to derive the blob SHA for
 *  FilesystemBackend/AzureBlobBackend, which have no content hash of their
 *  own) — so `hashCache` skips re-normalizing a doc whose blob SHA hasn't
 *  changed since the last build. */
async function computeSnapshotHash(sourcesDir: string, docId: string, hashCache: SnapshotHashCache): Promise<string | null> {
  const backend = getBackend();
  const snapshotPath = path.join(sourcesDir, docId, 'snapshot.md');
  try {
    const raw = await backend.readFile(snapshotPath);
    if (raw === null) return null;
    const blobSha = gitBlobSha(raw);
    const cached = lookupCachedHash(hashCache, docId, blobSha);
    if (cached !== undefined) return cached;
    const hash = computeSourceContentHash(raw, sha256Hex);
    recordHash(hashCache, docId, blobSha, hash);
    return hash;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: `computeSnapshotHash: failed to read/hash snapshot, degrading to no hash signal for this doc: ${snapshotPath}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

type SourceMetaEntry = { metaCache: NodeSourceMeta; identityMeta: SourceIdentityMeta; snapshotHash: string | null };

// Raw metadata.json shape asserted field-by-field, not typed — JSON.parse's
// result is unknown and every field below is read defensively regardless.
function buildCardMetaFromRawJson(meta: Record<string, unknown>, name: string): NodeSourceMeta {
  return {
    title: (meta.title as string) || name,
    url: (meta.url as string) || null,
    sourceType: (meta.source_type as string) || 'unknown',
    datePublished: (meta.date_published as string) || (meta.source_time as string) || '',
    authors: Array.isArray(meta.authors) ? meta.authors as string[] : [],
    topicTags: Array.isArray(meta.topic_tags) ? meta.topic_tags as string[] : [],
    oneLiner: (meta.one_liner as string) || null,
  };
}

function buildIdentityMetaFromRawJson(meta: Record<string, unknown>): SourceIdentityMeta {
  return {
    title: (meta.title as string) ?? null,
    url: (meta.url as string) ?? null,
    resolved_url: (meta.resolved_url as string) ?? null,
    provenance: Array.isArray(meta.provenance) ? meta.provenance as SourceIdentityMeta['provenance'] : [],
    content_sha256: (meta.content_sha256 as string) ?? null,
    same_as: (meta.same_as as string) ?? null,
    parent_doc_id: (meta.parent_doc_id as string) ?? null,
  };
}

async function readAndParseMetadata(backend: ReturnType<typeof getBackend>, metaPath: string): Promise<unknown> {
  let metaRaw: string | null;
  try {
    metaRaw = await backend.readFile(metaPath);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: `readAndParseMetadata: failed to read metadata.json, excluding this doc from the index build: ${metaPath}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return undefined;
  }
  if (metaRaw === null) return undefined;
  try {
    return JSON.parse(metaRaw);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: `readAndParseMetadata: malformed metadata.json, excluding this doc from the index build: ${metaPath}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return undefined;
  }
}

async function loadOneSourceMetaEntry(sourcesDir: string, name: string, hashCache: SnapshotHashCache): Promise<SourceMetaEntry | null> {
  const metaPath = path.join(sourcesDir, name, 'metadata.json');
  const meta = await readAndParseMetadata(getBackend(), metaPath);
  if (meta === undefined) return null;

  const raw = meta as Record<string, unknown>;
  const metaCache = buildCardMetaFromRawJson(raw, name);
  const identityMeta = buildIdentityMetaFromRawJson(raw);
  const snapshotHash = identityMeta.content_sha256 ? null : await computeSnapshotHash(sourcesDir, name, hashCache);
  return { metaCache, identityMeta, snapshotHash };
}

async function loadNodeMetaCache(
  sourcesDir: string | null,
): Promise<{ metaCache: Record<string, NodeSourceMeta>; identityMeta: Record<string, SourceIdentityMeta>; snapshotHashes: Record<string, string | null> }> {
  const metaCache: Record<string, NodeSourceMeta> = {};
  const identityMeta: Record<string, SourceIdentityMeta> = {};
  const snapshotHashes: Record<string, string | null> = {};
  const sourceEntries = sourcesDir ? await getBackend().listDirectory(sourcesDir) : [];
  // t/4350: one persisted cache load/save per build, not per doc — entries
  // for docs no longer in sourceEntries are dropped on save.
  const hashCache = loadSnapshotHashCache();
  await Promise.all(sourceEntries.map(async (name) => {
    const entry = await loadOneSourceMetaEntry(sourcesDir!, name, hashCache);
    if (!entry) return;
    metaCache[name] = entry.metaCache;
    identityMeta[name] = entry.identityMeta;
    snapshotHashes[name] = entry.snapshotHash;
  }));
  pruneAndSaveSnapshotHashCache(hashCache, sourceEntries);
  return { metaCache, identityMeta, snapshotHashes };
}

/** t/4334/t/4333 (PI scope addition, p/548#306): % of sources carrying each
 *  optional card field, so the UI's "how often is the card partial" question
 *  has a real number instead of a guess. Logged once per build, not per request. */
function sourceCardFieldCoverage(metaCache: Record<string, NodeSourceMeta>): { authorsPct: number; topicTagsPct: number; oneLinerPct: number; total: number } {
  const entries = Object.values(metaCache);
  const total = entries.length;
  if (total === 0) return { authorsPct: 0, topicTagsPct: 0, oneLinerPct: 0, total: 0 };
  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  return {
    total,
    authorsPct: pct(entries.filter(e => e.authors.length > 0).length),
    topicTagsPct: pct(entries.filter(e => e.topicTags.length > 0).length),
    oneLinerPct: pct(entries.filter(e => e.oneLiner !== null).length),
  };
}

async function indexSummaryFile(
  summariesDir: string, file: string, metaCache: Record<string, NodeSourceMeta>, index: NodeSourceIndex,
): Promise<void> {
  const backend = getBackend();
  const docId = file.replace(/\.json$/, '');
  let summary: {
    pov_summaries?: Record<string, {
      key_points?: Array<{
        taxonomy_node_id?: string | null;
        point?: string; stance?: string; verbatim?: string; excerpt_context?: string;
      }>;
    }>;
  };
  try {
    const raw = await backend.readFile(path.join(summariesDir, file));
    if (raw === null) return;
    summary = JSON.parse(raw);
  } catch { /* telemetry — silent by design */ return; }
  const meta = metaCache[docId] ?? { title: docId, url: null, sourceType: 'unknown', datePublished: '', authors: [], topicTags: [], oneLiner: null };
  for (const [pov, povData] of Object.entries(summary.pov_summaries || {})) {
    for (const kp of povData.key_points || []) {
      const nodeId = kp.taxonomy_node_id;
      if (!nodeId) continue;
      if (!index[nodeId]) index[nodeId] = [];
      index[nodeId].push({
        docId, canonicalDocId: docId, title: meta.title, pov,
        stance: kp.stance || 'neutral',
        point: kp.point || '',
        verbatim: kp.verbatim || '',
        excerptContext: kp.excerpt_context || '',
        url: meta.url, sourceType: meta.sourceType, datePublished: meta.datePublished,
      });
    }
  }
}

async function indexSummaryFiles(
  summaryFiles: string[], summariesDir: string, metaCache: Record<string, NodeSourceMeta>, index: NodeSourceIndex,
): Promise<void> {
  await Promise.all(
    summaryFiles.filter(f => f.endsWith('.json')).map(file => indexSummaryFile(summariesDir, file, metaCache, index))
  );
}

/** Fills in `canonicalDocId` (today it's set to each ref's own `docId` by
 *  `indexSummaryFile`) using the shared source-identity algorithm
 *  (`docs/specs/source-identity.md`, t/4344), mutating `index` in place.
 *  Every `docId` seen anywhere in the index participates, so a split part
 *  reachable only via one node still resolves against the full known-id
 *  set. Returns the title-collision and url-conflict reports (spec 4.5) for
 *  the caller to log — both are signals for a human cleanup pass, never
 *  applied as a merge. */
function applyCanonicalDocIds(
  index: NodeSourceIndex, identityMeta: Record<string, SourceIdentityMeta>, snapshotHashes: Record<string, string | null>,
): { titleCollisions: string[][]; urlConflicts: SourceUrlConflict[] } {
  const allDocIds = new Set<string>();
  for (const refs of Object.values(index)) for (const r of refs) allDocIds.add(r.docId);
  const docs: SourceIdentityDoc[] = [...allDocIds].map(id => ({
    id,
    metadata: identityMeta[id] ?? { title: id },
    snapshotSha256: snapshotHashes[id] ?? null,
  }));
  const { canonical, titleCollisions, urlConflicts } = groupSourceIdentities(docs);
  for (const refs of Object.values(index)) {
    for (const r of refs) r.canonicalDocId = canonical[r.docId] ?? r.docId;
  }
  return { titleCollisions, urlConflicts };
}

/**
 * Scan all summary JSON files and build a reverse index:
 * nodeId → list of source references that mapped to it.
 */
export async function buildNodeSourceIndex(): Promise<NodeSourceIndex> {
  const backend = getBackend();
  const summariesDir = resolveDataPath(loadDataConfig().summaries_dir);
  const sourcesDir = getSourcesDir();
  const index: NodeSourceIndex = {};

  const summaryFiles = await backend.listDirectory(summariesDir);
  if (summaryFiles.length === 0) return index;

  const { metaCache, identityMeta, snapshotHashes } = await loadNodeMetaCache(sourcesDir);
  await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index);
  applyCanonicalDocIds(index, identityMeta, snapshotHashes);
  return index;
}

// ── t/4334: build-once, invalidate-on-change cache + per-node lookup ──

type NodeSourceIndexCache = {
  index: NodeSourceIndex;
  cards: Record<string, SourceCardMeta>;
  /** Monotonic generation, bumped on every (re)build — mirrors
   *  `GitHubAPIBackend.getCacheGeneration()`'s existing convention. Callers
   *  (ServerAPI's route, Rosetta's client cache) key off this, not a TTL. */
  indexVersion: number;
  /** The summaries-dir listing at build time — the cheapest available
   *  data-change signal: an add/remove changes the file count or names. */
  invalidationSignature: string;
};

let nodeSourceIndexCache: NodeSourceIndexCache | null = null;
let nodeSourceIndexGeneration = 0;
let nodeSourceIndexBuildPromise: Promise<NodeSourceIndexCache> | null = null;

async function currentInvalidationSignature(): Promise<string> {
  const summariesDir = resolveDataPath(loadDataConfig().summaries_dir);
  const files = await getBackend().listDirectory(summariesDir);
  return files.slice().sort().join('|');
}

function buildCardMetaByCanonicalId(index: NodeSourceIndex, metaCache: Record<string, NodeSourceMeta>): Record<string, SourceCardMeta> {
  const cards: Record<string, SourceCardMeta> = {};
  for (const refs of Object.values(index)) {
    for (const r of refs) {
      if (cards[r.canonicalDocId]) continue; // one card per canonical document, not per reference
      cards[r.canonicalDocId] = cardMetaFor(r, metaCache);
    }
  }
  return cards;
}

function cardMetaFor(r: SourceReference, metaCache: Record<string, NodeSourceMeta>): SourceCardMeta {
  const m = metaCache[r.docId] ?? metaCache[r.canonicalDocId];
  return {
    title: m?.title ?? r.title,
    url: m?.url ?? r.url,
    authors: m?.authors ?? [],
    datePublished: m?.datePublished ?? r.datePublished,
    topicTags: m?.topicTags ?? [],
    oneLiner: m?.oneLiner ?? null,
  };
}

async function rebuildNodeSourceIndexCache(): Promise<NodeSourceIndexCache> {
  const start = Date.now();
  const summariesDir = resolveDataPath(loadDataConfig().summaries_dir);
  const sourcesDir = getSourcesDir();
  const index: NodeSourceIndex = {};
  const summaryFiles = await getBackend().listDirectory(summariesDir);
  const { metaCache, identityMeta, snapshotHashes } = await loadNodeMetaCache(sourcesDir);
  await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index);
  const { titleCollisions, urlConflicts } = applyCanonicalDocIds(index, identityMeta, snapshotHashes);
  const cards = buildCardMetaByCanonicalId(index, metaCache);
  nodeSourceIndexGeneration += 1;

  const entryCount = Object.values(index).reduce((n, refs) => n + refs.length, 0);
  const payloadBytes = Buffer.byteLength(JSON.stringify(index), 'utf-8');
  const coldBuildMs = Date.now() - start;
  const coverage = sourceCardFieldCoverage(metaCache);
  log.server.info(
    {
      coldBuildMs, entryCount, payloadBytes, nodeCount: Object.keys(index).length, canonicalDocCount: Object.keys(cards).length,
      titleCollisionCount: titleCollisions.length, urlConflictCount: urlConflicts.length, ...coverage,
    },
    'Node source index rebuilt',
  );
  if (titleCollisions.length > 0) {
    // t/4344 spec 4.5: a report for a human cleanup pass (t/4337), never applied as a merge.
    log.server.warn({ titleCollisions }, 'Node source index: title collisions found (no merge applied, human review needed)');
  }
  if (urlConflicts.length > 0) {
    // t/4344 spec 4.3/4.5: a pair vetoed from joining on a shared URL key, reported for the same human cleanup pass.
    log.server.warn({ urlConflicts }, 'Node source index: URL conflicts found (no merge applied, human review needed)');
  }
  getGlobalRecorder()?.record({
    type: 'system.info', component: 'node-source-index', level: 'info',
    message: 'Node source index rebuilt',
    data: { coldBuildMs, entryCount, payloadBytes, indexVersion: nodeSourceIndexGeneration, ...coverage },
  });

  return { index, cards, indexVersion: nodeSourceIndexGeneration, invalidationSignature: await currentInvalidationSignature() };
}

/** Builds lazily on first use (never at boot — avoids blocking server
 *  startup on a full summaries scan), reusing an in-flight build rather than
 *  starting a second one for concurrent callers. Invalidated by comparing
 *  the summaries-dir listing, not a TTL (t/4333 point 2). */
async function getNodeSourceIndexCache(): Promise<NodeSourceIndexCache> {
  if (nodeSourceIndexCache) {
    const sig = await currentInvalidationSignature();
    if (sig === nodeSourceIndexCache.invalidationSignature) return nodeSourceIndexCache;
  }
  if (!nodeSourceIndexBuildPromise) {
    nodeSourceIndexBuildPromise = rebuildNodeSourceIndexCache().finally(() => { nodeSourceIndexBuildPromise = null; });
  }
  nodeSourceIndexCache = await nodeSourceIndexBuildPromise;
  return nodeSourceIndexCache;
}

/**
 * t/4334 — per-node lookup for the Sources tab (t/4333), replacing the
 * whole-corpus `/api/node-source-index` response for a single-node render.
 * `verbatim`/`excerptContext` stay in the full reference list (not split into
 * an on-demand-only shape yet — ServerAPI's transport, t/4335, decides the
 * wire format); this just scopes the build to one node's references plus one
 * source card per canonical document referenced.
 */
export async function getNodeSources(nodeId: string): Promise<{ sources: SourceReference[]; cards: Record<string, SourceCardMeta>; indexVersion: number }> {
  const cache = await getNodeSourceIndexCache();
  const sources = cache.index[nodeId] ?? [];
  const cards: Record<string, SourceCardMeta> = {};
  for (const ref of sources) {
    if (cards[ref.canonicalDocId]) continue;
    const card = cache.cards[ref.canonicalDocId];
    if (card) cards[ref.canonicalDocId] = card;
  }
  return { sources, cards, indexVersion: cache.indexVersion };
}

/** Test-only: forces the next `getNodeSourceIndexCache()` call to rebuild,
 *  regardless of the invalidation signature. */
export function resetNodeSourceIndexCacheForTests(): void {
  nodeSourceIndexCache = null;
  nodeSourceIndexGeneration = 0;
}

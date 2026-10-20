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
import { loadDataConfig, resolveDataPath } from '../config.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { computeCanonicalDocIds, type SourceReference, type SourceCardMeta, type NodeSourceIndex } from '../../../../lib/sourceIndex/types.js';
import { getBackend, getSourcesDir } from './fileIO.js';

export type { SourceReference, SourceCardMeta, NodeSourceIndex };

type NodeSourceMeta = {
  title: string; url: string | null; sourceType: string; datePublished: string;
  authors: string[]; topicTags: string[]; oneLiner: string | null;
};

async function loadNodeMetaCache(sourcesDir: string | null): Promise<Record<string, NodeSourceMeta>> {
  const backend = getBackend();
  const metaCache: Record<string, NodeSourceMeta> = {};
  const sourceEntries = sourcesDir ? await backend.listDirectory(sourcesDir) : [];
  await Promise.all(sourceEntries.map(async (name) => {
    const metaPath = path.join(sourcesDir!, name, 'metadata.json');
    try {
      const metaRaw = await backend.readFile(metaPath);
      if (metaRaw !== null) {
        const meta = JSON.parse(metaRaw);
        metaCache[name] = {
          title: meta.title || name,
          url: meta.url || null,
          sourceType: meta.source_type || 'unknown',
          datePublished: meta.date_published || meta.source_time || '',
          authors: Array.isArray(meta.authors) ? meta.authors : [],
          topicTags: Array.isArray(meta.topic_tags) ? meta.topic_tags : [],
          oneLiner: meta.one_liner || null,
        };
      }
    } catch { /* telemetry — silent by design;  skip */ }
  }));
  return metaCache;
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
 *  `indexSummaryFile`) using the shared tier 1-4 algorithm, mutating `index`
 *  in place. Every `docId` seen anywhere in the index participates, so a
 *  split part reachable only via one node still resolves against the full
 *  known-id set. */
function applyCanonicalDocIds(index: NodeSourceIndex, metaCache: Record<string, NodeSourceMeta>): void {
  const allDocIds = new Set<string>();
  for (const refs of Object.values(index)) for (const r of refs) allDocIds.add(r.docId);
  const docIds = [...allDocIds];
  const canonicalMeta: Record<string, { url: string | null; title: string }> = {};
  for (const id of docIds) {
    const m = metaCache[id];
    canonicalMeta[id] = { url: m?.url ?? null, title: m?.title ?? id };
  }
  const canonicalIds = computeCanonicalDocIds(docIds, canonicalMeta);
  for (const refs of Object.values(index)) {
    for (const r of refs) r.canonicalDocId = canonicalIds[r.docId] ?? r.docId;
  }
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

  const metaCache = await loadNodeMetaCache(sourcesDir);
  await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index);
  applyCanonicalDocIds(index, metaCache);
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
  const metaCache = await loadNodeMetaCache(sourcesDir);
  await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index);
  applyCanonicalDocIds(index, metaCache);
  const cards = buildCardMetaByCanonicalId(index, metaCache);
  nodeSourceIndexGeneration += 1;

  const entryCount = Object.values(index).reduce((n, refs) => n + refs.length, 0);
  const payloadBytes = Buffer.byteLength(JSON.stringify(index), 'utf-8');
  const coldBuildMs = Date.now() - start;
  const coverage = sourceCardFieldCoverage(metaCache);
  log.server.info(
    { coldBuildMs, entryCount, payloadBytes, nodeCount: Object.keys(index).length, canonicalDocCount: Object.keys(cards).length, ...coverage },
    'Node source index rebuilt',
  );
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

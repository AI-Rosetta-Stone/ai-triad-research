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
import { mergeGroupEvidence, type EvidenceUnionMember } from '../../../../lib/sourceIndex/evidenceUnion.js';
import { getBackend, getSourcesDir } from './fileIO.js';
import {
  type SnapshotHashCache, gitBlobSha, loadSnapshotHashCache, lookupCachedHash, recordHash, pruneAndSaveSnapshotHashCache,
} from './snapshotHashCache.js';
import { loadSourcesIndex } from './sourcesIndexReader.js';
import type { SourcesIndexFile } from '../../../../lib/sourceIndex/sourcesIndexSchema.js';

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
    const raw = await backend.readFile(snapshotPath, { ref: 'main' });
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
    duplicate_of: (meta.duplicate_of as string) ?? null, // t/4337 C1 (spec section 6)
  };
}

async function readAndParseMetadata(backend: ReturnType<typeof getBackend>, metaPath: string): Promise<unknown> {
  let metaRaw: string | null;
  try {
    metaRaw = await backend.readFile(metaPath, { ref: 'main' });
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

type LoadedNodeMeta = { metaCache: Record<string, NodeSourceMeta>; identityMeta: Record<string, SourceIdentityMeta>; snapshotHashes: Record<string, string | null> };

function cardMetaFromSourcesIndexEntry(entry: SourcesIndexFile['docs'][number]): NodeSourceMeta {
  return {
    title: entry.title || entry.id,
    url: entry.url || null,
    sourceType: 'unknown', // not carried by the index — no card consumer reads it
    datePublished: entry.date_published || '',
    authors: entry.authors ?? [],
    topicTags: entry.topic_tags ?? [],
    oneLiner: entry.one_liner ?? null,
  };
}

function identityMetaFromSourcesIndexEntry(entry: SourcesIndexFile['docs'][number]): SourceIdentityMeta {
  return {
    title: entry.title ?? null,
    url: entry.url ?? null,
    resolved_url: entry.resolved_url ?? null,
    provenance: entry.provenance ?? [],
    content_sha256: entry.content_sha256 ?? null,
    same_as: entry.same_as ?? null,
    parent_doc_id: entry.parent_doc_id ?? null,
    duplicate_of: entry.duplicate_of ?? null, // t/4357: carry the mark through the hosted index path too
  };
}

/** t/4334#18: the index's own recorded-vs-computed hash split
 *  (`content_sha256` / `snapshot_sha256`) maps directly onto
 *  `identityMeta.content_sha256` (recorded, suffix-veto-eligible) and
 *  `snapshotHashes` (computed, never veto-eligible) — the exact distinction
 *  `groupSourceIdentities` already depends on via `SourceIdentityDoc`. */
function buildNodeMetaFromSourcesIndex(index: SourcesIndexFile): LoadedNodeMeta {
  const metaCache: Record<string, NodeSourceMeta> = {};
  const identityMeta: Record<string, SourceIdentityMeta> = {};
  const snapshotHashes: Record<string, string | null> = {};
  for (const entry of index.docs) {
    metaCache[entry.id] = cardMetaFromSourcesIndexEntry(entry);
    identityMeta[entry.id] = identityMetaFromSourcesIndexEntry(entry);
    snapshotHashes[entry.id] = entry.snapshot_sha256 ?? null;
  }
  return { metaCache, identityMeta, snapshotHashes };
}

/** t/4334#18: a configured data directory that lists empty is a silent
 *  failure mode, not a legitimate "nothing here yet" — e.g. `getSourcesDir()`
 *  returning a path the backend's tree doesn't actually cover (the hosted
 *  AC1 bug: `sources/` from a separate repo, read via a single-repo
 *  `GitHubAPIBackend`). `dirPath === null` ("sources not configured at all")
 *  is NOT warned here — that's a legitimate, already-handled absence. */
function warnIfEmptyConfiguredDir(label: string, dirPath: string, entries: string[]): void {
  if (entries.length > 0) return;
  log.server.warn({ label, dirPath }, `Node source index: listDirectory returned no entries for a configured data directory (${label})`);
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'node-source-index', level: 'warn',
    message: `listDirectory returned no entries for a configured data directory: ${label}`,
    data: { label, dirPath },
  });
}

/** Scans `getSourcesDir()` directly, per doc: `metadata.json` plus (when no
 *  recorded hash) a computed `snapshot.md` hash. The original (pre-index)
 *  path — still used when `sources-index.json` is missing or stale. */
async function loadNodeMetaCacheFromSourcesDir(sourcesDir: string | null): Promise<LoadedNodeMeta> {
  const metaCache: Record<string, NodeSourceMeta> = {};
  const identityMeta: Record<string, SourceIdentityMeta> = {};
  const snapshotHashes: Record<string, string | null> = {};
  const sourceEntries = sourcesDir ? await getBackend().listDirectory(sourcesDir, { ref: 'main' }) : [];
  if (sourcesDir) warnIfEmptyConfiguredDir('sourcesDir', sourcesDir, sourceEntries);
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

/** t/4499: `usedSourcesIndex` tells the phase-timing log which path
 *  `loadNodeMetaMs` actually measured — the fast `sources-index.json` read
 *  (hosted's normal case) or the slow per-doc `sourcesDir` fallback scan —
 *  since the same field name covers two very differently-shaped costs. */
async function loadNodeMetaCache(sourcesDir: string | null): Promise<LoadedNodeMeta & { usedSourcesIndex: boolean }> {
  const sourcesIndex = await loadSourcesIndex();
  if (sourcesIndex) return { ...buildNodeMetaFromSourcesIndex(sourcesIndex), usedSourcesIndex: true };
  return { ...await loadNodeMetaCacheFromSourcesDir(sourcesDir), usedSourcesIndex: false };
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
  missingMetaIds: Set<string>,
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
    const raw = await backend.readFile(path.join(summariesDir, file), { ref: 'main' });
    if (raw === null) return;
    summary = JSON.parse(raw);
  } catch { /* telemetry — silent by design */ return; }
  const cached = metaCache[docId];
  if (!cached) missingMetaIds.add(docId); // t/4334#25: aggregated, not per-occurrence — logged once per build
  const meta = cached ?? { title: docId, url: null, sourceType: 'unknown', datePublished: '', authors: [], topicTags: [], oneLiner: null };
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
): Promise<Set<string>> {
  const missingMetaIds = new Set<string>();
  await Promise.all(
    summaryFiles.filter(f => f.endsWith('.json')).map(file => indexSummaryFile(summariesDir, file, metaCache, index, missingMetaIds))
  );
  return missingMetaIds;
}

/** t/4334#25 (Rosetta): a per-doc fallback (no `metaCache` entry — identity
 *  metadata never loaded for this doc, the empty-listing WARN's per-doc
 *  counterpart) WARNs once per build with the count, never once per
 *  occurrence — the same aggregation shape as the title-collision/
 *  url-conflict reports below. */
function warnMissingMetaIds(missingMetaIds: Set<string>): void {
  if (missingMetaIds.size === 0) return;
  log.server.warn(
    { missingCount: missingMetaIds.size, missingDocIds: [...missingMetaIds].sort() },
    'Node source index: some docs have no source metadata (title/url/authors fall back to the bare doc id)',
  );
}

/** t/4337 section 7 (the post-apply gap, t/4337#60, SO e/347#2): a
 *  `duplicate_of`-marked entry's node attribution is never dropped wholesale
 *  — its quote survives whenever it isn't near-equal (spec 7.3) to one
 *  already kept on this node, attributed to the resolved id using its own
 *  card metadata when known. The resolved id's own entries are always kept
 *  whole, including repeats, and never deduped against each other — a
 *  pre-existing, duplicate_of-unrelated pattern this doesn't change. A
 *  group with no mark at all (grouping-only duplicates, e.g. split parts)
 *  collapses to one member and so is likewise untouched. See
 *  `lib/sourceIndex/evidenceUnion.ts` for the shared algorithm (also used by
 *  Electron's `main/fileIO.ts`, for parity). */
/** A `SourceReference` plus the `node`/`quote` the shared evidence-union
 *  helper needs (`lib/sourceIndex/evidenceUnion.ts`, spec section 7).
 *  `node` is constant within one call (one nodeId at a time, below);
 *  `quote` is the same text spec 7.1's table picks for a key_point
 *  (`verbatim`, else `point`) — this index only ever carries key_points. */
type SourceEvidenceLink = SourceReference & { node: string; quote: string };

/** One resolved-id group within one node (spec 7.1's group — duplicate_of
 *  marks only, never the section-4 hash/suffix grouping that already set
 *  `canonicalDocId`). An "own" ref (resolvedId === docId) is never touched
 *  — pushed exactly as it already is, repeats included, so an unmarked
 *  group (including grouping-only duplicates like split parts, whose
 *  shared `canonicalDocId` lives outside this pass) keeps its pre-existing
 *  fields untouched. Own refs still feed `mergeGroupEvidence` as the
 *  canonical member, so a marked ref's quote de-dups against them; only the
 *  merge's `via`-tagged output (a marked ref's surviving quote) is new — an
 *  untagged entry just mirrors an own ref already pushed. */
function resolveGroupRefs(
  nodeId: string, resolvedId: string, groupRefs: SourceReference[], metaCache: Record<string, NodeSourceMeta>,
): SourceReference[] {
  const ownRefs = groupRefs.filter(r => r.docId === resolvedId);
  const markedRefs = groupRefs.filter(r => r.docId !== resolvedId);
  if (markedRefs.length === 0) return ownRefs;

  const byDocId = new Map<string, SourceReference[]>();
  for (const r of markedRefs) {
    const bucket = byDocId.get(r.docId);
    if (bucket) bucket.push(r); else byDocId.set(r.docId, [r]);
  }
  const toLink = (r: SourceReference) => ({ ...r, node: nodeId, quote: r.verbatim || r.point });
  const members: EvidenceUnionMember<SourceEvidenceLink>[] = [
    ...(ownRefs.length > 0 ? [{ id: resolvedId, links: ownRefs.map(toLink) }] : []),
    ...[...byDocId.entries()].map(([docId, docRefs]) => ({ id: docId, links: docRefs.map(toLink) })),
  ];

  const target = metaCache[resolvedId];
  const kept = [...ownRefs];
  for (const { quote: _quote, doc: _doc, via, ...r } of mergeGroupEvidence(resolvedId, members)[nodeId] ?? []) {
    if (!via) continue; // an own ref's entry — already pushed above, unchanged
    kept.push({
      ...r, docId: resolvedId, canonicalDocId: resolvedId,
      title: target?.title ?? r.title, url: target?.url ?? r.url,
    });
  }
  return kept;
}

function dedupeByResolvedId(
  index: NodeSourceIndex, resolved: Record<string, string>, metaCache: Record<string, NodeSourceMeta>,
): void {
  for (const [nodeId, refs] of Object.entries(index)) {
    const byResolvedId = new Map<string, SourceReference[]>();
    for (const r of refs) {
      const resolvedId = resolved[r.docId] ?? r.docId;
      const bucket = byResolvedId.get(resolvedId);
      if (bucket) bucket.push(r); else byResolvedId.set(resolvedId, [r]);
    }

    const kept: SourceReference[] = [];
    for (const [resolvedId, groupRefs] of byResolvedId) {
      kept.push(...resolveGroupRefs(nodeId, resolvedId, groupRefs, metaCache));
    }
    index[nodeId] = kept;
  }
}

/** Fills in `canonicalDocId` (today it's set to each ref's own `docId` by
 *  `indexSummaryFile`) using the shared source-identity algorithm
 *  (`docs/specs/source-identity.md`, t/4344), mutating `index` in place.
 *  Every `docId` seen anywhere in the index participates, so a split part
 *  reachable only via one node still resolves against the full known-id
 *  set. Also applies t/4337 section 7: a valid `duplicate_of` mark unions
 *  that node's evidence across the group (`dedupeByResolvedId`), attributed
 *  to the resolved id. Returns the title-collision, url-conflict
 *  (spec 4.5) and duplicate-of-error (spec 6.1) reports for the caller to
 *  log — all three are signals for a human, never applied as a merge. */
function applyCanonicalDocIds(
  index: NodeSourceIndex, identityMeta: Record<string, SourceIdentityMeta>, snapshotHashes: Record<string, string | null>,
  metaCache: Record<string, NodeSourceMeta>,
): { titleCollisions: string[][]; urlConflicts: SourceUrlConflict[]; duplicateOfErrorCount: number } {
  // t/4357: every doc under sourcesDir participates, not just the ones cited
  // by a summary today — a `duplicate_of` target otherwise cited by nothing
  // would wrongly validate as `missing_target` (it genuinely IS in the
  // corpus; it just has no key-point referencing this particular build).
  const allDocIds = new Set<string>(Object.keys(identityMeta));
  for (const refs of Object.values(index)) for (const r of refs) allDocIds.add(r.docId);
  const docs: SourceIdentityDoc[] = [...allDocIds].map(id => ({
    id,
    metadata: identityMeta[id] ?? { title: id },
    snapshotSha256: snapshotHashes[id] ?? null,
  }));
  const { canonical, titleCollisions, urlConflicts, resolved, duplicateOfErrors } = groupSourceIdentities(docs);
  for (const refs of Object.values(index)) {
    for (const r of refs) r.canonicalDocId = canonical[r.docId] ?? r.docId;
  }
  dedupeByResolvedId(index, resolved, metaCache);
  if (duplicateOfErrors.length > 0) {
    // spec 6.1: WARN, never throw — an invalid mark is visible and treated as absent.
    log.server.warn({ duplicateOfErrors }, 'Node source index: invalid duplicate_of marks found (treated as absent)');
  }
  return { titleCollisions, urlConflicts, duplicateOfErrorCount: duplicateOfErrors.length };
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

  const summaryFiles = await backend.listDirectory(summariesDir, { ref: 'main' });
  if (summaryFiles.length === 0) {
    warnIfEmptyConfiguredDir('summariesDir', summariesDir, summaryFiles);
    return index;
  }

  const { metaCache, identityMeta, snapshotHashes } = await loadNodeMetaCache(sourcesDir);
  warnMissingMetaIds(await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index));
  applyCanonicalDocIds(index, identityMeta, snapshotHashes, metaCache);
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
  const files = await getBackend().listDirectory(summariesDir, { ref: 'main' });
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
  // t/4499: phase timing, split out of the single `coldBuildMs` total — a
  // real prod cold build (t/4333#11: ~5.5-5.7s of server time) needs to say
  // WHICH phase is expensive before anything can be fixed. Each `*Ms` field
  // below times exactly the step it's named for; `coldBuildMs` stays the
  // existing end-to-end total so nothing that already reads it breaks.
  const start = Date.now();
  const summariesDir = resolveDataPath(loadDataConfig().summaries_dir);
  const sourcesDir = getSourcesDir();
  const index: NodeSourceIndex = {};

  let t = Date.now();
  const summaryFiles = await getBackend().listDirectory(summariesDir, { ref: 'main' });
  warnIfEmptyConfiguredDir('summariesDir', summariesDir, summaryFiles);
  const summaryListMs = Date.now() - t;

  t = Date.now();
  const { metaCache, identityMeta, snapshotHashes, usedSourcesIndex } = await loadNodeMetaCache(sourcesDir);
  const loadNodeMetaMs = Date.now() - t;

  t = Date.now();
  const missingMetaIds = await indexSummaryFiles(summaryFiles, summariesDir, metaCache, index);
  warnMissingMetaIds(missingMetaIds);
  const summaryReadMs = Date.now() - t;

  t = Date.now();
  const { titleCollisions, urlConflicts, duplicateOfErrorCount } = applyCanonicalDocIds(index, identityMeta, snapshotHashes, metaCache);
  const applyCanonicalMs = Date.now() - t;

  t = Date.now();
  const cards = buildCardMetaByCanonicalId(index, metaCache);
  const cardBuildMs = Date.now() - t;
  nodeSourceIndexGeneration += 1;

  const entryCount = Object.values(index).reduce((n, refs) => n + refs.length, 0);
  const payloadBytes = Buffer.byteLength(JSON.stringify(index), 'utf-8');
  const coldBuildMs = Date.now() - start;
  const coverage = sourceCardFieldCoverage(metaCache);
  const phaseMs = { summaryListMs, loadNodeMetaMs, usedSourcesIndex, summaryReadMs, applyCanonicalMs, cardBuildMs };
  log.server.info(
    {
      coldBuildMs, entryCount, payloadBytes, nodeCount: Object.keys(index).length, canonicalDocCount: Object.keys(cards).length,
      titleCollisionCount: titleCollisions.length, urlConflictCount: urlConflicts.length,
      missingMetaCount: missingMetaIds.size, duplicateOfErrorCount, ...coverage, ...phaseMs,
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
    data: { coldBuildMs, entryCount, payloadBytes, indexVersion: nodeSourceIndexGeneration, ...coverage, ...phaseMs },
  });

  return { index, cards, indexVersion: nodeSourceIndexGeneration, invalidationSignature: await currentInvalidationSignature() };
}

/** Builds on first call — originally never at boot (t/4333 point 2's design),
 *  but t/4499's `prewarmNodeSourceIndex()` now makes that first call happen
 *  at server startup instead of waiting for the first real request, so a
 *  cold build's ~5.5s (t/4333#11) lands before traffic arrives rather than
 *  blocking it. This function itself is unchanged either way: it reuses an
 *  in-flight build rather than starting a second one for concurrent callers
 *  — exactly what makes the prewarm safe, since a request arriving mid-warm
 *  gets that same build, never a redundant one. Invalidated by comparing the
 *  summaries-dir listing, not a TTL. */
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
 * t/4499 AC2/AC3 — kicks off the index build at server startup instead of
 * waiting for the first real request to pay for it. Fire-and-forget: never
 * throws, never blocks the caller (server.ts's startup sequence), and never
 * races itself into a second build — `getNodeSourceIndexCache()`'s existing
 * in-flight-promise dedup (above) is the only concurrency mechanism, unchanged.
 * A real request arriving before the prewarm finishes awaits that exact same
 * promise through the normal `getNodeSources()` path; it never starts (or
 * waits on) a second one.
 */
export function prewarmNodeSourceIndex(): void {
  getNodeSourceIndexCache().catch((err: unknown) => {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: 'prewarmNodeSourceIndex: boot prewarm failed; the first real request will build it instead',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  });
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

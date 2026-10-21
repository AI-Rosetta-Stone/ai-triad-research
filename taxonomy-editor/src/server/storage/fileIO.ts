// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * File I/O service for the web server — mirrors the Electron main/fileIO.ts
 * logic without any Electron imports.
 *
 * All public functions are async.  Data-repo I/O is delegated to the pluggable
 * StorageBackend (default: FilesystemBackend).  Project-root I/O (AI models,
 * PS prompts) uses fs/promises directly — these files are always local.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { loadDataConfig, resolveDataPath, getDataRoot, getProjectRoot, getSourcesRoot, STORAGE_MODE } from '../config.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { POV_KEYS } from '../../../../lib/debate/types.js';
import type { StorageBackend } from './storageBackend.js';
import { log } from '../logger.js';
import { FilesystemBackend } from './filesystemBackend.js';
import { getGlobalRecorder, redactRecord } from '../../../../lib/flight-recorder/index.js';
import { parseNpy, extractNodeVectorsAsync } from '../../../../lib/npy.js';
import type { OrganizationEdge } from '../../../../lib/organizations/types.js';
import type { Entity } from '../../../../lib/entities/types.js';
import type { EntityMentionsFile, ContainerMentions } from '../../../../lib/entities/mentionTypes.js';
import { serializeEdgesJson } from '../../../../lib/edges/serializeEdges.js';
import { ABSENT_BASELINE, type EdgesData } from '../../../../lib/edges/mergeEdgesPreservingRationale.js';
import { getCurrentUserId } from '../security/userContext.js';
import { scheduleOverlayCommit } from './overlayCommitScheduler.js';
import type { NodeSourceIndex } from '../../../../lib/sourceIndex/types.js';
import { buildNodeSourceIndex } from './nodeSourceIndex.js';

// ── Extracted sub-modules (ADR-007, t/1688) — cohesion splits behind a stable
// barrel: importers keep importing these symbols from './fileIO.js'. Each module
// imports the backend accessors / path-safety helpers back from here (a
// request-time-only reference cycle, never touched at module load). ──
export * from './debateStore.js';
export * from './calibrationStore.js';
export * from './urlFetch.js';
export * from './overlayCommitScheduler.js';
export * from './conflictsFileIO.js';
export * from './nodeSourceIndex.js';
export type { OpEdSetSummary } from '../../../../lib/oped/types.js';
export { listOpedSets, loadOpedSet, saveOpedSetInProgress, loadOpedSetInProgress, finalizeOpedSet, deleteOpedSet, getOpedSetsQuotaStatus } from './opedStore.js';
export { upsertOpedRun, countRunningOpedRuns, getOpedRun } from './opedRunStore.js';
export type { RunControlRecord, RunStatus, VoiceState as OpedVoiceState } from './opedRunStore.js';
// ── Backend injection ──

// Taxonomy / conflicts / calibration / summaries / sources use `backend`.
// User content (chats, debates, community) routes through `userContentBackend`,
// which falls back to `backend` when not separately configured (Electron /
// filesystem mode). In production, `userContentBackend` is an AzureBlobBackend
// while `backend` stays on GitHubAPIBackend.
let backend: StorageBackend = new FilesystemBackend();
let userContentBackend: StorageBackend | null = null;
let briefExportBackend: StorageBackend | null = null;

// Parsed-entities cache — memoizes entities.json so repeated public getEntity
// (t/1786) hits, an UNAUTHENTICATED read tier, never re-parse the file per request
// (t/1793 event-loop-DoS lesson). Static, pipeline-curated data (no server write
// path); bounded to one entry, TTL caps staleness. Cleared when the taxonomy
// backend is swapped (a new source legitimately invalidates the cache).
const ENTITIES_CACHE_TTL_MS = 30_000;
let entitiesCache: { at: number; entities: Entity[] } | null = null;

// Parsed-mentions cache — same DoS discipline as entitiesCache (t/1793/t/1807).
// Absent-file case is NOT cached so a newly-built index is picked up on the next
// read within the TTL window.
const MENTIONS_CACHE_TTL_MS = 30_000;
const EMPTY_MENTIONS: EntityMentionsFile = {
  _schema_version: '1.0.0',
  _doc: 'empty — entity_mentions.json not yet built',
  last_modified: '',
  containers: {},
};
let mentionsCache: { at: number; data: EntityMentionsFile } | null = null;

/** Replace the taxonomy/default storage backend. */
export function setBackend(b: StorageBackend): void { backend = b; entitiesCache = null; mentionsCache = null; }
export function getBackend(): StorageBackend { return backend; }
/** Alias of setBackend, for explicit dual-backend wiring. */
export function setTaxonomyBackend(b: StorageBackend): void { backend = b; entitiesCache = null; mentionsCache = null; }
/** Set the backend for user content (chats/debates/community). */
export function setUserContentBackend(b: StorageBackend): void { userContentBackend = b; }
/** User-content backend; falls back to the taxonomy backend when unset. */
export function getUserContentBackend(): StorageBackend { return userContentBackend ?? backend; }
/** Set the backend for brief-export artifacts (t/2850 — dedicated container for lifecycle rule). */
export function setBriefExportBackend(b: StorageBackend): void { briefExportBackend = b; }
/** Brief-export backend; falls back to user-content backend when unset. */
export function getBriefExportBackend(): StorageBackend { return briefExportBackend ?? getUserContentBackend(); }

// ── Path safety ──

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_POV_RE = /^[a-z_-]+$/;
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.-]+$/;

export function assertSafeId(value: string, label: string): void {
  if (!value || !SAFE_ID_RE.test(value))
    throw Object.assign(new ActionableError({
      goal: 'Validate input parameter',
      problem: `Invalid ${label}: must be alphanumeric/hyphens/underscores, got "${value}"`,
      location: `server/fileIO.ts → assertSafeId(${label})`,
      nextSteps: ['Check the input value contains only allowed characters (a-z, A-Z, 0-9, hyphens, underscores)'],
    }), { statusCode: 400 });
}

function assertSafePov(value: string): void {
  if (!value || !SAFE_POV_RE.test(value))
    throw new ActionableError({
      goal: 'Validate input parameter',
      problem: `Invalid POV name: must be lowercase alpha/hyphens/underscores, got "${value}"`,
      location: 'server/fileIO.ts → assertSafePov',
      nextSteps: ['Check the input value contains only allowed characters (a-z, hyphens, underscores)'],
    });
}

// Non-throwing predicates over the same whitelists — single source of truth for
// the routing-layer path-param middleware (t/810) and any boolean checks.
export function isSafeId(value: string): boolean { return !!value && SAFE_ID_RE.test(value); }
export function isSafePov(value: string): boolean { return !!value && SAFE_POV_RE.test(value); }
export function isSafeFilename(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && SAFE_FILENAME_RE.test(value);
}

export function assertSafeFilename(value: string, label: string): void {
  if (!value || !SAFE_FILENAME_RE.test(value) || value.includes('..'))
    throw Object.assign(new ActionableError({
      goal: 'Validate input parameter',
      problem: `Invalid ${label}: must be alphanumeric/hyphens/underscores/dots, got "${value}"`,
      location: `server/fileIO.ts → assertSafeFilename(${label})`,
      nextSteps: ['Check the input value contains only allowed characters (a-z, A-Z, 0-9, hyphens, underscores, dots)'],
    }), { statusCode: 400 });
}

// ── Taxonomy directories ──

let activeTaxonomyDir = '';

export async function getTaxonomyDirs(): Promise<string[]> {
  const config = loadDataConfig();
  const taxonomyBase = resolveDataPath(path.dirname(config.taxonomy_dir));
  try {
    const entries = await backend.listDirectory(taxonomyBase);
    const dirs: string[] = [];
    for (const d of entries) {
      const full = path.join(taxonomyBase, d);
      const children = await backend.listDirectory(full);
      if (children.some(f => f.endsWith('.json') && f !== 'embeddings.json' && f !== 'edges.json')) {
        dirs.push(d);
      }
    }
    return dirs;
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'getTaxonomyDirs: listing failed, returning []',
      data: { error: String(err) },
    });
    return [];
  }
}

export function getActiveTaxonomyDirName(): string {
  if (!activeTaxonomyDir) {
    const config = loadDataConfig();
    activeTaxonomyDir = path.basename(config.taxonomy_dir);
  }
  return activeTaxonomyDir;
}

export function setActiveTaxonomyDir(dirName: string): void {
  activeTaxonomyDir = dirName;
}

export function getTaxonomyDir(): string {
  const config = loadDataConfig();
  const base = resolveDataPath(path.dirname(config.taxonomy_dir));
  const active = getActiveTaxonomyDirName();
  return path.join(base, active);
}

// ── Data availability ──

export async function isDataAvailable(): Promise<boolean> {
  const taxDir = getTaxonomyDir();
  try {
    const files = await backend.listDirectory(taxDir);
    const hasData = files.some(f => f.endsWith('.json') && f !== 'embeddings.json' && f !== 'edges.json');
    if (!hasData) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'file-io',
        level: 'error',
        message: `isDataAvailable: no taxonomy JSON found in ${taxDir} (${files.length} entries) — check TAXONOMY_CACHE_DIR vs AI_TRIAD_DATA_ROOT alignment`,
        data: { taxDir, fileCount: files.length, sample: files.slice(0, 5) },
      });
      log.server.error({ taxDir, fileCount: files.length }, 'isDataAvailable: no taxonomy JSON — check TAXONOMY_CACHE_DIR vs AI_TRIAD_DATA_ROOT');
    }
    log.server.debug({ taxDir, fileCount: files.length, hasData }, 'isDataAvailable check');
    return hasData;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.error({ taxDir, err: String(err) }, 'isDataAvailable error');
    return false;
  }
}

export function getDataRootPath(): string {
  return getDataRoot();
}

// ── Taxonomy CRUD ──

export async function resolveTaxonomyFilePath(pov: string): Promise<string> {
  assertSafePov(pov);
  const taxDir = getTaxonomyDir();
  if (pov === 'situations') {
    const sitPath = path.join(taxDir, 'situations.json');
    if (await backend.fileExists(sitPath)) return sitPath;
    const ccPath = path.join(taxDir, 'cross-cutting.json');
    if (await backend.fileExists(ccPath)) return ccPath;
    return sitPath;
  }
  return path.join(taxDir, `${pov}.json`);
}

export async function readTaxonomyFile(pov: string, opts?: { ref?: string }): Promise<unknown> {
  const filePath = await resolveTaxonomyFilePath(pov);
  const raw = await backend.readFile(filePath, opts);
  if (raw === null) throw new ActionableError({
    goal: 'Read taxonomy file',
    problem: `Taxonomy file not found: ${filePath}`,
    location: 'server/fileIO.ts → readTaxonomyFile',
    nextSteps: ['Verify the POV file exists in the active taxonomy directory'],
  });
  // Strip UTF-8 BOM if present — PowerShell's Set-Content writes BOM by default
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/** t/4187: `backend.readFileWithVersion` is optional (test-double backends
 *  needn't stub it); every production backend implements it. Falls back to a
 *  plain `readFile` + empty version \u2014 a real, never-stale "no precondition
 *  support" marker \u2014 for any backend that doesn't. Exported (t/4217) for harvestStore.ts's RMW writers. */
export async function readFileWithVersionOrFallback(
  filePath: string, opts?: { ref?: string },
): Promise<{ content: string; version: string } | null> {
  if (backend.readFileWithVersion) return backend.readFileWithVersion(filePath, opts);
  const content = await backend.readFile(filePath, opts);
  return content === null ? null : { content, version: '' };
}

/** t/4241: version available before JSON.parse, so a content-hash-keyed cache can skip parsing on a hit (t/4241#4). */
export async function readTaxonomyFileRawWithVersion(pov: string, opts?: { ref?: string }): Promise<{ content: string; version: string }> {
  const filePath = await resolveTaxonomyFilePath(pov);
  const result = await readFileWithVersionOrFallback(filePath, opts);
  if (result === null) throw new ActionableError({ goal: 'Read taxonomy file', problem: `Taxonomy file not found: ${filePath}`, location: 'server/fileIO.ts -> readTaxonomyFileRawWithVersion', nextSteps: ['Verify the POV file exists in the active taxonomy directory'] });
  return { content: result.content.replace(/^\uFEFF/, ''), version: result.version };
}

/** t/4187: like readTaxonomyFile, but also returns the version for the save route's write precondition (ETag). */
export async function readTaxonomyFileWithVersion(pov: string, opts?: { ref?: string }): Promise<{ data: unknown; version: string }> {
  const raw = await readTaxonomyFileRawWithVersion(pov, opts);
  return { data: JSON.parse(raw.content), version: raw.version };
}

const SYNTHETIC_POV_KEYS = new Set(['acc', 'saf', 'skp']);

export async function loadSyntheticCorpus(pov: string): Promise<unknown | null> {
  if (!SYNTHETIC_POV_KEYS.has(pov)) return null;
  const filePath = path.join(getTaxonomyDir(), 'synthetic', `corpus_${pov}.json`);
  const raw = await backend.readFile(filePath, { ref: 'main' });
  if (raw === null) return null;
  const parsed = JSON.parse(raw.replace(/^﻿/, ''));
  validateGraphAttributes(parsed, pov); // t/768: warn (don't reject) on type drift
  return parsed;
}

// ── graph_attributes type validation (t/768) ──
//
// Catch data corruption at load time (e.g. a number where a string[] is expected)
// via a flight-recorder warning, instead of letting it surface as a downstream
// runtime crash (the SearchPanel TypeError). Warn-only — never rejects the file;
// downstream code still guards types defensively.

const GA_STRING_KEYS = ['epistemic_type', 'rhetorical_strategy', 'falsifiability',
  'audience', 'emotional_register', 'attribution_text', 'node_scope'];
const GA_STRING_ARRAY_KEYS = ['assumes', 'intellectual_lineage'];

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function collectNodeAttrMismatches(nodeId: string, attrs: Record<string, unknown>): GraphAttrMismatch[] {
  const out: GraphAttrMismatch[] = [];
  for (const key of GA_STRING_KEYS) {
    const v = attrs[key];
    if (v != null && typeof v !== 'string') out.push({ nodeId, key, expected: 'string', actual: describeType(v) });
  }
  for (const key of GA_STRING_ARRAY_KEYS) {
    const v = attrs[key];
    if (v == null) continue;
    if (!Array.isArray(v)) { out.push({ nodeId, key, expected: 'string[]', actual: describeType(v) }); continue; }
    const bad = v.find(el => typeof el !== 'string');
    if (bad !== undefined) out.push({ nodeId, key, expected: 'string[]', actual: `array with ${describeType(bad)} element` });
  }
  return out;
}

export interface GraphAttrMismatch { nodeId: string; key: string; expected: string; actual: string; }

/** Pure detector: list graph_attributes entries whose value type is unexpected. */
export function findGraphAttributeMismatches(parsed: unknown): GraphAttrMismatch[] {
  const out: GraphAttrMismatch[] = [];
  const nodes = (parsed as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const node = n as { id?: unknown; graph_attributes?: unknown };
    const ga = node.graph_attributes;
    if (!ga || typeof ga !== 'object' || Array.isArray(ga)) continue;
    const nodeId = typeof node.id === 'string' ? node.id : '(unknown)';
    out.push(...collectNodeAttrMismatches(nodeId, ga as Record<string, unknown>));
  }
  return out;
}

/** Log graph_attributes type mismatches to the flight recorder (warn, best-effort). */
function validateGraphAttributes(parsed: unknown, pov: string): void {
  const recorder = getGlobalRecorder();
  if (!recorder) return;
  for (const m of findGraphAttributeMismatches(parsed)) {
    recorder.record({
      type: 'system.error',
      component: 'file-io',
      level: 'warn',
      message: `graph_attributes type mismatch (${pov} node ${m.nodeId}): ${m.key} expected ${m.expected}, got ${m.actual}`,
    });
  }
}

export async function loadSyntheticEmbeddings(): Promise<Record<string, { pov: string; vectors: number[][] }> | null> {
  const synDir = path.join(getTaxonomyDir(), 'synthetic');
  const result: Record<string, { pov: string; vectors: number[][] }> = {};
  let found = false;

  for (const pov of SYNTHETIC_POV_KEYS) {
    const npyPath = path.join(synDir, `embeddings_${pov}.npy`);
    const idxPath = path.join(synDir, `index_${pov}.json`);

    const tRead0 = Date.now();
    const [npyBuf, idxRaw] = await Promise.all([
      backend.readBinaryFile(npyPath),
      backend.readFile(idxPath, { ref: 'main' }),
    ]);
    const readMs = Date.now() - tRead0;
    if (!npyBuf || !idxRaw) continue;

    const tParseNpy0 = Date.now();
    const parsed = parseNpy(npyBuf);
    const parseNpyMs = Date.now() - tParseNpy0;

    const tIndexParse0 = Date.now();
    const index = JSON.parse(idxRaw.replace(/^﻿/, '')) as Record<string, { start: number; count: number }>;
    const indexParseMs = Date.now() - tIndexParse0;

    // t/4286: extractNodeVectorsAsync yields internally every 256 nodes, but
    // that alone doesn't help this loop's own back-to-back calls — the
    // explicit yield below ensures the event loop gets a turn between each
    // synthetic POV file too, not just within one (ServerAPI/Shared Lib).
    const tExtract0 = Date.now();
    const vectors = await extractNodeVectorsAsync(parsed, index, pov);
    const extractMs = Date.now() - tExtract0;
    Object.assign(result, vectors);

    // t/4286#20: per-POV phase timing to localize the canary's ~700ms cold-path
    // block among npy read / parseNpy / index JSON.parse / extraction, the same
    // way load_ms/serialize_ms split the route-level cold build (t/3165).
    log.storage.info({
      route: 'synthetic-embeddings', pov, read_ms: readMs, parse_npy_ms: parseNpyMs,
      index_parse_ms: indexParseMs, extract_ms: extractMs, node_count: Object.keys(vectors).length,
    }, 'synthetic-embeddings per-POV phase timing (cold path)');

    await new Promise<void>((r) => setImmediate(r));
    found = true;
  }

  return found ? result : null;
}

export async function writeTaxonomyFile(pov: string, data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  const filePath = await resolveTaxonomyFilePath(pov);
  return backend.writeFile(filePath, JSON.stringify(data, null, 2), opts);
}

// ── Conflict CRUD ──

export function getConflictsDir(): string {
  const config = loadDataConfig();
  return resolveDataPath(config.conflicts_dir);
}

export async function readAggregatedCruxes(): Promise<unknown | null> {
  const filePath = path.join(getTaxonomyDir(), 'aggregated-cruxes.json');
  const raw = await backend.readFile(filePath);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

// t/1541: write path for reviewer-entered crux external_evidence edits (mirrors
// writeEdgesFile). Callers ensureSessionBranch() first, so this lands on the
// caller's session branch. Regeneration safety (Export-AggregatedCruxes) is
// handled by Merge-CruxExternalEvidence.ps1 (t/1540), not here.
export async function writeAggregatedCruxes(data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  const filePath = path.join(getTaxonomyDir(), 'aggregated-cruxes.json');
  const result = await backend.writeFile(filePath, JSON.stringify(data, null, 2), opts);
  scheduleOverlayCommit(getCurrentUserId()); // t/4258/t/4277 C3: no following commit otherwise
  return result;
}

/** t/4190: like readAggregatedCruxes, also returns the version (ETag). */
export async function readAggregatedCruxesWithVersion(): Promise<{ data: unknown; version: string } | null> {
  try {
    const result = await readFileWithVersionOrFallback(path.join(getTaxonomyDir(), 'aggregated-cruxes.json'));
    if (result === null) return null;
    return { data: JSON.parse(result.content), version: result.version };
  } catch (err: unknown) { getGlobalRecorder()?.record({ type: 'system.error', component: 'file-io', level: 'warn', message: 'readAggregatedCruxesWithVersion: read/parse failed, returning null', data: { error: String(err) } }); return null; }
}

export async function readConflictClusters(): Promise<unknown | null> {
  const filePath = path.join(getConflictsDir(), '_conflict-clusters.json');
  const raw = await backend.readFile(filePath);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

/** t/4190: like readConflictClusters, also returns the version (ETag). */
export async function readConflictClustersWithVersion(): Promise<{ data: unknown; version: string } | null> {
  try {
    const result = await readFileWithVersionOrFallback(path.join(getConflictsDir(), '_conflict-clusters.json'));
    if (result === null) return null;
    return { data: JSON.parse(result.content), version: result.version };
  } catch (err: unknown) { getGlobalRecorder()?.record({ type: 'system.error', component: 'file-io', level: 'warn', message: 'readConflictClustersWithVersion: read/parse failed, returning null', data: { error: String(err) } }); return null; }
}

// ── Lineage categories ──

export async function readLineageCategories(): Promise<unknown | null> {
  const filePath = path.join(getTaxonomyDir(), 'lineage_categories.json');
  const raw = await backend.readFile(filePath);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

// ── Lineage enrichments ──

let lineageInfoCache: Record<string, unknown> | null = null;

export async function readLineageEnrichments(): Promise<Record<string, unknown>> {
  if (lineageInfoCache) return lineageInfoCache;
  const filePath = path.join(getDataRoot(), 'calibration', 'core', 'lineage-enrichments.json');
  const raw = await backend.readFile(filePath, { optional: true });
  if (raw === null) return {};
  try {
    const data = JSON.parse(raw) as Record<string, { category?: string; description?: string; url?: string | null }>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(data)) {
      result[key] = {
        label: key,
        summary: entry.description ?? '',
        example: '',
        frequency: entry.category ? `Category: ${entry.category}` : '',
        links: entry.url ? [{ label: 'Reference', url: entry.url }] : [],
      };
    }
    lineageInfoCache = result;
    return result;
  } catch { /* telemetry — silent by design */ return {}; }
}

// ── Policy registry ──

export async function readOrganizations(): Promise<unknown | null> {
  try {
    const p = path.join(getTaxonomyDir(), 'organizations.json');
    const raw = await backend.readFile(p, { ref: 'main' });
    if (raw === null) {
      log.server.warn({ path: p, ref: 'main' }, 'readOrganizations: file absent');
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    log.server.warn({ err }, 'readOrganizations failed');
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'readOrganizations failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export async function readOrganizationEdges(): Promise<OrganizationEdge[] | null> {
  try {
    const p = path.join(getTaxonomyDir(), 'organization_edges.json');
    const raw = await backend.readFile(p, { ref: 'main' });
    if (raw === null) {
      log.server.warn({ path: p, ref: 'main' }, 'readOrganizationEdges: file absent');
      return null;
    }
    const data = JSON.parse(raw);
    return (data as { edges?: OrganizationEdge[] })?.edges ?? [];
  } catch (err) {
    log.server.warn({ err }, 'readOrganizationEdges failed');
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'readOrganizationEdges failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export async function readPolicyRegistry(): Promise<unknown | null> {
  try {
    const taxDir = getTaxonomyDir();
    const p = path.join(taxDir, 'policy_actions.json');
    const exists = await backend.fileExists(p);
    log.server.debug({ taxDir, path: p, exists }, 'readPolicyRegistry');
    const raw = await backend.readFile(p);
    if (raw === null) return null;
    const data = JSON.parse(raw);
    const count = (data as { policies?: unknown[] })?.policies?.length ?? 0;
    log.server.debug({ count }, 'readPolicyRegistry loaded');
    return data;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    log.server.error({ err }, 'readPolicyRegistry failed');
    return null;
  }
}

// ── Entities (ent-*) ──

/**
 * Read the entity registry (`ent-*` records) from entities.json as typed `Entity[]`.
 * Returns `null` when the store is absent. The parsed list is memoized for
 * ENTITIES_CACHE_TTL_MS so repeated public `getEntity` (t/1786) hits — an
 * unauthenticated read tier — never re-parse the file per request (t/1793 DoS
 * lesson). entities.json is static, pipeline-curated data (no server write path),
 * so a short-TTL parsed cache needs no write-invalidation.
 */
export async function readEntities(): Promise<Entity[] | null> {
  if (entitiesCache && Date.now() - entitiesCache.at < ENTITIES_CACHE_TTL_MS) {
    return entitiesCache.entities;
  }
  try {
    const p = path.join(getTaxonomyDir(), 'entities.json');
    const raw = await backend.readFile(p, { ref: 'main' });
    if (raw === null) {
      log.server.warn({ path: p, ref: 'main' }, 'readEntities: file absent');
      return null;
    }
    const data = JSON.parse(raw) as { entities?: Entity[] };
    const entities = data.entities ?? [];
    entitiesCache = { at: Date.now(), entities };
    return entities;
  } catch (err) {
    log.server.warn({ err }, 'readEntities failed');
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'readEntities failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

/**
 * Entity registry as an `id → Entity` map — the lookup ServerAPI's `getEntity`
 * (t/1786) feeds to its `resolveMergedInto` walk (the merged_into tombstone walk
 * lives there, in exactly one layer; this layer only reads). Built fresh per call
 * from the cached parsed list (the JSON.parse, not the O(n) index, is the DoS
 * cost), so each caller gets a private map. Returns `null` when the store is absent.
 */
export async function readEntityRegistry(): Promise<Map<string, Entity> | null> {
  const entities = await readEntities();
  if (entities === null) {
    log.server.warn({ ref: 'main' }, 'readEntityRegistry: entity store absent');
    return null;
  }
  return new Map(entities.map(e => [e.id, e]));
}

// ── Entity Mentions (derived artifact) ──

/**
 * Read the full entity-mention index from `entity_mentions.json`.
 *
 * This is a **derived artifact** (re-buildable by retroactive re-index, §7 of
 * t/1890): absence means "no links yet", not an error. Returns an empty
 * `EntityMentionsFile` rather than `null` — callers can address
 * `file.containers[id]` safely without a null-check on the return value.
 * (Deviation from `readEntities` which returns `null` on absent; here the
 * empty-vs-absent distinction is meaningless to all callers.)
 *
 * The absent-file case is deliberately NOT cached so that once the index is
 * first built a subsequent read picks it up within the TTL window.
 * Memoized for MENTIONS_CACHE_TTL_MS — same DoS discipline as t/1807/t/1793.
 */
export async function readEntityMentions(): Promise<EntityMentionsFile> {
  if (mentionsCache && Date.now() - mentionsCache.at < MENTIONS_CACHE_TTL_MS) {
    return mentionsCache.data;
  }
  try {
    const p = path.join(getTaxonomyDir(), 'entity_mentions.json');
    const raw = await backend.readFile(p);
    if (raw === null) return EMPTY_MENTIONS;
    const data = JSON.parse(raw) as EntityMentionsFile;
    mentionsCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    log.server.warn({ err }, 'readEntityMentions failed');
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'readEntityMentions failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return EMPTY_MENTIONS;
  }
}

/**
 * Look up all mentions extracted from one container. Returns `null` when the
 * container has no recorded mentions or the index is absent.
 */
export async function readContainerMentions(containerId: string): Promise<ContainerMentions | null> {
  const file = await readEntityMentions();
  return file.containers[containerId] ?? null;
}

// ── Edges ──

function getEdgesPath(): string {
  return path.join(getTaxonomyDir(), 'edges.json');
}

export async function readEdgesFile(): Promise<unknown | null> {
  try {
    const raw = await backend.readFile(getEdgesPath());
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'readEdgesFile: read/parse failed, returning null',
      data: { error: String(err) },
    });
    return null;
  }
}

/** t/4189: like readEdgesFile, but also returns the version for the save
 *  route to hand back to the client as its write precondition (ETag). */
export async function readEdgesFileWithVersion(): Promise<{ data: unknown; version: string } | null> {
  try {
    const result = await readFileWithVersionOrFallback(getEdgesPath());
    if (result === null) return null;
    return { data: JSON.parse(result.content), version: result.version };
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'readEdgesFileWithVersion: read/parse failed, returning null',
      data: { error: String(err) },
    });
    return null;
  }
}

/**
 * Read the on-disk edges.json as a WRITE baseline for the rationale re-merge (t/2957),
 * strictly discriminating genuine absence from a read/parse failure — unlike `readEdgesFile`
 * above, which deliberately collapses both to `null` for its degrade-to-empty DISPLAY callers
 * (GET, updateEdgeStatus). The whole-file save re-merges rationale from this baseline; treating
 * a transient read error as "absent" would make the save write the stripped payload and wipe
 * on-disk rationale (the t/2945 incident), so a read or parse failure MUST propagate (refuse the
 * save) and never resolve to ABSENT_BASELINE. This is where the t/2957 #6.1 BLOCKER truly closes.
 *
 * `backend.readFile` returns `null` ONLY for genuine not-found (ENOENT / blob-not-found) and
 * THROWS on any other read error — verified in filesystemBackend.ts:53-54 (`code==='ENOENT'`
 * → null; else `throw err`) and azureBlobBackend.ts:149-155 (`isNotFound` → null; else throw).
 * So `raw === null` here is a TRUE absence, and `JSON.parse` throws on a corrupt file. Both
 * failure modes propagate to the caller; only a real ENOENT yields ABSENT_BASELINE.
 */
export async function readEdgesForSaveBaseline(): Promise<EdgesData | typeof ABSENT_BASELINE> {
  const raw = await backend.readFile(getEdgesPath());
  if (raw === null) return ABSENT_BASELINE;
  return JSON.parse(raw) as EdgesData;
}

export async function writeEdgesFile(data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  return backend.writeFile(getEdgesPath(), serializeEdgesJson(data), opts);
}

/** t/4189: `updateEdgeStatus`/`bulkUpdateEdges`/`swapEdgeDirection` mutate an
 *  already-loaded edges object and save it — unlike `writeTaxonomyFile`'s
 *  plain `(data, opts) => {version}` shape, callers need the mutated object
 *  back too (it becomes the route's in-memory cache). When the index/indices
 *  don't match anything, no write happens — the version is the client's own
 *  `baseSha` echoed back (nothing moved), not a fresh one. */
export async function updateEdgeStatus(
  edges: unknown, index: number, status: string, opts?: { baseSha?: string },
): Promise<{ data: unknown; version: string }> {
  const arr = edges as { edges: Record<string, unknown>[] };
  if (arr.edges && arr.edges[index]) {
    arr.edges[index].status = status;
    if (status === 'approved') {
      delete arr.edges[index].direction_flag;
    }
    const result = await writeEdgesFile(arr, opts);
    scheduleOverlayCommit(getCurrentUserId()); // t/4258/t/4277 C3: unlike PUT /api/edges, no following commit
    return { data: arr, version: result.version };
  }
  return { data: arr, version: opts?.baseSha ?? '' };
}

export async function bulkUpdateEdges(
  edges: unknown, indices: number[], status: string, opts?: { baseSha?: string },
): Promise<{ data: unknown; version: string }> {
  const arr = edges as { edges: Record<string, unknown>[] };
  if (arr.edges) {
    for (const i of indices) {
      if (arr.edges[i]) arr.edges[i].status = status;
    }
    const result = await writeEdgesFile(arr, opts);
    scheduleOverlayCommit(getCurrentUserId()); // t/4258/t/4277 C3
    return { data: arr, version: result.version };
  }
  return { data: arr, version: opts?.baseSha ?? '' };
}

export async function swapEdgeDirection(
  edges: unknown, index: number, opts?: { baseSha?: string },
): Promise<{ data: unknown; version: string }> {
  const arr = edges as { edges: Record<string, unknown>[] };
  if (arr.edges && arr.edges[index]) {
    const edge = arr.edges[index];
    const tmp = edge.source;
    edge.source = edge.target;
    edge.target = tmp;
    delete edge.direction_flag;
    const result = await writeEdgesFile(arr, opts);
    scheduleOverlayCommit(getCurrentUserId()); // t/4258/t/4277 C3
    return { data: arr, version: result.version };
  }
  return { data: arr, version: opts?.baseSha ?? '' };
}

interface PolicySourceReference {
  docId: string;
  title: string;
  dateIngested: string;
  sourceTime: string;
  stance: string;
  nodeId: string;
  pov: string;
}

type PolicySourceIndex = Record<string, PolicySourceReference[]>;

async function buildNodeToPoliciesMap(): Promise<Map<string, string[]>> {
  const nodeToPolicies = new Map<string, string[]>();
  for (const pov of POV_KEYS) {
    try {
      const file = await readTaxonomyFile(pov) as { nodes?: Array<{ id: string; graph_attributes?: { policy_actions?: { policy_id?: string }[] } }> };
      if (!file?.nodes) continue;
      for (const node of file.nodes) {
        const actions = node.graph_attributes?.policy_actions;
        if (!actions) continue;
        for (const action of actions) {
          if (!action.policy_id) continue;
          if (!nodeToPolicies.has(node.id)) nodeToPolicies.set(node.id, []);
          nodeToPolicies.get(node.id)!.push(action.policy_id);
        }
      }
    } catch { /* telemetry — silent by design;  skip unavailable POV files */ }
  }
  return nodeToPolicies;
}

async function loadPolicyMetaCache(sourcesDir: string | null): Promise<Record<string, { dateIngested: string; sourceTime: string }>> {
  const metaCache: Record<string, { dateIngested: string; sourceTime: string }> = {};
  const sourceEntries = sourcesDir ? await backend.listDirectory(sourcesDir) : [];
  for (const name of sourceEntries) {
    const metaPath = path.join(sourcesDir!, name, 'metadata.json');
    try {
      const metaRaw = await backend.readFile(metaPath);
      if (metaRaw !== null) {
        const meta = JSON.parse(metaRaw);
        metaCache[name] = {
          dateIngested: meta.date_ingested || meta.date_published || '',
          sourceTime: meta.source_time || '',
        };
      }
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return metaCache;
}

function joinNodeSourcesToPolicies(
  nodeToPolicies: Map<string, string[]>,
  nodeSourceIdx: NodeSourceIndex,
  policyMetaCache: Record<string, { dateIngested: string; sourceTime: string }>,
  result: PolicySourceIndex,
): void {
  for (const [nodeId, policyIds] of nodeToPolicies) {
    const sourceRefs = nodeSourceIdx[nodeId];
    if (!sourceRefs) continue;
    for (const polId of policyIds) {
      if (!result[polId]) result[polId] = [];
      for (const ref of sourceRefs) {
        const meta = policyMetaCache[ref.docId] || { dateIngested: ref.datePublished, sourceTime: '' };
        result[polId].push({
          docId: ref.docId, title: ref.title, dateIngested: meta.dateIngested,
          sourceTime: meta.sourceTime, stance: ref.stance, nodeId, pov: ref.pov,
        });
      }
    }
  }
}

/**
 * For each policy in policy_actions.json, find all nodes that reference it
 * (by scanning policy_actions in POV files), then use the node-source index
 * to find which sources reference those nodes.
 */
export async function buildPolicySourceIndex(): Promise<PolicySourceIndex> {
  const result: PolicySourceIndex = {};
  const sourcesDir = getSourcesDir();

  const regRaw = await readPolicyRegistry() as { policies?: { id: string }[] } | null;
  if (!regRaw?.policies) return result;
  for (const pol of regRaw.policies) { result[pol.id] = []; }

  const nodeToPolicies = await buildNodeToPoliciesMap();
  const nodeSourceIdx = await buildNodeSourceIndex();
  const policyMetaCache = await loadPolicyMetaCache(sourcesDir);
  joinNodeSourcesToPolicies(nodeToPolicies, nodeSourceIdx, policyMetaCache, result);
  return result;
}

// ── Proposals ──

export async function listProposals(): Promise<unknown[]> {
  const dir = getDataRoot();
  try {
    const entries = await backend.listDirectory(dir);
    const proposals: unknown[] = [];
    for (const f of entries.filter(f => f.startsWith('taxonomy-proposal') && f.endsWith('.json'))) {
      const raw = await backend.readFile(path.join(dir, f));
      if (raw !== null) {
        proposals.push({ filename: f, ...JSON.parse(raw) });
      }
    }
    return proposals;
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'listProposals: listing failed, returning []',
      data: { error: String(err) },
    });
    return [];
  }
}

export async function saveProposal(filename: string, data: unknown, opts?: { baseSha?: string }): Promise<{ version: string }> {
  assertSafeFilename(filename, 'proposal filename');
  return backend.writeFile(path.join(getDataRoot(), filename), JSON.stringify(data, null, 2), opts);
}

/** t/4192: a single proposal's content plus its version, for the save route
 *  to hand back to the client as its write precondition (ETag). */
export async function readProposalWithVersion(filename: string): Promise<{ data: unknown; version: string } | null> {
  assertSafeFilename(filename, 'proposal filename');
  const result = await readFileWithVersionOrFallback(path.join(getDataRoot(), filename));
  if (result === null) return null;
  return { data: JSON.parse(result.content), version: result.version };
}

// ── Admin feedback & error reports (t/837) ──
// Persisted through the user-content backend (Azure Blob in production) so they
// survive container restarts, instead of raw fs to the ephemeral data root.
// Filesystem/Electron mode falls back to the default backend (unchanged).

function adminDir(kind: 'feedback' | 'errors'): string {
  return path.join(getDataRoot(), 'admin', kind);
}

export async function saveFeedbackEntry(entry: { id: string; timestamp: string;[k: string]: unknown }): Promise<void> {
  const ts = entry.timestamp.replace(/:/g, '-');
  const file = path.join(adminDir('feedback'), `feedback-${ts}-${entry.id.slice(0, 8)}.json`);
  await getUserContentBackend().writeFile(file, JSON.stringify(entry, null, 2));
}

export async function saveErrorReport(entry: { id: string; timestamp: string;[k: string]: unknown }): Promise<void> {
  const ts = entry.timestamp.replace(/:/g, '-');
  const file = path.join(adminDir('errors'), `error-${ts}-${entry.id.slice(0, 8)}.json`);
  const sanitized = entry.context && typeof entry.context === 'object' && !Array.isArray(entry.context)
    ? { ...entry, context: redactRecord(entry.context as Record<string, unknown>) }
    : entry;
  await getUserContentBackend().writeFile(file, JSON.stringify(sanitized, null, 2));
}

async function readAdminEntries(kind: 'feedback' | 'errors', prefix: string): Promise<{ items: Record<string, unknown>[]; skipped: string[] }> {
  const ucb = getUserContentBackend();
  const dir = adminDir(kind);
  const items: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const files = (await ucb.listDirectory(dir)).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = await ucb.readFile(path.join(dir, f));
      if (raw == null) { skipped.push(f); continue; }
      const entry = JSON.parse(raw) as Record<string, unknown>;
      if (kind === 'feedback' && (entry.category === undefined || entry.category === null)) entry.category = 'general';
      items.push(entry);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'file-io', level: 'warn',
        message: `Failed to read/parse admin ${kind} entry; skipping`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { file: f },
      });
      skipped.push(f);
    }
  }
  return { items, skipped };
}

/** All feedback entries via the backend (unsorted); missing category → 'general'. */
export async function listFeedbackEntries(): Promise<{ items: Record<string, unknown>[]; skipped: string[] }> {
  return readAdminEntries('feedback', 'feedback-');
}

/** All client error reports via the backend (unsorted). */
export async function listErrorEntries(): Promise<{ items: Record<string, unknown>[]; skipped: string[] }> {
  return readAdminEntries('errors', 'error-');
}

/** Read a single error report by ID. Returns null if not found or unparseable. */
export async function getErrorReport(id: string): Promise<Record<string, unknown> | null> {
  assertSafeId(id, 'error report id');
  const ucb = getUserContentBackend();
  const suffix = `-${id.slice(0, 8)}.json`;
  const files = (await ucb.listDirectory(adminDir('errors'))).filter(f => f.startsWith('error-') && f.endsWith(suffix));
  if (files.length === 0) return null;
  try {
    const raw = await ucb.readFile(path.join(adminDir('errors'), files[0]));
    if (raw == null) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.server.warn({ err, errorId: id }, 'getErrorReport failed to read/parse error report');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'Failed to read/parse error report',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { errorId: id },
    });
    return null;
  }
}

const DUMP_FILENAME_RE = /^(client|server)-(.+)\.jsonl$/;

/** List flight recorder dump metadata from filenames + mtime (no file content read). */
export async function listFlightRecorderDumpIds(): Promise<Array<{ kind: 'client' | 'server'; dumpId: string; timestamp: string }>> {
  const dir = path.join(getDataRoot(), 'admin', 'flight-recorder-dumps');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.server.warn({ err }, 'listFlightRecorderDumpIds: failed to list dumps directory');
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'Failed to list flight recorder dumps directory',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return [];
  }
  const results: Array<{ kind: 'client' | 'server'; dumpId: string; timestamp: string }> = [];
  for (const name of names) {
    const m = DUMP_FILENAME_RE.exec(name);
    if (!m) continue;
    try {
      const stat = await fs.stat(path.join(dir, name));
      results.push({ kind: m[1] as 'client' | 'server', dumpId: m[2], timestamp: new Date(stat.mtimeMs).toISOString() });
    } catch (err) {
      log.server.warn({ err, file: name }, 'listFlightRecorderDumpIds: failed to stat dump file; skipping');
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'file-io', level: 'warn',
        message: 'Failed to stat flight recorder dump file; skipping',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        data: { file: name },
      });
    }
  }
  return results;
}

// ── Harvest operations (extracted to harvestStore.ts, ADR-007, max-lines) ──
export { harvestCreateConflict, harvestAddDebateRef, harvestUpdateSteelman, harvestAddVerdict, harvestQueueConcept, harvestSaveManifest } from './harvestStore.js';

// ── Summaries & Sources ──

export function getSourcesDir(): string | null {
  // Sources may live in a separate repo (ai-triad-sources).
  // getSourcesRoot() returns null when the path doesn't exist.
  const sourcesRoot = getSourcesRoot();
  if (sourcesRoot) return sourcesRoot;

  // Legacy fallback: sources inside data repo (pre-separation layout).
  // In API mode the backend handles existence — skip local filesystem check.
  const config = loadDataConfig();
  const legacy = resolveDataPath(config.sources_dir);
  return (STORAGE_MODE === 'github-api' || fsSync.existsSync(legacy)) ? legacy : null;
}

function getSummariesDir(): string {
  const config = loadDataConfig();
  return resolveDataPath(config.summaries_dir);
}

export interface DiscoveredSource {
  id: string;
  title: string;
  url: string | null;
  sourceType: string;
  datePublished: string;
  dateIngested: string;
  hasSummary: boolean;
  tags: string[];
  authors: string[];
}

export async function discoverSources(): Promise<DiscoveredSource[]> {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return []; // sources unavailable (web mode or repo not cloned)
  const summariesDir = getSummariesDir();

  const sourceEntries = await backend.listDirectory(sourcesDir);
  if (sourceEntries.length === 0) return [];

  const sources: DiscoveredSource[] = [];
  for (const name of sourceEntries) {
    const metaPath = path.join(sourcesDir, name, 'metadata.json');
    try {
      const metaRaw = await backend.readFile(metaPath);
      if (metaRaw === null) continue; // not a source directory (no metadata)
      const meta = JSON.parse(metaRaw);
      const summaryPath = path.join(summariesDir, `${name}.json`);
      sources.push({
        id: name,
        title: meta.title || name,
        url: meta.url || null,
        sourceType: meta.source_type || 'unknown',
        datePublished: meta.date_published || meta.source_time || '',
        dateIngested: meta.date_ingested || '',
        hasSummary: await backend.fileExists(summaryPath),
        tags: meta.pov_tags || [],
        authors: meta.authors || [],
      });
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return sources.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
}

export async function loadSummary(docId: string): Promise<unknown | null> {
  assertSafeId(docId, 'document id');
  const filePath = path.join(getSummariesDir(), `${docId}.json`);
  const raw = await backend.readFile(filePath);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch { /* telemetry — silent by design */ return null; }
}

export async function loadSnapshot(sourceId: string): Promise<string | null> {
  assertSafeId(sourceId, 'source id');
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return null; // sources unavailable
  return backend.readFile(path.join(sourcesDir, sourceId, 'snapshot.md'));
}

// ── Source document resolution ──

/** Result of resolving a fact's `doc_id` to an actual source document. */
export interface SourceDocumentResolution {
  available: boolean;
  type: 'pdf' | 'markdown' | null;
  /** Inline markdown content (markdown type only). */
  content?: string;
  /** Path/URL to fetch the document (pdf type only). Same-origin API URL in
   *  server mode; the Electron IPC mirror returns a local file path instead. */
  path?: string;
}

/** Find the raw PDF inside a source's `raw/` directory. Returns absolute path or null. */
async function findRawPdfPath(docId: string): Promise<string | null> {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return null;
  const rawDir = path.join(sourcesDir, docId, 'raw');
  const entries = await backend.listDirectory(rawDir);
  const pdf = entries.find(e => e.toLowerCase().endsWith('.pdf'));
  return pdf ? path.join(rawDir, pdf) : null;
}

/**
 * Resolve a source document by id. Determines whether the document exists and
 * returns its content (markdown) or a URL to fetch it (PDF).
 *
 * Resolution order:
 *   1. metadata source_type 'pdf' (or only a PDF present) + a raw PDF → pdf
 *   2. snapshot.md present → markdown (content inline)
 *   3. a raw PDF present without snapshot → pdf
 *   4. otherwise → { available: false } (AC #3 graceful degradation)
 */
export async function resolveSourceDocument(docId: string): Promise<SourceDocumentResolution> {
  assertSafeId(docId, 'document id');
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return { available: false, type: null }; // sources unavailable

  const docDir = path.join(sourcesDir, docId);

  // Read metadata best-effort to learn the original document type.
  let sourceType = '';
  try {
    const metaRaw = await backend.readFile(path.join(docDir, 'metadata.json'));
    if (metaRaw) sourceType = String(JSON.parse(metaRaw).source_type ?? '').toLowerCase();
  } catch (err) {
    // Malformed/missing metadata — fall back to content detection below.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'fileIO',
      level: 'warn',
      message: 'source document metadata unreadable',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }

  const pdfPath = await findRawPdfPath(docId);
  const snapshot = await backend.readFile(path.join(docDir, 'snapshot.md'));
  const fileUrl = `/api/source-documents/${encodeURIComponent(docId)}/file`;

  // Prefer markdown snapshot — renders inline with claim highlighting and
  // auto-scroll to the fact location. PDFs don't render in Electron's iframe.
  if (snapshot !== null) {
    return { available: true, type: 'markdown', content: snapshot };
  }
  if (pdfPath) {
    return { available: true, type: 'pdf', path: fileUrl };
  }
  return { available: false, type: null };
}

/** Read the raw PDF bytes for a source document. Returns null if absent. */
export async function readSourceDocumentPdf(docId: string): Promise<Buffer | null> {
  assertSafeId(docId, 'document id');
  const pdfPath = await findRawPdfPath(docId);
  if (!pdfPath) return null;
  return backend.readBinaryFile(pdfPath);
}

// ── Data-root validation (t/3296) — extracted to dataRootValidator.ts ──
export { validateDataRoot, validateCacheDirDisjoint } from './dataRootValidator.js';

// ── Dictionary ──

export async function loadDictionary(): Promise<{ standardized: unknown[]; colloquial: unknown[]; lintViolations: unknown[] }> {
  const dictDir = resolveDataPath('dictionary');
  const stdDir = path.join(dictDir, 'standardized');
  const colDir = path.join(dictDir, 'colloquial');

  const standardized: unknown[] = [];
  try {
    const stdFiles = await backend.listDirectory(stdDir);
    const stdJson = stdFiles.filter(f => f.endsWith('.json'));
    if (stdJson.length === 0) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'file-io', level: 'warn',
        message: 'loadDictionary: standardized dir present but zero .json files (empty-listing) — returning empty (t/3289)',
        data: { dir: stdDir, cause: 'empty-listing', fileCount: stdFiles.length },
      });
    }
    for (const f of stdJson) {
      try {
        const raw = await backend.readFile(path.join(stdDir, f));
        if (raw) standardized.push(JSON.parse(raw));
      } catch { /* telemetry — silent by design; skip malformed */ }
    }
  } catch (err: unknown) {
    const cause = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'dir-missing' : 'read-error';
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `loadDictionary: standardized dir unreadable — returning empty (${cause}) (t/3289)`,
      data: { dir: stdDir, cause, error: String(err) },
    });
  }

  const colloquial: unknown[] = [];
  try {
    const colFiles = await backend.listDirectory(colDir);
    const colJson = colFiles.filter(f => f.endsWith('.json'));
    if (colJson.length === 0) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'file-io', level: 'warn',
        message: 'loadDictionary: colloquial dir present but zero .json files (empty-listing) — returning empty (t/3289)',
        data: { dir: colDir, cause: 'empty-listing', fileCount: colFiles.length },
      });
    }
    for (const f of colJson) {
      try {
        const raw = await backend.readFile(path.join(colDir, f));
        if (raw) colloquial.push(JSON.parse(raw));
      } catch { /* telemetry — silent by design; skip malformed */ }
    }
  } catch (err: unknown) {
    const cause = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'dir-missing' : 'read-error';
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `loadDictionary: colloquial dir unreadable — returning empty (${cause}) (t/3289)`,
      data: { dir: colDir, cause, error: String(err) },
    });
  }

  return { standardized, colloquial, lintViolations: [] };
}

// ── PowerShell prompts (project-root I/O — always local) ──

// Allow-list of known prompt directories — the only values accepted for `dir`.
const PROMPT_DIR_SEGMENTS: Record<string, string[]> = {
  ps: ['scripts', 'AITriad', 'Prompts'],
  oped: ['lib', 'oped', 'prompts'],
};

export async function readPsPrompt(promptName: string, dir = 'ps'): Promise<{ text: string | null; error?: string }> {
  assertSafeFilename(promptName, 'prompt name'); // block path traversal (M1)
  const segments = PROMPT_DIR_SEGMENTS[dir];
  if (!segments) return { text: null, error: `Unknown prompt directory: ${dir}` };
  const promptsDir = path.join(getProjectRoot(), ...segments);
  const filePath = path.join(promptsDir, `${promptName}.prompt`);
  try {
    return { text: await fs.readFile(filePath, 'utf-8') };
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `readPsPrompt: prompt file not found or unreadable, returning error result: ${promptName}`,
      data: { filePath, error: String(err) },
    });
    return { text: null, error: `Prompt not found: ${promptName}` };
  }
}

export async function listPsPrompts(): Promise<string[]> {
  const promptsDir = path.join(getProjectRoot(), 'scripts', 'AITriad', 'Prompts');
  try {
    const entries = await fs.readdir(promptsDir);
    return entries
      .filter(f => f.endsWith('.prompt'))
      .map(f => f.replace('.prompt', ''));
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'listPsPrompts: directory listing failed, returning []',
      data: { promptsDir, error: String(err) },
    });
    return [];
  }
}

// ── AI models config (project-root I/O — always local) ──

export async function loadAIModels(): Promise<unknown> {
  const configPath = path.join(getProjectRoot(), 'ai-models.json');
  try {
    return JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch (err: unknown) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: 'loadAIModels: failed to load ai-models.json, returning empty config',
      data: { configPath, error: String(err) },
    });
    return { backends: [], models: [], defaults: {} };
  }
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Load taxonomy data from the filesystem for the CLI debate runner.
 * Resolves data root via .aitriad.json, loads all POV files, edges, embeddings, and policy registry.
 */

import fs from 'fs';
import path from 'path';
import type { PovNode, SituationNode, EdgesFile, Edge } from './taxonomyTypes.js';
import type { PolicyRef, SituationStatements } from './taxonomyContext.js';
import { ActionableError } from './errors.js';
import { parseNpy, extractNodeVectors } from '../npy.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import { stripDataUris } from './stripDataUris.js';
import { fetchUrlForPrompt } from '../url-fetch/fetchUrlForPrompt.js';

// ── Types ────────────────────────────────────────────────

export interface LineageCategoryData {
  /** Lineage name → { l1 category, l2 cluster } mapping. */
  mapping: Record<string, { l1: string; l2: string }>;
  /** Level 2 cluster definitions with labels. */
  level2_categories: { id: string; label: string; l1_parent: string; member_count: number }[];
}

export interface NodeEmbedding {
  pov: string;
  vector: number[];
  vectors?: number[][];
}

export interface LoadedTaxonomy {
  /** Selectable POV nodes only (no superseded_by). */
  accelerationist: { nodes: PovNode[] };
  /** Selectable POV nodes only (no superseded_by). */
  safetyist: { nodes: PovNode[] };
  /** Selectable POV nodes only (no superseded_by). */
  skeptic: { nodes: PovNode[] };
  situations: { nodes: SituationNode[] };
  /** Selectable edge set — both source and target are non-superseded. Default for all consumers. */
  edges: EdgesFile | null;
  /** Full edge set including edges to/from superseded nodes. Use for history, display and QBAF readers. */
  allEdges: EdgesFile | null;
  /** Embeddings for selectable nodes only. Superseded node embeddings are excluded. */
  embeddings: Record<string, NodeEmbedding>;
  policyRegistry: PolicyRef[];
  /** Lineage category data (L1 + L2 cluster mapping). Absent if file not found. */
  lineageCategories?: LineageCategoryData;
  /**
   * All nodes by ID including superseded. Use `.get(id)` when you need the exact stored node
   * (historical debate citations, audit trails — the node as it was when cited). Never use it
   * to pick a node for new reasoning; use resolveNode instead.
   */
  allNodesById: Map<string, PovNode>;
  /**
   * Resolve a node ID to its canonical survivor for new attribution and reasoning.
   * - Non-superseded node: returns itself.
   * - Superseded node with a valid chain to a non-superseded node: returns the chain endpoint.
   * - Superseded node in a cycle or with a dangling target: returns the node itself (WARN at load).
   * - Unknown ID: returns undefined.
   *
   * Contrast with allNodesById.get(id): that returns the exact stored node for historical lookup;
   * resolveNode follows the chain to give the current canonical node for new reasoning.
   */
  resolveNode: (id: string) => PovNode | undefined;
}

export interface ConflictFile {
  claim_id: string;
  claim_label: string;
  description: string;
  status: string;
  linked_taxonomy_nodes: string[];
  instances: { doc_id: string; stance: string; assertion: string }[];
}

// ── Data root resolution ─────────────────────────────────

interface AiTriadConfig {
  data_root: string;
  taxonomy_dir: string;
  sources_dir?: string;
  conflicts_dir: string;
  debates_dir: string;
}

/**
 * Resolve the repo root for CLI/node contexts: walks up to `.aitriad.json` and THROWS
 * if not found.
 * ⚠ NOT for Electron apps — use `resolveRepoRootForApp` in `lib/electron-shared` (it adds
 * the `scripts/AITriad` marker + an `app.getAppPath()` packaged fallback). Don't cross the
 * wires. (t/1721)
 */
export function resolveRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.aitriad.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new ActionableError({
    goal: 'Resolve data repository root',
    problem: 'Cannot find .aitriad.json in any parent directory',
    location: 'taxonomyLoader.resolveRepoRoot',
    nextSteps: [
      'Ensure you are running from within the ai-triad-research repository',
      `Verify that .aitriad.json exists in the repo root (searched upward from: ${startDir})`,
      'If the file is missing, restore it from git: git checkout -- .aitriad.json',
    ],
  });
}

export function resolveDataRoot(repoRoot: string): string {
  // Priority: env var > .aitriad.json
  if (process.env.AI_TRIAD_DATA_ROOT) {
    const envRoot = path.resolve(process.env.AI_TRIAD_DATA_ROOT);
    if (!fs.existsSync(envRoot)) {
      throw new ActionableError({
        goal: 'Resolve data repository root',
        problem: `AI_TRIAD_DATA_ROOT is set to '${envRoot}' but that directory does not exist`,
        location: 'taxonomyLoader.resolveDataRoot',
        nextSteps: [
          `Create the missing directory: mkdir -p "${envRoot}"`,
          'Fix the AI_TRIAD_DATA_ROOT environment variable to point to the correct data directory',
          'Unset AI_TRIAD_DATA_ROOT to fall back to .aitriad.json resolution',
        ],
      });
    }
    return envRoot;
  }
  const config = loadConfig(repoRoot);
  const dataRoot = path.resolve(repoRoot, config.data_root);
  if (!fs.existsSync(dataRoot)) {
    throw new ActionableError({
      goal: 'Resolve data repository root',
      problem: `Data root '${dataRoot}' (from .aitriad.json data_root: '${config.data_root}') does not exist`,
      location: 'taxonomyLoader.resolveDataRoot',
      nextSteps: [
        'Run Install-AITriadData to set up the data repository',
        `Set AI_TRIAD_DATA_ROOT to an existing data directory`,
        `Verify the data_root value in .aitriad.json points to a valid relative path (currently: '${config.data_root}')`,
      ],
    });
  }
  return dataRoot;
}

/**
 * Resolve the sources directory path. Returns null if it doesn't exist
 * (sources are optional — evidence retrieval gracefully degrades).
 */
export function resolveSourcesDir(repoRoot: string): string | null {
  const dataRoot = resolveDataRoot(repoRoot);
  const config = loadConfig(repoRoot);
  const sourcesDir = path.join(dataRoot, config.sources_dir ?? 'sources');
  return fs.existsSync(sourcesDir) ? sourcesDir : null;
}

/**
 * t/1450: Load the comp-linguist per-POV, per-BDI situation register-statements sidecar.
 * Node-only (reads the filesystem) — kept OUT of taxonomyContext.ts, which is
 * renderer-reachable and must stay browser-safe (no `fs`). Graceful-missing: a missing or
 * malformed file returns null, so the feature is silently off (AC1). Mirrors loadCoverageMap.
 */
export function loadSituationStatements(dataRoot: string): SituationStatements | null {
  const p = path.join(
    dataRoot,
    'research-artifacts',
    'comp-linguist',
    'situation-statements',
    'situation_statements.json',
  );
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8').replace(/^﻿/, ''));
    if (raw && typeof raw === 'object') {
      // Drop the non-situation _provenance key; keep only situation entries.
      const out: SituationStatements = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (key.startsWith('_')) continue;
        out[key] = value as SituationStatements[string];
      }
      return out;
    }
    return null;
  } catch (err) {
    getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-loader', level: 'warn', message: 'situation statements unreadable — returning null. err=' + String(err) });
    return null;
  }
}

function loadConfig(repoRoot: string): AiTriadConfig {
  const configPath = path.join(repoRoot, '.aitriad.json');
  if (!fs.existsSync(configPath)) {
    throw new ActionableError({
      goal: 'Load AI model configuration',
      problem: `Configuration file not found: ${configPath}`,
      location: 'taxonomyLoader.loadConfig',
      nextSteps: [
        'Ensure you are running from the ai-triad-research repo root',
        'Verify that .aitriad.json exists in the repository root',
        'If the file is missing, restore it from git: git checkout -- .aitriad.json',
      ],
    });
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'taxonomy-loader',
      level: 'error',
      message: `Failed to parse config file: ${configPath}`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    const errMsg = err instanceof ActionableError ? err.problem : (err instanceof Error ? err.message : String(err));
    throw new ActionableError({
      goal: 'Parse AI model configuration',
      problem: `Failed to parse ${configPath}: ${errMsg}`,
      location: 'taxonomyLoader.loadConfig',
      nextSteps: [
        `Open ${configPath} and fix the JSON syntax (trailing commas, unquoted keys, etc.)`,
        'Run the file through a JSON linter: npx jsonlint .aitriad.json',
        'If the file is corrupted, restore it from git: git checkout -- .aitriad.json',
      ],
      innerError: err,
    });
  }
}

// ── Taxonomy loading ─────────────────────────────────────

function loadJsonSafe<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    process.stderr.write(`[taxonomy-loader] Warning: File not found: ${filePath} — using empty default\n`);
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '')) as T;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'taxonomy-loader',
      level: 'warn',
      message: `Failed to parse ${filePath} — using empty default`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    process.stderr.write(`[taxonomy-loader] Warning: Failed to parse ${filePath}: ${err instanceof Error ? err.message : err} — using empty default\n`);
    return fallback;
  }
}

/** Merge synthetic multi-vector embeddings into the base embedding map in-place. */
function loadSyntheticEmbeddings(synDir: string, embeddings: Record<string, NodeEmbedding>): void {
  for (const pov of ['acc', 'saf', 'skp']) {
    const npyPath = path.join(synDir, `embeddings_${pov}.npy`);
    const idxPath = path.join(synDir, `index_${pov}.json`);
    if (!fs.existsSync(npyPath) || !fs.existsSync(idxPath)) continue;
    const parsed = parseNpy(fs.readFileSync(npyPath));
    const index = loadJsonSafe<Record<string, { start: number; count: number }>>(idxPath, {});
    const synVecs = extractNodeVectors(parsed, index, pov);
    for (const [nodeId, entry] of Object.entries(synVecs)) {
      if (!entry.vectors?.length) continue;
      if (embeddings[nodeId]) {
        embeddings[nodeId].vectors = entry.vectors;
      } else {
        embeddings[nodeId] = { pov: entry.pov, vector: entry.vectors[0], vectors: entry.vectors };
      }
    }
  }
}

/** Normalise the lineage mapping: support both old flat-string and new {l1, l2} value formats. */
function normalizeLineageMapping(
  raw: Record<string, string | { l1: string; l2: string }>,
): Record<string, { l1: string; l2: string }> {
  const out: Record<string, { l1: string; l2: string }> = {};
  for (const [name, val] of Object.entries(raw)) {
    out[name] = typeof val === 'string' ? { l1: val, l2: 'uncategorized' } : val;
  }
  return out;
}

/** Walk supersession chains for all POV nodes, recording the ultimate survivor (or null for
 *  cycles/dangling targets) and per-node hop depth. Emits WARN via the global flight recorder. */
function resolveSupersessionChains(
  allPovNodes: PovNode[],
  allNodesById: Map<string, PovNode>,
): { resolutionCache: Map<string, string | null>; depthCache: Map<string, number> } {
  const caches: SupersessionCaches = { resolutionCache: new Map(), depthCache: new Map() };
  for (const startNode of allPovNodes) {
    if (!startNode.superseded_by || caches.resolutionCache.has(startNode.id)) continue;
    settleWalk(walkSupersession(startNode.id, allNodesById, caches.resolutionCache), caches);
  }
  return caches;
}

interface SupersessionCaches {
  resolutionCache: Map<string, string | null>;
  depthCache: Map<string, number>;
}

/** How a supersession walk ended: at a live survivor, at an already-resolved node, in a cycle, or
 *  at a `superseded_by` target that isn't in the taxonomy. */
type WalkEnd = 'survivor' | 'cached' | 'cycle' | 'dangling';

interface SupersessionWalk {
  /** Visited ids in order; for `survivor` it ends with the survivor itself. */
  chain: string[];
  /** The node the walk stopped on. */
  cur: string;
  end: WalkEnd;
  /** `dangling` only: the missing target. */
  missingTarget?: string;
}

function warnSupersession(message: string): void {
  getGlobalRecorder()?.record({ type: 'system.error', component: 'taxonomy-loader', level: 'warn', message });
}

/** Follow `superseded_by` from `startId` until a survivor, a cached node, a cycle or a dangling target. */
function walkSupersession(
  startId: string,
  allNodesById: Map<string, PovNode>,
  resolutionCache: Map<string, string | null>,
): SupersessionWalk {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur = startId;
  while (!resolutionCache.has(cur)) {
    if (seen.has(cur)) return { chain, cur, end: 'cycle' };
    chain.push(cur);
    seen.add(cur);
    const nextId = allNodesById.get(cur)?.superseded_by;
    if (!nextId) return { chain, cur, end: 'survivor' };
    if (!allNodesById.has(nextId)) return { chain, cur, end: 'dangling', missingTarget: nextId };
    cur = nextId;
  }
  return { chain, cur, end: 'cached' };
}

/** Record a walk's outcome in the caches, emitting the same WARNs the inline walk did. */
function settleWalk(walk: SupersessionWalk, caches: SupersessionCaches): void {
  const { chain, cur } = walk;
  if (walk.end === 'cycle') {
    const cycleMembers = chain.slice(chain.indexOf(cur));
    warnSupersession(`loadTaxonomy: supersession cycle: ${[...cycleMembers, cur].join(' → ')} — members excluded from selection`);
    for (const id of chain) caches.resolutionCache.set(id, null);
  } else if (walk.end === 'dangling') {
    warnSupersession(`loadTaxonomy: node ${cur} superseded_by "${walk.missingTarget}" not found in taxonomy — treating as no survivor`);
    for (const id of chain) caches.resolutionCache.set(id, null);
  } else if (walk.end === 'survivor') {
    settleToSurvivor(chain, cur, caches);
  } else {
    settleToCached(chain, cur, caches);
  }
}

/** Every chain member before the survivor resolves to it, with its hop distance. */
function settleToSurvivor(chain: string[], survivor: string, caches: SupersessionCaches): void {
  chain.forEach((id, i) => {
    if (id === survivor) return;
    caches.resolutionCache.set(id, survivor);
    caches.depthCache.set(id, chain.length - 1 - i);
  });
  if (chain.length - 1 > 1) {
    warnSupersession(`loadTaxonomy: supersession chain ${chain.join(' → ')} — resolves to ${survivor}`);
  }
}

/** The chain joined an already-resolved node: inherit its resolution (or its null) and add the hops. */
function settleToCached(chain: string[], cur: string, caches: SupersessionCaches): void {
  const existingRes = caches.resolutionCache.get(cur) ?? null;
  const cachedDepth = caches.depthCache.get(cur) ?? 0;
  if (existingRes !== null && chain.length + cachedDepth > 1) {
    warnSupersession(`loadTaxonomy: supersession chain ${[...chain, cur].join(' → ')} — resolves to ${existingRes}`);
  }
  chain.forEach((id, i) => {
    if (caches.resolutionCache.has(id)) return;
    caches.resolutionCache.set(id, existingRes);
    if (existingRes !== null) caches.depthCache.set(id, chain.length - i + cachedDepth);
  });
}

export function loadTaxonomy(repoRoot: string): LoadedTaxonomy {
  const dataRoot = resolveDataRoot(repoRoot);
  const config = loadConfig(repoRoot);
  const taxonomyDir = path.join(dataRoot, config.taxonomy_dir);

  const acc = loadJsonSafe<{ nodes: PovNode[] }>(path.join(taxonomyDir, 'accelerationist.json'), { nodes: [] });
  const saf = loadJsonSafe<{ nodes: PovNode[] }>(path.join(taxonomyDir, 'safetyist.json'), { nodes: [] });
  const skp = loadJsonSafe<{ nodes: PovNode[] }>(path.join(taxonomyDir, 'skeptic.json'), { nodes: [] });
  const sit = loadJsonSafe<{ nodes: SituationNode[] }>(path.join(taxonomyDir, 'situations.json'), { nodes: [] });
  const allEdges = loadJsonSafe<EdgesFile | null>(path.join(taxonomyDir, 'edges.json'), null);

  // Embeddings: { model, dimension, node_count, nodes: { [id]: { pov, vector } } }
  const embeddingsRaw = loadJsonSafe<{ nodes?: Record<string, { pov: string; vector: number[] }> }>(
    path.join(taxonomyDir, 'embeddings.json'),
    { nodes: {} },
  );
  const embeddings: Record<string, NodeEmbedding> = embeddingsRaw.nodes ?? {};

  // Synthetic multi-vector embeddings (optional — produced by Export-SyntheticEmbeddings)
  const synDir = path.join(taxonomyDir, 'synthetic');
  loadSyntheticEmbeddings(synDir, embeddings);

  // Policy registry
  const policyRaw = loadJsonSafe<{ policies?: { id: string; action: string; source_povs?: string[] }[] }>(
    path.join(taxonomyDir, 'policy_actions.json'),
    { policies: [] },
  );
  const policyRegistry: PolicyRef[] = (policyRaw.policies ?? []).map(p => ({
    id: p.id,
    action: p.action,
    source_povs: p.source_povs,
  }));

  // Lineage categories (optional — absent means lineage distribution unavailable)
  const lineageRaw = loadJsonSafe<{
    mapping?: Record<string, string | { l1: string; l2: string }>;
    level2_categories?: { id: string; label: string; l1_parent: string; member_count: number }[];
  } | null>(path.join(taxonomyDir, 'lineage_categories.json'), null);

  let lineageCategories: LineageCategoryData | undefined;
  if (lineageRaw?.mapping && lineageRaw?.level2_categories) {
    lineageCategories = {
      mapping: normalizeLineageMapping(lineageRaw.mapping),
      level2_categories: lineageRaw.level2_categories,
    };
  }

  // ── Supersession: chain resolution + cycle/dangling detection ────────────────
  const allPovNodes: PovNode[] = [
    ...(acc.nodes ?? []),
    ...(saf.nodes ?? []),
    ...(skp.nodes ?? []),
  ];
  const allNodesById = new Map<string, PovNode>(allPovNodes.map(n => [n.id, n]));

  const { resolutionCache, depthCache } = resolveSupersessionChains(allPovNodes, allNodesById);

  const resolveNode = (id: string): PovNode | undefined => {
    const node = allNodesById.get(id);
    if (!node) return undefined;
    if (!node.superseded_by) return node;
    const resolved = resolutionCache.get(id);
    if (!resolved) return node; // cycle or dangling — return self
    return allNodesById.get(resolved) ?? node;
  };

  // Superseded IDs only — used to exclude rather than include, so sit/policy/cc nodes pass through.
  const supersededIds = new Set(allPovNodes.filter(n => n.superseded_by).map(n => n.id));

  // Filter embeddings: drop superseded POV nodes only; keep all other node types (sit, policy, cc).
  const selectableEmbeddings: Record<string, NodeEmbedding> = {};
  for (const [id, emb] of Object.entries(embeddings)) {
    if (!supersededIds.has(id)) selectableEmbeddings[id] = emb;
  }

  // Build selectable edge set: drop any edge whose source or target is superseded.
  const edges: EdgesFile | null = allEdges
    ? { ...allEdges, edges: allEdges.edges.filter(e => !supersededIds.has(e.source) && !supersededIds.has(e.target)) }
    : null;

  return {
    accelerationist: { nodes: (acc.nodes ?? []).filter(n => !n.superseded_by) },
    safetyist: { nodes: (saf.nodes ?? []).filter(n => !n.superseded_by) },
    skeptic: { nodes: (skp.nodes ?? []).filter(n => !n.superseded_by) },
    situations: { nodes: sit.nodes ?? [] },
    edges,
    allEdges,
    embeddings: selectableEmbeddings,
    policyRegistry,
    lineageCategories,
    allNodesById,
    resolveNode,
  };
}

// ── Conflict loading ─────────────────────────────────────

export function loadConflicts(repoRoot: string): ConflictFile[] {
  const dataRoot = resolveDataRoot(repoRoot);
  const config = loadConfig(repoRoot);
  const conflictsPath = path.join(dataRoot, config.conflicts_dir, 'conflicts.json');
  const raw = loadJsonSafe<{ conflicts?: ConflictFile[] } | null>(conflictsPath, null);
  if (!raw || !Array.isArray(raw.conflicts)) return [];
  return raw.conflicts;
}

// ── Vocabulary loading ──────────────────────────────────

export function loadVocabulary(repoRoot: string): { standardized: unknown[]; colloquial: unknown[] } {
  const dataRoot = resolveDataRoot(repoRoot);
  const dictDir = path.join(dataRoot, 'dictionary');
  const stdDir = path.join(dictDir, 'standardized');
  const colDir = path.join(dictDir, 'colloquial');

  const standardized: unknown[] = [];
  const colloquial: unknown[] = [];

  if (fs.existsSync(stdDir)) {
    for (const f of fs.readdirSync(stdDir).filter(f => f.endsWith('.json'))) {
      const data = loadJsonSafe(path.join(stdDir, f), null);
      if (data) standardized.push(data);
    }
  }
  if (fs.existsSync(colDir)) {
    for (const f of fs.readdirSync(colDir).filter(f => f.endsWith('.json'))) {
      const data = loadJsonSafe(path.join(colDir, f), null);
      if (data) colloquial.push(data);
    }
  }

  return { standardized, colloquial };
}

// ── Markdown conversion via markitdown ──────────────────

/**
 * Convert a file to Markdown using Microsoft's markitdown CLI.
 * Falls back to raw content if markitdown is not installed.
 */
export async function convertToMarkdown(filePath: string): Promise<string> {
  let resolved = path.resolve(filePath);

  // openSync is the first file operation — no statSync precedes it,
  // eliminating the check-then-use race (js/file-system-race, t/2001#8 fd-pattern).
  let fd: number = -1;
  let isDir = false;
  try {
    fd = fs.openSync(resolved, 'r');
    isDir = fs.fstatSync(fd).isDirectory();
    if (isDir) fs.closeSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ActionableError({
        goal: 'Load debate source document',
        problem: `File not found: ${resolved}`,
        location: 'taxonomyLoader.convertToMarkdown',
        nextSteps: [
          `Verify the file path is correct: ${resolved}`,
          'Check that the file has not been moved or renamed',
          'If using a relative path, ensure you are running from the repository root',
        ],
      });
    }
    if (code !== 'EISDIR') throw err;
    isDir = true; // Windows: directory open throws EISDIR before fstatSync
  }

  // If path is a directory, look for snapshot.md or the first .md file inside
  if (isDir) {
    const snapshot = path.join(resolved, 'snapshot.md');
    try {
      fd = fs.openSync(snapshot, 'r');
      resolved = snapshot;
    } catch {
      const mdFiles = fs.readdirSync(resolved).filter(f => f.endsWith('.md'));
      if (mdFiles.length > 0) {
        resolved = path.join(resolved, mdFiles[0]);
        fd = fs.openSync(resolved, 'r');
      } else {
        throw new ActionableError({
          goal: 'Load debate source document',
          problem: `Path is a directory with no .md files: ${resolved}`,
          location: 'taxonomyLoader.convertToMarkdown',
          nextSteps: [
            'Point docPath to a specific file, not a directory',
            `Add a snapshot.md file to ${resolved}`,
          ],
        });
      }
    }
  }

  if (resolved.endsWith('.md')) {
    try {
      return stripDataUris(fs.readFileSync(fd, 'utf-8')).text;
    } finally {
      fs.closeSync(fd);
    }
  }

  fs.closeSync(fd);
  try {
    return await runMarkitdown(resolved);
  } catch {
    process.stderr.write(`[taxonomy-loader] markitdown not available, reading raw content\n`);
    const fallbackFd = fs.openSync(resolved, 'r');
    try {
      return fs.readFileSync(fallbackFd, 'utf-8');
    } finally {
      fs.closeSync(fallbackFd);
    }
  }
}

/**
 * Convert HTML string to Markdown using markitdown via a temp file.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const { tmpdir } = await import('os');
  const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'aitriad-'));
  const tmpFile = path.join(tmpDir, 'input.html');
  try {
    // codeql[js/http-to-file-access] intentional: network HTML written to an app-generated mkdtempSync path for markitdown conversion; path is not user-controlled
    fs.writeFileSync(tmpFile, html, 'utf-8');
    return await runMarkitdown(tmpFile);
  } catch {
    process.stderr.write(`[taxonomy-loader] markitdown not available, stripping HTML tags\n`);
    return stripHtmlFallback(html);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  }
}

async function runMarkitdown(filePath: string): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise((resolve, reject) => {
    execFile('markitdown', [filePath], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

// Exported for testing only — not part of the public module API.
// Output is Markdown text consumed by callers; it is NOT HTML-rendered,
// so residual HTML entities in the output are inert (appear as literal text).
// Strips script/style/head blocks via a stability loop. Termination guaranteed:
// lazy matching always removes the shortest possible match, so s strictly shrinks
// toward a fixed point and the loop exits when no further tags can be matched.
export function stripHtmlFallback(html: string): string {
  let s = html;
  let prev: string;
  do {
    prev = s;
    // codeql[js/bad-tag-filter]
    // codeql[js/incomplete-multi-character-sanitization] do-while exits on stability; termination guaranteed by strict shrinking
    s = s
      .replace(/<script[\s\S]*?<\/script[^>]*>/gi, '')
      .replace(/<style[\s\S]*?<\/style[^>]*>/gi, '')
      .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, '')
      .replace(/<head[\s\S]*?<\/head[^>]*>/gi, '')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } while (s !== prev);
  return s;
}

// ── Source content loading ───────────────────────────────

export async function loadSourceContent(filePath: string): Promise<string> {
  return convertToMarkdown(filePath);
}

export async function fetchUrlContent(url: string): Promise<string> {
  // L10 fix (t/2528): route through SSRF-guarded fetcher (DNS/private-IP check).
  const result = await fetchUrlForPrompt(url);
  if (!result.ok) {
    throw new ActionableError({
      goal: 'Fetch debate source URL',
      problem: `Failed to fetch ${url}: ${result.reason ?? 'unknown error'}`,
      location: 'taxonomyLoader.fetchUrlContent',
      nextSteps: [
        'Verify the URL is correct and publicly accessible (HTTPS only)',
        'Check your network connection and any proxy settings',
        `Open the URL in a browser to confirm it loads: ${url}`,
        'If the resource requires authentication, download it manually and use a local file path instead',
      ],
    });
  }
  return result.text ?? '';
}

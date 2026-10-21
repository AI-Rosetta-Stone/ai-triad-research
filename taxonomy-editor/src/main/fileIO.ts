// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

import { app } from 'electron';
import { ActionableError } from '../../../lib/debate/errors.js';
import { renameSyncWithRetry } from '../../../lib/debate/persistence.js';
import { recordLockHolder } from '../../../lib/debate/lockHolder.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { parseNpy, extractNodeVectors } from '../../../lib/npy.js';
import { resolveRepoRootForApp } from '../../../lib/electron-shared/resolveRepoRootForApp.js';
import { assertSafeId } from '../../../lib/electron-shared/safeId.js';
import type { Entity } from '../../../lib/entities/types.js';
import { serializeEdgesJson } from '../../../lib/edges/serializeEdges.js';
import type { ContainerMentions, EntityMentionsFile } from '../../../lib/entities/mentionTypes.js';
import { serializePovTagProposals, type PovTagProposalsFile } from '../../../lib/schema/povTagProposals.js';
import {
  groupSourceIdentities, computeSourceContentHash,
  type SourceReference as SharedSourceReference, type SourceCardMeta as SharedSourceCardMeta,
  type SourceIdentityDoc, type SourceIdentityMeta,
} from '../../../lib/sourceIndex/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root via the shared electron resolver (walk to .aitriad.json/scripts/AITriad, fall
// back to the packaged app path). Was a local findRepoRoot — the robust reference the shared
// helper was based on, so this is a pure dedup (t/1721/t/1813).
const PROJECT_ROOT = resolveRepoRootForApp(__dirname, path.dirname(app.getAppPath()));
console.log(`[fileIO] PROJECT_ROOT: ${PROJECT_ROOT} (from __dirname: ${__dirname})`);
const IS_PACKAGED = app?.isPackaged ?? false;

// ── Platform-specific default data directory ──
function getPlatformDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'AITriad', 'data');
  } else if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), '..', 'AITriad', 'data');
  } else {
    const xdgData = process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
    return path.join(xdgData, 'aitriad', 'data');
  }
}

// ── Data path resolution from .aitriad.json ──
interface AiTriadConfig {
  data_root: string;
  sources_root?: string;
  taxonomy_dir: string;
  sources_dir: string;
  summaries_dir: string;
  conflicts_dir: string;
  debates_dir: string;
  queue_file: string;
  version_file: string;
}

let _dataConfigCache: AiTriadConfig | null = null;

export function loadDataConfig(): AiTriadConfig {
  if (_dataConfigCache) return _dataConfigCache;

  const defaults: AiTriadConfig = {
    data_root: IS_PACKAGED ? getPlatformDataDir() : '.',
    taxonomy_dir: 'taxonomy/Origin',
    sources_dir: 'sources',
    summaries_dir: 'summaries',
    conflicts_dir: 'conflicts',
    debates_dir: 'debates',
    queue_file: '.summarise-queue.json',
    version_file: 'TAXONOMY_VERSION',
  };

  // Search for .aitriad.json in multiple locations
  const searchPaths = [
    path.join(PROJECT_ROOT, '.aitriad.json'),
  ];
  if (IS_PACKAGED) {
    searchPaths.push(path.join(process.resourcesPath, '.aitriad.json'));
  }

  for (const configPath of searchPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        console.log(`[fileIO] Loaded config from ${configPath}`);
        const merged = { ...defaults, ...raw };
        _dataConfigCache = merged;
        return merged;
      }
    } catch { /* telemetry — silent by design;  try next */ }
  }

  console.log(`[fileIO] Using default config (packaged=${IS_PACKAGED}, data_root=${defaults.data_root})`);
  _dataConfigCache = defaults;
  return _dataConfigCache;
}

function resolveDataPath(subPath: string): string {
  const config = loadDataConfig();
  const envRoot = process.env.AI_TRIAD_DATA_ROOT;
  const dataRoot = envRoot || (path.isAbsolute(config.data_root)
    ? config.data_root
    : path.resolve(PROJECT_ROOT, config.data_root));
  return path.isAbsolute(subPath) ? subPath : path.resolve(dataRoot, subPath);
}

/** Check if data directory exists and has taxonomy files */
export function isDataAvailable(): boolean {
  try {
    const taxDir = resolveDataPath(loadDataConfig().taxonomy_dir);
    return fs.existsSync(taxDir) && fs.readdirSync(taxDir).some(f => f.endsWith('.json') && f !== 'embeddings.json' && f !== 'edges.json');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'warn',
      message: 'isDataAvailable: config or directory read failed — returning false (app will show data-unavailable UI)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

export function getDataRootPath(): string {
  return resolveDataPath('.');
}

/**
 * Validate the resolved data root at startup. Throws ActionableError when the
 * expected top-level sentinel directories (taxonomy/, dictionary/) are absent,
 * naming the resolved path and how it was resolved so the fix is one glance.
 * Call this before opening the main window so mis-provisioned installs fail loud
 * instead of showing silent-empty panels (t/3296, prevention for t/3290).
 */
export function validateDataRoot(): void {
  const config = loadDataConfig();
  const envRoot = process.env.AI_TRIAD_DATA_ROOT;
  const dataRoot = envRoot
    ? path.resolve(envRoot)
    : path.isAbsolute(config.data_root)
      ? config.data_root
      : path.resolve(PROJECT_ROOT, config.data_root);

  let method: string;
  if (envRoot) {
    method = 'AI_TRIAD_DATA_ROOT env var';
  } else if (fs.existsSync(path.join(PROJECT_ROOT, '.aitriad.json'))) {
    method = '.aitriad.json data_root field';
  } else if (IS_PACKAGED) {
    method = 'packaged-app platform default (no .aitriad.json override)';
  } else {
    method = 'PROJECT_ROOT fallback (dev mode, no .aitriad.json found)';
  }

  const REQUIRED_DIRS = ['taxonomy', 'dictionary'] as const;
  for (const dir of REQUIRED_DIRS) {
    const fullPath = path.join(dataRoot, dir);
    // Use readdirSync directly — ENOENT = definitive absent (same ActionableError class as empty).
    // Mirrors the server fs convention; eliminates the TOCTOU gap between existsSync + readdirSync.
    let entryCount: number;
    try {
      entryCount = fs.readdirSync(fullPath).length;
    } catch (fsErr) {
      /* telemetry — silent by design: ENOENT is immediately surfaced as ActionableError below */
      if ((fsErr as NodeJS.ErrnoException).code === 'ENOENT') {
        entryCount = 0;
      } else {
        throw fsErr;
      }
    }
    if (entryCount === 0) {
      throw new ActionableError({
        goal: 'Load application data',
        problem: `Data root resolved to "${dataRoot}" (via ${method}) but "${dir}/" is missing or empty`,
        location: 'main/fileIO.ts → validateDataRoot',
        nextSteps: [
          `Set AI_TRIAD_DATA_ROOT to your ai-triad-data clone root (e.g. set AI_TRIAD_DATA_ROOT=C:\\path\\to\\ai-triad-data)`,
          `Or update "data_root" in ${path.join(PROJECT_ROOT, '.aitriad.json')} to point at the data repo`,
          `Confirm the ai-triad-data repo is cloned and the path is correct: ${dataRoot}`,
          `Expected top-level directories inside the data root: ${REQUIRED_DIRS.map(d => d + '/').join(', ')}`,
        ],
      });
    }
  }
}

/** Persist a new data_root into .aitriad.json. Caller should relaunch the app afterward. */
export function setDataRootPath(newRoot: string): void {
  const configPath = path.join(PROJECT_ROOT, '.aitriad.json');
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(configPath)) {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch { /* telemetry — silent by design;  start fresh */ }
  existing.data_root = newRoot;
  fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  _dataConfigCache = null; // invalidate — caller should relaunch
  console.log(`[fileIO] Updated .aitriad.json data_root → ${newRoot}`);
}

const _config = loadDataConfig();
const TAXONOMY_BASE = path.dirname(resolveDataPath(_config.taxonomy_dir));
let activeTaxonomyDir = resolveDataPath(_config.taxonomy_dir);
const CONFLICTS_DIR = resolveDataPath(_config.conflicts_dir);
const SUMMARIES_DIR = resolveDataPath(_config.summaries_dir);
const SOURCES_DIR_LEGACY = resolveDataPath(_config.sources_dir);

// eslint-disable-next-line @typescript-eslint/no-use-before-define -- function declaration is hoisted
export { PROJECT_ROOT, resolveDataPath, writeJsonFileAtomic };

export function getSourcesDir(): string | null {
  const config = loadDataConfig();
  if (config.sources_root) {
    const resolved = path.isAbsolute(config.sources_root)
      ? config.sources_root
      : path.resolve(PROJECT_ROOT, config.sources_root);
    if (fs.existsSync(resolved)) return resolved;
  }
  return fs.existsSync(SOURCES_DIR_LEGACY) ? SOURCES_DIR_LEGACY : null;
}
export function getSummariesDir(): string { return SUMMARIES_DIR; }

const POV_FILE_MAP: Record<string, string> = {
  accelerationist: 'accelerationist.json',
  safetyist: 'safetyist.json',
  skeptic: 'skeptic.json',
  // Situations migration: renderer uses 'situations' key, resolves to situations.json (or cross-cutting.json fallback)
  'situations': 'situations.json',
};

/** Resolve the situations/cross-cutting file — tries situations.json first, falls back to cross-cutting.json. */
export function resolveSituationsFilePath(): string {
  const sitPath = path.join(activeTaxonomyDir, 'situations.json');
  if (fs.existsSync(sitPath)) return sitPath;
  return path.join(activeTaxonomyDir, 'cross-cutting.json');
}

export function getTaxonomyDirs(): string[] {
  if (!fs.existsSync(TAXONOMY_BASE)) return [];
  return fs.readdirSync(TAXONOMY_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'schemas')
    .map(d => d.name);
}

export function getActiveTaxonomyDirName(): string {
  return path.basename(activeTaxonomyDir);
}

export function setActiveTaxonomyDir(dirName: string): void {
  assertSafeId(dirName, 'taxonomy directory name');
  const newDir = path.join(TAXONOMY_BASE, dirName);
  if (!fs.existsSync(newDir)) {
    throw new ActionableError({
      goal: 'Load taxonomy directory',
      problem: `Taxonomy directory not found: ${dirName}`,
      location: 'main/fileIO.ts → setActiveTaxonomyDir',
      nextSteps: [
        `Verify that the directory "${dirName}" exists under ${TAXONOMY_BASE}`,
        'Run getTaxonomyDirs() to list available taxonomy directories',
        'Check .aitriad.json data_root points to the correct data location',
      ],
    });
  }
  activeTaxonomyDir = newDir;
}

/** Parse JSON with diagnostic error messages that identify the problem and suggest a fix. */
function parseJsonFile(filePath: string): unknown {
  // Strip UTF-8 BOM if present — PowerShell's Set-Content writes BOM by default
  const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    const msg = err instanceof Error ? err.message : String(err);
    const basename = path.basename(filePath);
    // Diagnose the specific problem
    let diagnosis: string;
    if (raw.length === 0) {
      diagnosis = `${basename} is empty (0 bytes). It may have been truncated during a failed write.`;
    } else if (fs.existsSync(filePath + '.tmp')) {
      diagnosis = `${basename} appears corrupted and a .tmp file exists, indicating a write was interrupted. ` +
        `Try: rename ${basename}.tmp to ${basename} to recover the last successful write.`;
    } else if (!raw.trimStart().startsWith('{') && !raw.trimStart().startsWith('[')) {
      diagnosis = `${basename} does not start with {{ or [ — it may not be JSON. First 100 chars: "${raw.slice(0, 100)}"`;
    } else {
      diagnosis = `${basename} contains malformed JSON. It may have been hand-edited incorrectly or truncated. Parse error: ${msg}`;
    }
    throw new ActionableError({
      goal: 'Parse taxonomy data file',
      problem: diagnosis,
      location: `main/fileIO.ts → parseJsonFile(${path.basename(filePath)})`,
      nextSteps: [
        `Inspect the file at ${filePath} for syntax issues`,
        'If a .tmp file exists alongside it, rename .tmp to the original to recover the last good write',
        'Re-run the PowerShell pipeline to regenerate the file if it is corrupted',
      ],
      innerError: err,
    });
  }
}

/** Write JSON atomically: write to .tmp then rename, preventing corruption on crash/disk-full. */
/**
 * Atomically write an ALREADY-SERIALIZED string to `filePath` (tmp file →
 * renameSyncWithRetry), recording and surfacing a caller-named ActionableError on failure.
 * Shared by the generic pretty writer and the dedicated edges writer so the atomic +
 * flight-recorder semantics live in exactly one place (t/1942). `caller` names the entry
 * point so a failed edges write reports `writeEdgesFile`, not this helper (the Location
 * field must name the path actually taken — docs/error-handling.md).
 */
function writeStringAtomic(filePath: string, content: string, caller: string): void {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    renameSyncWithRetry(tmpPath, filePath, 7, undefined, recordLockHolder);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'Operation failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    // Clean up tmp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch { /* telemetry — silent by design;  ignore */ }
    throw new ActionableError({
      goal: 'Save taxonomy data',
      problem: `Failed to write ${path.basename(filePath)}`,
      location: `main/fileIO.ts → ${caller}(${path.basename(filePath)})`,
      nextSteps: [
        'Check that the target directory exists and is writable',
        'Verify there is enough free disk space',
        `Inspect the file at ${filePath} to confirm it is not locked by another process`,
      ],
      innerError: err,
    });
  }
}

/**
 * Write a value as 2-space pretty JSON with a single trailing newline, atomically. The
 * GENERIC writer for every taxonomy JSON file EXCEPT edges.json — edges use the hybrid
 * format via writeEdgesFile. Do not change this default (t/673: it would silently compact
 * nodes/situations/policy_actions/… and blow up the data-repo diff).
 */
function writeJsonFileAtomic(filePath: string, data: unknown): void {
  writeStringAtomic(filePath, JSON.stringify(data, null, 2) + '\n', 'writeJsonFileAtomic');
}

export function readTaxonomyFile(pov: string): unknown {
  // Situations migration: fall back to cross-cutting.json if situations.json doesn't exist
  if (pov === 'situations') {
    return parseJsonFile(resolveSituationsFilePath());
  }
  const filename = POV_FILE_MAP[pov];
  if (!filename) {
    throw new ActionableError({
      goal: 'Resolve taxonomy POV directory',
      problem: `Unknown POV: "${pov}"`,
      location: 'main/fileIO.ts → readTaxonomyFile',
      nextSteps: [
        `Use one of the known POV keys: ${Object.keys(POV_FILE_MAP).join(', ')}`,
        'Check the renderer is passing the correct POV identifier',
      ],
    });
  }
  return parseJsonFile(path.join(activeTaxonomyDir, filename));
}

const SYNTHETIC_POV_KEYS = new Set(['acc', 'saf', 'skp']);

export function loadSyntheticCorpus(pov: string): unknown | null {
  if (!SYNTHETIC_POV_KEYS.has(pov)) return null;
  const filePath = path.join(activeTaxonomyDir, 'synthetic', `corpus_${pov}.json`);
  if (!fs.existsSync(filePath)) return null;
  return parseJsonFile(filePath);
}

let _syntheticEmbeddingsCache: Record<string, { pov: string; vectors: number[][] }> | null = null;
let _syntheticEmbeddingsTaxDir: string | null = null;

export function loadSyntheticEmbeddings(): Record<string, { pov: string; vectors: number[][] }> | null {
  if (_syntheticEmbeddingsCache && _syntheticEmbeddingsTaxDir === activeTaxonomyDir) {
    return _syntheticEmbeddingsCache;
  }
  const synDir = path.join(activeTaxonomyDir, 'synthetic');
  const result: Record<string, { pov: string; vectors: number[][] }> = {};
  let found = false;

  for (const pov of SYNTHETIC_POV_KEYS) {
    const npyPath = path.join(synDir, `embeddings_${pov}.npy`);
    const idxPath = path.join(synDir, `index_${pov}.json`);
    if (!fs.existsSync(npyPath) || !fs.existsSync(idxPath)) continue;

    const npyBuf = fs.readFileSync(npyPath);
    const parsed = parseNpy(npyBuf);
    const index = JSON.parse(fs.readFileSync(idxPath, 'utf-8')) as Record<string, { start: number; count: number }>;
    Object.assign(result, extractNodeVectors(parsed, index, pov));
    found = true;
  }

  _syntheticEmbeddingsCache = found ? result : null;
  _syntheticEmbeddingsTaxDir = activeTaxonomyDir;
  return _syntheticEmbeddingsCache;
}

export function updateSyntheticEmbeddings(nodeId: string, pov: string, vectors: number[][]): void {
  const synDir = path.join(activeTaxonomyDir, 'synthetic');
  // mkdirSync({recursive:true}) is idempotent — no existsSync guard (js/file-system-race, t/2022).
  fs.mkdirSync(synDir, { recursive: true });
  const filePath = path.join(synDir, 'synthetic_embeddings.json');
  let file: { model: string; dimension: number; node_count: number; nodes: Record<string, { pov: string; vectors: number[][] }> };
  try {
    // Read directly rather than existsSync-then-read (TOCTOU, t/2022). Missing file (ENOENT) =
    // first write → start from the default; a CORRUPT existing file must rethrow, never silently
    // default-and-overwrite (which would clobber recoverable data).
    file = parseJsonFile(filePath) as typeof file;
  } catch (err) {
    /* telemetry — silent by design: ENOENT = no file yet (first write, a normal case, not an
       error); any other error is a genuine parse failure that parseJsonFile already recorded
       before throwing, so it is rethrown here with no duplicate record. */
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    file = { model: 'all-MiniLM-L6-v2', dimension: 384, node_count: 0, nodes: {} };
  }
  file.nodes[nodeId] = { pov, vectors };
  file.node_count = Object.keys(file.nodes).length;
  fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
  _syntheticEmbeddingsCache = file.nodes;
  _syntheticEmbeddingsTaxDir = activeTaxonomyDir;
}

export function readLineageCategories(): unknown {
  const filePath = path.join(activeTaxonomyDir, 'lineage_categories.json');
  if (!fs.existsSync(filePath)) return null;
  return parseJsonFile(filePath);
}

let lineageInfoCache: Record<string, unknown> | null = null;

export function readLineageEnrichments(): Record<string, unknown> {
  if (lineageInfoCache) return lineageInfoCache;
  const filePath = path.join(getDataRootPath(), 'calibration', 'core', 'lineage-enrichments.json');
  if (!fs.existsSync(filePath)) return {};
  try {
    const raw = parseJsonFile(filePath) as Record<string, { category?: string; description?: string; url?: string | null }>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(raw)) {
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
  } catch {
    /* telemetry — silent by design */
    return {};
  }
}

export function writeTaxonomyFile(pov: string, data: unknown): void {
  // Situations migration: write to whichever file currently exists (prefer situations.json)
  if (pov === 'situations') {
    writeJsonFileAtomic(resolveSituationsFilePath(), data);
    return;
  }
  const filename = POV_FILE_MAP[pov];
  if (!filename) {
    throw new ActionableError({
      goal: 'Resolve taxonomy POV directory',
      problem: `Unknown POV: "${pov}"`,
      location: 'main/fileIO.ts → writeTaxonomyFile',
      nextSteps: [
        `Use one of the known POV keys: ${Object.keys(POV_FILE_MAP).join(', ')}`,
        'Check the renderer is passing the correct POV identifier',
      ],
    });
  }
  writeJsonFileAtomic(path.join(activeTaxonomyDir, filename), data);
}

export function readPolicyRegistry(): unknown {
  const filePath = path.join(activeTaxonomyDir, 'policy_actions.json');
  if (!fs.existsSync(filePath)) return null;
  return parseJsonFile(filePath);
}

// t/4038: policy_actions.lock mirrors PowerShell's Enter-GroundingLock / Enter-PolicyRegistryLock
// (scripts/AITriad/Private/GroundingLock.ps1, PolicyRegistryCore.ps1, #2983) — same constants, same
// atomic-exclusive-create + poll + stale-break semantics, so the editor and PS `Update-PolicyRegistry
// -Fix` serialize against the SAME lockfile. Async (not PS's blocking Start-Sleep) because this runs
// on Electron's main process event loop.
const POLICY_LOCK_WAIT_MS = 60_000;
const POLICY_LOCK_STALE_MS = 120_000;
const POLICY_LOCK_POLL_MS = 500;

function policyRegistryLockPath(): string {
  return path.join(activeTaxonomyDir, 'policy_actions.lock');
}

/** Acquire policy_actions.lock. Returns the open handle, or null on a 60s timeout (caller maps
 *  that to `{ status: 'refused', reason: 'locked' }` — never throws for a plain timeout). */
export async function acquirePolicyRegistryLock(): Promise<fs.promises.FileHandle | null> {
  const lockPath = policyRegistryLockPath();
  const start = Date.now();
  let warnedStale = false;
  for (;;) {
    try {
      return await fs.promises.open(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* telemetry — silent by design; lock vanished between open and stat, retry immediately */ }
      if (age > POLICY_LOCK_STALE_MS) {
        if (!warnedStale) {
          warnedStale = true;
          getGlobalRecorder()?.record({
            type: 'system.error', component: 'file-io', level: 'warn',
            message: `acquirePolicyRegistryLock: breaking stale lock '${lockPath}' (mtime age ${Math.round(age / 1000)}s > ${POLICY_LOCK_STALE_MS / 1000}s — holder presumed dead)`,
            data: { lockPath, ageSeconds: Math.round(age / 1000) },
          });
        }
        try { fs.unlinkSync(lockPath); } catch { /* telemetry — silent by design; next loop retries the open or re-checks age */ }
        continue;
      }
      if (Date.now() - start >= POLICY_LOCK_WAIT_MS) return null;
      await new Promise((resolve) => setTimeout(resolve, POLICY_LOCK_POLL_MS));
    }
  }
}

export function releasePolicyRegistryLock(handle: fs.promises.FileHandle): void {
  handle.close().catch(() => { /* telemetry — silent by design; handle already invalid */ });
  try { fs.unlinkSync(policyRegistryLockPath()); } catch { /* telemetry — silent by design; already removed */ }
}

/** The one write path for policy_actions.json from TypeScript — takes the already-serialized
 *  string from lib/policy/registryRecount.ts's serializePolicyRegistry, so the editor and
 *  PowerShell never fight over formatting (e/264#7 point 3). */
export function writePolicyRegistryRaw(content: string): void {
  const filePath = path.join(activeTaxonomyDir, 'policy_actions.json');
  writeStringAtomic(filePath, content, 'writePolicyRegistryRaw');
}

// t/4054: pov-tag-proposals.json (t/4052) — absent file is a legitimate "nothing to review yet"
// state (null), not an error; a present-but-malformed file is the caller's problem to surface.
export function readPovTagProposals(): unknown {
  const filePath = path.join(activeTaxonomyDir, 'pov-tag-proposals.json');
  if (!fs.existsSync(filePath)) return null;
  return parseJsonFile(filePath);
}

// serializePovTagProposals is the one serializer (lib/schema/povTagProposals.ts) — byte-identical
// to the committed file — so desktop and the server route never fight over formatting (t/4052).
export function writePovTagProposals(file: PovTagProposalsFile): void {
  const filePath = path.join(activeTaxonomyDir, 'pov-tag-proposals.json');
  writeStringAtomic(filePath, serializePovTagProposals(file), 'writePovTagProposals');
}

export function readAggregatedCruxes(): unknown | null {
  const filePath = path.join(activeTaxonomyDir, 'aggregated-cruxes.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonFile(filePath);
  } catch { /* telemetry — silent by design */ return null; }
}

export function readConflictClusters(): unknown | null {
  const filePath = path.join(CONFLICTS_DIR, '_conflict-clusters.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return parseJsonFile(filePath);
  } catch { /* telemetry — silent by design */ return null; }
}

// Conflicts are stored in a single consolidated file (schema v2.0) rather than
// one file per claim. Mirrors the server fileIO contract but synchronous.
const CONFLICTS_FILE = path.join(CONFLICTS_DIR, 'conflicts.json');

interface ConflictsWrapper {
  _schema_version: string;
  last_modified: string;
  conflict_count: number;
  conflicts: Record<string, unknown>[];
  [k: string]: unknown;
}

function getClaimId(conflict: unknown): string | undefined {
  return (conflict as { claim_id?: string } | null)?.claim_id;
}

/** Read the consolidated conflicts.json wrapper. Returns null if absent. Throws ActionableError on corrupt JSON. */
function readConflictsWrapper(): ConflictsWrapper | null {
  if (!fs.existsSync(CONFLICTS_FILE)) return null;
  const parsed = parseJsonFile(CONFLICTS_FILE) as ConflictsWrapper;
  if (!parsed || !Array.isArray(parsed.conflicts)) return null;
  return parsed;
}

/** Persist the conflicts array back to conflicts.json, refreshing wrapper metadata (preserves extra fields like _doc). */
function writeConflictsWrapper(wrapper: ConflictsWrapper): void {
  if (!fs.existsSync(CONFLICTS_DIR)) {
    fs.mkdirSync(CONFLICTS_DIR, { recursive: true });
  }
  const out: ConflictsWrapper = {
    ...wrapper,
    _schema_version: wrapper._schema_version ?? '2.0',
    last_modified: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    conflict_count: wrapper.conflicts.length,
    conflicts: wrapper.conflicts,
  };
  writeJsonFileAtomic(CONFLICTS_FILE, out);
}

export function readAllConflictFiles(): unknown[] {
  try {
    const wrapper = readConflictsWrapper();
    return wrapper ? wrapper.conflicts : [];
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'error',
      message: 'Failed to read conflicts.json',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.warn('[fileIO] Failed to read conflicts.json:', err);
    return [];
  }
}

export function writeConflictFile(claimId: string, data: unknown): void {
  const wrapper = readConflictsWrapper();
  if (!wrapper) {
    throw new ActionableError({
      goal: 'Update conflict definition',
      problem: `conflicts.json not found or unreadable in ${CONFLICTS_DIR}`,
      location: 'main/fileIO.ts → writeConflictFile',
      nextSteps: [
        `Verify that conflicts.json exists in ${CONFLICTS_DIR}`,
        'Re-run the consolidation pipeline to regenerate conflicts.json',
      ],
    });
  }
  const idx = wrapper.conflicts.findIndex(c => getClaimId(c) === claimId);
  if (idx === -1) {
    throw new ActionableError({
      goal: 'Update conflict definition',
      problem: `Conflict not found: ${claimId}`,
      location: 'main/fileIO.ts → writeConflictFile',
      nextSteps: [
        `Verify that a conflict with claim_id "${claimId}" exists in conflicts.json`,
        'Use createConflictFile() to create a new conflict instead of writeConflictFile()',
        'Run readAllConflictFiles() to list available conflicts',
      ],
    });
  }
  wrapper.conflicts[idx] = data as Record<string, unknown>;
  writeConflictsWrapper(wrapper);
}

export function createConflictFile(claimId: string, data: unknown): void {
  const wrapper = readConflictsWrapper() ?? {
    _schema_version: '2.0',
    last_modified: '',
    conflict_count: 0,
    conflicts: [],
  };
  if (wrapper.conflicts.some(c => getClaimId(c) === claimId)) {
    throw new ActionableError({
      goal: 'Create conflict definition',
      problem: `Conflict already exists: ${claimId}`,
      location: 'main/fileIO.ts → createConflictFile',
      nextSteps: [
        `Use writeConflictFile() to update the existing conflict "${claimId}"`,
        'Delete the existing conflict first if you intend to replace it',
      ],
    });
  }
  wrapper.conflicts.push(data as Record<string, unknown>);
  writeConflictsWrapper(wrapper);
}

export function deleteConflictFile(claimId: string): void {
  const wrapper = readConflictsWrapper();
  if (!wrapper) {
    throw new ActionableError({
      goal: 'Delete conflict definition',
      problem: `conflicts.json not found or unreadable in ${CONFLICTS_DIR}`,
      location: 'main/fileIO.ts → deleteConflictFile',
      nextSteps: [
        `Verify that conflicts.json exists in ${CONFLICTS_DIR}`,
        'The conflict may have already been removed — check if the operation can be skipped',
      ],
    });
  }
  const before = wrapper.conflicts.length;
  wrapper.conflicts = wrapper.conflicts.filter(c => getClaimId(c) !== claimId);
  if (wrapper.conflicts.length === before) {
    throw new ActionableError({
      goal: 'Delete conflict definition',
      problem: `Conflict not found: ${claimId}`,
      location: 'main/fileIO.ts → deleteConflictFile',
      nextSteps: [
        `Verify that a conflict with claim_id "${claimId}" exists in conflicts.json`,
        'The conflict may have already been removed — check if the operation can be skipped',
      ],
    });
  }
  writeConflictsWrapper(wrapper);
}

// ── Summaries & Sources ──

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

export function discoverSources(): DiscoveredSource[] {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return [];
  const summariesDir = resolveDataPath(loadDataConfig().summaries_dir);

  const sources: DiscoveredSource[] = [];
  for (const entry of fs.readdirSync(sourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(sourcesDir, entry.name, 'metadata.json');
    try {
      if (!fs.existsSync(metaPath)) continue;
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const summaryPath = path.join(summariesDir, `${entry.name}.json`);
      sources.push({
        id: entry.name,
        title: meta.title || entry.name,
        url: meta.url || null,
        sourceType: meta.source_type || 'unknown',
        datePublished: meta.date_published || meta.source_time || '',
        dateIngested: meta.date_ingested || '',
        hasSummary: fs.existsSync(summaryPath),
        tags: meta.pov_tags || [],
        authors: meta.authors || [],
      });
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return sources.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
}

export function loadSummary(docId: string): unknown | null {
  const config = loadDataConfig();
  const summariesDir = resolveDataPath(config.summaries_dir);
  const filePath = path.join(summariesDir, `${docId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'warn',
      message: `loadSummary: failed to read/parse summary for ${docId} — returning null`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export function loadSnapshot(sourceId: string): string | null {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return null;
  const filePath = path.join(sourcesDir, sourceId, 'snapshot.md');
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'file-io',
      level: 'warn',
      message: `loadSnapshot: failed to read snapshot for ${sourceId} — returning null`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

// ── Source document resolution ──
// Electron (sync) mirror of server/fileIO.ts `resolveSourceDocument`. Keep the
// precedence rules below in sync with the server twin. The only intentional
// divergence: PDFs resolve to a local absolute file path here (the renderer
// loads it directly via pdfjs) rather than the server's `/api/.../file` URL.

/** Result of resolving a fact's `doc_id` to an actual source document. */
export interface SourceDocumentResolution {
  available: boolean;
  type: 'pdf' | 'markdown' | null;
  /** Inline markdown content (markdown type only). */
  content?: string;
  /** Absolute local path to the document (pdf type only). */
  path?: string;
}

/** Find the raw PDF inside a source's `raw/` directory. Returns absolute path or null. */
function findRawPdfPath(docId: string): string | null {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return null;
  const rawDir = path.join(sourcesDir, docId, 'raw');
  if (!fs.existsSync(rawDir)) return null;
  const pdf = fs.readdirSync(rawDir).find(e => e.toLowerCase().endsWith('.pdf'));
  return pdf ? path.join(rawDir, pdf) : null;
}

/**
 * Resolve a source document by id. Determines whether the document exists and
 * returns its content (markdown) or a local path to fetch it (PDF).
 *
 * Resolution order (mirrors server/fileIO.ts):
 *   1. metadata source_type 'pdf' (or no markdown snapshot present) + a raw PDF → pdf
 *   2. snapshot.md present → markdown (content inline)
 *   3. a raw PDF present without snapshot → pdf
 *   4. otherwise → { available: false }
 */
export function resolveSourceDocument(docId: string): SourceDocumentResolution {
  const sourcesDir = getSourcesDir();
  if (!sourcesDir) return { available: false, type: null };

  const docDir = path.join(sourcesDir, docId);

  // Read metadata best-effort to learn the original document type.
  let sourceType = '';
  try {
    const metaPath = path.join(docDir, 'metadata.json');
    if (fs.existsSync(metaPath)) {
      sourceType = String(JSON.parse(fs.readFileSync(metaPath, 'utf-8')).source_type ?? '').toLowerCase();
    }
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

  const pdfPath = findRawPdfPath(docId);
  const snapshot = loadSnapshot(docId);

  // Prefer the PDF when the source is a PDF, or when no markdown snapshot exists.
  if (pdfPath && (sourceType === 'pdf' || snapshot === null)) {
    return { available: true, type: 'pdf', path: pdfPath };
  }
  if (snapshot !== null) {
    return { available: true, type: 'markdown', content: snapshot };
  }
  if (pdfPath) {
    return { available: true, type: 'pdf', path: pdfPath };
  }
  return { available: false, type: null };
}

export function readEdgesFile(): unknown | null {
  const edgesPath = path.join(activeTaxonomyDir, 'edges.json');
  if (!fs.existsSync(edgesPath)) return null;
  return parseJsonFile(edgesPath);
}

/**
 * Read the entity registry (ent-* records) from entities.json in the active
 * taxonomy dir — the desktop mirror of the server's readEntities (t/1807). The
 * file wraps its records under `{ entities: [...] }`; entities.json is static,
 * pipeline-curated data (no desktop write path). Returns [] when the file is
 * absent OR malformed — never throws — so the list-entities path (t/1889) degrades
 * to an empty browser instead of crashing.
 */
export function readEntities(): Entity[] {
  const entitiesPath = path.join(activeTaxonomyDir, 'entities.json');
  if (!fs.existsSync(entitiesPath)) return [];
  try {
    const data = parseJsonFile(entitiesPath) as { entities?: Entity[] } | null;
    return data?.entities ?? [];
  } catch (err) {
    // parseJsonFile already logged the parse failure; this records the recovery
    // decision (list-entities degrades to an empty browser) so the swallow is
    // visible in a flight-recorder dump (ADR-003).
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'main-file-io',
      level: 'warn',
      message: 'readEntities: entities.json could not be parsed; returning empty entity list',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return [];
  }
}

/**
 * Read the extracted entity mentions for one container from entity_mentions.json in
 * the active taxonomy dir — the desktop mirror of the server's readContainerMentions
 * (t/1903 mention read path). entity_mentions.json is a DERIVED, rebuildable artifact:
 * an absent file OR an absent container both mean "no links yet", never an error → null.
 * A malformed file also degrades to null (recording the recovery per ADR-003) so mention
 * rendering never crashes.
 */
export function readContainerMentions(containerId: string): ContainerMentions | null {
  const mentionsPath = path.join(activeTaxonomyDir, 'entity_mentions.json');
  if (!fs.existsSync(mentionsPath)) return null;
  try {
    const file = parseJsonFile(mentionsPath) as EntityMentionsFile | null;
    return file?.containers?.[containerId] ?? null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'main-file-io',
      level: 'warn',
      message: 'readContainerMentions: entity_mentions.json could not be parsed; returning null',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export function writeEdgesFile(data: unknown): void {
  const edgesPath = path.join(activeTaxonomyDir, 'edges.json');
  // edges.json uses the shared HYBRID format (t/673, docs/edges-json-format.md) so the
  // desktop and web writers stay byte-identical and don't churn the 14 MB file on every
  // build alternation. serializeEdgesJson supplies its own single trailing newline — do
  // NOT add `+ '\n'`. Mirrors the server's writeFile(getEdgesPath(), serializeEdgesJson(data)).
  writeStringAtomic(edgesPath, serializeEdgesJson(data), 'writeEdgesFile');
}

// ── Node ↔ Source reverse index ──────────────────────────────────────────────

// t/4341: re-exports the shared type (lib/sourceIndex/types.ts) rather than a local
// redeclaration, so adding canonicalDocId here is structural parity with the server's
// identically-shaped SourceReference (src/server/storage/nodeSourceIndex.ts), not just a
// same-looking interface that could drift.
export type SourceReference = SharedSourceReference;

// t/4342: re-exports the shared card shape (lib/sourceIndex/types.ts) — same parity
// rationale as SourceReference above, with the server's SourceCardMeta (nodeSourceIndex.ts).
export type SourceCardMeta = SharedSourceCardMeta;

export type NodeSourceIndex = Record<string, SourceReference[]>;

/**
 * Scan all summary JSON files and build a reverse index:
 * nodeId → list of source references that mapped to it.
 * Also loads source metadata for titles/URLs.
 */
// Shape of a source's metadata.json (only the fields the index builders read).
type SourceMetaJson = {
  title?: string; url?: string; source_type?: string;
  date_published?: string; source_time?: string; date_ingested?: string;
  authors?: string[]; topic_tags?: string[]; one_liner?: string;
  // t/4349: source-identity fields (docs/specs/source-identity.md, t/4344).
  resolved_url?: string; provenance?: SourceIdentityMeta['provenance'];
  content_sha256?: string; same_as?: string; parent_doc_id?: string;
  duplicate_of?: string; // t/4377 (spec section 6)
};

/**
 * Scan the sources dir once, mapping each source's parsed `metadata.json` via `mapMeta`
 * to a value keyed by source name. Missing dir / missing / malformed metadata are
 * skipped. Shared by the node- and policy-source index builders (t/1914 complexity split).
 */
function loadSourceMetadata<T>(mapMeta: (meta: SourceMetaJson, name: string) => T): Record<string, T> {
  const out: Record<string, T> = {};
  const srcDir = getSourcesDir();
  if (!srcDir) return out;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(srcDir, entry.name, 'metadata.json');
    try {
      if (fs.existsSync(metaPath)) {
        out[entry.name] = mapMeta(JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SourceMetaJson, entry.name);
      }
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return out;
}

type NodeSourceMeta = {
  title: string; url: string | null; sourceType: string; datePublished: string;
  authors: string[]; topicTags: string[]; oneLiner: string | null;
};
type SummaryFile = {
  pov_summaries?: Record<string, {
    key_points?: Array<{
      taxonomy_node_id?: string | null;
      point?: string; stance?: string; verbatim?: string; excerpt_context?: string;
    }>;
  }>;
};

/** Index one summary file's key-points into the node→source index (mutates `index`).
 *  Extracted verbatim from buildNodeSourceIndex's inner pov/key-point loops (t/1914). */
function indexSummaryKeyPoints(index: NodeSourceIndex, docId: string, meta: NodeSourceMeta, summary: SummaryFile): void {
  for (const [pov, povData] of Object.entries(summary.pov_summaries || {})) {
    for (const kp of povData.key_points || []) {
      const nodeId = kp.taxonomy_node_id;
      if (!nodeId) continue;
      if (!index[nodeId]) index[nodeId] = [];
      index[nodeId].push({
        docId,
        // t/4341: placeholder, overwritten by applyCanonicalDocIds below (mirrors the
        // server's indexSummaryFile — canonicalDocId needs the FULL known-doc-id set to
        // resolve tiers 2-4, which isn't available yet mid-scan).
        canonicalDocId: docId,
        title: meta.title,
        pov,
        stance: kp.stance || 'neutral',
        point: kp.point || '',
        verbatim: kp.verbatim || '',
        excerptContext: kp.excerpt_context || '',
        url: meta.url,
        sourceType: meta.sourceType,
        datePublished: meta.datePublished,
      });
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** Spec section 4.0: a doc with no *recorded* `content_sha256` gets a *computed* one from
 *  `snapshot.md`, mirroring the server's computeSnapshotHash (src/server/storage/
 *  nodeSourceIndex.ts) minus its persisted blob-sha cache — that cache exists only to avoid
 *  re-normalizing on every request against a remote storage backend; Electron reads the
 *  local filesystem directly and only computes this once per buildNodeSourceIndex call. */
function computeElectronSnapshotHash(docId: string): string | null {
  const snapshot = loadSnapshot(docId);
  if (snapshot === null) return null;
  return computeSourceContentHash(snapshot, sha256Hex);
}

function buildIdentityMetaFromRawJson(meta: SourceMetaJson): SourceIdentityMeta {
  return {
    title: meta.title ?? null,
    url: meta.url ?? null,
    resolved_url: meta.resolved_url ?? null,
    provenance: Array.isArray(meta.provenance) ? meta.provenance : [],
    content_sha256: meta.content_sha256 ?? null,
    same_as: meta.same_as ?? null,
    parent_doc_id: meta.parent_doc_id ?? null,
    duplicate_of: meta.duplicate_of ?? null, // t/4377 (spec section 6)
  };
}

/** t/4349: scans the sources dir once, building both the card-metadata cache and the
 *  source-identity metadata (+ computed snapshot hash when no recorded one exists) — the
 *  Electron-side twin of the server's loadNodeMetaCache (src/server/storage/
 *  nodeSourceIndex.ts), so canonical grouping reads the same `metadata.json` fields the
 *  server reads, not just `{url, title}` (t/4334#11 condition 2). */
function loadSourceMetaAndIdentity(): {
  metaCache: Record<string, NodeSourceMeta>;
  identityMeta: Record<string, SourceIdentityMeta>;
  snapshotHashes: Record<string, string | null>;
} {
  const metaCache: Record<string, NodeSourceMeta> = {};
  const identityMeta: Record<string, SourceIdentityMeta> = {};
  const snapshotHashes: Record<string, string | null> = {};
  const srcDir = getSourcesDir();
  if (!srcDir) return { metaCache, identityMeta, snapshotHashes };

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(srcDir, entry.name, 'metadata.json');
    try {
      if (!fs.existsSync(metaPath)) continue;
      const raw = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SourceMetaJson;
      metaCache[entry.name] = {
        title: raw.title || entry.name,
        url: raw.url || null,
        sourceType: raw.source_type || 'unknown',
        datePublished: raw.date_published || raw.source_time || '',
        authors: Array.isArray(raw.authors) ? raw.authors : [],
        topicTags: Array.isArray(raw.topic_tags) ? raw.topic_tags : [],
        oneLiner: raw.one_liner || null,
      };
      const identity = buildIdentityMetaFromRawJson(raw);
      identityMeta[entry.name] = identity;
      snapshotHashes[entry.name] = identity.content_sha256 ? null : computeElectronSnapshotHash(entry.name);
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return { metaCache, identityMeta, snapshotHashes };
}

/** t/4377 (spec section 6.3), ported verbatim from the server's identically-named helper
 *  (src/server/storage/nodeSourceIndex.ts): a `duplicate_of`-marked entry (`resolved[docId]
 *  !== docId`) is dropped whenever its resolved id already has its own, unmarked entry in
 *  this node's list — "a duplicate pair gives one evidence unit, not two" (SO condition C2).
 *  When no unmarked entry exists for that id (only the mark cites this node), exactly one
 *  marked entry survives instead of vanishing, re-attributed to the resolved id using its
 *  own card metadata when known. Unmarked entries, and grouping-only duplicates with no
 *  mark (e.g. split parts), are never touched — only a mark changes row count. */
function dedupeByResolvedId(
  index: NodeSourceIndex, resolved: Record<string, string>, metaCache: Record<string, NodeSourceMeta>,
): void {
  for (const [nodeId, refs] of Object.entries(index)) {
    const hasOwnEntry = new Set(refs.filter(r => (resolved[r.docId] ?? r.docId) === r.docId).map(r => r.docId));
    const seenViaMark = new Set<string>();
    const kept: SourceReference[] = [];
    for (const r of refs) {
      const resolvedId = resolved[r.docId] ?? r.docId;
      if (resolvedId === r.docId) { kept.push(r); continue; }
      if (hasOwnEntry.has(resolvedId) || seenViaMark.has(resolvedId)) continue;
      seenViaMark.add(resolvedId);
      const target = metaCache[resolvedId];
      kept.push({
        ...r, docId: resolvedId, canonicalDocId: resolvedId,
        title: target?.title ?? r.title, url: target?.url ?? r.url,
      });
    }
    index[nodeId] = kept;
  }
}

/** t/4341/t/4349/t/4377: fills in canonicalDocId (set to each ref's own docId by
 *  indexSummaryKeyPoints) using the shared source-identity algorithm — mirrors the server's
 *  applyCanonicalDocIds (src/server/storage/nodeSourceIndex.ts) so both builds group
 *  identically for the same data. Every doc under the sources dir participates (not just
 *  docs cited by a summary today) — a `duplicate_of` target otherwise cited by nothing would
 *  wrongly validate as `missing_target` (t/4377, same fix as server-side #3590), and a split
 *  part reachable only via one node still resolves against the full known-id set. Also
 *  applies t/4377's section 6: a valid `duplicate_of` mark collapses that node's two evidence
 *  rows into one (`dedupeByResolvedId`), attributed to the resolved id. Returns the
 *  title-collision (spec 4.5) and duplicate-of-error (spec 6.1) reports for the caller to
 *  log — both are signals for a human, never applied as a merge. */
function applyCanonicalDocIds(
  index: NodeSourceIndex, identityMeta: Record<string, SourceIdentityMeta>, snapshotHashes: Record<string, string | null>,
  metaCache: Record<string, NodeSourceMeta>,
): { titleCollisions: string[][]; duplicateOfErrorCount: number } {
  const allDocIds = new Set<string>(Object.keys(identityMeta));
  for (const refs of Object.values(index)) for (const r of refs) allDocIds.add(r.docId);
  const docs: SourceIdentityDoc[] = [...allDocIds].map(id => ({
    id,
    metadata: identityMeta[id] ?? { title: id },
    snapshotSha256: snapshotHashes[id] ?? null,
  }));
  const { canonical, titleCollisions, resolved, duplicateOfErrors } = groupSourceIdentities(docs);
  for (const refs of Object.values(index)) {
    for (const r of refs) r.canonicalDocId = canonical[r.docId] ?? r.docId;
  }
  dedupeByResolvedId(index, resolved, metaCache);
  if (duplicateOfErrors.length > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `buildNodeSourceIndex: ${duplicateOfErrors.length} invalid duplicate_of mark(s) found (treated as absent)`,
      data: { duplicateOfErrors },
    });
  }
  return { titleCollisions, duplicateOfErrorCount: duplicateOfErrors.length };
}

/** Shared by `buildNodeSourceIndex` and `getNodeSources` (t/4342) so the per-node lookup
 *  doesn't re-scan the sources dir a second time for card metadata. */
function buildNodeSourceIndexWithMeta(): { index: NodeSourceIndex; metaCache: Record<string, NodeSourceMeta> } {
  const index: NodeSourceIndex = {};

  if (!fs.existsSync(SUMMARIES_DIR)) return { index, metaCache: {} };

  // Pre-load source metadata for titles/URLs, plus the full source-identity metadata.
  const { metaCache, identityMeta, snapshotHashes } = loadSourceMetaAndIdentity();

  // Scan all summary files
  for (const file of fs.readdirSync(SUMMARIES_DIR)) {
    if (!file.endsWith('.json')) continue;
    const docId = file.replace(/\.json$/, '');

    let summary: SummaryFile;
    try {
      summary = JSON.parse(fs.readFileSync(path.join(SUMMARIES_DIR, file), 'utf-8'));
    } catch { /* telemetry — silent by design */ continue; }

    const meta = metaCache[docId] || { title: docId, url: null, sourceType: 'unknown', datePublished: '', authors: [], topicTags: [], oneLiner: null };
    indexSummaryKeyPoints(index, docId, meta, summary);
  }

  const { titleCollisions } = applyCanonicalDocIds(index, identityMeta, snapshotHashes, metaCache);
  if (titleCollisions.length > 0) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `buildNodeSourceIndex: ${titleCollisions.length} title collision(s) found (no merge applied, human review needed)`,
      data: { titleCollisions },
    });
  }
  return { index, metaCache };
}

export function buildNodeSourceIndex(): NodeSourceIndex {
  return buildNodeSourceIndexWithMeta().index;
}

/** One source card per canonical document, same shape/fallback order as the server's
 *  identically-named helper (src/server/storage/nodeSourceIndex.ts:cardMetaFor) — kept as
 *  its own function rather than inlined so getNodeSources stays under the complexity
 *  budget (t/4342, CI: local/complexity-budget). */
function cardMetaFor(ref: SourceReference, metaCache: Record<string, NodeSourceMeta>): SourceCardMeta {
  const m = metaCache[ref.docId] ?? metaCache[ref.canonicalDocId];
  return {
    title: m?.title ?? ref.title,
    url: m?.url ?? ref.url,
    authors: m?.authors ?? [],
    datePublished: m?.datePublished ?? ref.datePublished,
    topicTags: m?.topicTags ?? [],
    oneLiner: m?.oneLiner ?? null,
  };
}

/** One card per canonical document referenced by `sources`, not one per reference —
 *  extracted from getNodeSources alongside cardMetaFor for the same complexity-budget
 *  reason. */
function buildCardsForSources(sources: SourceReference[], metaCache: Record<string, NodeSourceMeta>): Record<string, SourceCardMeta> {
  const cards: Record<string, SourceCardMeta> = {};
  for (const ref of sources) {
    if (!cards[ref.canonicalDocId]) cards[ref.canonicalDocId] = cardMetaFor(ref, metaCache);
  }
  return cards;
}

/**
 * t/4342 — Electron-side equivalent of the server's per-node lookup
 * (src/server/storage/nodeSourceIndex.ts:getNodeSources). No build-once cache on this
 * side yet (unlike the server's invalidate-on-listing-change cache) — each call re-scans,
 * mirroring the existing uncached `buildNodeSourceIndex` IPC handler; `indexVersion` is
 * therefore always 0 (nothing to compare it against yet on this leg).
 */
export function getNodeSources(nodeId: string): { sources: SourceReference[]; cards: Record<string, SourceCardMeta>; indexVersion: number } {
  const { index, metaCache } = buildNodeSourceIndexWithMeta();
  const sources = index[nodeId] ?? [];
  const cards = buildCardsForSources(sources, metaCache);
  return { sources, cards, indexVersion: 0 };
}

// ── Policy ↔ Source reverse index ─────────────────────────────────────────────

export interface PolicySourceReference {
  docId: string;
  title: string;
  dateIngested: string;
  sourceTime: string;
  stance: string;
  nodeId: string;
  pov: string;
}

export type PolicySourceIndex = Record<string, PolicySourceReference[]>;

/**
 * For each policy in policy_actions.json, find all nodes that reference it
 * (by scanning policy_actions in POV files), then use the node-source index
 * to find which sources reference those nodes.
 * Returns policyId → list of source references.
 */
/** Scan all non-situation POV files for node→policy_id references. Extracted verbatim
 *  from buildPolicySourceIndex step 2 (t/1914 complexity split). */
function buildNodePolicyMap(): Map<string, string[]> {
  const nodeToPolicies = new Map<string, string[]>();
  for (const pov of Object.keys(POV_FILE_MAP)) {
    if (pov === 'situations') continue;
    try {
      const file = readTaxonomyFile(pov) as { nodes?: Array<{ id: string; graph_attributes?: { policy_actions?: { policy_id?: string }[] } }> };
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

export function buildPolicySourceIndex(): PolicySourceIndex {
  const result: PolicySourceIndex = {};

  // 1. Load policy registry to get all policy IDs
  const regRaw = readPolicyRegistry() as { policies?: { id: string }[] } | null;
  if (!regRaw?.policies) return result;
  for (const pol of regRaw.policies) {
    result[pol.id] = [];
  }

  // 2. Build node → policy mapping by scanning all POV files
  const nodeToPolicies = buildNodePolicyMap();

  // 3. Build or reuse the node-source index
  const nodeSourceIdx = buildNodeSourceIndex();

  // 4. Pre-load source metadata for dateIngested / sourceTime
  const metaCache = loadSourceMetadata((meta) => ({
    dateIngested: meta.date_ingested || meta.date_published || '',
    sourceTime: meta.source_time || '',
  }));

  // 5. For each node that has sources, map those sources to the node's policies
  for (const [nodeId, policyIds] of nodeToPolicies) {
    const sourceRefs = nodeSourceIdx[nodeId];
    if (!sourceRefs) continue;

    for (const polId of policyIds) {
      if (!result[polId]) result[polId] = [];
      for (const ref of sourceRefs) {
        const meta = metaCache[ref.docId] || { dateIngested: ref.datePublished, sourceTime: '' };
        result[polId].push({
          docId: ref.docId,
          title: ref.title,
          dateIngested: meta.dateIngested,
          sourceTime: meta.sourceTime,
          stance: ref.stance,
          nodeId,
          pov: ref.pov,
        });
      }
    }
  }

  return result;
}

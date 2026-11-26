// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { AiSettings, PromptOverrides } from './analysisTypes.js';
import { ActionableError } from '../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { DEFAULT_MODEL, loadModelRegistry } from '../../../lib/ai-client/index.js';
import { app } from 'electron';
import { resolveRepoRootForApp } from '../../../lib/electron-shared/resolveRepoRootForApp.js';
import { assertSafeId, assertContainedIn } from '../../../lib/electron-shared/safeId.js';

// Repo root via the shared electron resolver (walks to .aitriad.json/scripts/AITriad,
// falls back to the packaged app path — the asar hardening the t/1720 comment flagged
// as a follow-up). Was a local findProjectRoot with a weak ../../.. fallback (t/1721).
const PROJECT_ROOT = resolveRepoRootForApp(__dirname, path.dirname(app.getAppPath()));
const CONFIG_DIR = path.join(os.homedir(), '.poviewer');

const TAXONOMY_BASE = path.join(PROJECT_ROOT, 'taxonomy');
let activeTaxonomyDir = path.join(TAXONOMY_BASE, 'Origin');
function resolveSourcesDir(): string {
  // Priority: env var > sources_root in .aitriad.json > PROJECT_ROOT/sources
  // Note: sources_root points directly to the directory containing source folders
  // (not a parent that contains a sources/ subdirectory)
  const envRoot = process.env.AI_TRIAD_SOURCES_ROOT;
  if (envRoot) {
    return path.isAbsolute(envRoot) ? envRoot : path.resolve(PROJECT_ROOT, envRoot);
  }
  try {
    const configPath = path.join(PROJECT_ROOT, '.aitriad.json');
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''));
      if (raw.sources_root) {
        return path.isAbsolute(raw.sources_root) ? raw.sources_root : path.resolve(PROJECT_ROOT, raw.sources_root);
      }
    }
  } catch { /* fall through */ /* telemetry — silent by design */ }
  return path.join(PROJECT_ROOT, 'sources');
}
const SOURCES_DIR = resolveSourcesDir();
const SOURCES_ROOT_RESOLVED = path.resolve(SOURCES_DIR);

// t/2534 (M6/M8pov): validate a renderer-supplied source ID and resolve its
// directory, guaranteeing the result stays inside SOURCES_DIR. assertSafeId
// rejects traversal tokens (`..`, separators, absolute paths) up front;
// assertContainedIn is the defense-in-depth backstop after path.resolve.
function resolveSourceDirSafe(sourceId: string): string {
  assertSafeId(sourceId, 'sourceId');
  const dir = path.resolve(SOURCES_DIR, sourceId);
  assertContainedIn(dir, SOURCES_ROOT_RESOLVED);
  return dir;
}

export function getSourcesRoot(): string {
  return SOURCES_DIR;
}
const SETTINGS_PATH = path.join(PROJECT_ROOT, 'poviewer', 'settings.json');
const AI_SETTINGS_PATH = path.join(CONFIG_DIR, 'ai-settings.json');
const PROMPTS_PATH = path.join(CONFIG_DIR, 'prompts.json');

const POV_FILE_MAP: Record<string, string> = {
  accelerationist: 'accelerationist.json',
  safetyist: 'safetyist.json',
  skeptic: 'skeptic.json',
  'situations': 'situations.json',
};

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
  // t/2534 (M9pov): dirName is renderer-supplied (picked from getTaxonomyDirs());
  // reject traversal tokens and confine the result to TAXONOMY_BASE.
  assertSafeId(dirName, 'dirName');
  const newDir = path.resolve(TAXONOMY_BASE, dirName);
  assertContainedIn(newDir, path.resolve(TAXONOMY_BASE));
  if (!fs.existsSync(newDir)) {
    throw new ActionableError({
      goal: 'Switch active taxonomy directory',
      problem: `Taxonomy directory not found: ${dirName}`,
      location: 'fileIO.ts:setActiveTaxonomyDir',
      nextSteps: [
        `Create the directory at taxonomy/${dirName}/ with the required POV JSON files`,
        'Run getTaxonomyDirs() to see available taxonomy directories',
        'Check for typos in the directory name',
      ],
    });
  }
  activeTaxonomyDir = newDir;
}

export function readTaxonomyFile(pov: string): unknown {
  const filename = POV_FILE_MAP[pov];
  if (!filename) {
    throw new ActionableError({
      goal: 'Read taxonomy file for a point-of-view',
      problem: `Unknown POV: "${pov}"`,
      location: 'fileIO.ts:readTaxonomyFile',
      nextSteps: [
        `Use one of the valid POV keys: ${Object.keys(POV_FILE_MAP).join(', ')}`,
        'Check the caller to ensure the POV value is not misspelled or undefined',
      ],
    });
  }
  const filePath = path.join(activeTaxonomyDir, filename);
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

export function readSnapshot(sourceId: string): string {
  const filePath = path.join(resolveSourceDirSafe(sourceId), 'snapshot.md');
  if (!fs.existsSync(filePath)) {
    throw new ActionableError({
      goal: 'Read snapshot markdown for a source document',
      problem: `Snapshot not found for source: ${sourceId}`,
      location: 'fileIO.ts:readSnapshot',
      nextSteps: [
        `Verify that sources/${sourceId}/snapshot.md exists`,
        'Re-ingest the source using the import pipeline to generate the snapshot',
        'Check that the sourceId matches a directory under sources/',
      ],
    });
  }
  return fs.readFileSync(filePath, 'utf-8');
}

export function loadSettings(): unknown {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return {};
  }
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
  return JSON.parse(raw);
}

export function saveSettings(data: unknown): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export interface SourceMetadataOnDisk {
  id: string;
  title: string;
  sourceType: string;
  url: string | null;
  addedAt: string;
  status: string;
}

export function createSourceOnDisk(meta: SourceMetadataOnDisk): void {
  // t/2534 (M7): meta.id is renderer-supplied — validate at the write site too
  // (the IPC handler's Zod schema is the first line of defense).
  assertSafeId(meta.id, 'meta.id');
  const sourceDir = resolveSourceDirSafe(meta.id);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(sourceDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(sourceDir, 'metadata.json'),
    JSON.stringify(meta, null, 2) + '\n',
    'utf-8',
  );
  const snapshotPath = path.join(sourceDir, 'snapshot.md');
  // Atomic exclusive create: the 'wx' flag fails with EEXIST if the file already
  // exists, eliminating the check-then-write TOCTOU race that an existsSync guard
  // introduces (CodeQL js/file-system-race). Preserves the original intent —
  // create an empty snapshot only when one isn't already present, never clobber.
  try {
    fs.writeFileSync(snapshotPath, '', { flag: 'wx' });
  } catch (err) {
    // EEXIST is the expected benign outcome (snapshot already present) — no-op.
    if ((err as { code?: string }).code === 'EEXIST') return; /* telemetry — silent by design */
    // Any other error is a real write failure: record (ADR-003) then rethrow.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'poviewer-fileio',
      level: 'error',
      message: 'Failed to create empty snapshot.md',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw err;
  }
}

// === Read Source File Content ===

export async function readSourceFileContent(filePath: string): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new ActionableError({
      goal: 'Read source file content for analysis',
      problem: `File not found: ${filePath}`,
      location: 'fileIO.ts:readSourceFileContent',
      nextSteps: [
        'Verify the file path is correct and the file exists on disk',
        'Check that the source was fully ingested with a snapshot or raw file',
        'Re-import the source if the file was moved or deleted',
      ],
    });
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.txt') {
    return fs.readFileSync(filePath, 'utf-8');
  }

  if (ext === '.pdf') {
    const { extractPdfText } = await import('./pdfExtractor.js');
    const result = await extractPdfText(filePath);
    return result.fullText;
  }

  if (ext === '.docx') {
    // For docx, read raw text (basic extraction)
    // Full docx parsing would require a dedicated library
    // For now, return a placeholder directing user to convert to .md
    return `[DOCX file: ${path.basename(filePath)}]\n\nDOCX text extraction requires conversion. Use the Import-Document script to convert to Markdown first, or add the .md version of this file.`;
  }

  throw new ActionableError({
    goal: 'Read source file content for analysis',
    problem: `Unsupported file type: ${ext}`,
    location: 'fileIO.ts:readSourceFileContent',
    nextSteps: [
      'Convert the file to a supported format (.md, .txt, .pdf, or .docx)',
      'Use Import-Document to convert to Markdown first',
      `Supported extensions: .md, .txt, .pdf, .docx (got "${ext}")`,
    ],
  });
}

// === Discover Sources from Pipeline ===

export interface DiscoveredSource {
  id: string;
  title: string;
  sourceType: string;
  url: string | null;
  authors: string[];
  dateIngested: string;
  povTags: string[];
  topicTags: string[];
  oneLiner: string;
  summaryStatus: string;
  snapshotText: string;
  hasSummary: boolean;
}

export interface PipelineSummary {
  doc_id: string;
  taxonomy_version: string;
  generated_at: string;
  ai_model: string;
  temperature: number;
  pov_summaries: Record<string, {
    stance?: string;
    key_points: Array<{
      taxonomy_node_id: string | null;
      category: string;
      point: string;
      excerpt_context: string;
      stance?: string;
    }>;
  }>;
  factual_claims: Array<{
    claim: string;
    doc_position: string;
    potential_conflict_id: string | null;
  }>;
  unmapped_concepts: Array<{
    concept: string;
    suggested_pov: string;
    suggested_category: string;
    reason: string;
  }>;
}

const SUMMARIES_DIR = path.join(PROJECT_ROOT, 'summaries');

export function discoverSources(): DiscoveredSource[] {
  const results: DiscoveredSource[] = [];

  if (!fs.existsSync(SOURCES_DIR)) return results;

  const dirs = fs.readdirSync(SOURCES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of dirs) {
    const metaPath = path.join(SOURCES_DIR, dir.name, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));

      // Read snapshot text
      const snapshotPath = path.join(SOURCES_DIR, dir.name, 'snapshot.md');
      const snapshotText = fs.existsSync(snapshotPath)
        ? fs.readFileSync(snapshotPath, 'utf-8')
        : '';

      // Skip sources with empty snapshots (not fully ingested)
      if (!snapshotText.trim()) continue;

      // Check if summary exists
      const summaryPath = path.join(SUMMARIES_DIR, `${dir.name}.json`);
      const hasSummary = fs.existsSync(summaryPath);

      results.push({
        id: meta.id || dir.name,
        title: meta.title || dir.name,
        sourceType: meta.source_type || 'unknown',
        url: meta.url || null,
        authors: meta.authors || [],
        dateIngested: meta.date_ingested || '',
        povTags: meta.pov_tags || [],
        topicTags: meta.topic_tags || [],
        oneLiner: meta.one_liner || '',
        summaryStatus: meta.summary_status || 'pending',
        snapshotText,
        hasSummary,
      });
    } catch {
      // Skip sources with invalid metadata
      /* telemetry — silent by design */
    }
  }

  return results;
}

export function loadPipelineSummary(docId: string): PipelineSummary | null {
  // t/2534 (M8pov): docId is renderer-supplied.
  assertSafeId(docId, 'docId');
  const summaryPath = path.resolve(SUMMARIES_DIR, `${docId}.json`);
  assertContainedIn(summaryPath, path.resolve(SUMMARIES_DIR));
  if (!fs.existsSync(summaryPath)) return null;
  const raw = fs.readFileSync(summaryPath, 'utf-8');
  return JSON.parse(raw);
}

// === Annotation File I/O ===

export function saveAnnotations(sourceId: string, annotations: unknown): void {
  const sourceDir = resolveSourceDirSafe(sourceId);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(sourceDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(sourceDir, 'annotations.json'),
    JSON.stringify(annotations, null, 2) + '\n',
    'utf-8',
  );
}

export function loadAnnotations(sourceId: string): unknown {
  const filePath = path.join(resolveSourceDirSafe(sourceId), 'annotations.json');
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// === Analysis Result I/O ===

export function saveAnalysisResult(sourceId: string, result: unknown): void {
  const sourceDir = resolveSourceDirSafe(sourceId);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(sourceDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(sourceDir, 'analysis.json'),
    JSON.stringify(result, null, 2) + '\n',
    'utf-8',
  );
}

export function loadAnalysisResult(sourceId: string): unknown | null {
  const filePath = path.join(resolveSourceDirSafe(sourceId), 'analysis.json');
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

// === AI Settings I/O ===

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// Google shuts these ids down on 2026-12-01 (t/781); a saved choice maps to its designated successor.
const RETIRED_MODEL_SUCCESSORS: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-3.5-flash-lite',
  'gemini-2.5-pro': 'gemini-3.8-flash',
};

/**
 * Map a saved model that Google has retired to its successor. An id that is neither retired nor in
 * `knownModelIds` is left as the user saved it, with a WARN (it may be a typo or a model removed from
 * the registry). `knownModelIds` null means the registry could not be read, so the check is skipped.
 */
export function migrateRetiredModel(
  settings: AiSettings,
  knownModelIds: ReadonlySet<string> | null = null,
  warn: (message: string) => void = (m) => console.warn(m),
): AiSettings {
  const successor = RETIRED_MODEL_SUCCESSORS[settings.model];
  if (successor) {
    warn(`WARN: saved AI model '${settings.model}' is retired; using '${successor}' (t/781)`);
    return { ...settings, model: successor };
  }
  if (knownModelIds && !knownModelIds.has(settings.model)) {
    warn(`WARN: saved AI model '${settings.model}' is not in ai-models.json; leaving it unchanged (t/781)`);
  }
  return settings;
}

function knownRegistryModelIds(): ReadonlySet<string> | null {
  try {
    return new Set(loadModelRegistry(PROJECT_ROOT).models.map((m) => m.id));
  } catch (err) {
    console.warn(`WARN: could not read ai-models.json to check the saved AI model: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export function loadAiSettings(): AiSettings {
  if (fs.existsSync(AI_SETTINGS_PATH)) {
    const raw = fs.readFileSync(AI_SETTINGS_PATH, 'utf-8');
    return migrateRetiredModel(JSON.parse(raw) as AiSettings, knownRegistryModelIds());
  }
  return { model: DEFAULT_MODEL, temperature: 0.1 };
}

export function saveAiSettings(settings: AiSettings): void {
  ensureConfigDir();
  fs.writeFileSync(AI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

// === Prompt Overrides I/O ===

export function loadPromptOverrides(): PromptOverrides | null {
  if (fs.existsSync(PROMPTS_PATH)) {
    const raw = fs.readFileSync(PROMPTS_PATH, 'utf-8');
    return JSON.parse(raw);
  }
  return null;
}

export function savePromptOverrides(overrides: PromptOverrides): void {
  ensureConfigDir();
  fs.writeFileSync(PROMPTS_PATH, JSON.stringify(overrides, null, 2) + '\n', 'utf-8');
}

// === Taxonomy Loading Helpers ===

export function readAllTaxonomies(): string {
  const result: Record<string, unknown> = {};
  for (const [pov, filename] of Object.entries(POV_FILE_MAP)) {
    const filePath = path.join(activeTaxonomyDir, filename);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      result[pov] = JSON.parse(raw);
    }
  }
  return JSON.stringify(result, null, 2);
}

// === Export Helpers ===

export function getSourceDir(sourceId: string): string {
  return resolveSourceDirSafe(sourceId);
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

// === Raw PDF Path Resolution ===

export function findRawPdfPath(sourceId: string): string | null {
  const rawDir = path.join(resolveSourceDirSafe(sourceId), 'raw');
  if (!fs.existsSync(rawDir)) return null;
  const files = fs.readdirSync(rawDir);
  const pdf = files.find(f => f.toLowerCase().endsWith('.pdf'));
  if (!pdf) return null;
  return path.join(rawDir, pdf);
}

export function readRawPdfBytes(sourceId: string): Buffer | null {
  const pdfPath = findRawPdfPath(sourceId);
  if (!pdfPath) return null;
  return fs.readFileSync(pdfPath);
}

// === Taxonomy File Watching ===

const activeWatchers: fs.FSWatcher[] = [];

export function watchTaxonomyFiles(onChange: (pov: string) => void): void {
  stopWatchingTaxonomyFiles();

  const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  for (const [pov, filename] of Object.entries(POV_FILE_MAP)) {
    const filePath = path.join(activeTaxonomyDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const watcher = fs.watch(filePath, () => {
        // Debounce: editors often fire multiple events per save
        if (debounceTimers[pov]) clearTimeout(debounceTimers[pov]);
        debounceTimers[pov] = setTimeout(() => {
          console.log(`[TaxonomyWatcher] Change detected: ${pov} (${filename})`);
          onChange(pov);
        }, 300);
      });

      activeWatchers.push(watcher);
      console.log(`[TaxonomyWatcher] Watching ${filename}`);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'taxonomy-watcher',
        level: 'error',
        message: `Failed to watch taxonomy file ${filename}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      console.error(`[TaxonomyWatcher] Failed to watch ${filename}:`, err);
    }
  }
}

export function stopWatchingTaxonomyFiles(): void {
  for (const watcher of activeWatchers) {
    watcher.close();
  }
  activeWatchers.length = 0;
  console.log('[TaxonomyWatcher] All watchers stopped');
}

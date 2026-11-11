// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveRepoRoot, resolveDataRoot } from './taxonomyLoader.js';
import { getGlobalRecorder } from '../flight-recorder/index.js';
import type { SourceEvidenceIndex, DocMetaMap } from './evidenceFromSummaries.js';

/** Load source evidence index from configured taxonomy directory. Returns undefined if not found. */
export function loadSourceEvidenceIndex(sessionId?: string): SourceEvidenceIndex | undefined {
  try {
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    const root = resolveRepoRoot(__dir);
    const dataRoot = resolveDataRoot(root);

    // Read .aitriad.json for taxonomy_dir (same as assignWeights.ts, modulateEdgeWeights.ts)
    const aitriadPath = path.join(root, '.aitriad.json');
    const aitriadConfig = JSON.parse(
      fs.readFileSync(aitriadPath, 'utf-8').replace(/^\uFEFF/, ''),
    ) as { taxonomy_dir: string };
    const taxonomyDir = path.join(dataRoot, aitriadConfig.taxonomy_dir);

    const indexPath = path.join(taxonomyDir, 'source_evidence_index.json');
    if (fs.existsSync(indexPath)) {
      return JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    }

    // File not found: log WARN with actual path
    getGlobalRecorder()?.record({
      type: 'state.error',
      component: 'debate-engine',
      level: 'warn',
      debate_id: sessionId,
      message: `Source evidence index not found at ${indexPath}`,
    });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'state.error',
      component: 'debate-engine',
      level: 'warn',
      debate_id: sessionId,
      message: 'Source evidence index unavailable',
      error: {
        name: (err as Error).name ?? 'Error',
        message: String(err),
        stack: (err as Error).stack,
      },
    });
  }
  return undefined;
}

/** Load document metadata map from configured sources directory. Returns undefined if not found. */
export function loadDocTitles(sessionId?: string): DocMetaMap | undefined {
  try {
    const __dir = path.dirname(fileURLToPath(import.meta.url));
    const root = resolveRepoRoot(__dir);
    const sourcesRoot = resolveSourcesRoot(root);
    if (!sourcesRoot) return undefined;
    return loadDocMetadataMap(sourcesRoot);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'state.error',
      component: 'debate-engine',
      level: 'warn',
      debate_id: sessionId,
      message: 'Doc titles loading failed',
      error: {
        name: (err as Error).name ?? 'Error',
        message: String(err),
        stack: (err as Error).stack,
      },
    });
    return undefined;
  }
}

function resolveSourcesRoot(root: string): string | null {
  const configPath = path.join(root, '.aitriad.json');
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const sourcesRoot = config.sources_root ? path.resolve(root, config.sources_root) : null;
  if (!sourcesRoot || !fs.existsSync(sourcesRoot)) return null;
  return sourcesRoot;
}

function loadDocMetadataMap(sourcesRoot: string): DocMetaMap | undefined {
  const metaMap: Record<string, { title: string; resolved_url?: string; provenance_label?: string }> = {};
  for (const entry of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(sourcesRoot, entry.name, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    const docMeta = loadSingleDocMeta(metaPath, entry.name);
    if (docMeta) metaMap[entry.name] = docMeta;
  }
  return Object.keys(metaMap).length > 0 ? metaMap : undefined;
}

function loadSingleDocMeta(metaPath: string, docName: string): { title: string; resolved_url?: string; provenance_label?: string } | null {
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (!meta.title) return null;
    const docMeta: { title: string; resolved_url?: string; provenance_label?: string } = { title: meta.title };
    if (meta.resolved_url) docMeta.resolved_url = meta.resolved_url;
    if (meta.provenance?.length > 0 && meta.provenance[0].id) docMeta.provenance_label = meta.provenance[0].id;
    if (!docMeta.resolved_url && meta.url) docMeta.resolved_url = meta.url;
    return docMeta;
  } catch {
    return null;
  }
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Source & summary handlers (t/1689 split of ipcHandlers.ts, ADR-007).
// Source discovery, per-document summaries/snapshots, document resolution, and
// the source-evidence retrieval pipeline (runs in main for filesystem access).
// The evidence-index / doc-title caches move here as module-level state — they
// were function-scoped closures inside registerIpcHandlers before the split.

import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  discoverSources,
  loadSummary,
  loadSnapshot,
  resolveSourceDocument,
  getDataRootPath,
  loadDataConfig,
  PROJECT_ROOT,
} from '../fileIO.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { usableTitle } from '../../../../lib/debate/docTitlesFromSourcesIndex.js';

/** Build a doc-title map entry from one source's parsed metadata.json, or null when it
 *  has no title. Extracted verbatim from loadDocTitles (t/1914 complexity split). */
/** t/521: a bare identifier (arXiv id) or a title equal to the doc id is not a title; such a document is left out. */
function buildDocMeta(docId: string, meta: { title?: string; resolved_url?: string; url?: string; provenance?: { id?: string }[] }): { title: string; resolved_url?: string; provenance_label?: string } | null {
  const title = usableTitle(meta.title, docId);
  if (!title) return null;
  const docMeta: { title: string; resolved_url?: string; provenance_label?: string } = { title };
  if (meta.resolved_url) docMeta.resolved_url = meta.resolved_url;
  if (meta.provenance?.length && meta.provenance[0].id) {
    docMeta.provenance_label = meta.provenance[0].id;
  }
  // Fallback: if no resolved_url yet but url field exists, use it
  if (!docMeta.resolved_url && meta.url) docMeta.resolved_url = meta.url;
  return docMeta;
}

export function registerSourceHandlers(): void {
  // Summaries & Sources
  ipcMain.handle('discover-sources', () => discoverSources());
  ipcMain.handle('load-summary', (_event, docId: string) => loadSummary(docId));
  ipcMain.handle('load-snapshot', (_event, sourceId: string) => {
    const content = loadSnapshot(sourceId);
    return content ? { content } : null;
  });
  ipcMain.handle('source-documents:resolve', (_event, docId: string) =>
    resolveSourceDocument(docId),
  );

  // ── Source evidence (runs in main process for filesystem access) ──
  type SourceEvidenceIndex = import('../../../../lib/debate/evidenceFromSummaries.js').SourceEvidenceIndex;
  type DocTitleMap = import('../../../../lib/debate/evidenceFromSummaries.js').DocTitleMap;
  let _evidenceIndex: SourceEvidenceIndex | null = null;
  let _docTitles: DocTitleMap | undefined;
  function loadEvidenceIndex(): SourceEvidenceIndex | null {
    if (_evidenceIndex) return _evidenceIndex;
    try {
      const config = loadDataConfig();
      const taxDir = path.join(getDataRootPath(), config.taxonomy_dir);
      const indexPath = path.join(taxDir, 'source_evidence_index.json');
      if (!fs.existsSync(indexPath)) return null;
      _evidenceIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return _evidenceIndex;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'loadEvidenceIndex: failed to read source_evidence_index.json — returning null (source evidence will be unavailable)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  }

  /** Build doc_id → metadata map from source metadata.json files (best-effort). */
  function loadDocTitles(): DocTitleMap | undefined {
    if (_docTitles) return _docTitles;
    try {
      const config = loadDataConfig();
      const sourcesRoot = config.sources_root
        ? path.resolve(PROJECT_ROOT, config.sources_root)
        : null;
      if (!sourcesRoot || !fs.existsSync(sourcesRoot)) return undefined;
      const metaMap: Record<string, { title: string; resolved_url?: string; provenance_label?: string }> = {};
      const dirs = fs.readdirSync(sourcesRoot, { withFileTypes: true });
      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        const metaPath = path.join(sourcesRoot, entry.name, 'metadata.json');
        if (!fs.existsSync(metaPath)) continue;
        try {
          const docMeta = buildDocMeta(entry.name, JSON.parse(fs.readFileSync(metaPath, 'utf-8')));
          if (docMeta) metaMap[entry.name] = docMeta;
        } catch { /* telemetry — silent by design;  skip malformed metadata */ }
      }
      _docTitles = Object.keys(metaMap).length > 0 ? metaMap as unknown as DocTitleMap : undefined;
      if (_docTitles) console.log(`[evidence] Loaded ${Object.keys(metaMap).length} document metadata entries`);
      return _docTitles;
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'loadDocTitles: failed to read sources directory — returning undefined (source evidence will have no title labels)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return undefined;
    }
  }

  ipcMain.handle('load-source-evidence-index', () => loadEvidenceIndex());
  ipcMain.handle('load-doc-titles', () => loadDocTitles());

  // greatest-hits exclusion list (t/1998) — reads the same static calibration file the debate
  // engine reads (lib/debate/debateEngine/taxonomyContext.ts) so desktop and engine exclude
  // the same nodes. Returns { node_ids } or null when the file is absent/unreadable; the
  // renderer degrades gracefully rather than failing the debate (TL t/1998#2). Mirrors the
  // load-doc-titles / load-source-evidence-index read pattern. Read per call (not cached):
  // called once per debate build, and t/1999 may generate the file mid-session, so a cached
  // null would go stale.
  ipcMain.handle('load-greatest-hits', (): { node_ids: string[] } | null => {
    try {
      const filePath = path.join(getDataRootPath(), 'calibration', 'greatest-hits.json');
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
        node_ids?: string[];
        nodes?: { node_id?: string }[];
      };
      // Accept v1 (flat `node_ids`) and v2 (`nodes[].node_id`, t/2003 / DebateTool #241) — pull
      // the ID list from whichever shape the file carries so exclusion survives the data-repo
      // regen timing. A v2 file read as v1-only would silently return [] → exclusion no-ops,
      // exactly the silent-degrade trap TL flagged (t/1998#2). Malformed v2 entries (no
      // node_id) are dropped, never surfaced as undefined.
      const nodeIds = data.node_ids
        ?? data.nodes?.map((n) => n.node_id).filter((id): id is string => typeof id === 'string')
        ?? [];
      return { node_ids: nodeIds };
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'warn',
        message: 'load-greatest-hits: failed to read greatest-hits.json — returning null (debate exclusion list will be empty)',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      return null;
    }
  });

  ipcMain.handle('get-source-evidence', async (_event, nodeIds: string[], pov: string) => {
    const emptyResult = { facts: [], keyPoints: [], formattedBlock: '', nodesCovered: [], totalCandidates: 0 };
    const index = loadEvidenceIndex();
    if (!index) return emptyResult;
    try {
      const { retrieveSourceEvidence } = await import('../../../../lib/debate/evidenceFromSummaries.js');
      const docTitles = loadDocTitles();
      return retrieveSourceEvidence(nodeIds, pov, index, 3, 2, docTitles);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ipc-handlers',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      console.warn(`[ipc] get-source-evidence failed: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
      return emptyResult;
    }
  });
}

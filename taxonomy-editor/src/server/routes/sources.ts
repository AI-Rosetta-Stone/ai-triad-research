// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1687 (Phase 2 server.ts split, ADR-007): the summaries / sources / source-
// documents / dictionary / source-evidence / evidence-qbaf / proposals /
// ps-prompts / fetch-url / upload-document route run, moved verbatim out of
// server.ts behind the registration seam. This run sits between
// registerHarvestRoutes and registerSyncRoutes, so registration order — and the
// routeTable snapshot — is preserved by placing registerSourcesRoutes() at its
// former position.
//
// The run's two module-local caches (_evidenceIndex/loadEvidenceIndex and
// _docTitles/loadDocTitles) are read only by handlers in this run, so they move
// in as module-local state — no ServerCtx surface, no setter/invalidator.
//
// Two necessary, behaviour-preserving path adjustments (routes/ is one directory
// deeper than server.ts):
//   1. lib dynamic/type imports go from '../../../lib/...' to '../../../../lib/...'.
//   2. loadDocTitles walks up from __dirname to find .aitriad.json; server.ts
//      resolved '..','..','..' from src/server (→ repo root), so from src/server/
//      routes we resolve one extra '..' ('..','..','..','..') to land on the same
//      repo root before the upward .aitriad.json search.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { DEFAULT_MODEL, withTimeout } from '../../../../lib/ai-client/index.js';
import { log } from '../logger.js';
import * as ai from '../ai/aiBackends.js';
import { resolveGenerationContext, enforceBackendAllowed } from './generationContext.js';
import { getDataRoot } from '../config.js';
import { readDataFile } from '../storage/readDataFile.js';
import { greatestHitsPath } from '../../../../lib/debate/corpusCoverage.js';
import * as fileIO from '../storage/fileIO.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Source evidence (module-local caches, read only by the routes below) ──

type SourceEvidenceIndex = import('../../../../lib/debate/evidenceFromSummaries.js').SourceEvidenceIndex;
let _evidenceIndex: SourceEvidenceIndex | null = null;
async function loadEvidenceIndex(): Promise<SourceEvidenceIndex | null> {
  if (_evidenceIndex) return _evidenceIndex;
  try {
    const taxDir = fileIO.getTaxonomyDir();
    const relPath = path.relative(getDataRoot(), path.join(taxDir, 'source_evidence_index.json'));
    const buf = await readDataFile(relPath);
    _evidenceIndex = JSON.parse(buf.toString('utf-8')) as SourceEvidenceIndex;
    return _evidenceIndex;
  } catch (err) {
    // Fallback-Path Logging (t/3200/t/3169): the source-evidence index failed to load/parse →
    // evidence-backed source features degrade to null. Cached above, so this warns at most once per
    // process until a load succeeds; the error distinguishes absent from malformed.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'sources-routes', level: 'warn',
      message: `source_evidence_index load failed — evidence features degraded to null: ${String(err)}`,
      data: { fallback: 'evidence-index-null' },
      error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack },
    });
    log.server.warn({ component: 'sources-routes', err: String(err) }, 'source_evidence_index load failed — evidence features degraded to null');
    return null;
  }
}

type DocMetaMap = import('../../../../lib/debate/evidenceFromSummaries.js').DocMetaMap;
let _docTitles: DocMetaMap | null | undefined;

/** Walk up from this module to find .aitriad.json and resolve its sources_root, or null. */
function resolveSourcesRootFromConfig(): string | null {
  let searchDir = path.resolve(__dirname, '..', '..', '..', '..');
  let aitriadPath = '';
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(searchDir, '.aitriad.json');
    if (fs.existsSync(candidate)) { aitriadPath = candidate; break; }
    searchDir = path.dirname(searchDir);
  }
  if (!aitriadPath) return null;
  const aitriadConfig = JSON.parse(fs.readFileSync(aitriadPath, 'utf-8'));
  const sourcesRoot = aitriadConfig.sources_root
    ? path.resolve(path.dirname(aitriadPath), aitriadConfig.sources_root)
    : null;
  if (!sourcesRoot || !fs.existsSync(sourcesRoot)) return null;
  return sourcesRoot;
}

/** Read per-source metadata.json titles/urls under sourcesRoot into a DocMetaMap. */
function readDocMetaMap(sourcesRoot: string): DocMetaMap {
  const metaMap: DocMetaMap = {};
  for (const entry of fs.readdirSync(sourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(sourcesRoot, entry.name, 'metadata.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.title) {
        const docMeta: { title: string; resolved_url?: string; provenance_label?: string } = { title: meta.title };
        if (meta.resolved_url) docMeta.resolved_url = meta.resolved_url;
        if (meta.provenance?.length > 0 && meta.provenance[0].id) docMeta.provenance_label = meta.provenance[0].id;
        if (!docMeta.resolved_url && meta.url) docMeta.resolved_url = meta.url;
        metaMap[entry.name] = docMeta;
      }
    } catch { /* telemetry — silent by design;  skip */ }
  }
  return metaMap;
}

function loadDocTitles(): DocMetaMap | null {
  if (_docTitles !== undefined) return _docTitles;
  try {
    const sourcesRoot = resolveSourcesRootFromConfig();
    if (!sourcesRoot) { _docTitles = null; return null; }
    const metaMap = readDocMetaMap(sourcesRoot);
    _docTitles = Object.keys(metaMap).length > 0 ? metaMap : null;
    return _docTitles;
  } catch { /* telemetry — silent by design */ _docTitles = null; return null; }
}

/**
 * t/1998: read `calibration/greatest-hits.json` and return its node IDs as
 * `{ node_ids }` for the renderer's greatest-hits exclusion. Returns null when the
 * file is absent or unreadable (graceful no-op — the renderer treats null as "no
 * exclusion available"; see the loud-degrade design in t/1998#2). Mirrors
 * loadDocTitles (fs read, null on absence). Deliberately does NOT use
 * corpusCoverage.loadGreatestHitsFile(): that returns a Set (JSON.stringify(new
 * Set()) → {}) and throws on a missing file.
 *
 * t/2003: accepts BOTH file shapes so it survives the DebateTool v2 data regen on
 * either side of it — v1 = flat `node_ids: string[]`; v2 = `nodes: [{ node_id, pov,
 * bdi_category, ... }]`. Without this, v2 leaves `node_ids` undefined → `{ node_ids:
 * [] }` → exclusion silently no-ops. The response contract (`{ node_ids: string[] }`)
 * is unchanged — the renderer builds the Set + filters vs. live nodes.
 */
export async function loadGreatestHitsNodeIds(): Promise<{ node_ids: string[] } | null> {
  try {
    const absPath = greatestHitsPath(getDataRoot());
    const relPath = path.relative(getDataRoot(), absPath);
    const buf = await readDataFile(relPath);
    const parsed = JSON.parse(buf.toString('utf-8')) as {
      node_ids?: unknown;
      nodes?: Array<{ node_id?: unknown }>;
    };
    const raw: unknown[] = Array.isArray(parsed.node_ids)
      ? parsed.node_ids
      : Array.isArray(parsed.nodes)
        ? parsed.nodes.map(n => n?.node_id)
        : [];
    const node_ids = raw.filter((id): id is string => typeof id === 'string');
    return { node_ids };
  } catch (err) {
    // Fallback-Path Logging (t/3200/t/3169): the greatest-hits asset failed to load/parse →
    // GET /api/greatest-hits degrades to null (client shows no curated set). Warn so a missing or
    // corrupt asset is visible instead of a silent empty; the error distinguishes absent from malformed.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'sources-routes', level: 'warn',
      message: `greatest-hits asset load failed — degraded to null: ${String(err)}`,
      data: { fallback: 'greatest-hits-null' },
      error: { name: (err as Error)?.name ?? 'Error', message: String(err), stack: (err as Error)?.stack },
    });
    log.server.warn({ component: 'sources-routes', err: String(err) }, 'greatest-hits asset load failed — degraded to null');
    return null;
  }
}

export function registerSourcesRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, post, put } = r;

  // ── Summaries & Sources ──

  get('/api/sources', async (_req, res) => {
    json(res, await fileIO.discoverSources());
  });

  get('/api/summaries/:docId', async (req, res) => {
    const docId = param(req, 'docId', '/api/summaries/:docId');
    const data = await fileIO.loadSummary(docId);
    if (data === null) { error(res, `Summary not found: ${docId}`, 404); return; }
    json(res, data);
  });

  get('/api/snapshots/:sourceId', async (req, res) => {
    const sourceId = param(req, 'sourceId', '/api/snapshots/:sourceId');
    const data = await fileIO.loadSnapshot(sourceId);
    if (data === null) { error(res, `Snapshot not found: ${sourceId}`, 404); return; }
    json(res, { content: data });
  });

  // ── Source documents (resolve doc_id → content/path; serve raw PDF) ──

  get('/api/source-documents/:docId', async (req, res) => {
    const docId = param(req, 'docId', '/api/source-documents/:docId');
    try {
      json(res, await fileIO.resolveSourceDocument(docId));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err, docId }, 'source-document resolution failed');
      // AC #3 graceful degradation — never surface a 500 for a missing/bad doc.
      json(res, { available: false, type: null });
    }
  });

  get('/api/source-documents/:docId/file', async (req, res) => {
    const docId = param(req, 'docId', '/api/source-documents/:docId/file');
    try {
      const pdf = await fileIO.readSourceDocumentPdf(docId);
      if (pdf === null) { error(res, `Source document not found: ${docId}`, 404); return; }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'Content-Disposition': `inline; filename="${encodeURIComponent(docId)}.pdf"`,
      });
      res.end(pdf);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err, docId }, 'source-document file serve failed');
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  // ── Dictionary ──

  const DICTIONARY_TIMEOUT_MS = 10_000;

  get('/api/dictionary', async (_req, res) => {
    const t0 = Date.now();
    try {
      json(res, await withTimeout(fileIO.loadDictionary(), DICTIONARY_TIMEOUT_MS, 'dictionary-github'));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'dictionary', level: 'warn',
        message: 'dictionary.github.timeout',
        data: { duration_ms: Date.now() - t0 },
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      json(res, { standardized: [], colloquial: [], lintViolations: [] });
    }
  });

  // ── Source evidence ──

  get('/api/source-evidence-index', async (_req, res) => {
    json(res, await loadEvidenceIndex());
  });

  get('/api/doc-titles', (_req, res) => {
    json(res, loadDocTitles());
  });

  // t/1998: greatest-hits exclusion list for the renderer's node scoring. Returns
  // `{ node_ids }` or null (absent file) — never the Set that loadGreatestHitsFile
  // yields (JSON.stringify(new Set()) → {}). Renderer builds the Set + filters vs.
  // live nodes, so no server-side knownNodeIds filtering here.
  get('/api/greatest-hits', async (_req, res) => {
    json(res, await loadGreatestHitsNodeIds());
  });

  post('/api/source-evidence', async (_req, res, body) => {
    const { nodeIds, pov } = body as { nodeIds: string[]; pov: string };
    const emptyResult = { facts: [], keyPoints: [], formattedBlock: '', nodesCovered: [], totalCandidates: 0 };
    const index = await loadEvidenceIndex();
    if (!index) { json(res, emptyResult); return; }
    try {
      const { retrieveSourceEvidence } = await import('../../../../lib/debate/evidenceFromSummaries.js');
      const docTitles = loadDocTitles() ?? undefined;
      json(res, retrieveSourceEvidence(nodeIds, pov, index, 3, 2, docTitles));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, 'source-evidence failed');
      json(res, emptyResult);
    }
  });

  // ── Evidence QBAF (runs full pipeline server-side) ──

  post('/api/evidence-qbaf', async (req, res, body) => {
    const { claimText, claimId, model } = body as { claimText: string; claimId: string; model?: string };
    if (!claimText || !claimId) { error(res, 'claimText and claimId are required', 400); return; }

    // t/2625: gate the user-supplied model through the shared entitlement path — a
    // free/restricted tier can't select a premium backend via body.model. Pins free tier.
    const { tier, effectiveModel, backend } = resolveGenerationContext(req, model);
    if (enforceBackendAllowed(res, tier, backend)) return;

    const sourcesDir = fileIO.getSourcesDir();
    if (!sourcesDir || !fs.existsSync(sourcesDir)) { json(res, null); return; }

    try {
      const { retrieveEvidence } = await import('../../../../lib/debate/evidenceRetriever.js');
      const { buildEvidenceQbaf } = await import('../../../../lib/debate/evidenceQbaf.js');
      type AIAdapter = import('../../../../lib/debate/aiAdapter.js').AIAdapter;

      const evidenceItems = retrieveEvidence(claimText, sourcesDir, { topK: 10 });
      if (evidenceItems.length === 0) { json(res, null); return; }

      const adapter: AIAdapter = {
        generateText: async (prompt: string, mdl: string) => {
          const result = await ai.generateText(prompt, mdl);
          return result.text;
        },
        // t/3614: required AIAdapter member (host-loaded registry, cached). This evidence-qbaf adapter
        // never runs the debate engine, but the interface requires it uniformly.
        registry: ai.getModelRegistry(),
      };

      const evalModel = effectiveModel || DEFAULT_MODEL;
      const result = await buildEvidenceQbaf(claimText, evidenceItems, adapter, evalModel, {
        claimBaseStrength: 0.5,
      });
      json(res, { ...result, claim_id: claimId });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.api.warn({ err }, `evidence-qbaf failed for ${claimId}`);
      json(res, null);
    }
  });

  // ── Proposals ──

  get('/api/proposals', async (_req, res) => { json(res, await fileIO.listProposals()); });

  put('/api/proposals/:filename', async (req, res, body) => {
    try {
      await fileIO.saveProposal(param(req, 'filename', '/api/proposals/:filename'), body);
      json(res, { saved: true });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to save proposal', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  // ── PowerShell prompts ──

  get('/api/ps-prompts', async (_req, res) => { json(res, await fileIO.listPsPrompts()); });

  get('/api/ps-prompts/:name', async (req, res) => {
    const dir = new URL(req.url ?? '', 'http://localhost').searchParams.get('dir') ?? 'ps';
    json(res, await fileIO.readPsPrompt(param(req, 'name', '/api/ps-prompts/:name'), dir));
  });

  // ── URL content ──

  post('/api/fetch-url', async (_req, res, body) => {
    const { url } = body as { url: string };
    try {
      json(res, await fileIO.fetchUrlContent(url));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'fetch-url', level: 'warn',
        message: 'Failed to fetch URL content', data: { url },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 502, err);
    }
  });

  // ── File upload (replaces pickDocumentFile dialog) ──

  post('/api/upload-document', async (req, res) => {
    // Expects multipart form data or raw text body
    // For now, accept raw text with filename header
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const content = Buffer.concat(chunks).toString('utf-8');
    const filename = req.headers['x-filename'] as string || 'uploaded-document';
    json(res, { cancelled: false, filePath: filename, content });
  });
}

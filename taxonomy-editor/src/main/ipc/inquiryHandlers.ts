// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Inquiry — Electron main-process job runner (t/3579). Runs the SHARED lib/debate
// `runInquiryPipeline` (t/3585) in-process, mirroring `briefExportHandlers.ts`'s local
// job-Map pattern (t/2840) minus the server-only concerns: desktop is single-user, so
// there is no auth gate, no per-user quota, no rate limiting, and no cross-replica
// persistence fallback (`server/inquiryJobs.ts`/`storage/inquiryResultStore.ts`, t/3578) —
// a single in-memory Map is the complete, durable-enough store for one desktop process.
//
// `status`/`terminationReason`/`resultId`/`error` field names and the terminal
// done/done_truncated/failed vocabulary mirror the server's InquiryStatusResponse
// (t/3578, ServerAPI's inquiryJobs.ts) exactly — Rosetta Stone's bridge (t/3582) polls
// both builds through the same shape. `InquiryJobStatus`, `isTerminalStatus`, and
// `deriveTruncation` are the canonical hoisted symbols from lib/inquiry (t/3609) — no
// local duplicates.
//
// t/3683: persistence + history/export leg. Completed results are also written to
// userData/inquiry-results (mirrors briefExportHandlers.ts's filesystem + _index.json
// pattern, t/2840) — the in-memory `jobs` Map alone isn't durable enough for "My
// Questions" history to survive the 30-min TTL sweep or an app restart. `get-inquiry`
// falls back to the persisted result when the in-memory job is gone (mirrors the
// server's cross-replica fallback, routes/inquiry.ts) because useInquiryStore.ts opens
// history rows via getInquiry, not a separate "view" call.

import { ipcMain, app, dialog, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, readTaxonomyFile } from '../fileIO.js';
import { computeEmbeddings } from '../embeddings.js';
import { makeElectronAIAdapter } from '../electronAIAdapter.js';
import { assembleNodeEmbeddings, type NodeEmbeddingMap } from '../../../../lib/debate/relevanceSelection.js';
import type { GroundingTaxonomy } from '../../../../lib/debate/inquiryGrounding.js';
import { runInquiryPipeline, type InquiryPipelineDeps, type InquiryStage } from '../../../../lib/debate/inquiryPipeline.js';
import { runHeadlessDebate } from '../../../../lib/debate/headlessRunner.js';
import { resolvePoverInfo } from '../../../../lib/debate/soulDocLoader.js';
import { loadTaxonomy, type LoadedTaxonomy } from '../../../../lib/debate/taxonomyLoader.js';
import { selectablePovNodes } from '../../../../lib/debate/supersession.js';
import { loadModelRegistry } from '../../../../lib/ai-client/registry.js';
import {
  InquiryRequestSchema, type InquiryRequest, type InquiryResult,
  type InquiryJobStatus, isTerminalStatus, deriveTruncation,
} from '../../../../lib/inquiry/index.js';
import { inquiryToJson, inquiryToMarkdown, inquiryToPrintHtml, inquiryExportFilename } from '../../../../lib/inquiry/inquiryExport.js';
import { errorMessage } from '../../../../lib/debate/errors.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

const JOB_TTL_MS = 30 * 60_000; // matches server's INQUIRY_JOB_TTL_MS (t/3578#6) — deep fidelity can run ~45 min

interface InquiryJob {
  jobId: string;
  status: InquiryJobStatus;
  progressPct: number;
  terminationReason: string | null;
  resultId: string | null;
  error: string | null;
  result: InquiryResult | null;
  startedAt: number;
}

const jobs = new Map<string, InquiryJob>();

// ── Local persistence (t/3683) — mirrors briefExportHandlers.ts's filesystem + _index.json
// pattern (t/2840): userData/inquiry-results/inquiry-<jobId>.json + a listing index. Desktop
// has no auth/multi-user concept, so this is a flat single-user store (no per-user subdir,
// unlike server/storage/inquiryResultStore.ts). ──

/** Cheap listing row for "My Questions" history. Field-for-field identical to the server's
 *  InquiryResultSummary (storage/inquiryResultStore.ts) and the renderer bridge's copy
 *  (bridge/types.ts) — a third hand-kept copy of the same shape. Flagged, not blocked on:
 *  worth a t/3609-style hoist to lib/inquiry next time all three are touched. */
interface InquiryResultSummary {
  jobId: string;
  question: string;
  debateId: string | null;
  truncated: boolean;
  terminationReason?: string;
  createdAt: string;
}

const INQUIRY_INDEX_FILE = '_index.json';
function inquiryResultsDir(): string { return path.join(app.getPath('userData'), 'inquiry-results'); }

// jobId reaches `inquiryResultFile` from the renderer-supplied `get-inquiry` IPC param (untrusted —
// TS types are erased at runtime, per the Electron IPC boundary rule) as well as from our own
// randomUUID() jobs. Mirrors server storage/fileIO.ts's assertSafeId: reject anything outside
// alphanumeric/hyphen/underscore BEFORE it reaches a file path, closing the `../../etc/passwd`-style
// traversal a raw template-string join would otherwise allow.
const SAFE_JOB_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isSafeJobId(jobId: string): boolean { return SAFE_JOB_ID_RE.test(jobId); }
function inquiryResultFile(jobId: string): string { return path.join(inquiryResultsDir(), `inquiry-${jobId}.json`); }

function readInquiryIndex(): InquiryResultSummary[] {
  try { return JSON.parse(fs.readFileSync(path.join(inquiryResultsDir(), INQUIRY_INDEX_FILE), 'utf-8')) as InquiryResultSummary[]; }
  // eslint-disable-next-line local/require-warn-on-degraded-catch-return -- ENOENT on first run is normal new-user state; [] is the correct baseline, not a degraded fallback
  catch { /* no index yet / unreadable → empty list — silent by design (ADR-003) */ return []; }
}
function writeInquiryIndex(entries: InquiryResultSummary[]): void {
  fs.mkdirSync(inquiryResultsDir(), { recursive: true });
  fs.writeFileSync(path.join(inquiryResultsDir(), INQUIRY_INDEX_FILE), JSON.stringify(entries, null, 2), 'utf-8');
}
function upsertInquiryIndex(row: InquiryResultSummary): void {
  const entries = readInquiryIndex();
  const i = entries.findIndex(e => e.jobId === row.jobId);
  if (i >= 0) entries[i] = row; else entries.push(row);
  writeInquiryIndex(entries);
}

/** Persist a completed result BEFORE the caller flips the job to a terminal status — a poll
 *  observing `done`/`done_truncated` is then guaranteed the result is loadable (mirrors the
 *  server's ordering, inquiryJobs.ts). */
function persistInquiryResult(jobId: string, result: InquiryResult, summary: InquiryResultSummary): void {
  fs.mkdirSync(inquiryResultsDir(), { recursive: true });
  fs.writeFileSync(inquiryResultFile(jobId), JSON.stringify(result, null, 2), 'utf-8');
  upsertInquiryIndex(summary);
}

function loadPersistedInquiryResult(jobId: string): InquiryResult | null {
  try { return JSON.parse(fs.readFileSync(inquiryResultFile(jobId), 'utf-8')) as InquiryResult; }
  // eslint-disable-next-line local/require-warn-on-degraded-catch-return -- ENOENT means the result is absent (never run, swept before this feature landed, or unknown id); null is the correct "not found" outcome
  catch { /* result absent → null (get-inquiry surfaces "not found") — silent by design (ADR-003) */ return null; }
}

/** Best-effort dangle-tolerant debate reference off the (passthrough) result — mirrors
 *  server's readDebateRef (inquiryJobs.ts). The contract does not declare `debateId`. */
function readDebateRef(result: InquiryResult): string | null {
  const v = (result as unknown as Record<string, unknown>).debateId;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const PROGRESS: Record<InquiryJobStatus, number> = {
  queued: 0, grounding: 10, debating: 40, judging: 70, synthesizing: 90,
  done: 100, done_truncated: 100, failed: 100,
};

function setStatus(job: InquiryJob, status: InquiryJobStatus): void {
  job.status = status;
  job.progressPct = PROGRESS[status];
}

function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (isTerminalStatus(j.status) && now - j.startedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

// Map the pipeline's stage vocabulary (deriving/grounding/debating/projecting/synthesizing) onto the
// job's coarser status set — mirrors server inquiryPipelineDeps.ts's mapStage exactly.
function mapStage(stage: InquiryStage): InquiryJobStatus {
  switch (stage) {
    case 'deriving':
    case 'grounding': return 'grounding';
    case 'debating': return 'debating';
    case 'projecting': return 'judging';
    case 'synthesizing': return 'synthesizing';
    default: { const _x: never = stage; return _x; }
  }
}

// ── Grounding taxonomy (Electron-local corpus read) ──
//
// readTaxonomyFile only serves accelerationist/safetyist/skeptic (main process convention —
// see ipc/taxonomyHandlers.ts's POV_FILE_KEYS); unlike the server's getAssembledCorpus, there
// is no separate 'cross-cutting' pov file to read here. The cc camp's GroundingEnvelope entry
// stays empty from this build (nodesByCamp is a PARTIAL record by design, ADR-001) — the
// situationNodes (read via readTaxonomyFile('situations'), which itself falls back to
// cross-cutting.json) still populate the anchor-situation selection.
const POV_FILES = ['accelerationist', 'safetyist', 'skeptic'] as const;

async function buildGroundingTaxonomy(): Promise<GroundingTaxonomy> {
  const povNodes: GroundingTaxonomy['povNodes'] = [];
  const nodeEmbeddings: NodeEmbeddingMap = {};
  const sitFile = readTaxonomyFile('situations') as { nodes?: GroundingTaxonomy['situationNodes'] } | null;
  const situationNodes = sitFile?.nodes ?? [];
  const embed = (texts: string[], ids?: string[]): Promise<number[][]> => computeEmbeddings(texts, ids);

  for (const pov of POV_FILES) {
    try {
      const file = readTaxonomyFile(pov) as { nodes?: GroundingTaxonomy['povNodes'] } | null;
      // t/4432: exclude superseded nodes — grounding is new selection, not historical lookup
      // (SO C1, t/4355; same rule lib/debate/taxonomyLoader.ts's loadTaxonomy applies).
      const nodes = selectablePovNodes(file?.nodes ?? []);
      povNodes.push(...nodes);
      const { nodeEmbeddings: povEmbeddings } = await assembleNodeEmbeddings(pov, nodes, [], embed, null);
      Object.assign(nodeEmbeddings, povEmbeddings);
    } catch (err) {
      // A missing/unreadable pov file degrades to skipping that camp's nodes (envelope is
      // partial over camps by design) — WARN so the degradation is visible (root AGENTS.md).
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry-desktop', level: 'warn',
        message: `Grounding taxonomy: pov '${pov}' unreadable — skipped`,
        error: { name: (err as Error).name ?? 'Error', message: errorMessage(err) },
      });
    }
  }
  return { povNodes, situationNodes, nodeEmbeddings };
}

// Main-branch taxonomy is immutable at runtime within a single desktop session — memoize
// rather than re-reading per inquiry (mirrors server's getLoadedTaxonomy, t/3581).
let _loadedTaxonomy: LoadedTaxonomy | null = null;
function getLoadedTaxonomy(): LoadedTaxonomy {
  if (_loadedTaxonomy === null) _loadedTaxonomy = loadTaxonomy(PROJECT_ROOT);
  return _loadedTaxonomy;
}

// ── Job creation + async runner ──

function startJob(request: InquiryRequest): InquiryJob {
  sweepJobs();
  const job: InquiryJob = {
    jobId: randomUUID(),
    status: 'queued',
    progressPct: 0,
    terminationReason: null,
    resultId: null,
    error: null,
    result: null,
    startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);
  void runJob(job, request);
  return job;
}

async function runJob(job: InquiryJob, request: InquiryRequest): Promise<void> {
  try {
    const adapter = makeElectronAIAdapter('Inquiry');
    const deps: InquiryPipelineDeps = {
      registry: loadModelRegistry(PROJECT_ROOT),
      taxonomy: await buildGroundingTaxonomy(),
      embed: (texts: string[]) => computeEmbeddings(texts),
      // t/4025/t/4050: deriveDebateConfig runs inside runInquiryPipeline without a soulResolver
      // (InquiryPipelineDeps has no passthrough for it), so the config this lambda receives
      // lacks one. Add it here so Electron-run debates record soul_provenance like cli.ts does.
      runDebate: (config, _question) => runHeadlessDebate({ ...config, soulResolver: resolvePoverInfo }, adapter, getLoadedTaxonomy())
        .then(r => ({ session: r.session, terminationReason: r.terminationReason })),
      adapter,
      onStage: (stage: InquiryStage) => setStatus(job, mapStage(stage)),
    };
    const result = await runInquiryPipeline(request, deps);

    const { truncated, terminationReason } = deriveTruncation(result);
    job.result = result;
    job.resultId = job.jobId;
    job.terminationReason = terminationReason ?? null;

    // Persist BEFORE flipping to a terminal state (t/3683) — a poll observing done/done_truncated
    // is then guaranteed the result is loadable, and "My Questions" history survives the TTL
    // sweep / an app restart even though the in-memory job does not.
    try {
      persistInquiryResult(job.jobId, result, {
        jobId: job.jobId,
        question: request.question,
        debateId: readDebateRef(result),
        truncated,
        terminationReason,
        createdAt: new Date().toISOString(),
      });
    } catch (persistErr) {
      // A failed persist must not fail the inquiry itself — the user still sees their answer this
      // session, they just lose history durability for it. WARN so the degradation is visible.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'inquiry-desktop', level: 'warn',
        message: `Failed to persist inquiry result ${job.jobId} — answer is shown but will not survive an app restart`,
        error: { name: (persistErr as Error).name ?? 'Error', message: errorMessage(persistErr) },
      });
    }

    setStatus(job, truncated ? 'done_truncated' : 'done');
  } catch (err) {
    job.error = errorMessage(err);
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'inquiry-desktop', level: 'error',
      message: `Desktop inquiry job failed at ${job.status}`,
      error: { name: (err as Error).name ?? 'Error', message: job.error, stack: (err as Error).stack },
    });
    setStatus(job, 'failed');
  } finally {
    job.startedAt = Date.now(); // restart the TTL clock from the terminal state
  }
}

/** The poll view — matches Rosetta Stone's InquiryStatusResponse field names verbatim (t/3582#2). */
function jobView(job: InquiryJob): Record<string, unknown> {
  const base = {
    jobId: job.jobId,
    status: job.status,
    progressPct: job.progressPct,
    terminationReason: job.terminationReason,
    resultId: job.resultId,
    error: job.error,
  };
  return job.result ? { ...base, result: job.result } : base;
}

/** Cross-restart / post-TTL fallback view (t/3683) — mirrors the server's cross-replica fallback
 *  (routes/inquiry.ts). `useInquiryStore.ts` opens a "My Questions" history row by calling
 *  get-inquiry, so once the in-memory job is gone the persisted result must still resolve. */
function diskFallbackView(jobId: string): Record<string, unknown> | null {
  if (!isSafeJobId(jobId)) return null; // reject before it ever reaches a file path (t/3683)
  const result = loadPersistedInquiryResult(jobId);
  if (!result) return null;
  const { truncated, terminationReason } = deriveTruncation(result);
  return {
    jobId,
    status: truncated ? 'done_truncated' : 'done',
    progressPct: 100,
    terminationReason: terminationReason ?? null,
    resultId: jobId,
    error: null,
    result,
  };
}

// ── Export ──

/** Render `html` to a PDF buffer via an offscreen BrowserWindow — mirrors debateExport.ts's
 *  debateToPdf pattern exactly. */
async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const pdfWindow = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdfBuffer = await pdfWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdfBuffer);
  } finally {
    pdfWindow.destroy();
  }
}

// ── IPC registration ──

export function registerInquiryHandlers(): void {
  ipcMain.handle('start-inquiry', (_event, request: unknown): { jobId: string } => {
    const parsed = InquiryRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new Error('Invalid inquiry request: ' + parsed.error.message);
    }
    const job = startJob(parsed.data);
    return { jobId: job.jobId };
  });

  ipcMain.handle('get-inquiry', (_event, jobId: string): Record<string, unknown> | null => {
    const job = jobs.get(jobId);
    if (job) return jobView(job);
    return diskFallbackView(jobId); // job swept from memory / app restarted — try the disk (t/3683)
  });

  ipcMain.handle('list-inquiries', (): InquiryResultSummary[] => readInquiryIndex());

  ipcMain.handle('export-inquiry-to-file', async (
    event, result: InquiryResult, title: string, format: 'json' | 'markdown' | 'pdf',
  ): Promise<{ cancelled: boolean; filePath?: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { cancelled: true };

    const extMap: Record<typeof format, string> = { json: 'json', markdown: 'md', pdf: 'pdf' };
    const ext = extMap[format];
    const filterMap: Record<typeof format, { name: string; extensions: string[] }> = {
      json: { name: 'JSON', extensions: ['json'] },
      markdown: { name: 'Markdown', extensions: ['md'] },
      pdf: { name: 'PDF', extensions: ['pdf'] },
    };

    const dialogResult = await dialog.showSaveDialog(win, {
      title: 'Export Inquiry',
      defaultPath: inquiryExportFilename(title, ext),
      filters: [filterMap[format]],
    });
    if (dialogResult.canceled || !dialogResult.filePath) return { cancelled: true };
    const filePath = dialogResult.filePath;

    switch (format) {
      case 'json':
        fs.writeFileSync(filePath, inquiryToJson(result), 'utf-8');
        break;
      case 'markdown':
        fs.writeFileSync(filePath, inquiryToMarkdown(result), 'utf-8');
        break;
      case 'pdf':
        fs.writeFileSync(filePath, await renderHtmlToPdf(inquiryToPrintHtml(result)));
        break;
      default: { const _x: never = format; return _x; }
    }
    return { cancelled: false, filePath };
  });
}

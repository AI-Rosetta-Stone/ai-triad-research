// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Inquiry — Electron main-process handler tests (t/3579, t/3683). Mocks the shared
// runInquiryPipeline and every host-specific dep it's wired with, exercising the load-bearing
// cases: lifecycle (start returns immediately, poll observes queued → terminal), the error
// path, truncation classification (done_truncated vs done), and (t/3683) persistence — history
// listing, the disk fallback for a job unknown to the in-memory Map, and file export.
//
// Persistence assertions are real file round-trips against a temp userData dir (mirrors
// briefExportHandlers.test.ts), not a mocked fs — the whole point of t/3683 is the disk store.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = path.join(os.tmpdir(), `inquiry-handlers-test-${process.pid}`);

const mockShowSaveDialog = vi.hoisted(() => vi.fn());
const mockPrintToPDF = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3])));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => TMP) },
  dialog: { showSaveDialog: mockShowSaveDialog },
  BrowserWindow: Object.assign(
    vi.fn(function BrowserWindow() {
      return { loadURL: vi.fn(async () => {}), webContents: { printToPDF: mockPrintToPDF }, destroy: vi.fn() };
    }),
    { fromWebContents: vi.fn(() => ({})) },
  ),
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  readTaxonomyFile: vi.fn(() => ({ nodes: [] })),
}));
vi.mock('../embeddings.js', () => ({ computeEmbeddings: vi.fn(async () => []) }));
vi.mock('../electronAIAdapter.js', () => ({
  // t/3614: registry replaced getModelMinTimeout as the required AIAdapter member.
  makeElectronAIAdapter: vi.fn(() => ({ generateText: vi.fn(), registry: { backends: [], models: [] } })),
}));
vi.mock('../../../../lib/debate/relevanceSelection.js', () => ({
  assembleNodeEmbeddings: vi.fn(async () => ({ nodeEmbeddings: {}, allNodeIds: [] })),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: vi.fn() }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: vi.fn(() => ({})) }));
vi.mock('../../../../lib/ai-client/registry.js', () => ({ loadModelRegistry: vi.fn(() => ({})) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));

const runInquiryPipeline = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({ runInquiryPipeline }));

const saveDebateSession = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../debateIO.js', () => ({ saveDebateSession }));

import { ipcMain } from 'electron';
import { runHeadlessDebate } from '../../../../lib/debate/headlessRunner.js';
import { registerInquiryHandlers } from '../ipc/inquiryHandlers.js';
import type { InquiryResult } from '../../../../lib/inquiry/index.js';
import type { DebateSession } from '../../../../lib/debate/types/session.js';

type Handler = (...args: unknown[]) => unknown;
function handlers(): Record<string, Handler> {
  const map: Record<string, Handler> = {};
  for (const [ch, fn] of (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls) map[ch] = fn;
  return map;
}

const VALID_REQUEST = { question: 'Should AI be paused?', fidelity: 'quick' as const };

function fakeResult(over: Partial<InquiryResult> = {}): InquiryResult {
  return {
    schemaVersion: 1,
    request: VALID_REQUEST,
    campVerdicts: [],
    convergences: [],
    evidenceLayers: [],
    unresolvedGaps: [],
    calibration: [],
    derivation: { fidelity: 'quick', models: {}, rounds: 4, callBudget: 20 },
    grounding: { nodesByCamp: {} },
    singleRunCaveat: 'Single run; not yet replicated.',
    ...over,
  } as InquiryResult;
}

async function createAndWait(h: Record<string, Handler>, request: unknown = VALID_REQUEST) {
  const { jobId } = (await h['start-inquiry'](null, request)) as { jobId: string };
  for (let i = 0; i < 100; i++) {
    const job = (await h['get-inquiry'](null, jobId)) as { status: string } & Record<string, unknown>;
    if (job.status === 'done' || job.status === 'done_truncated' || job.status === 'failed') return { jobId, job };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not terminate');
}

describe('inquiryHandlers — Electron parity (t/3579)', () => {
  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    runInquiryPipeline.mockReset();
    mockShowSaveDialog.mockReset();
    mockPrintToPDF.mockClear();
    saveDebateSession.mockReset();
    (runHeadlessDebate as unknown as { mockReset: () => void }).mockReset();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    registerInquiryHandlers();
  });
  afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  it('start-inquiry returns { jobId } immediately, without waiting on the pipeline', async () => {
    let resolvePipeline: (r: InquiryResult) => void = () => {};
    runInquiryPipeline.mockImplementation(() => new Promise<InquiryResult>((res) => { resolvePipeline = res; }));
    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    expect(jobId).toBeTruthy();
    const job = (await h['get-inquiry'](null, jobId)) as { status: string };
    expect(job.status).toBe('queued');
    resolvePipeline(fakeResult());
  });

  it('lifecycle: queued → done, with result embedded and terminationReason null', async () => {
    runInquiryPipeline.mockResolvedValue(fakeResult());
    const h = handlers();
    const { job } = await createAndWait(h);
    expect(job.status).toBe('done');
    expect(job.terminationReason).toBeNull();
    expect(job.result).toBeTruthy();
    expect((job as { resultId: string }).resultId).toBeTruthy();
  });

  it('truncation: a censored calibration entry classifies the job as done_truncated with terminationReason surfaced', async () => {
    runInquiryPipeline.mockResolvedValue(fakeResult({
      calibration: [{ metric: 'convergence', value: 0.4, trust: { verdict: 'censored', reason: 'budget ceiling hit', terminationReason: 'api_ceiling' } }],
    }));
    const h = handlers();
    const { job } = await createAndWait(h);
    expect(job.status).toBe('done_truncated');
    expect(job.terminationReason).toBe('api_ceiling');
    expect(job.result).toBeTruthy();
  });

  it('error path: pipeline throws → job fails, get-inquiry surfaces the error message', async () => {
    runInquiryPipeline.mockRejectedValue(new Error('provider 503'));
    const h = handlers();
    const { job } = await createAndWait(h);
    expect(job.status).toBe('failed');
    expect(job.error).toBe('provider 503');
    expect(job.result).toBeUndefined();
  });

  it('start-inquiry rejects an invalid request (schema boundary) — never starts a job for it', () => {
    const h = handlers();
    expect(() => h['start-inquiry'](null, { question: '' })).toThrow(/Invalid inquiry request/);
    expect(runInquiryPipeline).not.toHaveBeenCalled();
  });

  it('get-inquiry on an unknown jobId returns null', async () => {
    const h = handlers();
    const result = await h['get-inquiry'](null, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('inquiryHandlers — persistence, history, export (t/3683)', () => {
  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    runInquiryPipeline.mockReset();
    mockShowSaveDialog.mockReset();
    mockPrintToPDF.mockClear();
    saveDebateSession.mockReset();
    (runHeadlessDebate as unknown as { mockReset: () => void }).mockReset();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    registerInquiryHandlers();
  });
  afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  it('list-inquiries returns [] when nothing has ever been persisted (ADR-001 graceful-empty)', async () => {
    const h = handlers();
    expect(await h['list-inquiries'](null)).toEqual([]);
  });

  it('a completed job is persisted to disk and appears in list-inquiries', async () => {
    runInquiryPipeline.mockResolvedValue(fakeResult());
    const h = handlers();
    const { jobId } = await createAndWait(h);
    const list = (await h['list-inquiries'](null)) as { jobId: string; question: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].jobId).toBe(jobId);
    expect(list[0].question).toBe(VALID_REQUEST.question);
  });

  it('a failed job is NOT persisted (only completed results are history)', async () => {
    runInquiryPipeline.mockRejectedValue(new Error('provider 503'));
    const h = handlers();
    await createAndWait(h);
    expect(await h['list-inquiries'](null)).toEqual([]);
  });

  it('get-inquiry falls back to the persisted result for a job unknown to the in-memory Map — the "My Questions" reopen path (useInquiryStore.ts)', async () => {
    // Simulates a job swept by the 30-min TTL or an app restart: never started via
    // start-inquiry (so `jobs` has no entry for it), but a result was previously persisted.
    const jobId = 'swept-job-id';
    const result = fakeResult();
    const dir = path.join(TMP, 'inquiry-results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `inquiry-${jobId}.json`), JSON.stringify(result), 'utf-8');
    fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify([
      { jobId, question: VALID_REQUEST.question, debateId: null, truncated: false, createdAt: new Date(0).toISOString() },
    ]), 'utf-8');

    const h = handlers();
    const view = (await h['get-inquiry'](null, jobId)) as { status: string; result?: unknown; resultId: string } | null;
    expect(view).not.toBeNull();
    expect(view!.status).toBe('done');
    expect(view!.resultId).toBe(jobId);
    expect(view!.result).toBeTruthy();
  });

  it('get-inquiry on a jobId with no memory entry AND no persisted file returns null', async () => {
    const h = handlers();
    expect(await h['get-inquiry'](null, 'never-existed')).toBeNull();
  });

  it('get-inquiry rejects a path-traversal jobId instead of reading outside inquiry-results/ (t/3683 security)', async () => {
    // A file that genuinely exists on disk, just outside the intended inquiry-results/ directory —
    // if the traversal guard were missing, `inquiry-${jobId}.json` would resolve to it.
    const secretPath = path.join(TMP, 'inquiry-secret.json');
    fs.writeFileSync(secretPath, JSON.stringify(fakeResult()), 'utf-8');
    const h = handlers();
    const traversalJobId = '../secret';
    expect(await h['get-inquiry'](null, traversalJobId)).toBeNull();
  });

  it('export-inquiry-to-file: json format writes via the shared inquiryToJson converter and returns the chosen path', async () => {
    const filePath = path.join(TMP, 'answer.json');
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const h = handlers();
    const result = fakeResult();
    const outcome = (await h['export-inquiry-to-file']({ sender: {} }, result, 'My question', 'json')) as { cancelled: boolean; filePath?: string };
    expect(outcome).toEqual({ cancelled: false, filePath });
    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written.result.schemaVersion).toBe(1);
    expect(written.question).toBe(VALID_REQUEST.question);
  });

  it('export-inquiry-to-file: markdown format writes readable text', async () => {
    const filePath = path.join(TMP, 'answer.md');
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const h = handlers();
    await h['export-inquiry-to-file']({ sender: {} }, fakeResult(), 'My question', 'markdown');
    expect(fs.readFileSync(filePath, 'utf-8').length).toBeGreaterThan(0);
  });

  it('export-inquiry-to-file: pdf format renders via printToPDF (offscreen BrowserWindow)', async () => {
    const filePath = path.join(TMP, 'answer.pdf');
    mockShowSaveDialog.mockResolvedValue({ canceled: false, filePath });
    const h = handlers();
    await h['export-inquiry-to-file']({ sender: {} }, fakeResult(), 'My question', 'pdf');
    expect(mockPrintToPDF).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(filePath).length).toBeGreaterThan(0);
  });

  it('export-inquiry-to-file: cancelling the save dialog returns { cancelled: true } and writes nothing', async () => {
    mockShowSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const h = handlers();
    const outcome = await h['export-inquiry-to-file']({ sender: {} }, fakeResult(), 'My question', 'json');
    expect(outcome).toEqual({ cancelled: true });
  });
});

// t/4682/t/4678: a question's debate must show up in "My Debates" and support "View raw run"
// on desktop — both depend on the full DebateSession (captured off deps.runDebate) being saved
// through debateIO, something runInquiryPipeline's own return value never carries.
describe('inquiryHandlers — saves the debate session for My Debates (t/4682)', () => {
  function fakeSession(id = 'sess-1'): DebateSession {
    return { id } as unknown as DebateSession;
  }

  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    runInquiryPipeline.mockReset();
    saveDebateSession.mockReset();
    (runHeadlessDebate as unknown as { mockReset: () => void }).mockReset();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    registerInquiryHandlers();
  });
  afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  it('saves the session with origin {mode: inquiry, inquiry_id: jobId} once the pipeline calls deps.runDebate', async () => {
    const session = fakeSession('sess-42');
    (runHeadlessDebate as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({ session, terminationReason: undefined });
    runInquiryPipeline.mockImplementation(async (request: unknown, deps: { runDebate: (c: unknown, q: string) => Promise<unknown> }) => {
      await deps.runDebate({}, (request as { question: string }).question);
      return fakeResult();
    });

    const h = handlers();
    const { jobId, job } = await createAndWait(h);

    expect(job.status).toBe('done');
    expect(saveDebateSession).toHaveBeenCalledTimes(1);
    expect(saveDebateSession).toHaveBeenCalledWith(session, 'inquiry-desktop');
    expect(session.origin).toEqual({ mode: 'inquiry', inquiry_id: jobId });
  });

  it('a saveDebateSession failure degrades gracefully — the job still reaches done with its answer intact', async () => {
    const session = fakeSession('sess-43');
    (runHeadlessDebate as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({ session, terminationReason: undefined });
    runInquiryPipeline.mockImplementation(async (request: unknown, deps: { runDebate: (c: unknown, q: string) => Promise<unknown> }) => {
      await deps.runDebate({}, (request as { question: string }).question);
      return fakeResult();
    });
    saveDebateSession.mockRejectedValue(new Error('disk full'));

    const h = handlers();
    const { job } = await createAndWait(h);

    expect(job.status).toBe('done');
    expect(job.result).toBeTruthy();
  });

  it('never calls saveDebateSession when the pipeline never invokes deps.runDebate (no regression on the non-inquiry path shape)', async () => {
    runInquiryPipeline.mockResolvedValue(fakeResult());
    const h = handlers();
    const { job } = await createAndWait(h);
    expect(job.status).toBe('done');
    expect(saveDebateSession).not.toHaveBeenCalled();
  });
});

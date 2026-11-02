// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4710/t/4711/t/4713: Electron's leg of the shared debate-progress mapping. The local
// PROGRESS table was replaced by lib/debate/debateProgressMapping.ts's stageProgress(), and
// deps.onDebateProgress now drives a fine-grained stageDetail line during the Debate stage.
// Mirrors inquiryHandlers.soulResolver.test.ts's mock scaffold — runInquiryPipeline's mock
// actually drives deps.onStage/onDebateProgress (rather than black-boxing it) so the real
// runJob wiring under test executes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageProgress } from '../../../../lib/debate/debateProgressMapping.js';

const TMP = path.join(os.tmpdir(), `inquiry-stage-progress-test-${process.pid}`);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => TMP) },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn(() => ({})) }),
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  readTaxonomyFile: vi.fn(() => ({ nodes: [] })),
}));
vi.mock('../embeddings.js', () => ({ computeEmbeddings: vi.fn(async () => []) }));
vi.mock('../electronAIAdapter.js', () => ({
  makeElectronAIAdapter: vi.fn(() => ({ generateText: vi.fn(), registry: { backends: [], models: [] } })),
}));
vi.mock('../../../../lib/debate/relevanceSelection.js', () => ({
  assembleNodeEmbeddings: vi.fn(async () => ({ nodeEmbeddings: {}, allNodeIds: [] })),
}));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: vi.fn() }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: vi.fn(() => ({})) }));
vi.mock('../../../../lib/ai-client/registry.js', () => ({ loadModelRegistry: vi.fn(() => ({})) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));
vi.mock('../debateIO.js', () => ({ saveDebateSession: vi.fn(async () => undefined) }));

const runInquiryPipeline = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({ runInquiryPipeline }));

import { ipcMain } from 'electron';
import { registerInquiryHandlers } from '../ipc/inquiryHandlers.js';
import type { InquiryResult } from '../../../../lib/inquiry/index.js';

type Handler = (...args: unknown[]) => unknown;
function handlers(): Record<string, Handler> {
  const map: Record<string, Handler> = {};
  for (const [ch, fn] of (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls) map[ch] = fn;
  return map;
}

const VALID_REQUEST = { question: 'Should AI be paused?', fidelity: 'quick' as const };

function fakeResult(): InquiryResult {
  return {
    schemaVersion: 1, request: VALID_REQUEST, campVerdicts: [], convergences: [],
    evidenceLayers: [], unresolvedGaps: [], calibration: [],
    derivation: { fidelity: 'quick', models: {}, rounds: 4, callBudget: 20 },
    grounding: { nodesByCamp: {} }, singleRunCaveat: 'x',
  } as unknown as InquiryResult;
}

type PipelineDeps = {
  onStage?: (s: string) => void;
  onDebateProgress?: (u: { fraction: number; detail: string }) => void;
};

async function waitForStatus(h: Record<string, Handler>, jobId: string, status: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const job = (await h['get-inquiry'](null, jobId)) as Record<string, unknown>;
    if (job.status === status) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`job never reached status "${status}"`);
}

async function waitForTerminal(h: Record<string, Handler>, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const job = (await h['get-inquiry'](null, jobId)) as { status: string } & Record<string, unknown>;
    if (job.status === 'done' || job.status === 'done_truncated' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not terminate');
}

describe('inquiryHandlers — stageProgress/stageDetail wiring (t/4713)', () => {
  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    runInquiryPipeline.mockReset();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    registerInquiryHandlers();
  });

  it('sets progressPct via the shared stageProgress() mapping and stageDetail from onDebateProgress while debating', async () => {
    let resolvePipeline: () => void = () => {};
    runInquiryPipeline.mockImplementation((_request: unknown, deps: PipelineDeps) => {
      deps.onStage?.('grounding');
      deps.onStage?.('debating');
      deps.onDebateProgress?.({ fraction: 0.5, detail: 'Round 2 of 4 · Skeptic responding' });
      return new Promise<InquiryResult>((res) => { resolvePipeline = () => res(fakeResult()); });
    });

    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const mid = await waitForStatus(h, jobId, 'debating');

    expect(mid.progressPct).toBe(stageProgress('debating', 0.5));
    expect(mid.stageDetail).toBe('Round 2 of 4 · Skeptic responding');

    resolvePipeline();
    await waitForTerminal(h, jobId);
  });

  it('clears stageDetail once the stage moves past debating', async () => {
    let resolvePipeline: () => void = () => {};
    runInquiryPipeline.mockImplementation((_request: unknown, deps: PipelineDeps) => {
      deps.onStage?.('debating');
      deps.onDebateProgress?.({ fraction: 1, detail: 'Closing arguments' });
      deps.onStage?.('projecting'); // mapStage → 'judging'
      return new Promise<InquiryResult>((res) => { resolvePipeline = () => res(fakeResult()); });
    });

    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const judging = await waitForStatus(h, jobId, 'judging');

    expect(judging.progressPct).toBe(stageProgress('judging'));
    expect(judging.stageDetail).toBeUndefined();

    resolvePipeline();
    await waitForTerminal(h, jobId);
  });

  it('never surfaces stageDetail on a terminal status (done)', async () => {
    runInquiryPipeline.mockImplementation((_request: unknown, deps: PipelineDeps) => {
      deps.onStage?.('debating');
      deps.onDebateProgress?.({ fraction: 0.2, detail: 'Opening statements' });
      deps.onStage?.('synthesizing');
      return Promise.resolve(fakeResult());
    });

    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const final = await waitForTerminal(h, jobId);

    expect(final.status).toBe('done');
    expect(final.progressPct).toBe(100);
    expect(final.stageDetail).toBeUndefined();
  });

  it('ignores a late debate-progress event after the stage has moved on (never goes backwards)', async () => {
    let resolvePipeline: () => void = () => {};
    runInquiryPipeline.mockImplementation((_request: unknown, deps: PipelineDeps) => {
      deps.onStage?.('debating');
      deps.onDebateProgress?.({ fraction: 0.9, detail: 'Closing arguments' });
      deps.onStage?.('projecting'); // mapStage → 'judging'
      deps.onDebateProgress?.({ fraction: 0.3, detail: 'Stale round' }); // late event
      return new Promise<InquiryResult>((res) => { resolvePipeline = () => res(fakeResult()); });
    });

    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const judging = await waitForStatus(h, jobId, 'judging');

    expect(judging.progressPct).toBe(stageProgress('judging'));
    expect(judging.stageDetail).toBeUndefined();

    resolvePipeline();
    await waitForTerminal(h, jobId);
  });

  it('a lower fraction while still debating does not move the bar backwards', async () => {
    let resolvePipeline: () => void = () => {};
    runInquiryPipeline.mockImplementation((_request: unknown, deps: PipelineDeps) => {
      deps.onStage?.('debating');
      deps.onDebateProgress?.({ fraction: 0.6, detail: 'Round 3 of 4' });
      deps.onDebateProgress?.({ fraction: 0.4, detail: 'Waiting to retry…' });
      return new Promise<InquiryResult>((res) => { resolvePipeline = () => res(fakeResult()); });
    });

    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const mid = await waitForStatus(h, jobId, 'debating');

    expect(mid.progressPct).toBe(stageProgress('debating', 0.6));
    expect(mid.stageDetail).toBe('Waiting to retry…');

    resolvePipeline();
    await waitForTerminal(h, jobId);
  });
});

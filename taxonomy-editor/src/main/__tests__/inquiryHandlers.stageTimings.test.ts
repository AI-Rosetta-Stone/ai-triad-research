// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/327: stageTimings through the real inquiryHandlers module. setStatus records the transitions
// (via lib's advanceStageTimings) and jobView/get-inquiry expose them. Mock scaffold mirrors
// inquiryHandlers.stageProgress.test.ts; Date.now is pinned per stage so the timestamps are exact.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = path.join(os.tmpdir(), `inquiry-stage-timings-test-${process.pid}`);

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

type PipelineDeps = { onStage?: (s: string) => void };

async function waitForTerminal(h: Record<string, Handler>, jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const job = (await h['get-inquiry'](null, jobId)) as { status: string } & Record<string, unknown>;
    if (job.status === 'done' || job.status === 'done_truncated' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not terminate');
}

describe('inquiryHandlers — stageTimings through the real module (t/327)', () => {
  let now: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
    runInquiryPipeline.mockReset();
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    now = vi.spyOn(Date, 'now');
    registerInquiryHandlers();
  });

  afterEach(() => {
    now.mockRestore();
  });

  it('get-inquiry always sends stageTimings with all four stages, empty until entered', async () => {
    runInquiryPipeline.mockImplementation(() => new Promise(() => {})); // never settles
    now.mockReturnValue(1000);
    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };

    const view = (await h['get-inquiry'](null, jobId)) as { stageTimings?: Record<string, unknown> };
    expect(view.stageTimings).toEqual({ grounding: {}, debating: {}, judging: {}, synthesizing: {} });
  });

  it('happy path: each stage ends where the next starts, and done ends the final stage', async () => {
    runInquiryPipeline.mockImplementation(async (_request: unknown, deps: PipelineDeps) => {
      now.mockReturnValue(1000); deps.onStage?.('grounding');
      now.mockReturnValue(2000); deps.onStage?.('debating');
      now.mockReturnValue(3000); deps.onStage?.('judging');
      now.mockReturnValue(4000); deps.onStage?.('synthesizing');
      now.mockReturnValue(5000);
      return fakeResult();
    });
    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const job = await waitForTerminal(h, jobId);

    expect(job.status).toBe('done');
    expect(job.stageTimings).toEqual({
      grounding: { startedAt: 1000, endedAt: 2000 },
      debating: { startedAt: 2000, endedAt: 3000 },
      judging: { startedAt: 3000, endedAt: 4000 },
      synthesizing: { startedAt: 4000, endedAt: 5000 },
    });
  });

  it('failed job: the stage it died in gets an endedAt; later stages stay unstarted', async () => {
    runInquiryPipeline.mockImplementation(async (_request: unknown, deps: PipelineDeps) => {
      now.mockReturnValue(1000); deps.onStage?.('grounding');
      now.mockReturnValue(2000); deps.onStage?.('debating');
      now.mockReturnValue(3000);
      throw new Error('debate exploded');
    });
    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const job = await waitForTerminal(h, jobId);

    expect(job.status).toBe('failed');
    expect(job.stageTimings).toEqual({
      grounding: { startedAt: 1000, endedAt: 2000 },
      debating: { startedAt: 2000, endedAt: 3000 },
      judging: {},
      synthesizing: {},
    });
  });

  it('a same-stage repeat (deriving then grounding) does not restart the stage clock', async () => {
    runInquiryPipeline.mockImplementation(async (_request: unknown, deps: PipelineDeps) => {
      now.mockReturnValue(1000); deps.onStage?.('deriving'); // mapStage → 'grounding'
      now.mockReturnValue(1500); deps.onStage?.('grounding'); // same status: not a transition
      now.mockReturnValue(2000); deps.onStage?.('debating');
      now.mockReturnValue(3000);
      return fakeResult();
    });
    const h = handlers();
    const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
    const job = await waitForTerminal(h, jobId);

    expect((job.stageTimings as Record<string, unknown>).grounding).toEqual({ startedAt: 1000, endedAt: 2000 });
  });
});

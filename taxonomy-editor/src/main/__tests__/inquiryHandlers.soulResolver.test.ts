// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4025/t/4050 — the Electron inquiry job runner's `deps.runDebate` lambda must pass
// `soulResolver: resolvePoverInfo` into the config it hands to `runHeadlessDebate`, so Electron
// debates record `soul_provenance` the same way cli.ts already does (DebateTool's PR #3013 added
// the `soulResolver` param to `deriveDebateConfig`, but `runInquiryPipeline` calls it without one —
// this lambda is where Electron adds it back). Mirrors inquiryHandlers.test.ts's mock scaffold,
// but `runInquiryPipeline`'s mock actually invokes `deps.runDebate` (rather than black-boxing it)
// so the real lambda under test runs and its call into `runHeadlessDebate` can be inspected.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = path.join(os.tmpdir(), `inquiry-soul-resolver-test-${process.pid}`);

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

const mockRunHeadlessDebate = vi.hoisted(() => vi.fn(async () => ({ session: {}, terminationReason: null })));
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: mockRunHeadlessDebate }));

vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: vi.fn(() => ({})) }));
vi.mock('../../../../lib/ai-client/registry.js', () => ({ loadModelRegistry: vi.fn(() => ({})) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));
// t/4682: inquiryHandlers now imports debateIO.js (to save the session for My Debates), whose
// top-level resolveDataPath() call this file's bare fileIO.js mock doesn't provide — stub the
// whole module out, this file isn't exercising that save path.
vi.mock('../debateIO.js', () => ({ saveDebateSession: vi.fn(async () => undefined) }));

const FAKE_CONFIG = { topic: 'q', activePovers: ['accelerationist'] } as unknown;

// Invokes deps.runDebate itself, mirroring what runInquiryPipeline actually does internally —
// this is the only way to exercise the real lambda rather than treating it as a black box.
const runInquiryPipeline = vi.hoisted(() => vi.fn(async (_request: unknown, deps: { runDebate: (c: unknown, q: string) => Promise<unknown> }) => {
  await deps.runDebate(FAKE_CONFIG, 'q');
  return {
    schemaVersion: 1, request: { question: 'q', fidelity: 'quick' }, campVerdicts: [], convergences: [],
    evidenceLayers: [], unresolvedGaps: [], calibration: [],
    derivation: { fidelity: 'quick', models: {}, rounds: 4, callBudget: 20 },
    grounding: { nodesByCamp: {} }, singleRunCaveat: 'x',
  };
}));
vi.mock('../../../../lib/debate/inquiryPipeline.js', () => ({ runInquiryPipeline }));

import { ipcMain } from 'electron';
import { registerInquiryHandlers } from '../ipc/inquiryHandlers.js';

type Handler = (...args: unknown[]) => unknown;
function handlers(): Record<string, Handler> {
  const map: Record<string, Handler> = {};
  for (const [ch, fn] of (ipcMain.handle as unknown as { mock: { calls: [string, Handler][] } }).mock.calls) map[ch] = fn;
  return map;
}

const VALID_REQUEST = { question: 'Should AI be paused?', fidelity: 'quick' as const };

async function createAndWait(h: Record<string, Handler>) {
  const { jobId } = (await h['start-inquiry'](null, VALID_REQUEST)) as { jobId: string };
  for (let i = 0; i < 100; i++) {
    const job = (await h['get-inquiry'](null, jobId)) as { status: string };
    if (job.status === 'done' || job.status === 'done_truncated' || job.status === 'failed') return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job did not terminate');
}

beforeEach(() => {
  (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
  mockRunHeadlessDebate.mockClear();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  registerInquiryHandlers();
});

describe('inquiryHandlers — runDebate wires soulResolver into runHeadlessDebate (t/4050)', () => {
  it('REGRESSION: the config passed to runHeadlessDebate carries soulResolver, resolving to the real resolvePoverInfo', async () => {
    const h = handlers();
    await createAndWait(h);

    expect(mockRunHeadlessDebate).toHaveBeenCalledOnce();
    const [configArg] = mockRunHeadlessDebate.mock.calls[0] as [{ soulResolver?: unknown }];
    expect(configArg.soulResolver).toBeDefined();
    expect(typeof configArg.soulResolver).toBe('function');
  });

  it('the original config fields pass through unchanged alongside soulResolver', async () => {
    const h = handlers();
    await createAndWait(h);

    const [configArg] = mockRunHeadlessDebate.mock.calls[0] as [{ topic?: string; activePovers?: string[] }];
    expect(configArg.topic).toBe('q');
    expect(configArg.activePovers).toEqual(['accelerationist']);
  });
});

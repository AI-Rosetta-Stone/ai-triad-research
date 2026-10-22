// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4432 (t/4424 audit): `buildGroundingTaxonomy()` reads raw POV files and feeds
 * `InquiryPipelineDeps.taxonomy`, consumed by `runInquiryPipeline` for inquiry grounding and
 * relevance — a new-selection surface, so a superseded node must be excluded (SO C1, t/4355).
 * Mirrors inquiryHandlers.test.ts's scaffold: `runInquiryPipeline` is mocked so its call args
 * (specifically `deps.taxonomy.povNodes`) can be captured; the real `selectablePovNodes` filter
 * (lib/debate/supersession.js) is NOT mocked, since that's exactly what's under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TMP = path.join(os.tmpdir(), `inquiry-superseded-grounding-${process.pid}`);

const h = vi.hoisted(() => ({
  povFileNodes: [] as unknown[],
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => TMP) },
  dialog: { showSaveDialog: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn(() => ({})) }),
}));

vi.mock('../fileIO.js', () => ({
  PROJECT_ROOT: '/fake/root',
  readTaxonomyFile: vi.fn((pov: string) => (pov === 'situations' ? { nodes: [] } : { nodes: h.povFileNodes })),
}));
vi.mock('../embeddings.js', () => ({ computeEmbeddings: vi.fn(async () => []) }));
vi.mock('../electronAIAdapter.js', () => ({
  makeElectronAIAdapter: vi.fn(() => ({ generateText: vi.fn(), registry: { backends: [], models: [] } })),
}));
// assembleNodeEmbeddings is real: no mock for lib/debate/relevanceSelection.js — buildGroundingTaxonomy
// calls it directly with the already-filtered nodes, so the production code path is exercised whole.
vi.mock('../../../../lib/debate/headlessRunner.js', () => ({ runHeadlessDebate: vi.fn() }));
vi.mock('../../../../lib/debate/taxonomyLoader.js', () => ({ loadTaxonomy: vi.fn(() => ({})) }));
vi.mock('../../../../lib/ai-client/registry.js', () => ({ loadModelRegistry: vi.fn(() => ({})) }));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn(() => null) }));

const runInquiryPipeline = vi.hoisted(() => vi.fn());
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
const LIVE = { id: 'acc-desires-100', label: 'Live node', description: 'd' };
const SUPERSEDED = { id: 'acc-desires-099', label: 'Old node', description: 'd', superseded_by: 'acc-desires-100' };

beforeEach(() => {
  (ipcMain.handle as unknown as { mockReset: () => void }).mockReset();
  runInquiryPipeline.mockReset();
  h.povFileNodes = [SUPERSEDED, LIVE];
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  registerInquiryHandlers();
});
afterEach(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('buildGroundingTaxonomy: excludes superseded nodes from inquiry grounding (t/4432)', () => {
  it("the pipeline's taxonomy.povNodes omits the superseded node and keeps the live one", async () => {
    let capturedDeps: { taxonomy?: { povNodes?: { id: string }[] } } | undefined;
    runInquiryPipeline.mockImplementation((_req: unknown, deps: typeof capturedDeps) => {
      capturedDeps = deps;
      return Promise.resolve({
        schemaVersion: 1, request: VALID_REQUEST, campVerdicts: [], convergences: [],
        evidenceLayers: [], unresolvedGaps: [], calibration: [],
        derivation: { fidelity: 'quick', models: {}, rounds: 4, callBudget: 20 },
        grounding: { nodesByCamp: {} }, singleRunCaveat: 'x',
      });
    });
    const h2 = handlers();
    await h2['start-inquiry'](null, VALID_REQUEST);
    // Give buildGroundingTaxonomy's async work (inside start-inquiry) a tick to run.
    await new Promise((r) => setTimeout(r, 20));

    const ids = capturedDeps?.taxonomy?.povNodes?.map(n => n.id) ?? [];
    expect(ids).toContain('acc-desires-100');
    expect(ids).not.toContain('acc-desires-099');
  });
});

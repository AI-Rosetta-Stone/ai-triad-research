// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression gate: engine respects calibrationDataRoot from DebateConfig (t/2219).
// When set, the engine's appendCalibrationLog call must use it — not the system-resolved
// dataRoot — so isolated experiment runs don't contaminate the main calibration log.

import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('./calibrationLogger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./calibrationLogger.js')>();
  return {
    ...actual,
    appendCalibrationLog: vi.fn(),
    readCalibrationLog: vi.fn().mockReturnValue([]),
  };
});

// Hermetic data root (t/56): without this, resolveDataRoot throws wherever
// ../ai-triad-data is absent (e.g. .worktrees/<name>), the calibration block
// swallows it, and appendCalibrationLog is never reached.
vi.mock('./taxonomyLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taxonomyLoader.js')>();
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-iso-'));
  return { ...actual, resolveDataRoot: () => dataRoot, loadConflicts: () => [] };
});

import { DebateEngine } from './debateEngine.js';
import { appendCalibrationLog } from './calibrationLogger.js';
import { createMockAdapter, createMinimalTaxonomy, createDefaultConfig } from './debateEngine.testHelpers.js';

const richResponse = JSON.stringify({
  statement: 'Mock response', my_claims: [], taxonomy_refs: [],
  move_types: [], claims: [], areas_of_agreement: [],
  areas_of_disagreement: [], cruxes: [], unresolved_questions: [],
  summary: 'Mock', responder: 'safetyist', addressing: 'accelerationist',
  focus_point: 'test', agreement_detected: false, intervene: false,
  suggested_move: 'PIN', target_debater: 'safetyist',
  trigger_reasoning: 'r', trigger_evidence: 'e',
  outcome: 'accept', score: 0.8, flags: [], clarifies_taxonomy: [],
  overall_assessment: { notes: 'test' },
});
const manyResponses = Array.from({ length: 300 }, () => richResponse);

describe('DebateEngine calibrationDataRoot isolation (t/2219)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls appendCalibrationLog with calibrationDataRoot when set', async () => {
    const calRoot = '/isolated/cal-root';
    const config = createDefaultConfig({ rounds: 1, calibrationDataRoot: calRoot });
    const engine = new DebateEngine(config, createMockAdapter(manyResponses), createMinimalTaxonomy());
    await engine.run();

    const mockFn = vi.mocked(appendCalibrationLog);
    expect(mockFn).toHaveBeenCalledTimes(1); // exactly one write per debate (t/2716)
    expect(mockFn.mock.calls[0][1]).toBe(calRoot);
  });

  it('calls appendCalibrationLog with system dataRoot when calibrationDataRoot is not set', async () => {
    const config = createDefaultConfig({ rounds: 1 });
    const engine = new DebateEngine(config, createMockAdapter(manyResponses), createMinimalTaxonomy());
    await engine.run();

    const mockFn = vi.mocked(appendCalibrationLog);
    expect(mockFn).toHaveBeenCalledTimes(1); // exactly one write per debate (t/2716)
    // Must be a non-empty filesystem path — not '/isolated/cal-root'
    const calledRoot = mockFn.mock.calls[0][1];
    expect(typeof calledRoot).toBe('string');
    expect(calledRoot.length).toBeGreaterThan(0);
    expect(calledRoot).not.toBe('/isolated/cal-root');
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/58: when calibration logging fails before the row is written (e.g. the data
// root does not resolve), the WARN must say the debate was skipped, not just
// "non-critical".

import { describe, it, expect, vi } from 'vitest';

vi.mock('./calibrationLogger.js', async (importOriginal) =>
  (await import('./__tests__/hermeticCalibration.js')).hermeticCalibrationLogger(importOriginal));

vi.mock('./taxonomyLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taxonomyLoader.js')>();
  return {
    ...actual,
    resolveDataRoot: () => { throw new Error('data root missing (test)'); },
    loadConflicts: () => [],
  };
});

import { DebateEngine } from './debateEngine.js';
import type { DebateProgress } from './debateEngine.js';
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

describe('calibration-skip WARN (t/58)', () => {
  it('names the skip and the cause when the data root does not resolve', async () => {
    const warnings: string[] = [];
    const engine = new DebateEngine(
      createDefaultConfig({ rounds: 1 }),
      createMockAdapter(Array.from({ length: 300 }, () => richResponse)),
      createMinimalTaxonomy(),
    );
    await engine.run((p: DebateProgress) => {
      if (p.phase === 'warning' && p.message) warnings.push(p.message);
    });

    expect(vi.mocked(appendCalibrationLog)).not.toHaveBeenCalled();
    const cal = warnings.filter(w => w.includes('Calibration logging'));
    expect(cal).toHaveLength(1);
    expect(cal[0]).toContain('data root missing (test)');
    expect(cal[0]).toContain('NOT written to the calibration log');
  }, 20_000);
});

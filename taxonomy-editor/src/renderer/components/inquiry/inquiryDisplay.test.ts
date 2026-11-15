// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { isZeroResult, stageStatus, trustVerdictLabel, STAGE_ORDER, formatStageElapsed, formatStageElapsedSpoken } from './inquiryDisplay';
import type { InquiryResult } from '@lib/inquiry';

function makeResult(overrides: Partial<InquiryResult> = {}): InquiryResult {
  return {
    schemaVersion: 1,
    request: { question: 'q', fidelity: 'standard' },
    campVerdicts: [],
    convergences: [],
    evidenceLayers: [],
    unresolvedGaps: [],
    calibration: [],
    derivation: { fidelity: 'standard', models: {}, rounds: 4, callBudget: 150 },
    grounding: {},
    singleRunCaveat: 'n=1',
    ...overrides,
  };
}

describe('isZeroResult (t/3583#4 point 2 — ADR-001 graceful-empty needs its own treatment)', () => {
  it('is true when campVerdicts, convergences, and evidenceLayers are all empty', () => {
    expect(isZeroResult(makeResult())).toBe(true);
  });

  it('is false when any of the three arrays has content', () => {
    expect(isZeroResult(makeResult({ campVerdicts: [{ camp: 'acc', verdict: 'x', nodes: [] }] }))).toBe(false);
    expect(isZeroResult(makeResult({ convergences: [{ claim: 'x', nodes: [] }] }))).toBe(false);
    expect(isZeroResult(makeResult({ evidenceLayers: [{ title: 't', role: 'r', solves: 's', sources: [] }] }))).toBe(false);
  });
});

describe('trustVerdictLabel', () => {
  it('renders the researcher-facing label, not the internal enum value (TL t/3583#2)', () => {
    expect(trustVerdictLabel('censored')).toBe('incomplete');
    expect(trustVerdictLabel('trust')).toBe('trust');
  });
});

describe('stageStatus', () => {
  it('marks every stage waiting when queued or null', () => {
    for (const stage of STAGE_ORDER) {
      expect(stageStatus('queued', stage)).toBe('wait');
      expect(stageStatus(null, stage)).toBe('wait');
    }
  });

  it('marks earlier stages done, the current stage live, later stages waiting', () => {
    expect(stageStatus('judging', 'grounding')).toBe('done');
    expect(stageStatus('judging', 'debating')).toBe('done');
    expect(stageStatus('judging', 'judging')).toBe('live');
    expect(stageStatus('judging', 'synthesizing')).toBe('wait');
  });
});

describe('formatStageElapsed (t/324)', () => {
  it('formats m:ss, rolling to h:mm:ss at one hour', () => {
    expect(formatStageElapsed(0)).toBe('0:00');
    expect(formatStageElapsed(7_900)).toBe('0:07');
    expect(formatStageElapsed(102_000)).toBe('1:42');
    expect(formatStageElapsed(725_000)).toBe('12:05');
    expect(formatStageElapsed(3_600_000)).toBe('1:00:00');
    expect(formatStageElapsed(3_725_000)).toBe('1:02:05');
  });
  it('clamps negative input to 0:00', () => {
    expect(formatStageElapsed(-5_000)).toBe('0:00');
  });
  it('speaks the full form for screen readers', () => {
    expect(formatStageElapsedSpoken(102_000)).toBe('1 minute 42 seconds');
    expect(formatStageElapsedSpoken(1_000)).toBe('1 second');
    expect(formatStageElapsedSpoken(120_000)).toBe('2 minutes');
    expect(formatStageElapsedSpoken(3_725_000)).toBe('1 hour 2 minutes 5 seconds');
    expect(formatStageElapsedSpoken(0)).toBe('0 seconds');
  });
});

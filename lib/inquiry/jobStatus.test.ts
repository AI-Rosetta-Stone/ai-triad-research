// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Unit coverage for the hoisted inquiry job-status vocabulary (t/3609). These pin the two behaviours
// three hosts formerly duplicated: the terminal classification (server isTerminalStatus / main
// isTerminal / renderer isInquiryTerminal — all verified byte-equivalent before the collapse) and the
// truncation derivation. The exhaustive-switch guarantee is enforced by tsc, not runtime, so it isn't
// asserted here; a new unclassified status is a COMPILE error at this single site.

import { describe, it, expect } from 'vitest';
import { isTerminalStatus, deriveTruncation, TRUNCATION_REASONS, advanceStageTimings } from './jobStatus.js';
import type { InquiryResult } from './schema.js';

/** Minimal InquiryResult carrying only the calibration trust states deriveTruncation reads. */
function resultWithTrust(entries: Array<{ verdict: 'trust' | 'censored'; terminationReason?: string }>): InquiryResult {
  return {
    calibration: entries.map((e) => ({ trust: { verdict: e.verdict, terminationReason: e.terminationReason } })),
  } as unknown as InquiryResult;
}

describe('isTerminalStatus', () => {
  it('classifies done / done_truncated / failed as terminal', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('done_truncated')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
  });

  it('classifies queued and every pipeline stage as non-terminal', () => {
    for (const s of ['queued', 'grounding', 'debating', 'judging', 'synthesizing'] as const) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

describe('deriveTruncation', () => {
  it('reports not-truncated when every metric trusts and no budget reason fired', () => {
    expect(deriveTruncation(resultWithTrust([{ verdict: 'trust' }, { verdict: 'trust', terminationReason: 'natural' }])))
      .toEqual({ truncated: false });
  });

  it('reports truncated on a censored verdict, carrying its terminationReason', () => {
    expect(deriveTruncation(resultWithTrust([{ verdict: 'trust' }, { verdict: 'censored', terminationReason: 'api_ceiling' }])))
      .toEqual({ truncated: true, terminationReason: 'api_ceiling' });
  });

  it('reports truncated on a budget-binding terminationReason even when the verdict trusts', () => {
    for (const tr of TRUNCATION_REASONS) {
      expect(deriveTruncation(resultWithTrust([{ verdict: 'trust', terminationReason: tr }])))
        .toEqual({ truncated: true, terminationReason: tr });
    }
  });

  it('does NOT truncate on a non-budget terminationReason (e.g. natural)', () => {
    expect(deriveTruncation(resultWithTrust([{ verdict: 'trust', terminationReason: 'natural' }])))
      .toEqual({ truncated: false });
  });

  it('returns not-truncated for an empty calibration array', () => {
    expect(deriveTruncation(resultWithTrust([]))).toEqual({ truncated: false });
  });
});

describe('advanceStageTimings', () => {
  function newTimings() {
    return {
      grounding: {},
      debating: {},
      judging: {},
      synthesizing: {},
    };
  }

  it('records startedAt when entering the first stage from queued', () => {
    const timings = newTimings();
    advanceStageTimings(timings, undefined, 'grounding', 1000);
    expect(timings.grounding.startedAt).toBe(1000);
    expect(timings.grounding.endedAt).toBeUndefined();
    expect(timings.debating.startedAt).toBeUndefined();
  });

  it('records endedAt on prev stage and startedAt on next stage when advancing', () => {
    const timings = newTimings();
    advanceStageTimings(timings, undefined, 'grounding', 1000);
    advanceStageTimings(timings, 'grounding', 'debating', 2000);
    expect(timings.grounding.endedAt).toBe(2000);
    expect(timings.debating.startedAt).toBe(2000);
  });

  it('advances through all four stages correctly', () => {
    const timings = newTimings();
    advanceStageTimings(timings, undefined, 'grounding', 1000);
    advanceStageTimings(timings, 'grounding', 'debating', 2000);
    advanceStageTimings(timings, 'debating', 'judging', 3000);
    advanceStageTimings(timings, 'judging', 'synthesizing', 4000);
    expect(timings.grounding).toEqual({ startedAt: 1000, endedAt: 2000 });
    expect(timings.debating).toEqual({ startedAt: 2000, endedAt: 3000 });
    expect(timings.judging).toEqual({ startedAt: 3000, endedAt: 4000 });
    expect(timings.synthesizing).toEqual({ startedAt: 4000 });
  });

  it('returns the updated timings object', () => {
    const timings = newTimings();
    const result = advanceStageTimings(timings, undefined, 'grounding', 1000);
    expect(result).toBe(timings);
  });
});

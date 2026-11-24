// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { debaterTurns, relevanceDrift, relevanceResult, fieldCentroid, residualSimilarity, residualScores } from './inquiryRelevance.js';
import type { TranscriptEntry } from './types/session.js';

const turn = (id: string, speaker: string, content = 'text') =>
  ({ id, speaker, type: 'statement', content, taxonomy_refs: [] }) as unknown as TranscriptEntry;

const scores = (...xs: number[]) => xs.map((similarity, i) => ({ entry_id: `t${i}`, similarity }));

describe('debaterTurns (t/284 item 5)', () => {
  it('keeps debater turns and drops system, moderator, and empty entries', () => {
    const out = debaterTurns([
      turn('a', 'accelerationist'),
      turn('b', 'system'),
      turn('c', 'moderator'),
      turn('d', 'skeptic', '   '),
      { ...turn('e', 'safetyist'), type: 'system' } as unknown as TranscriptEntry,
    ]);
    expect(out.map(e => e.id)).toEqual(['a']);
  });
});

describe('relevanceDrift (t/284 item 5 thresholds)', () => {
  it('warns when the mean is below 0.35', () => {
    expect(relevanceDrift(scores(0.3, 0.3, 0.4)).warn).toBe(true);
  });

  it('warns on 3 consecutive turns below 0.25 even when the mean is fine', () => {
    const r = relevanceDrift(scores(0.9, 0.2, 0.2, 0.2, 0.9));
    expect(r.warn).toBe(true);
    expect(r.reason).toContain('3 consecutive');
  });

  it('does not warn on 2 consecutive low turns with a good mean', () => {
    expect(relevanceDrift(scores(0.9, 0.2, 0.2, 0.9)).warn).toBe(false);
  });

  it('does not warn on an empty run', () => {
    expect(relevanceDrift([]).warn).toBe(false);
  });
});

describe('relevanceResult', () => {
  it('reports a null mean for no turns, so nothing is faked', () => {
    expect(relevanceResult([]).mean).toBeNull();
  });

  it('reports the mean and the drift flag', () => {
    const r = relevanceResult(scores(0.5, 0.7));
    expect(r.mean).toBeCloseTo(0.6);
    expect(r.drift_warning).toBe(false);
  });
});

describe('residual similarity (t/496)', () => {
  it('fieldCentroid is the mean of the vectors of the right dimension, or undefined when there are none', () => {
    expect(fieldCentroid([[1, 0], [3, 2], [9, 9, 9]], 2)).toEqual([2, 1]);
    expect(fieldCentroid([], 2)).toBeUndefined();
    expect(fieldCentroid([[1, 2, 3]], 2)).toBeUndefined();
  });

  it('removes the shared component: two texts that differ only by the centroid direction stop looking alike', () => {
    // Both vectors are dominated by the field direction [1, 0]; their own parts point opposite ways.
    const centroid = [10, 0];
    const a = [10, 1], b = [10, -1];
    expect(residualSimilarity(a, b, centroid)).toBeCloseTo(-1);
    expect(residualSimilarity(a, [10, 2], centroid)).toBeCloseTo(1);
  });

  it('scores each turn in order and gives the mean', () => {
    const entries = [turn('e1', 'safetyist'), turn('e2', 'skeptic')];
    const out = residualScores(entries, [[10, 1], [10, -1]], [10, 1], [10, 0]);
    expect(out.residual_similarity.map(t => t.entry_id)).toEqual(['e1', 'e2']);
    expect(out.residual_similarity[0].similarity).toBeCloseTo(1);
    expect(out.residual_similarity[1].similarity).toBeCloseTo(-1);
    expect(out.residual_mean).toBeCloseTo(0);
  });

  it('gives a null mean for no turns', () => {
    expect(residualScores([], [], [1, 0], [0, 0])).toEqual({ residual_similarity: [], residual_mean: null });
  });
});

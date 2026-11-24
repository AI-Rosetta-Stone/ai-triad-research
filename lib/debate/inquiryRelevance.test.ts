// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { debaterTurns, relevanceDrift, relevanceResult } from './inquiryRelevance.js';
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

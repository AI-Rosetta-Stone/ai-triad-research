// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { buildDebateOptions } from './newDebateOptions';

const base = {
  debateTitle: '',
  background: '',
  evaluatorModel: '',
  confrontationRounds: 2,
  argumentationRounds: 3,
  concludingRounds: 1,
  stepMode: false,
  narrativeVoicing: false,
  stageModels: { brief: '', plan: '', cite: '' },
};

describe('buildDebateOptions — excludeGreatestHits toggle wiring (t/1979)', () => {
  it('passes excludeGreatestHits: true when the Setup toggle is on', () => {
    expect(buildDebateOptions({ ...base, excludeGreatestHits: true }).excludeGreatestHits).toBe(true);
  });

  it('omits excludeGreatestHits (undefined) when off — the store coalesces to false', () => {
    // Off should not send an explicit false; sessionSlice writes `?? false`, so undefined ⇒ Off.
    expect(buildDebateOptions({ ...base, excludeGreatestHits: false }).excludeGreatestHits).toBeUndefined();
  });

  it('leaves unrelated fields intact', () => {
    const opts = buildDebateOptions({ ...base, excludeGreatestHits: true });
    expect(opts.useAdaptiveStaging).toBe(true);
    expect(opts.phaseBoundsOverride?.maxArgumentationRounds).toBe(3);
  });
});

describe('buildDebateOptions — narrative voicing toggle wiring (h3)', () => {
  it('passes narrativeVoicing: true when on and omits it when off', () => {
    expect(buildDebateOptions({ ...base, excludeGreatestHits: false, narrativeVoicing: true }).narrativeVoicing).toBe(true);
    expect(buildDebateOptions({ ...base, excludeGreatestHits: false }).narrativeVoicing).toBeUndefined();
  });
});

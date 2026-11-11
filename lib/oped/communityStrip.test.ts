// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { stripOpEdStagesForCommunity } from './communityStrip.js';

const stage = { stage: 'generation', attempt: 1, model: 'm', prompt: 'SOURCE MATERIAL: private text', output: 'o' };

describe('stripOpEdStagesForCommunity (t/171)', () => {
  it('drops stages from every member and keeps everything else', () => {
    const set = { topic: 't', opeds: [{ pov: 'skeptic', body: 'b', stages: [stage] }, { pov: 'safetyist', body: 'c' }] };
    expect(stripOpEdStagesForCommunity(set)).toEqual({ topic: 't', opeds: [{ pov: 'skeptic', body: 'b' }, { pov: 'safetyist', body: 'c' }] });
  });

  it('does not mutate its input', () => {
    const set = { opeds: [{ pov: 'skeptic', stages: [stage] }] };
    stripOpEdStagesForCommunity(set);
    expect(set.opeds[0].stages).toHaveLength(1);
  });

  it('leaves non-op-ed shapes alone, including a top-level stages key (debate diagnostics use one)', () => {
    const debate = { id: 'd', stages: [{ name: 'context-rot' }] };
    expect(stripOpEdStagesForCommunity(debate)).toBe(debate);
    expect(stripOpEdStagesForCommunity(null)).toBeNull();
    expect(stripOpEdStagesForCommunity('x')).toBe('x');
  });
});

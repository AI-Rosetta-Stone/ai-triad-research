// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node
// t/4872: SituationNodeSchema gains superseded_by (mirrors PovNodeSchema's field exactly), and
// situationDescriptionPattern is relaxed to accept "A situation concept that..." alongside
// "A situation that..." (t/4860 F3, ~250 corpus entries use "concept").

import { describe, it, expect } from 'vitest';
import { SituationNodeSchema } from '../schemas.js';

const sitNode = (extra: Record<string, unknown> = {}) => ({
  id: 'sit-001',
  label: 'A situation',
  description: 'A situation that tests something.',
  interpretations: { accelerationist: 'a', safetyist: 's', skeptic: 'k' },
  linked_nodes: [],
  conflict_ids: [],
  ...extra,
});

describe('SituationNodeSchema — superseded_by (t/4872)', () => {
  it('accepts a situation carrying superseded_by', () => {
    const r = SituationNodeSchema.safeParse(sitNode({ superseded_by: 'sit-157' }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.superseded_by).toBe('sit-157');
  });

  it('accepts a situation without superseded_by (absent, not stripped)', () => {
    const r = SituationNodeSchema.safeParse(sitNode());
    expect(r.success).toBe(true);
    expect(r.success && r.data.superseded_by).toBeUndefined();
  });

  it('rejects a non-string superseded_by', () => {
    expect(SituationNodeSchema.safeParse(sitNode({ superseded_by: 42 })).success).toBe(false);
  });
});

describe('SituationNodeSchema — description pattern (t/4872, t/4860 F3)', () => {
  it('accepts "A situation that..."', () => {
    expect(SituationNodeSchema.safeParse(sitNode({ description: 'A situation that something happens.' })).success).toBe(true);
  });

  it('accepts "A situation concept that..." (the ~250-entry corpus variant)', () => {
    expect(SituationNodeSchema.safeParse(sitNode({ description: 'A situation concept that something happens.' })).success).toBe(true);
  });

  it('rejects a description that matches neither form', () => {
    const r = SituationNodeSchema.safeParse(sitNode({ description: 'Something happens.' }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toContain('A situation that...');
    expect(r.error?.issues[0].message).toContain('A situation concept that...');
  });

  it('rejects a near-miss variant ("A situational that...")', () => {
    expect(SituationNodeSchema.safeParse(sitNode({ description: 'A situational that something happens.' })).success).toBe(false);
  });
});

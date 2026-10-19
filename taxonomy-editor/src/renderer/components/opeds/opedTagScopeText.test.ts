// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import { opedTagScopeText, opedCommunityTagText, tagLabelFor } from './opedTagScopeText';

// t/3992. Registry injected so these don't move when the committed one does.
const REGISTRY = { version: 1, povs: { skeptic: [{ id: 'critical', label: 'Critical', soul_doc: 'skeptic.critical', description: 'd' }] } };

describe('opedTagScopeText (t/3992)', () => {
  it('Scope names the wing and the excluded count', () => {
    expect(opedTagScopeText('Skeptic', 'Critical', { mode: 'scope', excludedUntagged: 31 })).toBe('Skeptic · Critical wing (scope; 31 not tagged Critical excluded)');
  });

  it('Prioritize never shows a count (SO e/254#6 cond 3)', () => {
    expect(opedTagScopeText('Skeptic', 'Critical', { mode: 'prioritize', excludedUntagged: 0 })).toBe('Skeptic · Critical wing (prioritized)');
    // Even a nonzero value (should not happen) is not shown in Prioritize.
    expect(opedTagScopeText('Skeptic', 'Critical', { mode: 'prioritize', excludedUntagged: 7 })).not.toMatch(/7|excluded/);
  });

  it('community badge names the wing and mode', () => {
    expect(opedCommunityTagText('Skeptic', { label: 'Critical', mode: 'scope' })).toBe('Skeptic · Critical wing (Scope)');
    expect(opedCommunityTagText('Skeptic', { label: 'Critical', mode: 'prioritize' })).toBe('Skeptic · Critical wing (Prioritize)');
  });

  it('tagLabelFor uses the registry label, falling back to the id for a retired tag or no registry', () => {
    expect(tagLabelFor('skeptic', 'critical', REGISTRY)).toBe('Critical');
    expect(tagLabelFor('skeptic', 'retired', REGISTRY)).toBe('retired');
    expect(tagLabelFor('skeptic', 'critical', null)).toBe('critical');
  });
});

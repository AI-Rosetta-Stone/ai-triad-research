// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

let mockState: any;

vi.mock('../../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { getState: () => mockState },
}));

import { getStoredPlainDescription } from './OverviewView';

// t/4361: a debate's stored taxonomy_suggestions can reference a node that's since been
// superseded (t/4355 holds it out of state.<pov>.nodes) — the plain-description lookup must
// still find it by exact id, across the full set.
describe('getStoredPlainDescription — includes superseded nodes', () => {
  beforeEach(() => {
    mockState = {
      accelerationist: { nodes: [] },
      safetyist: { nodes: [] },
      skeptic: { nodes: [] },
      supersededNodes: { accelerationist: [], safetyist: [], skeptic: [] },
    };
  });

  it('finds a selectable node', () => {
    mockState.accelerationist.nodes = [{ id: 'acc-beliefs-001', plain_description: 'Plain A' }];

    expect(getStoredPlainDescription('acc-beliefs-001')).toBe('Plain A');
  });

  it('finds a superseded node by exact id, not just the survivor', () => {
    mockState.accelerationist.nodes = [{ id: 'acc-beliefs-003', plain_description: 'Survivor plain' }];
    mockState.supersededNodes.accelerationist = [{
      index: 0,
      node: { id: 'acc-beliefs-002', superseded_by: 'acc-beliefs-003', plain_description: 'Old plain' },
    }];

    expect(getStoredPlainDescription('acc-beliefs-002')).toBe('Old plain');
  });

  it('returns null for an unknown id', () => {
    expect(getStoredPlainDescription('acc-beliefs-999')).toBeNull();
  });
});

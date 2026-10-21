// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4363 (t/4355 child): SituationsTab's selectedNode lookup falls back to a superseded POV node
// when selectedNodeId isn't a situations-node id. Tested as a pure helper (not a full component
// render) — mirrors how the sibling PovTab fix is exercised via the real superseded.ts accessors.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PovNode, PovTaxonomyFile, SituationNode } from '../../types/taxonomy';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { splitForState, EMPTY_HELD, __resetSupersededCacheForTests } = await import('../../hooks/useTaxonomyStore/superseded');
const { resolveSupersededFallback } = await import('./SituationsTab');

const povNode = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: `label ${id}`, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);

const LIVE = povNode('acc-beliefs-001');
const SUPERSEDED = povNode('acc-beliefs-002', { superseded_by: 'acc-beliefs-001' });

const situationNode = (id: string): SituationNode =>
  ({ id, label: `sit ${id}`, description: 'd', linked_nodes: [], conflict_ids: [], interpretations: {} } as unknown as SituationNode);

function buildTaxonomyState() {
  const file = { pov: 'accelerationist', last_modified: '2026-01-01', nodes: [LIVE, SUPERSEDED] } as PovTaxonomyFile;
  return splitForState(
    { supersededNodes: EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null },
    { accelerationist: file },
  ) as never as Parameters<typeof resolveSupersededFallback>[2];
}

describe('resolveSupersededFallback', () => {
  beforeEach(() => __resetSupersededCacheForTests());

  it('is null when a situations node was already found (the normal path)', () => {
    const sit = situationNode('cc-001');
    expect(resolveSupersededFallback(sit, sit.id, buildTaxonomyState())).toBeNull();
  });

  it('is null with no selectedNodeId', () => {
    expect(resolveSupersededFallback(null, null, buildTaxonomyState())).toBeNull();
  });

  it('is null when the id resolves to a live (non-superseded) POV node', () => {
    expect(resolveSupersededFallback(null, LIVE.id, buildTaxonomyState())).toBeNull();
  });

  it('returns the superseded POV node when the id resolves to one, superseded or not in situations', () => {
    const result = resolveSupersededFallback(null, SUPERSEDED.id, buildTaxonomyState());
    expect(result).toEqual(SUPERSEDED);
  });

  it('is null for an id unknown to both situations and the POV index', () => {
    expect(resolveSupersededFallback(null, 'unknown-id', buildTaxonomyState())).toBeNull();
  });
});

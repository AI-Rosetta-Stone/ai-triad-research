// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4360 (t/4355 child): a conflict's linked taxonomy nodes still show a superseded
// node (not hidden), marked as superseded, and its policy_actions still feed Related
// Policies — both resolved by id via `allNodesById`/`isSuperseded`, not a file scan.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConflictFile, PovNode, PovTaxonomyFile } from '../../types/taxonomy';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@bridge', () => ({ api: { clipboardWriteText: vi.fn() }, isElectronMode: () => false }));
vi.mock('../../hooks/useDebateStore', () => ({ useDebateStore: (sel: never) => sel({ createConflictDebate: vi.fn() }) }));

const { useTaxonomyStore } = await import('../../hooks/useTaxonomyStore');
const { splitForState, EMPTY_HELD, __resetSupersededCacheForTests } = await import('../../hooks/useTaxonomyStore/superseded');
const { ConflictDetail } = await import('./ConflictDetail');

const node = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: `label ${id}`, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);

const LIVE = node('acc-beliefs-001');
const OLD = node('acc-beliefs-002', {
  superseded_by: 'acc-beliefs-001',
  graph_attributes: { policy_actions: [{ policy_id: 'pol-001', action: 'retired-action' }] },
} as never);

const conflict: ConflictFile = {
  claim_id: 'conflict-001',
  claim_label: 'Test conflict',
  description: '',
  status: 'open',
  instances: [],
  human_notes: [],
  linked_taxonomy_nodes: [LIVE.id, OLD.id],
} as never;

beforeEach(() => {
  __resetSupersededCacheForTests();
  const file = { pov: 'accelerationist', last_modified: '2026-01-01', nodes: [LIVE, OLD] } as PovTaxonomyFile;
  useTaxonomyStore.setState({
    supersededNodes: EMPTY_HELD, safetyist: null, skeptic: null, situations: null,
    conflicts: [conflict], policyRegistry: [{ id: 'pol-001', action: 'retired-action' }], validationErrors: {},
    ...splitForState({ supersededNodes: EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null }, { accelerationist: file }),
  } as never);
});

describe('ConflictDetail — linked superseded nodes (t/4360)', () => {
  it('still shows a superseded linked node, marked as superseded, with its exact label', () => {
    render(<ConflictDetail conflict={conflict} readOnly />);
    expect(screen.getByText('label acc-beliefs-002')).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    // The live linked node is shown without the badge.
    expect(screen.getByText('label acc-beliefs-001').closest('.cd-node-row')).not.toHaveTextContent('Superseded');
  });

  it('still derives Related Policies from a superseded linked node', () => {
    render(<ConflictDetail conflict={conflict} readOnly />);
    expect(screen.getByText('retired-action')).toBeInTheDocument();
  });
});

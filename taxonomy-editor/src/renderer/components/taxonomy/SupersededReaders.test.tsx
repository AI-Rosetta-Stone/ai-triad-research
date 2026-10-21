// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4355 PR 1b: readers of superseded nodes. The banner, the citation resolver, and the two id sets
// (validate against all ids; offer only selectable ids).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PovNode, PovTaxonomyFile } from '../../types/taxonomy';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const { useTaxonomyStore } = await import('../../hooks/useTaxonomyStore');
const { splitForState, EMPTY_HELD, resolveNode, resolveNodeId, __resetSupersededCacheForTests } = await import('../../hooks/useTaxonomyStore/superseded');
const { SupersededBanner } = await import('./SupersededBanner');
const { resolveRef } = await import('../shared/resolveRef');
const { getAllKnownNodeIds, getSelectableNodeIds, findNodeMetaInStore } = await import('../../hooks/useDebateStore/shared/taxonomyContext');

const node = (id: string, over: Partial<PovNode> = {}): PovNode =>
  ({ id, category: 'Beliefs', label: `label ${id}`, description: 'd', parent_id: null, children: [], situation_refs: [], ...over } as PovNode);
const LIVE = node('acc-beliefs-001');
const OLD = node('acc-beliefs-002', { superseded_by: 'acc-beliefs-001' });

beforeEach(() => {
  __resetSupersededCacheForTests();
  const file = { pov: 'accelerationist', last_modified: '2026-01-01', nodes: [LIVE, OLD] } as PovTaxonomyFile;
  useTaxonomyStore.setState({
    supersededNodes: EMPTY_HELD, safetyist: null, skeptic: null, situations: null,
    ...splitForState({ supersededNodes: EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null }, { accelerationist: file }),
  } as never);
});

describe('SupersededBanner', () => {
  it('names the replacement and opens it', () => {
    const setActiveTab = vi.fn();
    const setSelectedNodeId = vi.fn();
    useTaxonomyStore.setState({ setActiveTab, setSelectedNodeId } as never);
    render(<SupersededBanner node={OLD} />);
    expect(screen.getByRole('note')).toHaveTextContent('Superseded by');
    fireEvent.click(screen.getByRole('button', { name: /acc-beliefs-001/ }));
    expect(setActiveTab).toHaveBeenCalledWith('accelerationist');
    expect(setSelectedNodeId).toHaveBeenCalledWith('acc-beliefs-001');
  });

  it('renders nothing for a live node', () => {
    const { container } = render(<SupersededBanner node={LIVE} />);
    expect(container.firstChild).toBeNull();
  });

  it('a dangling replacement is named, not linked', () => {
    render(<SupersededBanner node={node('acc-beliefs-009', { superseded_by: 'acc-beliefs-999' })} />);
    expect(screen.getByText('acc-beliefs-999 (not found)')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('citation resolver', () => {
  it('resolves a cited superseded node to the exact node', async () => {
    const r = await resolveRef({ kind: 'node', id: 'acc-beliefs-002' } as never);
    expect(r).toMatchObject({ kind: 'node', record: { id: 'acc-beliefs-002' } });
  });
});

describe('survivor resolution (lib buildSupersessionIndex)', () => {
  const state = () => useTaxonomyStore.getState() as never;

  it('resolves a superseded id to its survivor, a live id to itself, an unknown id to itself', () => {
    expect(resolveNode(state(), 'acc-beliefs-002')?.id).toBe('acc-beliefs-001');
    expect(resolveNodeId(state(), 'acc-beliefs-001')).toBe('acc-beliefs-001');
    expect(resolveNodeId(state(), 'acc-beliefs-777')).toBe('acc-beliefs-777');
  });

  it('follows a chain to the live end', () => {
    __resetSupersededCacheForTests();
    const file = { pov: 'accelerationist', last_modified: '2026-01-01', nodes: [
      LIVE, OLD, node('acc-beliefs-003', { superseded_by: 'acc-beliefs-002' }),
    ] } as PovTaxonomyFile;
    useTaxonomyStore.setState(splitForState(
      { supersededNodes: EMPTY_HELD, accelerationist: null, safetyist: null, skeptic: null }, { accelerationist: file },
    ) as never);
    expect(resolveNodeId(state(), 'acc-beliefs-003')).toBe('acc-beliefs-001');
  });

  it('labels a cited superseded id with the exact node, not the survivor', () => {
    expect(findNodeMetaInStore('acc-beliefs-002')).toEqual({ label: 'label acc-beliefs-002', pov: 'accelerationist', description: 'd' });
  });
});

describe('debate id sets (t/4355#7)', () => {
  it('validation knows superseded ids (so they are never fuzzy-corrected to another node)', () => {
    expect(getAllKnownNodeIds().has('acc-beliefs-002')).toBe(true);
  });
  it('ids offered to the model exclude superseded ones', () => {
    const offered = getSelectableNodeIds();
    expect(offered.has('acc-beliefs-001')).toBe(true);
    expect(offered.has('acc-beliefs-002')).toBe(false);
  });
});

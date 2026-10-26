// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4364 (t/4355 child): a by-id preview must resolve a superseded node — `allNodesById`,
// not a per-POV `.nodes.find`, which only sees selectable nodes post-t/4355-PR1.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: ({ node }: { node: { id: string; label?: string } }) => <div data-testid="node-detail">{node.label ?? node.id}</div>,
}));
vi.mock('../debate/SituationDetail', () => ({ SituationDetail: () => <div /> }));
vi.mock('../conflict/ConflictDetail', () => ({ ConflictDetail: () => <div /> }));

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    accelerationist: null,
    safetyist: null,
    skeptic: null,
    situations: null,
    conflicts: [],
    navigateToNode: vi.fn(),
    ...overrides,
  };
}

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: vi.fn() }));

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
const mockStore = useTaxonomyStore as unknown as ReturnType<typeof vi.fn>;
(mockStore as unknown as { getState: typeof mockStore }).getState = mockStore;

const { SearchPreview } = await import('./SearchPreview');

describe('SearchPreview — by-id lookup resolves superseded nodes (t/4364)', () => {
  it('shows a superseded node by its exact stored label, not the "not found" empty state', () => {
    mockStore.mockReturnValue(makeStore({
      accelerationist: {
        nodes: [{ id: 'acc-beliefs-002', label: 'Old belief', description: 'd', category: 'Beliefs', superseded_by: 'acc-beliefs-001' }],
      },
    }));

    render(<SearchPreview searchPreviewId="acc-beliefs-002" />);

    expect(screen.getByTestId('node-detail')).toHaveTextContent('Old belief');
    expect(screen.queryByText('Node not found')).not.toBeInTheDocument();
  });

  it('shows the empty state for an id that truly does not exist', () => {
    mockStore.mockReturnValue(makeStore({ accelerationist: { nodes: [] } }));

    render(<SearchPreview searchPreviewId="acc-beliefs-999" />);

    expect(screen.getByText('Node not found')).toBeInTheDocument();
  });
});

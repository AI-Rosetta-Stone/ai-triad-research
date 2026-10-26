// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { getEdgeDetail, record } = vi.hoisted(() => ({ getEdgeDetail: vi.fn(), record: vi.fn() }));

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record }) }));
vi.mock('@bridge', () => ({ api: { getEdgeDetail } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storeValue: any;
vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => storeValue }));

const { EdgeDetailPanel } = await import('./EdgeDetailPanel');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEdge(over: any = {}) {
  return {
    source: 'acc-belief-001',
    target: 'saf-belief-002',
    type: 'SUPPORTS',
    bidirectional: false,
    confidence: 0.8,
    weight: 0.6,
    status: 'approved',
    discovered_at: '2026-01-01',
    model: 'test',
    ...over,
  };
}

const EDGE_TYPES = [{ type: 'SUPPORTS', bidirectional: false, definition: 'A supports B.' }];

describe('EdgeDetailPanel (t/1009)', () => {
  beforeEach(() => {
    getEdgeDetail.mockReset();
    record.mockReset();
    storeValue = {
      selectedEdge: null,
      selectEdge: vi.fn(),
      getLabelForId: (id: string) => `L:${id}`,
      edgesFile: { edges: [], edge_types: EDGE_TYPES },
      setActiveTab: vi.fn(),
      setSelectedNodeId: vi.fn(),
      showRelatedEdges: vi.fn(),
      accelerationist: null,
      safetyist: null,
      skeptic: null,
    };
  });

  it('renders nothing when no edge is selected', () => {
    const { container } = render(<EdgeDetailPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders edge details and inline rationale without fetching', () => {
    const edge = makeEdge({ rationale: 'inline rationale text' });
    storeValue.selectedEdge = edge;
    storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };

    render(<EdgeDetailPanel />);

    expect(screen.getByText('SUPPORTS')).toBeDefined();
    expect(screen.getByText('A supports B.')).toBeDefined();
    expect(screen.getByText('inline rationale text')).toBeDefined();
    expect(screen.getByText('80%')).toBeDefined();
    expect(getEdgeDetail).not.toHaveBeenCalled();
  });

  it('navigates when a node link is clicked without crashing (t/1412 regression)', () => {
    // Regression: handleNavigate called the removed nodePovFromId, crashing on click.
    const edge = makeEdge({ rationale: 'x' }); // source acc-belief-001
    storeValue.selectedEdge = edge;
    storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };

    render(<EdgeDetailPanel />);
    fireEvent.click(screen.getByText('L:acc-belief-001')); // source endpoint label

    expect(storeValue.setActiveTab).toHaveBeenCalledWith('accelerationist');
    expect(storeValue.setSelectedNodeId).toHaveBeenCalledWith('acc-belief-001');
    expect(storeValue.showRelatedEdges).toHaveBeenCalledWith('acc-belief-001');
  });

  it('fetches rationale on demand when it is missing from the selected edge', async () => {
    const edge = makeEdge(); // no rationale
    storeValue.selectedEdge = edge;
    storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };
    getEdgeDetail.mockResolvedValue(makeEdge({ rationale: 'fetched rationale' }));

    render(<EdgeDetailPanel />);

    // Loading indicator shows first, then the fetched text resolves.
    expect(screen.getByText(/Loading rationale/)).toBeDefined();
    expect(await screen.findByText('fetched rationale')).toBeDefined();
    expect(getEdgeDetail).toHaveBeenCalledWith(0);
  });

  it('handles a rationale fetch failure gracefully', async () => {
    const edge = makeEdge();
    storeValue.selectedEdge = edge;
    storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };
    getEdgeDetail.mockRejectedValue(new Error('boom'));

    render(<EdgeDetailPanel />);

    // Falls back to the empty-state placeholder and records the failure to the flight recorder.
    expect(await screen.findByText(/No rationale recorded/)).toBeDefined();
    expect(record).toHaveBeenCalled();
  });

  describe('superseded endpoint marker (t/4364)', () => {
    it('marks a superseded source endpoint, linking to its replacement', () => {
      const edge = makeEdge({ rationale: 'x' }); // source acc-belief-001
      storeValue.selectedEdge = edge;
      storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };
      storeValue.accelerationist = {
        nodes: [{ id: 'acc-belief-001', label: 'Old', superseded_by: 'acc-belief-003' }],
      };

      render(<EdgeDetailPanel />);

      const mark = screen.getByText('superseded');
      expect(mark).toBeInTheDocument();
      fireEvent.click(mark);
      expect(storeValue.setActiveTab).toHaveBeenCalledWith('accelerationist');
      expect(storeValue.setSelectedNodeId).toHaveBeenCalledWith('acc-belief-003');
    });

    it('shows no marker when neither endpoint is superseded', () => {
      const edge = makeEdge({ rationale: 'x' });
      storeValue.selectedEdge = edge;
      storeValue.edgesFile = { edges: [edge], edge_types: EDGE_TYPES };
      storeValue.accelerationist = { nodes: [{ id: 'acc-belief-001', label: 'Live' }] };

      render(<EdgeDetailPanel />);

      expect(screen.queryByText('superseded')).not.toBeInTheDocument();
    });
  });
});

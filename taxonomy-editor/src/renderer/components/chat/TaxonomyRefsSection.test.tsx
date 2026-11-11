// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/167: Chat's Why grounding now uses the shared BdiGroundingView from debate.
// These tests verify the Chat wrapper passes the correct props (refs, emptyText) to the shared component.
// BdiGroundingView's own tests (in debate-workspace) verify BDI grouping, ordering, and interactivity.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TaxonomyRef } from '../../types/debate';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

// Mock BdiGroundingView to verify props are passed correctly
const mockBdiGroundingView = vi.fn((props) => {
  if (props.refs.length === 0 && props.emptyText) {
    return <div data-testid="bdi-empty">{props.emptyText}</div>;
  }
  if (props.refs.length === 0) {
    return null;
  }
  return (
    <div data-testid="bdi-grounding">
      {props.refs.map((r: TaxonomyRef) => (
        <div key={r.node_id} data-testid={`ref-${r.node_id}`}>{r.node_id}</div>
      ))}
    </div>
  );
});

vi.mock('../debate-workspace/TaxonomyRefs', () => ({
  BdiGroundingView: mockBdiGroundingView,
}));

import { TaxonomyRefsSection } from './ChatWorkspace';

describe('TaxonomyRefsSection — Chat integration with BdiGroundingView (t/167)', () => {
  const NODE_A: TaxonomyRef = { node_id: 'skp-beliefs-001', label: 'Node A', relevance: 'why A matters' };
  const NODE_B: TaxonomyRef = { node_id: 'skp-desires-001', label: 'Node B', relevance: 'why B matters' };

  it('passes refs to BdiGroundingView', () => {
    render(<TaxonomyRefsSection refs={[NODE_A, NODE_B]} />);
    expect(mockBdiGroundingView).toHaveBeenCalledWith(
      expect.objectContaining({ refs: [NODE_A, NODE_B] }),
      expect.anything()
    );
    expect(screen.getByTestId('ref-skp-beliefs-001')).toBeInTheDocument();
    expect(screen.getByTestId('ref-skp-desires-001')).toBeInTheDocument();
  });

  it('passes Chat-specific empty-state wording when no refs', () => {
    const emptyText = 'No taxonomy grounding recorded for this answer.';
    render(<TaxonomyRefsSection refs={[]} emptyText={emptyText} />);
    expect(mockBdiGroundingView).toHaveBeenCalledWith(
      expect.objectContaining({ refs: [], emptyText }),
      expect.anything()
    );
    expect(screen.getByTestId('bdi-empty')).toHaveTextContent(emptyText);
  });

  it('renders nothing when no refs and no emptyText (for user messages)', () => {
    const { container } = render(<TaxonomyRefsSection refs={[]} />);
    expect(mockBdiGroundingView).toHaveBeenCalledWith(
      expect.objectContaining({ refs: [], emptyText: undefined }),
      expect.anything()
    );
    expect(container.firstChild).toBeNull();
  });
});


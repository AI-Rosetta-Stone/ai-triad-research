// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroundingSection } from './GroundingSection';
import type { GroundingEnvelope } from '@lib/inquiry';

const KNOWN_NODE_IDS = new Set(['acc-beliefs-001', 'saf-beliefs-001', 'skp-beliefs-001']);

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: { lookupPinnedData: (id: string) => unknown }) => unknown) =>
    selector({
      lookupPinnedData: (id: string) => (KNOWN_NODE_IDS.has(id) ? { type: 'pov', pov: 'accelerationist', node: { id, label: 'resolved' } } : null),
    }),
}));
vi.mock('../shared/LinkedNodePreview', () => ({
  LinkedNodePreview: ({ nodeId }: { nodeId: string }) => <div data-testid="node-preview">{nodeId}</div>,
}));

describe('GroundingSection (t/4591)', () => {
  const mockGrounding: GroundingEnvelope = {
    nodesByCamp: {
      acc: [{ nodeId: 'acc-beliefs-001', label: 'AI acceleration belief node', camp: 'acc' }],
      saf: [{ nodeId: 'saf-beliefs-001', label: 'AI safety belief node', camp: 'saf' }],
      skp: [{ nodeId: 'skp-beliefs-001', label: 'AI skeptic belief node', camp: 'skp' }],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders camp tabs for camps with nodes', () => {
    render(<GroundingSection grounding={mockGrounding} />);
    expect(screen.getByRole('tab', { name: 'Accelerationist' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Safetyist' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Skeptic' })).toBeInTheDocument();
  });

  it('displays nodes for the active tab', () => {
    render(<GroundingSection grounding={mockGrounding} />);
    expect(screen.getByText('AI acceleration belief node')).toBeInTheDocument();
  });

  it('switches tabs when clicked', async () => {
    const user = userEvent.setup();
    render(<GroundingSection grounding={mockGrounding} />);

    const safetyistTab = screen.getByRole('tab', { name: 'Safetyist' });
    await user.click(safetyistTab);

    expect(screen.getByText('AI safety belief node')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Safetyist' })).toHaveAttribute('aria-selected', 'true');
  });

  it('handles empty grounding gracefully', () => {
    const emptyGrounding: GroundingEnvelope = { nodesByCamp: {} };
    const { container } = render(<GroundingSection grounding={emptyGrounding} />);
    expect(container.querySelector('.grounding-section')).not.toBeInTheDocument();
  });

  it('renders Situation tab when situationNodes exist', () => {
    const groundingWithSituations: GroundingEnvelope = {
      nodesByCamp: { acc: [{ nodeId: 'acc-beliefs-001', label: 'AI acceleration belief node', camp: 'acc' }] },
      situationNodes: [
        { nodeId: 'cc-situations-001', label: 'Situation One' },
        { nodeId: 'cc-situations-002', label: 'Situation Two' },
        { nodeId: 'cc-situations-003', label: 'Situation Three' },
      ],
    };

    render(<GroundingSection grounding={groundingWithSituations} />);
    expect(screen.getByRole('tab', { name: 'Situation' })).toBeInTheDocument();
  });

  it('limits situation tab to top 3 nodes', async () => {
    const user = userEvent.setup();
    const groundingWithManyNodes: GroundingEnvelope = {
      nodesByCamp: { acc: [{ nodeId: 'acc-beliefs-001', label: 'AI acceleration belief node', camp: 'acc' }] },
      situationNodes: [
        { nodeId: 'cc-situations-001', label: 'Situation One' },
        { nodeId: 'cc-situations-002', label: 'Situation Two' },
        { nodeId: 'cc-situations-003', label: 'Situation Three' },
        { nodeId: 'cc-situations-004', label: 'Situation Four' },
      ],
    };

    render(<GroundingSection grounding={groundingWithManyNodes} />);
    await user.click(screen.getByRole('tab', { name: 'Situation' }));

    expect(screen.getByText('Situation One')).toBeInTheDocument();
    expect(screen.getByText('Situation Two')).toBeInTheDocument();
    expect(screen.getByText('Situation Three')).toBeInTheDocument();
    expect(screen.queryByText('Situation Four')).not.toBeInTheDocument();
  });

  it('supports keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<GroundingSection grounding={mockGrounding} />);

    const firstRow = screen.getByText('AI acceleration belief node').closest('tr');
    expect(firstRow).not.toBeNull();
    firstRow!.focus();
    await user.keyboard('{Enter}');
    expect(firstRow).toHaveAttribute('aria-selected', 'true');
  });

  it('renders node preview on row selection', async () => {
    const user = userEvent.setup();
    render(<GroundingSection grounding={mockGrounding} />);

    const firstRow = screen.getByText('AI acceleration belief node').closest('tr');
    expect(firstRow).not.toBeNull();
    await user.click(firstRow!);
    expect(screen.getByTestId('node-preview')).toHaveTextContent('acc-beliefs-001');
  });

  it('shows missing node message when node not in taxonomy', async () => {
    const user = userEvent.setup();
    const groundingWithMissingNode: GroundingEnvelope = {
      nodesByCamp: {
        acc: [{ nodeId: 'acc-deleted-999', label: 'Stale label', camp: 'acc' }],
      },
    };

    render(<GroundingSection grounding={groundingWithMissingNode} />);
    const firstRow = screen.getByText('Stale label').closest('tr');
    expect(firstRow).not.toBeNull();
    await user.click(firstRow!);
    expect(screen.getByText('Node no longer in taxonomy')).toBeInTheDocument();
  });
});

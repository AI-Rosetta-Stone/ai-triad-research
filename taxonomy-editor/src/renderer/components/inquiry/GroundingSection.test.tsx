// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroundingSection } from './GroundingSection';
import type { GroundingEnvelope } from '@lib/inquiry';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: vi.fn(() => ({
    accelerationist: { 'acc-beliefs-001': { id: 'acc-beliefs-001', label: 'AI acceleration belief node' } },
    safetyist: { 'saf-beliefs-001': { id: 'saf-beliefs-001', label: 'AI safety belief node' } },
    skeptic: { 'skp-beliefs-001': { id: 'skp-beliefs-001', label: 'AI skeptic belief node' } },
  })),
}));

describe('GroundingSection (t/4591)', () => {
  const mockGrounding: GroundingEnvelope = {
    nodesByCamp: {
      acc: [{ id: 'acc-beliefs-001' }],
      saf: [{ id: 'saf-beliefs-001' }],
      skp: [{ id: 'skp-beliefs-001' }],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders camp tabs for camps with nodes', () => {
    render(<GroundingSection grounding={mockGrounding} />);
    expect(screen.getByRole('button', { name: 'Accelerationist' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Safetyist' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skeptic' })).toBeInTheDocument();
  });

  it('displays nodes for the active tab', () => {
    render(<GroundingSection grounding={mockGrounding} />);
    expect(screen.getByText('acc-beliefs-001')).toBeInTheDocument();
  });

  it('switches tabs when clicked', async () => {
    const user = userEvent.setup();
    render(<GroundingSection grounding={mockGrounding} />);

    const safetyistTab = screen.getByRole('button', { name: 'Safetyist' });
    await user.click(safetyistTab);

    expect(screen.getByText('saf-beliefs-001')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Safetyist' })).toHaveAttribute('aria-selected', 'true');
  });

  it('handles empty grounding gracefully', () => {
    const emptyGrounding: GroundingEnvelope = { nodesByCamp: {} };
    const { container } = render(<GroundingSection grounding={emptyGrounding} />);
    expect(container.querySelector('.grounding-section')).not.toBeInTheDocument();
  });

  it('renders Situation tab when situationNodes exist', () => {
    const groundingWithSituations: GroundingEnvelope = {
      nodesByCamp: { acc: [{ id: 'acc-beliefs-001' }] },
      situationNodes: [
        { id: 'cc-situations-001' },
        { id: 'cc-situations-002' },
        { id: 'cc-situations-003' },
      ],
    };

    render(<GroundingSection grounding={groundingWithSituations} />);
    expect(screen.getByRole('button', { name: 'Situation' })).toBeInTheDocument();
  });

  it('limits situation tab to top 3 nodes', async () => {
    const user = userEvent.setup();
    const groundingWithManyNods: GroundingEnvelope = {
      nodesByCamp: { acc: [{ id: 'acc-beliefs-001' }] },
      situationNodes: [
        { id: 'cc-situations-001' },
        { id: 'cc-situations-002' },
        { id: 'cc-situations-003' },
        { id: 'cc-situations-004' },
      ],
    };

    render(<GroundingSection grounding={groundingWithManyNods} />);
    await user.click(screen.getByRole('button', { name: 'Situation' }));

    expect(screen.getByText('cc-situations-001')).toBeInTheDocument();
    expect(screen.getByText('cc-situations-002')).toBeInTheDocument();
    expect(screen.getByText('cc-situations-003')).toBeInTheDocument();
    expect(screen.queryByText('cc-situations-004')).not.toBeInTheDocument();
  });

  it('supports keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<GroundingSection grounding={mockGrounding} />);

    const firstRow = screen.getByText('acc-beliefs-001').closest('tr');
    if (firstRow) {
      await user.keyboard('{Enter}');
      expect(firstRow).toHaveAttribute('aria-selected', 'true');
    }
  });
});

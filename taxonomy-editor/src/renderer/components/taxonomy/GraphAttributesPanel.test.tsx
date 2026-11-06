// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2448 — the BDI-scales doc-link (TheoryLink) renders beside each scale label
// (Priority/Operationality via RankedSelectCell, Confidence via ConfidenceCell) and
// opens the docs/bdi-scales.md GitHub blob URL through the bridge.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { RankedSelectCell, ConfidenceCell, GraphAttributesPanel } from './GraphAttributesPanel';
import { usePreferencesStore } from '../../store/preferencesStore';
import type { GraphAttributes } from '@lib/debate/taxonomyTypes';

const openExternal = vi.fn().mockResolvedValue(undefined);
vi.mock('@bridge', () => ({ api: { openExternal: (...args: unknown[]) => openExternal(...args) } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const mockTaxonomyStore = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => mockTaxonomyStore() }));

const BDI_DOC_URL = 'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/bdi-scales.md';

describe('GraphAttributesPanel — BDI scale doc-links (t/2448)', () => {
  // t/2867: TheoryLink now gates on viewMode; advanced view shows the doc-links these tests assert.
  beforeEach(() => { openExternal.mockClear(); cleanup(); usePreferencesStore.setState({ viewMode: 'advanced' }); });

  it('renders the doc link beside a RankedSelectCell label and opens docs/bdi-scales.md', () => {
    render(<RankedSelectCell label="Priority" value={3} options={[{ value: 3, label: '3 — Important' }]} />);
    const link = screen.getByRole('button', { name: /how the bdi scales work/i });
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith(BDI_DOC_URL);
  });

  it('renders the doc link beside the Confidence label and opens docs/bdi-scales.md', () => {
    render(<ConfidenceCell value={0.5} />);
    const link = screen.getByRole('button', { name: /how the bdi scales work/i });
    expect(link).toBeTruthy();
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith(BDI_DOC_URL);
  });
});

describe('GraphAttributesPanel — default-expand first policy action (t/4919)', () => {
  beforeEach(() => {
    cleanup();
    mockTaxonomyStore.mockReturnValue({
      policyRegistry: [],
      edgesFile: {
        edges: [
          { source: 'pol-001', target: 'acc-B-001', type: 'supports' },
          { source: 'pol-002', target: 'acc-B-001', type: 'supports' },
          { source: 'pol-002', target: 'acc-B-002', type: 'supports' },
        ],
      },
    });
  });

  const attrs = (): GraphAttributes => ({
    policy_actions: [
      { policy_id: 'pol-001', action: 'First policy action', framing: '' },
      { policy_id: 'pol-002', action: 'Second policy action', framing: '' },
    ],
  });

  it('expands the first policy action by default, with aria-expanded set', () => {
    render(<GraphAttributesPanel attrs={attrs()} nodeId="acc-B-001" defaultOpen readOnly />);
    const firstToggle = screen.getByText(/1 edge/).closest('button')!;
    const secondToggle = screen.getByText(/2 edges/).closest('button')!;
    expect(firstToggle).toHaveAttribute('aria-expanded', 'true');
    expect(secondToggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapsing the default-expanded action holds across a re-render for the same node', () => {
    const { rerender } = render(<GraphAttributesPanel attrs={attrs()} nodeId="acc-B-001" defaultOpen readOnly />);
    const firstToggle = screen.getByText(/1 edge/).closest('button')!;
    fireEvent.click(firstToggle); // user collapses the default-opened action
    expect(firstToggle).toHaveAttribute('aria-expanded', 'false');

    // Re-render with a NEW (equal-content) attrs object for the same node — must not reopen.
    rerender(<GraphAttributesPanel attrs={attrs()} nodeId="acc-B-001" defaultOpen readOnly />);
    expect(screen.getByText(/1 edge/).closest('button')).toHaveAttribute('aria-expanded', 'false');
  });

  it('a node switch re-applies the default to the new node\'s first policy action', () => {
    const { rerender } = render(<GraphAttributesPanel attrs={attrs()} nodeId="acc-B-001" defaultOpen readOnly />);
    fireEvent.click(screen.getByText(/1 edge/).closest('button')!);
    expect(screen.getByText(/1 edge/).closest('button')).toHaveAttribute('aria-expanded', 'false');

    rerender(<GraphAttributesPanel attrs={attrs()} nodeId="acc-B-002" defaultOpen readOnly />);
    expect(screen.getByText(/1 edge/).closest('button')).toHaveAttribute('aria-expanded', 'true');
  });

  it('an empty policy_actions list renders without throwing (nothing to default-expand)', () => {
    render(<GraphAttributesPanel attrs={{}} nodeId="acc-B-001" defaultOpen readOnly />);
    expect(screen.queryByText('Policy Actions')).not.toBeNull();
  });
});

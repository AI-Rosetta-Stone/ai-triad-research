// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4625: BdiGroundingView — the standalone "Why" tab's content. Reuses the same
// chips/per-node/inline-detail UI as TaxonomyRefsSection's How->Plan BDI section
// (BdiSectionBody, shared not copied), without the outer <details> disclosure, and with
// its own empty state (AC5) when a statement has no BDI refs.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  nodeIdToTab: () => ({ tab: 'skp', colorVar: 'var(--color-skp)' }),
  getNodeLabel: (id: string) => `Label for ${id}`,
  getNodeWeight: () => null,
  focusMainWindowNode: vi.fn(),
  buildExplainPrompt: vi.fn(() => 'prompt'),
  buildSelectionExplainPrompt: vi.fn(() => 'selection prompt'),
  fixMarkdownLinks: (s: string) => s,
  resolvePolRef: (ref: string | { policy_id: string; relevance: string }) =>
    typeof ref === 'string' ? { id: ref, relevance: null } : { id: ref.policy_id, relevance: ref.relevance },
  getPolicyAction: () => 'Some policy action',
}));

vi.mock('../../utils/humanizeSpeakers', () => ({
  humanizeSpeakerIds: (ids: string) => ids,
}));

const lookupPinnedData = vi.fn((id: string) => ({
  type: 'pov' as const,
  pov: 'skeptic' as const,
  node: { id, label: 'Test Node', category: 'Beliefs', description: 'A description' },
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));

vi.mock('../taxonomy/TaxonomyRefDetail', () => ({
  TaxonomyRefDetail: ({ nodeId, onClose }: { nodeId: string; onClose: () => void }) => (
    <div data-testid="ref-detail" data-node={nodeId}>
      <button onClick={onClose}>close-detail</button>
    </div>
  ),
}));

import { BdiGroundingView } from './TaxonomyRefs';
import type { TaxonomyRef } from '../../types/debate';

const NODE = 'skp-beliefs-164';
const REFS: TaxonomyRef[] = [{ node_id: NODE, relevance: 'why it matters', relevance_score: 0.66 }];

describe('BdiGroundingView (t/4625 Why tab)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('AC5: shows the empty state when there are no BDI refs at all (e.g. a System entry)', () => {
    render(<BdiGroundingView refs={[]} />);
    expect(screen.getByText('No BDI grounding for this statement.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: NODE })).not.toBeInTheDocument();
  });

  it('renders the chip and per-node entry for a statement with BDI refs, no outer BDI disclosure', () => {
    render(<BdiGroundingView refs={REFS} />);
    expect(screen.queryByText('No BDI grounding for this statement.')).not.toBeInTheDocument();
    // No <summary>BDI</summary> toggle — the Why tab selection IS the disclosure.
    expect(screen.queryByText('BDI')).not.toBeInTheDocument();
    expect(screen.getAllByText(NODE).length).toBeGreaterThan(0);
    expect(screen.getByText('why it matters')).toBeInTheDocument();
  });

  it('t/4653: shows the node id, label, and relevance text, but no "Relevance ..." weight line', () => {
    render(<BdiGroundingView refs={REFS} />);
    expect(screen.getByRole('button', { name: NODE })).toBeInTheDocument();
    expect(screen.getByText('Label for ' + NODE)).toBeInTheDocument();
    expect(screen.getByText('why it matters')).toBeInTheDocument();
    // The chip's own "(0.66)" score suffix is untouched — only the per-ref
    // "(Relevance … ; Confidence/Priority/Operationality …)" line is removed.
    expect(screen.queryByText(/Relevance/)).not.toBeInTheDocument();
  });

  it('clicking a ref shows the inline POV detail (not a navigation)', () => {
    render(<BdiGroundingView refs={REFS} />);
    expect(screen.queryByTestId('ref-detail')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: NODE }));
    expect(screen.getByTestId('ref-detail')).toHaveAttribute('data-node', NODE);
  });

  it('clicking the ref again toggles the inline detail off', () => {
    render(<BdiGroundingView refs={REFS} />);
    fireEvent.click(screen.getByRole('button', { name: NODE }));
    expect(screen.getByTestId('ref-detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: NODE }));
    expect(screen.queryByTestId('ref-detail')).not.toBeInTheDocument();
  });

  it('a statement with only policy refs (no taxonomy refs) is not treated as empty', () => {
    render(<BdiGroundingView refs={[]} policyRefs={['pol-001']} />);
    expect(screen.queryByText('No BDI grounding for this statement.')).not.toBeInTheDocument();
    expect(screen.getAllByText('pol-001').length).toBeGreaterThan(0);
  });

  it('prefers metaPolicyRefs over policyRefs, matching TaxonomyRefsSection scoping', () => {
    render(<BdiGroundingView refs={[]} policyRefs={['pol-ignored']} metaPolicyRefs={['pol-wins']} />);
    expect(screen.getAllByText('pol-wins').length).toBeGreaterThan(0);
    expect(screen.queryByText('pol-ignored')).not.toBeInTheDocument();
  });
});

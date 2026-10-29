// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4627: after a chat reply, its BDI grounding refs are always visible (no "N references"
// expand step), and clicking one shows that node's detail inline — toggle off on a second
// click, switch on clicking a different ref, independent per reply. Mirrors the debate side's
// TaxonomyRefs.bdiDetail.test.tsx wiring/mock pattern, since both consume the same shared
// TaxNodeDetail (components/shared/TaxNodeDetail.tsx).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TaxonomyRef } from '../../types/debate';

// t/4651: TaxNodeDetail (rendered unmocked here) now calls scrollIntoView on open — jsdom
// doesn't implement it.
Element.prototype.scrollIntoView = vi.fn();

const lookupPinnedData = vi.fn((id: string) => {
  if (id === 'unknown-node-999') return undefined;
  return {
    type: 'pov' as const,
    pov: 'skeptic' as const,
    node: { id, label: `Label for ${id}`, category: 'Beliefs', description: 'A description' },
  };
});

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('@lib/debate/nodeIdUtils', () => ({
  nodePovFromId: (id: string) => (id.startsWith('skp') ? 'skeptic' : id.startsWith('pol') ? null : 'accelerationist'),
}));
// ChatWorkspace.tsx -> DetailPane -> NodeDetail -> (transitively) PovTab -> PromptsPanel ->
// PromptInspector, which reads MODELS_BY_BACKEND from this same mocked useTaxonomyStore module.
// Stub NodeDetail to cut that chain before it reaches an export this test doesn't provide
// (mirrors ChatWorkspace.test.tsx's mock for the same reason).
vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: () => <div data-testid="node-detail" />,
}));

import { TaxonomyRefsSection } from './ChatWorkspace';

const NODE_A: TaxonomyRef = { node_id: 'skp-beliefs-001', label: 'Node A', relevance: 'why A matters' };
const NODE_B: TaxonomyRef = { node_id: 'skp-beliefs-002', label: 'Node B', relevance: 'why B matters' };

describe('TaxonomyRefsSection — per-reply BDI grounding (t/4627)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the ref list without an expand step (AC1)', () => {
    render(<TaxonomyRefsSection refs={[NODE_A]} />);
    expect(screen.queryByRole('button', { name: /reference/ })).toBeNull();
    expect(screen.getByText('skp-beliefs-001')).toBeInTheDocument();
    expect(screen.getByText('Node A')).toBeInTheDocument();
    expect(screen.getByText('why A matters')).toBeInTheDocument();
  });

  it('clicking a ref shows its detail inline; no detail before clicking (AC2)', () => {
    render(<TaxonomyRefsSection refs={[NODE_A]} />);
    expect(screen.queryByText('Label for skp-beliefs-001')).toBeNull();
    fireEvent.click(screen.getByText('skp-beliefs-001'));
    expect(lookupPinnedData).toHaveBeenCalledWith('skp-beliefs-001');
    expect(screen.getByText('Label for skp-beliefs-001')).toBeInTheDocument();
  });

  it('clicking the same ref again hides the detail (AC2, AC4 toggle-close)', () => {
    render(<TaxonomyRefsSection refs={[NODE_A]} />);
    const pill = screen.getByText('skp-beliefs-001');
    fireEvent.click(pill);
    expect(screen.getByText('Label for skp-beliefs-001')).toBeInTheDocument();
    fireEvent.click(pill);
    expect(screen.queryByText('Label for skp-beliefs-001')).toBeNull();
  });

  it('clicking a different ref in the same reply switches the open detail (AC2, AC4 switch)', () => {
    render(<TaxonomyRefsSection refs={[NODE_A, NODE_B]} />);
    fireEvent.click(screen.getByText('skp-beliefs-001'));
    expect(screen.getByText('Label for skp-beliefs-001')).toBeInTheDocument();
    fireEvent.click(screen.getByText('skp-beliefs-002'));
    expect(screen.queryByText('Label for skp-beliefs-001')).toBeNull();
    expect(screen.getByText('Label for skp-beliefs-002')).toBeInTheDocument();
  });

  it('two replies keep independent open state (AC2, AC4 independence)', () => {
    render(
      <>
        <TaxonomyRefsSection refs={[NODE_A]} />
        <TaxonomyRefsSection refs={[NODE_B]} />
      </>,
    );
    const [pillA, pillB] = screen.getAllByText(/skp-beliefs-00[12]/);
    fireEvent.click(pillA);
    expect(screen.getByText('Label for skp-beliefs-001')).toBeInTheDocument();
    expect(screen.queryByText('Label for skp-beliefs-002')).toBeNull();
    fireEvent.click(pillB);
    expect(screen.getByText('Label for skp-beliefs-001')).toBeInTheDocument();
    expect(screen.getByText('Label for skp-beliefs-002')).toBeInTheDocument();
  });

  it('an unresolved ref id shows the not-found state, not a blank area (TL addition, t/4627#2)', () => {
    const unknownRef: TaxonomyRef = { node_id: 'unknown-node-999', relevance: 'r' };
    render(<TaxonomyRefsSection refs={[unknownRef]} />);
    fireEvent.click(screen.getByText('unknown-node-999'));
    expect(screen.getByText(/not found/i)).toBeInTheDocument();
  });

  it('renders nothing when there are no refs', () => {
    const { container } = render(<TaxonomyRefsSection refs={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

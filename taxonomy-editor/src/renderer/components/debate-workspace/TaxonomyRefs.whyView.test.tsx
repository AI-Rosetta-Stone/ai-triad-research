// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4625: BdiGroundingView — the standalone "Why" tab's content (BdiSectionBody), with its own
// empty state (AC5) when a statement has no BDI refs. This used to also back a collapsible BDI
// section in How->Plan, removed as redundant with this always-visible view (t/4625#10).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

// t/4651: TaxNodeDetail (rendered unmocked here) now calls scrollIntoView on open — jsdom
// doesn't implement it.
Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));
const { mockRecord } = vi.hoisted(() => ({ mockRecord: vi.fn() }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

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

// t/4654: a pov fixture now renders NodeDetail (via TaxNodeDetail's own wrapper), not
// TaxonomyRefDetail — kept mocked too for the policy/unresolved arm.
vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: ({ node }: { node: { id: string } }) => <div data-testid="ref-detail" data-node={node.id} />,
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

// t/187 (t/167#3): grouped by BDI category, Desires -> Intentions -> Beliefs (-> Situations).
describe('BdiGroundingView BDI grouping (t/187)', () => {
  const MIXED: TaxonomyRef[] = [
    { node_id: 'acc-beliefs-001', relevance: 'b low', relevance_score: 0.2 },
    { node_id: 'saf-intentions-004', relevance: 'i only', relevance_score: 0.5 },
    { node_id: 'skp-beliefs-009', relevance: 'b high', relevance_score: 0.9 },
    { node_id: 'saf-desires-002', relevance: 'd only', relevance_score: 0.4 },
  ];

  it('renders groups in order Desires, Intentions, Beliefs with counts', () => {
    const { container } = render(<BdiGroundingView refs={MIXED} />);
    const labels = [...container.querySelectorAll('.taxrefs-bdi-group-label')].map(el => el.textContent);
    expect(labels).toEqual(['Desires (1)', 'Intentions (1)', 'Beliefs (2)']);
  });

  it('omits empty groups', () => {
    render(<BdiGroundingView refs={[MIXED[0], MIXED[2]]} />);
    expect(screen.getByRole('group', { name: 'Beliefs, 2 nodes' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Desires/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Intentions/ })).not.toBeInTheDocument();
  });

  it('sorts by relevance within a group and keeps each ref in its own category', () => {
    render(<BdiGroundingView refs={MIXED} />);
    const beliefs = screen.getByRole('group', { name: 'Beliefs, 2 nodes' });
    const nodes = within(beliefs).getAllByRole('button').map(b => b.textContent);
    expect(nodes).toEqual(['skp-beliefs-009', 'acc-beliefs-001']);
    expect(within(screen.getByRole('group', { name: 'Desires, 1 node' })).queryByText('skp-beliefs-009')).not.toBeInTheDocument();
  });

  it('puts situation nodes in their own group after Beliefs instead of dropping them', () => {
    const { container } = render(<BdiGroundingView refs={[...MIXED, { node_id: 'sit-176', relevance: 'context', relevance_score: 0.7 }]} />);
    const labels = [...container.querySelectorAll('.taxrefs-bdi-group-label')].map(el => el.textContent);
    expect(labels[labels.length - 1]).toBe('Situations (1)');
    expect(within(screen.getByRole('group', { name: 'Situations, 1 node' })).getByText('context')).toBeInTheDocument();
  });

  it('labels the policy block like the BDI groups (Design p/14#20)', () => {
    render(<BdiGroundingView refs={MIXED} policyRefs={['pol-007', 'pol-008']} />);
    const pol = screen.getByRole('group', { name: 'Policy actions, 2 actions' });
    expect(within(pol).getByText('Policy actions (2)')).toBeInTheDocument();
  });

  it('shows an unrecognised node id under Situations and records a WARN', () => {
    mockRecord.mockClear();
    render(<BdiGroundingView refs={[{ node_id: 'zzz-unknown', relevance: 'odd', relevance_score: 0.1 }, { node_id: 'sit-001', relevance: 'ok', relevance_score: 0.2 }]} />);
    expect(within(screen.getByRole('group', { name: 'Situations, 2 nodes' })).getByText('odd')).toBeInTheDocument();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ level: 'warn', component: 'debate-workspace' });
    expect(String(mockRecord.mock.calls[0][0].message)).toContain('zzz-unknown');
  });

  it('renders policy refs after all BDI groups', () => {
    const { container } = render(<BdiGroundingView refs={MIXED} policyRefs={['pol-007']} />);
    const body = container.querySelector('.debate-reasoning-section-body') as HTMLElement;
    const blocks = [...body.children].map(c => c.className);
    expect(blocks.slice(0, 3).every(c => c.includes('taxrefs-bdi-group'))).toBe(true);
    expect(blocks[3]).toBe('taxrefs-policy-refs');
    expect(within(body.children[3] as HTMLElement).getAllByText('pol-007').length).toBeGreaterThan(0);
  });

  it('a click inside a group still opens the inline node detail', () => {
    render(<BdiGroundingView refs={MIXED} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Intentions, 1 node' })).getByRole('button', { name: 'saf-intentions-004' }));
    expect(screen.getByTestId('ref-detail')).toHaveAttribute('data-node', 'saf-intentions-004');
  });

  it('uses the caller-provided emptyText, defaulting to the debate wording', () => {
    const { rerender } = render(<BdiGroundingView refs={[]} />);
    expect(screen.getByText('No BDI grounding for this statement.')).toBeInTheDocument();
    rerender(<BdiGroundingView refs={[]} emptyText="No taxonomy grounding recorded for this answer." />);
    expect(screen.getByText('No taxonomy grounding recorded for this answer.')).toBeInTheDocument();
    expect(screen.queryByText('No BDI grounding for this statement.')).not.toBeInTheDocument();
  });
});

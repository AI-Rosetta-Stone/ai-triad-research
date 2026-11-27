// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/778: the Why panel (debate and Chat): no BDI group headings, the label beside the id,
// explanations collapsed by default, Expand all / Collapse all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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
import { resetWhyExplanations } from './whyExplanations';
import type { TaxonomyRef } from '../../types/debate';

const REFS: TaxonomyRef[] = [
  { node_id: 'acc-beliefs-007', relevance: 'belief reason', relevance_score: 0.9 },
  { node_id: 'acc-desires-042', relevance: 'desire reason', relevance_score: 0.5 },
  { node_id: 'acc-intentions-011', relevance: 'intention reason', relevance_score: 0.7 },
  { node_id: 'sit-003', relevance: 'situation reason', relevance_score: 0.6 },
];

describe('BdiGroundingView (t/778)', () => {
  beforeEach(() => { vi.clearAllMocks(); resetWhyExplanations(); });

  it('drops the Desires, Intentions and Beliefs headings but keeps Situations, in D-I-B order', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    expect(screen.queryByText(/^Desires/)).toBeNull();
    expect(screen.queryByText(/^Intentions/)).toBeNull();
    expect(screen.queryByText(/^Beliefs/)).toBeNull();
    expect(screen.getByText('Situations (1)')).toBeInTheDocument();
    const ids = Array.from(container.querySelectorAll('.debate-reasoning-node')).map(b => b.textContent);
    expect(ids).toEqual(['acc-desires-042', 'acc-intentions-011', 'acc-beliefs-007', 'sit-003']);
  });

  it('puts the label in the same row as the id, and the explanation is collapsed by default', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    const line = container.querySelector('.debate-why-row-line') as HTMLElement;
    expect(line.querySelector('.debate-reasoning-node')?.textContent).toBe('acc-desires-042');
    expect(line.querySelector('.debate-why-row-label')?.textContent).toBe('Label for acc-desires-042');
    expect(screen.queryByText('desire reason')).toBeNull();
  });

  it('clicking a label toggles that row only, with aria-expanded', () => {
    render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    const label = screen.getByRole('button', { name: 'Label for acc-desires-042' });
    expect(label.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(label);
    expect(label.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('desire reason')).toBeInTheDocument();
    expect(screen.queryByText('belief reason')).toBeNull();
    fireEvent.click(label);
    expect(screen.queryByText('desire reason')).toBeNull();
  });

  it('clicking the id still opens the node detail and does not toggle the explanation', () => {
    render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    fireEvent.click(screen.getByRole('button', { name: 'acc-desires-042' }));
    expect(screen.getByTestId('ref-detail')).toBeInTheDocument();
    expect(screen.queryByText('desire reason')).toBeNull();
  });

  it('Expand all opens every row and then reads Collapse all', () => {
    render(<BdiGroundingView stateKey="e1" refs={REFS} polRefs={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    for (const t of ['desire reason', 'intention reason', 'belief reason', 'situation reason']) expect(screen.getByText(t)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByText('desire reason')).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
  });

  it('opening the last collapsed row flips the control to Collapse all', () => {
    render(<BdiGroundingView stateKey="e1" refs={[REFS[1]]} />);
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Label for acc-desires-042' }));
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  it('keeps the open rows per statement for the session', () => {
    const first = render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Label for acc-desires-042' }));
    first.unmount();
    render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    expect(screen.getByText('desire reason')).toBeInTheDocument();
    render(<BdiGroundingView stateKey="e2" refs={REFS} />);
    expect(screen.getAllByText('desire reason').length).toBe(1);
  });

  it('the Expand all link shares the BDI eyebrow line, with BDI on the left', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    const head = container.querySelector('.debate-why-head') as HTMLElement;
    expect(head.querySelector('.taxrefs-bdi-group-label')?.textContent).toBe('BDI');
    expect(head.querySelector('.debate-why-expand-all')?.textContent).toBe('Expand all');
    expect(container.querySelectorAll('.debate-why-expand-all')).toHaveLength(1);
  });

  it('with no BDI rows the link goes on the first heading (Situations)', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={[REFS[3]]} />);
    const head = container.querySelector('.debate-why-head') as HTMLElement;
    expect(head.querySelector('.taxrefs-bdi-group-label')?.textContent).toBe('Situations (1)');
    expect(head.querySelector('.debate-why-expand-all')).not.toBeNull();
    expect(container.querySelectorAll('.debate-why-expand-all')).toHaveLength(1);
  });

  it('with only policy refs the link goes on the Policy actions heading', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={[]} policyRefs={['pol-001']} />);
    const head = container.querySelector('.debate-why-head') as HTMLElement;
    expect(head.querySelector('.taxrefs-bdi-group-label')?.textContent).toBe('Policy actions (1)');
    expect(head.querySelector('.debate-why-expand-all')).not.toBeNull();
  });

  it('the Expand all control points at the list it controls', () => {
    const { container } = render(<BdiGroundingView stateKey="e1" refs={REFS} />);
    const id = screen.getByRole('button', { name: 'Expand all' }).getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
  });

  it('with no stateKey (Chat) the rows still toggle, and the explanation starts collapsed', () => {
    render(<BdiGroundingView refs={REFS} />);
    expect(screen.queryByText('desire reason')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Label for acc-desires-042' }));
    expect(screen.getByText('desire reason')).toBeInTheDocument();
  });
});

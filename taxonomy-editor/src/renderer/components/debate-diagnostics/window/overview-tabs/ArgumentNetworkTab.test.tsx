// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArgumentNetworkTab, collectConfidenceImpacts } from './ArgumentNetworkTab';
import { useTaxonomyStore } from '../../../../hooks/useTaxonomyStore';
import type { OverviewTab } from '../types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@lib/debate/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@lib/debate/types')>();
  return {
    ...original,
    POVER_INFO: {
      accelerationist: { label: 'Accelerationist', pov: 'accelerationist', color: 'var(--color-acc)' },
      safetyist:       { label: 'Safetyist', pov: 'safetyist', color: 'var(--color-saf)' },
      skeptic:         { label: 'Skeptic', pov: 'skeptic', color: 'var(--color-skp)' },
    },
  };
});
vi.mock('@lib/debate/soul-docs/accelerationist.soul.json', () => ({ default: { label: 'Accelerationist' } }));
vi.mock('@lib/debate/soul-docs/safetyist.soul.json',       () => ({ default: { label: 'Safetyist' } }));
vi.mock('@lib/debate/soul-docs/skeptic.soul.json',         () => ({ default: { label: 'Skeptic' } }));
vi.mock('@bridge', () => ({
  api: {
    clipboardWriteText: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@lib/debate/qbaf', () => ({
  computeQbafStrengths: vi.fn().mockReturnValue({ strengths: new Map() }),
}));
vi.mock('../../../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(
    vi.fn().mockReturnValue({}),
    { getState: vi.fn().mockReturnValue({}) },
  ),
}));
vi.mock('../shared', () => ({
  INodeRow: (props: any) => (
    <div data-testid={`inode-${props.node?.id}`}>{props.node?.text}</div>
  ),
}));
// helpers are used inline by ArgumentNetworkTab
vi.mock('../helpers', () => ({
  speakerLabel: (s: string) => s,
  Highlight: ({ text }: { text: string }) => <>{text}</>,
}));

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeDebate(extraEntries: unknown[] = []) {
  const base = [
    { id: 'e1', type: 'statement', speaker: 'accelerationist', content: 'First turn.', taxonomy_refs: [], policy_refs: [], metadata: {} },
    { id: 'e2', type: 'statement', speaker: 'safetyist', content: 'Second turn.', taxonomy_refs: [], policy_refs: [], metadata: {} },
  ];
  return {
    id: 'test-debate-0000',
    topic: { scope: {} },
    transcript: [...base, ...extraEntries],
    phase: 'rounds',
    diagnostics: { entries: {} },
    argument_network: undefined,
    commitments: undefined,
  } as any;
}

function makeNode(id: string, entryId = 'e1', text = 'A claim') {
  return {
    id,
    text,
    type: 'I-node',
    speaker: 'accelerationist',
    source_entry_id: entryId,
    base_strength: 0.5,
  } as any;
}

function makeEdge(source: string, target: string, type: 'attacks' | 'supports') {
  return { source, target, type, weight: 0.5 } as any;
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    debate: makeDebate(),
    an: { nodes: [], edges: [] },
    anFilterMode: 'all' as const,
    anFilterNodeId: '',
    setAnFilterMode: vi.fn(),
    setAnFilterNodeId: vi.fn(),
    focusedNodeId: null,
    handleUpdateSubScore: vi.fn(),
    setOverviewTab: vi.fn() as (tab: OverviewTab) => void,
    setSelectedEntry: vi.fn(),
    setLocalOverride: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArgumentNetworkTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crash with empty AN (nodes: [], edges: [])', () => {
    expect(() => {
      render(<ArgumentNetworkTab {...makeProps()} />);
    }).not.toThrow();
  });

  it('shows edge count summary with attacks and supports counts', () => {
    const nodes = [makeNode('n1', 'e1', 'Claim A'), makeNode('n2', 'e2', 'Claim B')];
    const edges = [
      makeEdge('n1', 'n2', 'attacks'),
      makeEdge('n2', 'n1', 'attacks'),
      makeEdge('n1', 'n2', 'supports'),
    ];

    render(
      <ArgumentNetworkTab
        {...makeProps({ an: { nodes, edges } })}
      />,
    );

    // Summary line: "N I-nodes · M CA · P RA"
    const summary = screen.getByText(/2 I-nodes · 2 CA · 1 RA/i);
    expect(summary).toBeInTheDocument();
  });

  it('renders INodeRow for each AN node', () => {
    const nodes = [
      makeNode('n1', 'e1', 'First claim'),
      makeNode('n2', 'e1', 'Second claim'),
      makeNode('n3', 'e2', 'Third claim'),
    ];

    render(
      <ArgumentNetworkTab
        {...makeProps({ an: { nodes, edges: [] } })}
      />,
    );

    expect(screen.getByTestId('inode-n1')).toBeInTheDocument();
    expect(screen.getByTestId('inode-n2')).toBeInTheDocument();
    expect(screen.getByTestId('inode-n3')).toBeInTheDocument();
    expect(screen.getByText('First claim')).toBeInTheDocument();
    expect(screen.getByText('Second claim')).toBeInTheDocument();
    expect(screen.getByText('Third claim')).toBeInTheDocument();
  });

  it('minimap places a steelman node in the steelmanned camp\'s arc/color, not the speaker\'s (t/3781)', () => {
    const nodes = [
      { ...makeNode('n1', 'e1', 'Safetyist claim'), speaker: 'safetyist' },
      { ...makeNode('n2', 'e2', 'Steelman of skeptic'), speaker: 'accelerationist', steelman_of: 'skeptic' },
    ];

    const { container } = render(
      <ArgumentNetworkTab
        {...makeProps({ an: { nodes, edges: [] } })}
      />,
    );

    const circles = container.querySelectorAll('.ant-minimap-wrap circle');
    expect(circles).toHaveLength(2);
    const fills = Array.from(circles).map(c => c.getAttribute('fill'));
    // n2 is authored by accelerationist but steelmans skeptic — must render skeptic's color, never accelerationist's.
    expect(fills[0]).toBe('var(--color-saf)');
    expect(fills[1]).toBe('var(--color-skp)');
  });

  it('shows filter select with All, Unattributed, Novel, and Anchored options', () => {
    render(<ArgumentNetworkTab {...makeProps()} />);

    const select = screen.getByRole('combobox');
    expect(select).toBeInTheDocument();

    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    expect(options).toContain('All claims');
    expect(options).toContain('Unattributed only');
    expect(options).toContain('Novel arguments');
    expect(options).toContain('Attributed only');
  });

  // Regression: community/older debates may have argument_network.edges = null
  it('renders without crash when an.edges is null (community debate format)', () => {
    const nodes = [makeNode('n1', 'e1', 'Community claim')];
    expect(() => {
      render(
        <ArgumentNetworkTab
          {...makeProps({ an: { nodes, edges: null as any } })}
        />,
      );
    }).not.toThrow();
    expect(screen.getByTestId('inode-n1')).toBeInTheDocument();
  });
});

// t/4361: an old debate's confidence-history impacts must still surface for a node that's since
// been superseded (t/4355 holds superseded nodes out of state.<pov>.nodes).
describe('collectConfidenceImpacts — includes superseded nodes', () => {
  afterEach(() => {
    vi.mocked(useTaxonomyStore.getState).mockReturnValue({} as any);
  });

  it('counts history impacts from both selectable and superseded nodes for the same debate', () => {
    vi.mocked(useTaxonomyStore.getState).mockReturnValue({
      accelerationist: {
        nodes: [{
          id: 'acc-beliefs-001', label: 'Selectable node',
          confidence_history: [{ date: '2026-01-01', value: 0.6, delta: 0.1, reason: 'debate-1 turn' }],
        }],
      },
      safetyist: { nodes: [] },
      skeptic: { nodes: [] },
      supersededNodes: {
        accelerationist: [{
          index: 0,
          node: {
            id: 'acc-beliefs-002', label: 'Superseded node', superseded_by: 'acc-beliefs-003',
            priority_history: [{ date: '2026-01-02', value: 0.4, delta: -0.2, reason: 'debate-1 turn' }],
          },
        }],
        safetyist: [], skeptic: [],
      },
    } as any);

    const impacts = collectConfidenceImpacts('debate-1');

    expect(impacts.map(i => i.nodeId).sort()).toEqual(['acc-beliefs-001', 'acc-beliefs-002']);
  });
});

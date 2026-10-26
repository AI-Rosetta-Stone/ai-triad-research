import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NodeTree, getOrderedNodeIds, type ClusterGroup } from './NodeTree';
import type { PovNode } from '../../types/taxonomy';

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('../conflict/edit-conflicts', () => ({
  EditConflictBadge: () => null,
}));

function makeStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
}
const mockLocalStorage = makeStorageMock();
Object.defineProperty(window, 'localStorage', { value: mockLocalStorage });
// NodeTree backs its collapse state on sessionStorage (t/2720): empty at session
// start → all categories collapsed. Render suites below seed it with '[]' (nothing
// collapsed) so node rows are visible; the session-start test leaves it empty.
const mockSessionStorage = makeStorageMock();
Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage });

Element.prototype.scrollIntoView = vi.fn();
HTMLElement.prototype.focus = vi.fn();

function makeNode(overrides: Partial<PovNode> & { id: string; category: string }): PovNode {
  return {
    label: overrides.id,
    description: '',
    children: [],
    parent_id: null,
    parent_relationship: null,
    ...overrides,
  } as PovNode;
}

const NODES: PovNode[] = [
  makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'Open dev is safe', confidence: 0.9 }),
  makeNode({ id: 'acc-B-002', category: 'Beliefs', label: 'Markets self-correct', confidence: 0.6 }),
  makeNode({ id: 'acc-D-001', category: 'Desires', label: 'Maximize progress', priority: 5 }),
  makeNode({ id: 'acc-D-002', category: 'Desires', label: 'Open access', priority: 3 }),
  makeNode({ id: 'acc-I-001', category: 'Intentions', label: 'Fund research' }),
  makeNode({ id: 'acc-I-002', category: 'Intentions', label: 'Publish papers' }),
];

describe('getOrderedNodeIds', () => {
  it('returns IDs grouped by category order (Desires, Intentions, Beliefs)', () => {
    const ids = getOrderedNodeIds(NODES, 'id');
    const desireIdx = ids.indexOf('acc-D-001');
    const intentionIdx = ids.indexOf('acc-I-001');
    const beliefIdx = ids.indexOf('acc-B-001');
    expect(desireIdx).toBeLessThan(intentionIdx);
    expect(intentionIdx).toBeLessThan(beliefIdx);
  });

  it('sorts alphabetically by label within categories when sortMode is label', () => {
    const ids = getOrderedNodeIds(NODES, 'label');
    const desires = ids.filter(id => id.includes('-D-'));
    expect(desires[0]).toBe('acc-D-001');
    expect(desires[1]).toBe('acc-D-002');
  });

  it('sorts by priority descending for Desires in priority mode', () => {
    const ids = getOrderedNodeIds(NODES, 'priority');
    const desires = ids.filter(id => id.includes('-D-'));
    expect(desires[0]).toBe('acc-D-001');
    expect(desires[1]).toBe('acc-D-002');
  });

  it('sorts by confidence descending for Beliefs in priority mode', () => {
    const ids = getOrderedNodeIds(NODES, 'priority');
    const beliefs = ids.filter(id => id.includes('-B-'));
    expect(beliefs[0]).toBe('acc-B-001');
    expect(beliefs[1]).toBe('acc-B-002');
  });

  it('returns cluster order when clusters are provided in similarity mode', () => {
    const clusters: ClusterGroup[] = [
      { label: 'Cluster A', nodeIds: ['acc-I-002', 'acc-B-001'] },
      { label: 'Cluster B', nodeIds: ['acc-D-001'] },
    ];
    const ids = getOrderedNodeIds(NODES, 'similarity', null, clusters);
    expect(ids).toEqual(['acc-I-002', 'acc-B-001', 'acc-D-001']);
  });

  it('sorts Beliefs by debate_tested sort_key ascending (least tested first)', () => {
    const nodes: PovNode[] = [
      makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'A', graph_attributes: { debate_tested: { sort_key: 3.2 } } as any }),
      makeNode({ id: 'acc-B-002', category: 'Beliefs', label: 'B', graph_attributes: { debate_tested: { sort_key: 0.5 } } as any }),
      makeNode({ id: 'acc-B-003', category: 'Beliefs', label: 'C', graph_attributes: { debate_tested: { sort_key: 1.8 } } as any }),
    ];
    const beliefs = getOrderedNodeIds(nodes, 'debate_tested').filter(id => id.includes('-B-'));
    expect(beliefs).toEqual(['acc-B-002', 'acc-B-003', 'acc-B-001']);
  });

  it('sorts Beliefs by debate_tested sort_key descending (most tested first)', () => {
    const nodes: PovNode[] = [
      makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'A', graph_attributes: { debate_tested: { sort_key: 3.2 } } as any }),
      makeNode({ id: 'acc-B-002', category: 'Beliefs', label: 'B', graph_attributes: { debate_tested: { sort_key: 0.5 } } as any }),
      makeNode({ id: 'acc-B-003', category: 'Beliefs', label: 'C', graph_attributes: { debate_tested: { sort_key: 1.8 } } as any }),
    ];
    const beliefs = getOrderedNodeIds(nodes, 'debate_tested_desc').filter(id => id.includes('-B-'));
    expect(beliefs).toEqual(['acc-B-001', 'acc-B-003', 'acc-B-002']);
  });

  it('treats missing debate_tested as sort_key 0 (least tested)', () => {
    const nodes: PovNode[] = [
      makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'A', graph_attributes: { debate_tested: { sort_key: 2.0 } } as any }),
      makeNode({ id: 'acc-B-002', category: 'Beliefs', label: 'B' }),
    ];
    const beliefs = getOrderedNodeIds(nodes, 'debate_tested').filter(id => id.includes('-B-'));
    expect(beliefs).toEqual(['acc-B-002', 'acc-B-001']);
  });
});

describe('NodeTree', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    // Seed sessionStorage with nothing-collapsed so category rows render for these suites.
    mockSessionStorage.clear();
    mockSessionStorage.setItem('taxonomy-editor-collapsed-categories', '[]');
  });

  it('renders category headers with counts', () => {
    render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/Desires/)).toBeDefined();
    expect(screen.getByText(/Intentions/)).toBeDefined();
    expect(screen.getByText(/Beliefs/)).toBeDefined();
  });

  it('collapses all BDI categories at session start (empty sessionStorage) (t/2720)', () => {
    // Fresh session: no stored collapse state at all.
    mockSessionStorage.clear();
    render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={vi.fn()} />);
    // Category headers still render...
    expect(screen.getByText(/Desires/)).toBeDefined();
    expect(screen.getByText(/Intentions/)).toBeDefined();
    expect(screen.getByText(/Beliefs/)).toBeDefined();
    // ...but every category is collapsed, so no node rows are visible.
    expect(screen.queryByText('Open dev is safe')).toBeNull();
    expect(screen.queryByText('Maximize progress')).toBeNull();
    expect(screen.queryByText('Fund research')).toBeNull();
  });

  it('calls onSelect when a node is clicked', () => {
    const onSelect = vi.fn();
    render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Open dev is safe').closest('.node-item')!);
    expect(onSelect).toHaveBeenCalledWith('acc-B-001');
  });

  it('applies selected class to the active node', () => {
    render(<NodeTree nodes={NODES} selectedNodeId="acc-B-001" onSelect={vi.fn()} />);
    const nodeEl = screen.getByText('Open dev is safe').closest('.node-item');
    expect(nodeEl?.className).toContain('selected');
  });

  it('shows cluster loading state when sortMode is similarity and loading', () => {
    render(
      <NodeTree
        nodes={NODES}
        selectedNodeId={null}
        onSelect={vi.fn()}
        sortMode="similarity"
        clusterLoading={true}
      />,
    );
    expect(screen.getByText('Clustering nodes...')).toBeDefined();
  });

  it('renders cluster groups when clusters are provided', () => {
    const clusters: ClusterGroup[] = [
      { label: 'Safety beliefs', nodeIds: ['acc-B-001', 'acc-B-002'] },
    ];
    render(
      <NodeTree
        nodes={NODES}
        selectedNodeId={null}
        onSelect={vi.fn()}
        sortMode="similarity"
        clusters={clusters}
      />,
    );
    expect(screen.getByText(/Safety beliefs/)).toBeDefined();
  });

  it('shows labels but hides raw node IDs in list rows (t/2317)', () => {
    render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={vi.fn()} />);
    // Human-readable labels are shown...
    expect(screen.getByText('Open dev is safe')).toBeDefined();
    expect(screen.getByText('Maximize progress')).toBeDefined();
    // ...but the raw node IDs are no longer rendered for end users.
    expect(screen.queryByText('acc-B-001')).toBeNull();
    expect(screen.queryByText('acc-D-001')).toBeNull();
  });
});

describe('NodeTree debate-tested chip display gate (t/1661)', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    // Seed sessionStorage with nothing-collapsed so category rows render for these suites.
    mockSessionStorage.clear();
    mockSessionStorage.setItem('taxonomy-editor-collapsed-categories', '[]');
  });

  // Hybrid gate: Beliefs always show the chip (legacy "Untested" when record-less);
  // Desire/Intention nodes show it only once they carry a debate_tested record.
  const GATED_NODES: PovNode[] = [
    makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'Belief no record' }),
    makeNode({ id: 'acc-D-001', category: 'Desires', label: 'Desire cited', graph_attributes: { debate_tested: { tier: 'cited', sort_key: 1.0 } } as any }),
    makeNode({ id: 'acc-D-002', category: 'Desires', label: 'Desire no record' }),
    makeNode({ id: 'acc-I-001', category: 'Intentions', label: 'Intention well tested', graph_attributes: { debate_tested: { tier: 'well_tested', sort_key: 4.0 } } as any }),
    makeNode({ id: 'acc-I-002', category: 'Intentions', label: 'Intention no record' }),
  ];

  function chipTextFor(label: string): string | null {
    const item = screen.getByText(label).closest('.node-item');
    return item?.querySelector('.debate-tested-chip')?.textContent ?? null;
  }

  it('renders the chip for a Desire node with a populated debate_tested record', () => {
    render(<NodeTree nodes={GATED_NODES} selectedNodeId={null} onSelect={vi.fn()} sortMode="debate_tested" showDebateTestedChip />);
    expect(chipTextFor('Desire cited')).toContain('Cited');
  });

  it('renders the chip for an Intention node with a populated debate_tested record', () => {
    render(<NodeTree nodes={GATED_NODES} selectedNodeId={null} onSelect={vi.fn()} sortMode="debate_tested" showDebateTestedChip />);
    expect(chipTextFor('Intention well tested')).toContain('Well Tested');
  });

  it('renders no chip for Desire/Intention nodes lacking a debate_tested record', () => {
    render(<NodeTree nodes={GATED_NODES} selectedNodeId={null} onSelect={vi.fn()} sortMode="debate_tested" showDebateTestedChip />);
    expect(chipTextFor('Desire no record')).toBeNull();
    expect(chipTextFor('Intention no record')).toBeNull();
  });

  it('preserves the legacy Untested chip for record-less Belief nodes', () => {
    render(<NodeTree nodes={GATED_NODES} selectedNodeId={null} onSelect={vi.fn()} sortMode="debate_tested" showDebateTestedChip />);
    expect(chipTextFor('Belief no record')).toContain('Untested');
  });

  it('renders no chips when showDebateTestedChip is false (non-debate-tested sort)', () => {
    render(<NodeTree nodes={GATED_NODES} selectedNodeId={null} onSelect={vi.fn()} sortMode="debate_tested" />);
    expect(chipTextFor('Desire cited')).toBeNull();
    expect(chipTextFor('Belief no record')).toBeNull();
  });
});

// ── t/4532: title-only nav, per-POV collapse state, no-auto-expand on first view ──

describe('t/4532: nav row shows title only, no aphorism', () => {
  it('never renders graph_attributes.aphorism, even when present', () => {
    mockSessionStorage.setItem('taxonomy-editor-collapsed-categories', '[]');
    const withAphorism = [
      makeNode({ id: 'acc-B-001', category: 'Beliefs', label: 'Open dev is safe', graph_attributes: { aphorism: 'Move fast, build things' } as any }),
    ];
    render(<NodeTree nodes={withAphorism} selectedNodeId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Open dev is safe')).toBeDefined();
    expect(screen.queryByText('Move fast, build things')).toBeNull();
  });
});

describe('t/4532: collapse state is per POV', () => {
  const accNodes = NODES; // acc-* ids, as above
  const safNodes: PovNode[] = [
    makeNode({ id: 'saf-B-001', category: 'Beliefs', label: 'Caution first' }),
    makeNode({ id: 'saf-D-001', category: 'Desires', label: 'Avoid harm' }),
    makeNode({ id: 'saf-I-001', category: 'Intentions', label: 'Slow rollout' }),
  ];

  beforeEach(() => mockSessionStorage.clear());

  it('expanding Desires for one POV leaves Desires collapsed for another', () => {
    const r1 = render(<NodeTree nodes={accNodes} selectedNodeId={null} onSelect={vi.fn()} pov="accelerationist" />);
    fireEvent.click(document.querySelector('[data-cat="Desires"]')!);
    expect(screen.getByText('Maximize progress')).toBeDefined();
    r1.unmount();

    render(<NodeTree nodes={safNodes} selectedNodeId={null} onSelect={vi.fn()} pov="safetyist" />);
    expect(screen.queryByText('Avoid harm')).toBeNull(); // still collapsed: safetyist's own key, untouched
  });

  it('reopening a POV already visited this session keeps what was expanded there', () => {
    const r1 = render(<NodeTree nodes={accNodes} selectedNodeId={null} onSelect={vi.fn()} pov="accelerationist" />);
    fireEvent.click(document.querySelector('[data-cat="Desires"]')!);
    expect(screen.getByText('Maximize progress')).toBeDefined();
    r1.unmount();

    // Switch away and back (PovTab's conditional mount: NodeTree remounts fresh each time).
    render(<NodeTree nodes={safNodes} selectedNodeId={null} onSelect={vi.fn()} pov="safetyist" />).unmount();
    render(<NodeTree nodes={accNodes} selectedNodeId={null} onSelect={vi.fn()} pov="accelerationist" />);
    expect(screen.getByText('Maximize progress')).toBeDefined(); // still expanded
  });

  it('two NodeTree instances with no pov prop share the legacy bare key (backward compat)', () => {
    // Existing suites above never pass `pov` and seed the bare key directly — this just pins
    // that the fallback really is the pre-t/4532 key, not a `:undefined`-suffixed one.
    mockSessionStorage.setItem('taxonomy-editor-collapsed-categories', '[]');
    render(<NodeTree nodes={accNodes} selectedNodeId={null} onSelect={vi.fn()} />);
    expect(screen.getByText('Open dev is safe')).toBeDefined();
  });
});

describe('t/4532: a preselected/restored node does not auto-expand its category on first view', () => {
  beforeEach(() => mockSessionStorage.clear());

  it('first-ever view this session: a preselected node in a collapsed category stays collapsed', () => {
    // True first view: sessionStorage has nothing for this POV yet.
    render(<NodeTree nodes={NODES} selectedNodeId="acc-D-001" onSelect={vi.fn()} pov="accelerationist" />);
    expect(screen.queryByText('Maximize progress')).toBeNull(); // Desires stays collapsed
  });

  it('explicit navigation within the same mount still auto-expands (search, link, keyboard-nav)', () => {
    const { rerender } = render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={vi.fn()} pov="accelerationist" />);
    expect(screen.queryByText('Maximize progress')).toBeNull();
    rerender(<NodeTree nodes={NODES} selectedNodeId="acc-D-001" onSelect={vi.fn()} pov="accelerationist" />);
    expect(screen.getByText('Maximize progress')).toBeDefined(); // now expanded: a later, explicit selection
  });

  it('reopening a POV already visited this session: a preselected node DOES auto-expand (not a first view)', () => {
    render(<NodeTree nodes={NODES} selectedNodeId={null} onSelect={vi.fn()} pov="accelerationist" />).unmount();
    // Second mount: sessionStorage already has this POV's key (still all-collapsed, but present).
    render(<NodeTree nodes={NODES} selectedNodeId="acc-D-001" onSelect={vi.fn()} pov="accelerationist" />);
    expect(screen.getByText('Maximize progress')).toBeDefined();
  });
});

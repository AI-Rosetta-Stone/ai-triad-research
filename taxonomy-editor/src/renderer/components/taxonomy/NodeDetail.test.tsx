// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression tests for t/2142: Zustand inline-object selector caused infinite
// render loop. Scalar selectors fix it; a successful render() call proves the
// fix holds. Also asserts Simple/Advanced tab visibility gate works correctly.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PovNode } from '../../types/taxonomy';

// ── Store mocks ──────────────────────────────────────────────────────────────

const mockTaxonomyStore = {
  updatePovNode: vi.fn(),
  deletePovNode: vi.fn(),
  movePovNodeCategory: vi.fn(),
  movePovNode: vi.fn(),
  validationErrors: {},
  getAllNodeIds: vi.fn(() => []),
  getAllConflictIds: vi.fn(() => []),
  runAttributeFilter: vi.fn(),
  showAttributeInfo: vi.fn(),
  navigateToLineage: vi.fn(),
  setToolbarPanel: vi.fn(),
  selectedEdge: null,
  relatedNodeId: null,
  loadEdges: vi.fn(),
  edgesFile: null,
  setSelectedNodeId: vi.fn(),
  getLabelForId: vi.fn(() => ''),
  aggregatedCruxes: null,
  showCruxDetail: vi.fn(),
  conflicts: [],
  accelerationist: null,
  safetyist: null,
  skeptic: null,
  situations: null,
};

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: () => mockTaxonomyStore,
}));

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: () => ({ activeDebate: null }),
}));

// t/4574: the panel-local per-node mode replaces the global viewMode read in NodeDetail.
// mockPrefsState.viewMode is kept so other consumers (DescriptionSection's search-highlight
// guard) and existing tests about the *global* control continue to compile, but NodeDetail
// itself now reads/writes nodeDetailModes, keyed by node id.
const mockPrefsState = {
  viewMode: 'simple' as 'simple' | 'advanced',
  setViewMode: vi.fn(),
  hydrate: vi.fn(),
  nodeDetailModes: {} as Record<string, 'simple' | 'advanced'>,
  setNodeDetailMode: vi.fn(async (nodeId: string, mode: 'simple' | 'advanced') => {
    mockPrefsState.nodeDetailModes = { ...mockPrefsState.nodeDetailModes, [nodeId]: mode };
  }),
};

vi.mock('../../store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: typeof mockPrefsState) => unknown) =>
    selector(mockPrefsState),
}));

/** Sets the panel-local mode for a node — the t/4574 replacement for the old `mockPrefsState.viewMode = ...`. */
function setNodeMode(nodeId: string, mode: 'simple' | 'advanced') {
  mockPrefsState.nodeDetailModes = { ...mockPrefsState.nodeDetailModes, [nodeId]: mode };
}

// ── Bridge / lib mocks ───────────────────────────────────────────────────────

vi.mock('@bridge', () => ({
  api: {
    clipboardWriteText: vi.fn(),
    resolveSourceDocument: vi.fn().mockResolvedValue({ available: false, type: null }),
    openExternal: vi.fn(),
    getSourceEvidence: vi.fn().mockResolvedValue({ facts: [], keyPoints: [], formattedBlock: '', nodesCovered: [], totalCandidates: 0 }),
    getWebAppUrl: vi.fn().mockResolvedValue(null),
    logNodeDeletion: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

vi.mock('@lib/electron-shared/povMeta', () => ({
  POV_META: {
    accelerationist: { label: 'Accelerationist', color: '#e74c3c' },
    safetyist: { label: 'Safetyist', color: '#2980b9' },
    skeptic: { label: 'Skeptic', color: '#27ae60' },
    'cross-cutting': { label: 'Cross-Cutting', color: '#8e44ad' },
  },
}));

// ── Heavy child stubs ─────────────────────────────────────────────────────────

vi.mock('../edge-browser/RelatedEdgesPanel', () => ({ RelatedEdgesPanel: () => null }));
vi.mock('../edge-browser/EdgeDetailPanel', () => ({ EdgeDetailPanel: () => null }));
vi.mock('../policy/SourcesPanel', () => ({ SourcesPanel: () => null }));
vi.mock('../policy/PhrasesPanel', () => ({ PhrasesPanel: () => null }));
vi.mock('../analysis/FactsPanel', () => ({
  FactsPanel: () => null,
  getFactCount: () => 0,
  preloadFactsIndex: vi.fn(),
}));
vi.mock('../conflict', () => ({
  ConflictsPanel: () => null,
  conflictsForNode: () => [],
}));
vi.mock('./GraphAttributesPanel', () => ({ GraphAttributesPanel: () => null }));
vi.mock('./NodeEditHistory', () => ({ NodeEditHistory: () => null }));
// t/3393/t/4574: spy (not a plain () => null) so tests can assert the status badge was
// actually reached for a given node category, not just that rendering didn't throw. The
// status moved from a Content-tab chip to the meta-line NodeStatusBadge (t/4574 spec §2.1).
const { mockNodeStatusBadge } = vi.hoisted(() => ({ mockNodeStatusBadge: vi.fn(() => null) }));
vi.mock('./DebateTestedChip', () => ({
  DebateTestedChip: vi.fn(() => null),
  NodeStatusBadge: mockNodeStatusBadge,
}));
vi.mock('./DebateTestedDrilldown', () => ({ DebateTestedDrilldown: () => null }));
vi.mock('../shared/MentionField', () => ({
  useContainerMentionKit: () => ({
    mentions: [],
    onSelectRef: vi.fn(),
    renderField: (_fieldName: string, fallback: string) => fallback,
    segmentsFor: () => [],
  }),
  MentionField: () => null,
}));
vi.mock('../../utils/regeneratePlainDescription', () => ({ triggerPovNodeRegeneration: vi.fn() }));
vi.mock('../../data/lineageLookup', () => ({ getLineageInfo: () => null }));
vi.mock('../../prompts/research', () => ({ researchPrompt: () => '' }));
// t/4167: who may edit POV tags (default: may, so the other tests are unaffected).
const tagPerm = vi.hoisted(() => ({ canEdit: true }));
vi.mock('../../hooks/useCanEditPovTags', () => ({ useCanEditPovTags: () => tagPerm.canEdit }));
// t/4559: who sees the "..." menu / Pin fallback (default: admin, so the other tests —
// written against the pre-t/4559 always-visible menu — are unaffected).
const adminState = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../../hooks/useIsAdmin', () => ({ useIsAdmin: () => adminState.isAdmin }));
vi.mock('../conflict/edit-conflicts', () => ({
  EditConflictBadge: () => null,
}));

// ── Minimal valid PovNode fixture ────────────────────────────────────────────

const mockNode: PovNode = {
  id: 'acc-beliefs-001',
  category: 'beliefs',
  label: 'Test Belief',
  description: 'A test belief node.',
  parent_id: null,
  children: [],
  situation_refs: [],
};

// ── Component under test ──────────────────────────────────────────────────────

import { NodeDetail } from './NodeDetail';

describe('NodeDetail — Zustand scalar selector regression (t/2142)', () => {
  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    vi.clearAllMocks();
  });

  it('renders without infinite loop in simple mode', () => {
    // Pre-fix: inline `{ viewMode }` object selector created new ref each render
    // → Zustand re-subscribed → re-render → "Maximum update depth exceeded"
    expect(() =>
      render(
        <NodeDetail
          pov="acc"
          node={mockNode}
          readOnly={false}
          onPin={vi.fn()}
          onSimilarSearch={vi.fn()}
          onRelated={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });

  it('renders without infinite loop in advanced mode', () => {
    setNodeMode(mockNode.id, 'advanced');
    expect(() =>
      render(
        <NodeDetail
          pov="acc"
          node={mockNode}
          readOnly={false}
          onPin={vi.fn()}
          onSimilarSearch={vi.fn()}
          onRelated={vi.fn()}
        />,
      ),
    ).not.toThrow();
  });

  it('surfaces Content and Related in simple mode; Attributes and other advanced tabs stay hidden (t/4559, reverses t/3003)', () => {
    render(
      <NodeDetail
        pov="acc"
        node={mockNode}
        readOnly={false}
        onPin={vi.fn()}
        onSimilarSearch={vi.fn()}
        onRelated={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /analysis/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /related/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /research/i })).not.toBeInTheDocument();
  });

  it('shows all four tabs in advanced mode', () => {
    setNodeMode(mockNode.id, 'advanced');
    render(
      <NodeDetail
        pov="acc"
        node={mockNode}
        readOnly={false}
        onPin={vi.fn()}
        onSimilarSearch={vi.fn()}
        onRelated={vi.fn()}
      />,
    );
    expect(screen.getByRole('tab', { name: /analysis/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /related/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /attributes/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /research/i })).toBeInTheDocument();
  });

  // t/4559 — Attributes is now Advanced-only; a user on it who drops to Simple lands on Content.
  it('resets the active tab to Content when switching advanced→simple while on Attributes', () => {
    setNodeMode(mockNode.id, 'advanced');
    const { rerender } = render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );

    const attributesTab = screen.getByRole('tab', { name: /attributes/i });
    fireEvent.click(attributesTab);
    expect(attributesTab.className).toContain('node-detail-tab-active');

    mockPrefsState.nodeDetailModes = {};
    rerender(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );

    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /analysis/i }).className).toContain('node-detail-tab-active');
  });

  // t/2826 — the Pin-for-comparison ("bookmark") control is Advanced-view only.
  it('omits Pin for Comparison from the actions menu in simple mode', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.queryByRole('menuitem', { name: /pin for comparison/i })).not.toBeInTheDocument();
  });

  it('includes Pin for Comparison in the actions menu in advanced mode', () => {
    setNodeMode(mockNode.id, 'advanced');
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menuitem', { name: /pin for comparison/i })).toBeInTheDocument();
  });

  // t/4200 — the soul-doc button hands the node's pov_tags to the dialog, which opens on that tag's soul.
  it('the soul-doc button passes the node pov_tags to onOpenSoulDoc', () => {
    setNodeMode(mockNode.id, 'advanced');
    const onOpenSoulDoc = vi.fn();
    render(
      <NodeDetail pov="skeptic" node={{ ...mockNode, pov_tags: ['institutional'] }} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} onOpenSoulDoc={onOpenSoulDoc} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Soul document' }));
    expect(onOpenSoulDoc).toHaveBeenCalledWith(['institutional']);
  });
});

// ── t/4574: the panel-local Simple/Advanced toggle is per-node and isolated from the
// global `viewMode` control in both directions, and the panel drops to Analysis when
// the effective mode is Simple and the active tab is Advanced-only (on toggle or on
// node change) — docs/ux/node-detail-redesign.md §1, §2.5.

describe('NodeDetail — panel-local Simple/Advanced toggle isolation and persistence (t/4574)', () => {
  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    mockPrefsState.viewMode = 'simple';
    vi.clearAllMocks();
  });

  it('clicking Advanced writes only the per-node mode — the global setViewMode is never called', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
    expect(mockPrefsState.setNodeDetailMode).toHaveBeenCalledWith(mockNode.id, 'advanced');
    expect(mockPrefsState.setViewMode).not.toHaveBeenCalled();
    expect(mockPrefsState.viewMode).toBe('simple');
  });

  it('the global viewMode being Advanced does not flip this panel to Advanced', () => {
    mockPrefsState.viewMode = 'advanced';
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
  });

  it('each node remembers its own mode independently, and an untoggled node opens in Simple', () => {
    const otherNode: PovNode = { ...mockNode, id: 'acc-beliefs-777' };
    setNodeMode(mockNode.id, 'advanced');
    const { rerender } = render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /attributes/i })).toBeInTheDocument();

    rerender(<NodeDetail pov="acc" node={otherNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
  });

  it('drops to Analysis when toggling to Simple while an Advanced-only tab is active', () => {
    setNodeMode(mockNode.id, 'advanced');
    const { rerender } = render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /attributes/i }));
    expect(screen.getByRole('tab', { name: /attributes/i }).className).toContain('node-detail-tab-active');

    // The toggle's own store write isn't reactive in this lightweight mock (see
    // mockPrefsState), so the drop-to-Analysis rule is driven the same way the rest of
    // this suite drives a mode change: write the store, then rerender.
    setNodeMode(mockNode.id, 'simple');
    rerender(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /analysis/i }).className).toContain('node-detail-tab-active');
  });

  it('drops to Analysis on node change when the new node is Simple and an Advanced-only tab was active', () => {
    const otherNode: PovNode = { ...mockNode, id: 'acc-beliefs-778' };
    setNodeMode(mockNode.id, 'advanced');
    const { rerender } = render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /attributes/i }));
    expect(screen.getByRole('tab', { name: /attributes/i }).className).toContain('node-detail-tab-active');

    // otherNode has never been toggled — its mode defaults to Simple.
    rerender(<NodeDetail pov="acc" node={otherNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /attributes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /analysis/i }).className).toContain('node-detail-tab-active');
  });

  it('the toggle is a radiogroup with aria-checked reflecting the current mode', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Detail view' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Simple' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Advanced' })).toHaveAttribute('aria-checked', 'false');
  });

  // t/4574#15 item 1 (Design): these vanished because TheoryLink's own gate reads the
  // *global* viewMode, not this panel's local mode — the global control defaults to
  // Simple, so the icons silently no-op'd even though the panel itself was Advanced.
  it('the ontology-guide and Soul-analysis icons show in Advanced, independent of the global viewMode', () => {
    mockPrefsState.viewMode = 'simple'; // the global control stays Simple throughout
    setNodeMode(mockNode.id, 'advanced');
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Help: taxonomy ontology guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Soul documents analysis' })).toBeInTheDocument();
  });
});

// ── History tab viewMode gating (t/3021) ──────────────────────────────────────
// Locks the current policy: History is an Advanced-only tab (NodeDetail.tsx:670,
// advanced: true → filtered out of the tab bar in Simple view) and the activeTab
// reset effect forces 'content' whenever the view drops to Simple off a hidden
// tab. The t/3022 Option-3 ruling keeps this gating (it adds a *separate* Simple
// last-edited line, not the tab), so these assertions stay valid.

describe('NodeDetail — History tab viewMode gating (t/3021)', () => {
  const nodeWithHistory: PovNode = {
    ...mockNode,
    _edit_history: [
      { user: 'first@test.com', timestamp: '2026-01-01T00:00:00Z', fields_changed: ['label'] },
      { user: 'second@test.com', timestamp: '2026-01-02T00:00:00Z', fields_changed: ['description'] },
    ],
  };

  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    vi.clearAllMocks();
  });

  it('shows the History tab in advanced mode when edit history exists', () => {
    setNodeMode(mockNode.id, 'advanced');
    render(
      <NodeDetail pov="acc" node={nodeWithHistory} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
  });

  it('hides the History tab in simple mode even when edit history exists', () => {
    mockPrefsState.nodeDetailModes = {};
    render(
      <NodeDetail pov="acc" node={nodeWithHistory} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
  });

  it('hides the History tab in simple mode when there is no edit history', () => {
    mockPrefsState.nodeDetailModes = {};
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
  });

  it('resets the active tab to Content when switching advanced→simple while on History', () => {
    setNodeMode(mockNode.id, 'advanced');
    const { rerender } = render(
      <NodeDetail pov="acc" node={nodeWithHistory} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );

    // Open the History tab — it becomes the active tab.
    const historyTab = screen.getByRole('tab', { name: /history/i });
    fireEvent.click(historyTab);
    expect(historyTab.className).toContain('node-detail-tab-active');

    // Drop to Simple view. The reset effect keys on viewMode → forces activeTab back to 'content'.
    mockPrefsState.nodeDetailModes = {};
    rerender(
      <NodeDetail pov="acc" node={nodeWithHistory} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );

    // History tab is gone, and Content is now the active tab (not a stale hidden 'history').
    expect(screen.queryByRole('tab', { name: /history/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /analysis/i }).className).toContain('node-detail-tab-active');
  });
});

// ── Simple-view last-edited line (t/3022, Option 3) ───────────────────────────
// The full History tab stays Advanced-only; Simple view surfaces just the
// who/when last-edited datum inline. Sourced from _edit_meta, falling back to the
// most-recent _edit_history entry.

describe('NodeDetail — Simple-view last-edited line (t/3022)', () => {
  const nodeWithMeta: PovNode = {
    ...mockNode,
    _edit_meta: { last_edited_by: 'editor@test.com', last_edited_at: '2026-02-03T10:00:00Z' },
  };
  const nodeWithHistoryOnly: PovNode = {
    ...mockNode,
    _edit_history: [{ user: 'histuser@test.com', timestamp: '2026-02-04T10:00:00Z', fields_changed: ['label'] }],
  };

  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    vi.clearAllMocks();
  });

  it('shows the last-edited line in Simple view from _edit_meta (username, domain stripped)', () => {
    render(<NodeDetail pov="acc" node={nodeWithMeta} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText(/last edited by/i)).toBeInTheDocument();
    expect(screen.getByText('editor')).toBeInTheDocument();
  });

  it('falls back to the most-recent _edit_history entry when _edit_meta is absent', () => {
    render(<NodeDetail pov="acc" node={nodeWithHistoryOnly} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText(/last edited by/i)).toBeInTheDocument();
    expect(screen.getByText('histuser')).toBeInTheDocument();
  });

  // t/4574 spec §2.6: the footer now shows in Advanced too (History still has the full log).
  it('shows the last-edited line in Advanced view too (t/4574 — was Simple-only)', () => {
    setNodeMode(mockNode.id, 'advanced');
    render(<NodeDetail pov="acc" node={nodeWithMeta} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText(/last edited by/i)).toBeInTheDocument();
  });

  it('omits the last-edited line when the node has no edit metadata', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByText(/last edited by/i)).not.toBeInTheDocument();
  });
});

// ── Debate Tested on all BDI categories (t/3393) ────────────────────────────
// Previously gated to `node.category === 'Beliefs'` only; the underlying
// debate_tested record is populated on Desires/Intentions nodes too (confirmed
// against live taxonomy data), so the chip must render on every category.

describe('NodeDetail — Debate Tested chip renders on every BDI category (t/3393)', () => {
  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    vi.clearAllMocks();
  });

  it.each(['Beliefs', 'Desires', 'Intentions'] as const)('renders the Debate Tested chip for a %s node', (category) => {
    render(
      <NodeDetail
        pov="acc"
        node={{ ...mockNode, category }}
        readOnly={false}
        onPin={vi.fn()}
        onSimilarSearch={vi.fn()}
        onRelated={vi.fn()}
      />,
    );
    expect(mockNodeStatusBadge).toHaveBeenCalled();
  });
});

// ── Delete flow: dangling-reference warning + durable log (t/3852) ─────────

describe('NodeDetail — delete flow warns of dangling references and logs the deletion (t/3852)', () => {
  beforeEach(() => {
    mockPrefsState.nodeDetailModes = {};
    vi.clearAllMocks();
    mockTaxonomyStore.accelerationist = null;
    mockTaxonomyStore.safetyist = null;
    mockTaxonomyStore.skeptic = null;
    mockTaxonomyStore.situations = null;
    mockTaxonomyStore.edgesFile = null;
  });

  function openDeleteDialog() {
    fireEvent.click(screen.getByTitle('More actions'));
    fireEvent.click(screen.getByRole('menuitem', { name: /delete/i }));
  }

  it('shows no dangling warning and logs zero counts when nothing references the node', async () => {
    const { api } = await import('@bridge');
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    openDeleteDialog();
    expect(screen.queryByText(/this will orphan/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockTaxonomyStore.deletePovNode).toHaveBeenCalledWith('acc', mockNode.id);
    expect(api.logNodeDeletion).toHaveBeenCalledWith({
      nodeId: mockNode.id,
      pov: 'acc',
      label: mockNode.label,
      user: '_anonymous',
      danglingEdges: 0,
      danglingSituationRefs: 0,
      danglingChildren: 0,
    });
  });

  it('shows the dangling-reference count and logs it when edges and situations reference the node', async () => {
    const { api } = await import('@bridge');
    mockTaxonomyStore.edgesFile = {
      _schema_version: '1', _doc: '', last_modified: '', edge_types: [],
      edges: [
        { source: mockNode.id, target: 'saf-beliefs-002', type: 'supports', bidirectional: false, confidence: 1 },
        { source: 'skp-beliefs-003', target: mockNode.id, type: 'supports', bidirectional: false, confidence: 1 },
      ],
    } as never;
    mockTaxonomyStore.situations = {
      _schema_version: '1', _doc: '', last_modified: '',
      nodes: [{ id: 'sit-001', label: 'S', description: 'd', linked_nodes: [mockNode.id], conflict_ids: [] }],
    } as never;

    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    openDeleteDialog();
    expect(screen.getByText('This will orphan 2 edges, 1 situation reference.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(mockTaxonomyStore.deletePovNode).toHaveBeenCalledWith('acc', mockNode.id);
    expect(api.logNodeDeletion).toHaveBeenCalledWith({
      nodeId: mockNode.id,
      pov: 'acc',
      label: mockNode.label,
      user: '_anonymous',
      danglingEdges: 2,
      danglingSituationRefs: 1,
      danglingChildren: 0,
    });
  });
});

// ── POV tags are admin-only (t/4167) ─────────────────────────────────────────
describe('NodeDetail — POV tag editing is admin-only (t/4167)', () => {
  const renderTagged = () => render(
    <NodeDetail pov="skeptic" node={{ ...mockNode, pov_tags: ['critical'] }} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
  );

  beforeEach(() => { tagPerm.canEdit = true; });

  it('without tag permission the chips show but there is no remove or add control', () => {
    tagPerm.canEdit = false;
    renderTagged();
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Add POV tag' })).not.toBeInTheDocument();
  });

  it('without tag permission the rest of the node stays editable', () => {
    tagPerm.canEdit = false;
    renderTagged();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThan(0);
  });

  it('with tag permission the remove and add controls show', () => {
    renderTagged();
    expect(screen.getByRole('button', { name: 'Remove tag Critical' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add POV tag' })).toBeInTheDocument();
  });
});

// ── t/4559: the "..." overflow menu and the read-only Pin fallback are admin-only ──
// (desktop: always admin; web: profile.isAdmin === true; while loading/on error: not admin —
// covered by useIsAdmin.test.ts. Here: the component actually hides the controls either way.)

describe('NodeDetail — "..." menu and Pin fallback are admin-only (t/4559)', () => {
  beforeEach(() => {
    adminState.isAdmin = true;
    setNodeMode(mockNode.id, 'advanced');
  });

  it('admin: sees the "..." menu (editable) in advanced mode', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByTitle('More actions')).toBeInTheDocument();
  });

  it('non-admin: the "..." menu is hidden (editable) in advanced mode', () => {
    adminState.isAdmin = false;
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByTitle('More actions')).not.toBeInTheDocument();
  });

  // t/4574 spec §2.2: the read-only Pin fallback is now a "⋯" menu item, not a separate button.
  it('admin: sees Pin for Comparison in the "⋯" menu in read-only advanced mode', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menuitem', { name: /pin for comparison/i })).toBeInTheDocument();
  });

  it('non-admin: the "⋯" menu (and its Pin entry) is hidden in read-only advanced mode', () => {
    adminState.isAdmin = false;
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByTitle('More actions')).not.toBeInTheDocument();
  });
});

// ── t/4532: Steelman Vulnerability / Intellectual Lineage, collapsed by default ──

describe('t/4532: Steelman Vulnerability and Intellectual Lineage collapse', () => {
  const nodeWithBoth: PovNode = {
    ...mockNode,
    graph_attributes: {
      steelman_vulnerability: 'A real vulnerability.',
      intellectual_lineage: ['Rawls', 'Nozick'],
    } as never,
  };

  beforeEach(() => {
    setNodeMode(mockNode.id, 'advanced');
    vi.clearAllMocks();
  });

  it('both sections are collapsed when the node opens', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Steelman Vulnerability/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Intellectual Lineage/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('A real vulnerability.')).toBeNull();
    expect(screen.queryByText('Rawls')).toBeNull();
  });

  it('toggling Steelman Vulnerability expands it, and editing still writes through updatePovNode', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Steelman Vulnerability/ }));
    expect(screen.getByRole('button', { name: /Steelman Vulnerability/ })).toHaveAttribute('aria-expanded', 'true');
    const textarea = screen.getByDisplayValue('A real vulnerability.');
    fireEvent.change(textarea, { target: { value: 'An updated vulnerability.' } });
    expect(mockTaxonomyStore.updatePovNode).toHaveBeenCalledWith(
      'acc', nodeWithBoth.id,
      { graph_attributes: expect.objectContaining({ steelman_vulnerability: 'An updated vulnerability.' }) },
    );
  });

  it('toggling Intellectual Lineage expands it, and the chip drill-down still works', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Intellectual Lineage/ }));
    expect(screen.getByText('Rawls')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Rawls'));
    // getLineageInfo is mocked to return null (module mock above) — the "no detail" arm still proves the drill-down fired.
    expect(screen.getByText('No detailed information available for this lineage.')).toBeInTheDocument();
  });

  it('collapsing after expanding hides the content again', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    const header = screen.getByRole('button', { name: /Steelman Vulnerability/ });
    fireEvent.click(header);
    expect(screen.queryByText('A real vulnerability.')).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByText('A real vulnerability.')).toBeNull();
  });

  it('switching to a different node re-collapses both sections', () => {
    const { rerender } = render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Steelman Vulnerability/ }));
    fireEvent.click(screen.getByRole('button', { name: /Intellectual Lineage/ }));
    expect(screen.getByRole('button', { name: /Steelman Vulnerability/ })).toHaveAttribute('aria-expanded', 'true');

    const otherNode: PovNode = { ...nodeWithBoth, id: 'acc-beliefs-002' };
    rerender(<NodeDetail pov="acc" node={otherNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Steelman Vulnerability/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Intellectual Lineage/ })).toHaveAttribute('aria-expanded', 'false');
  });
});

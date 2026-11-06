// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression tests for t/2142: Zustand inline-object selector caused infinite
// render loop. Scalar selectors fix it; a successful render() call proves the
// fix holds. Also covers t/4826's What/Why/How tab-group filter, which replaced
// the per-node Simple/Advanced toggle and the old Analysis/Content tab.

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

// t/4826: the per-node nodeDetailModes override is retired. NodeDetail now reads the rail's
// global `viewMode` directly for tool-gating (header icons, description toolbar, Pin), and the
// panel-wide `nodeDetailTabGroup` drives which tabs are reachable.
const mockPrefsState = {
  viewMode: 'simple' as 'simple' | 'advanced',
  setViewMode: vi.fn(),
  hydrate: vi.fn(),
  nodeDetailTabGroup: 'what' as 'what' | 'why' | 'how',
  setNodeDetailTabGroup: vi.fn(async (group: 'what' | 'why' | 'how') => {
    mockPrefsState.nodeDetailTabGroup = group;
  }),
};

vi.mock('../../store/preferencesStore', () => ({
  usePreferencesStore: (selector: (s: typeof mockPrefsState) => unknown) =>
    selector(mockPrefsState),
}));

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

/** Opens the Attributes tab — the metrics row, label error and POV tags now live there (t/4826 §3). */
function openAttributesTab() {
  fireEvent.click(screen.getByRole('tab', { name: /attributes/i }));
}

// ── Component under test ──────────────────────────────────────────────────────

import { NodeDetail } from './NodeDetail';

describe('NodeDetail — Zustand scalar selector regression (t/2142)', () => {
  beforeEach(() => {
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
    vi.clearAllMocks();
  });

  it('renders without infinite loop in the What group', () => {
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

  it('renders without infinite loop in the How group', () => {
    mockPrefsState.nodeDetailTabGroup = 'how';
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

  it('the What group shows Steelman Vulnerability, Related and Attributes only', () => {
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
    expect(screen.getByRole('tab', { name: /steelman vulnerability/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /related/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /attributes/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /intellectual lineage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /research/i })).not.toBeInTheDocument();
  });

  it('the Why group shows Intellectual Lineage, Sources, Conflicts and Cruxes only', () => {
    mockPrefsState.nodeDetailTabGroup = 'why';
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: /intellectual lineage/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^sources$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /conflicts/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /cruxes/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /steelman vulnerability/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^related$/i })).not.toBeInTheDocument();
  });

  it('the How group shows Sources, Facts, Phrases, History and Research only', () => {
    mockPrefsState.nodeDetailTabGroup = 'how';
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: /^sources$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /facts/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /phrases/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /research/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /conflicts/i })).not.toBeInTheDocument();
  });

  it('every tab in a group is reachable regardless of the rail viewMode (t/4826 §2 — gating retired)', () => {
    mockPrefsState.nodeDetailTabGroup = 'how';
    mockPrefsState.viewMode = 'simple';
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /research/i })).toBeInTheDocument();
  });

  // t/2826 — the Pin-for-comparison ("bookmark") control is Advanced-view only (rail viewMode).
  it('omits Pin for Comparison from the actions menu when the rail is Simple', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.queryByRole('menuitem', { name: /pin for comparison/i })).not.toBeInTheDocument();
  });

  it('includes Pin for Comparison in the actions menu when the rail is Advanced', () => {
    mockPrefsState.viewMode = 'advanced';
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menuitem', { name: /pin for comparison/i })).toBeInTheDocument();
  });

  // t/4200 — the soul-doc button hands the node's pov_tags to the dialog, which opens on that tag's soul.
  it('the soul-doc button passes the node pov_tags to onOpenSoulDoc', () => {
    mockPrefsState.viewMode = 'advanced';
    const onOpenSoulDoc = vi.fn();
    render(
      <NodeDetail pov="skeptic" node={{ ...mockNode, pov_tags: ['institutional'] }} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} onOpenSoulDoc={onOpenSoulDoc} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Soul document' }));
    expect(onOpenSoulDoc).toHaveBeenCalledWith(['institutional']);
  });
});

// ── t/4826: the What/Why/How tab-group toggle replaces the retired per-node Simple/Advanced
// toggle. It's panel-wide (not per-node), independent of the rail's global viewMode, and
// switching groups keeps the active tab when it's still in the new group, otherwise opens the
// new group's first tab (Design spec §1-§2).

describe('NodeDetail — What/Why/How tab-group toggle (t/4826)', () => {
  beforeEach(() => {
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
    vi.clearAllMocks();
  });

  it('is a radiogroup labeled "Tab group" with three options, defaulting to What', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Tab group' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'What' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Why' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('radio', { name: 'How' })).toHaveAttribute('aria-checked', 'false');
  });

  it('clicking Why calls setNodeDetailTabGroup, not setViewMode — the group is panel-wide, not per-node', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Why' }));
    expect(mockPrefsState.setNodeDetailTabGroup).toHaveBeenCalledWith('why');
    expect(mockPrefsState.setViewMode).not.toHaveBeenCalled();
  });

  // Header icons / Pin gating read the rail's global viewMode directly now (t/4826 §4) — not any
  // per-node state, and not the tab group.
  it('header icons show when the rail viewMode is Advanced, independent of the tab group', () => {
    mockPrefsState.viewMode = 'advanced';
    mockPrefsState.nodeDetailTabGroup = 'how';
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Help: taxonomy ontology guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Soul documents analysis' })).toBeInTheDocument();
  });

  it('switching to a group that still contains the active tab keeps it selected', () => {
    mockPrefsState.nodeDetailTabGroup = 'why';
    const { rerender } = render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /^sources$/i }));
    expect(screen.getByRole('tab', { name: /^sources$/i }).className).toContain('node-detail-tab-active');

    // 'how' also contains 'sources' (TAB_GROUPS table) — it should stay active.
    mockPrefsState.nodeDetailTabGroup = 'how';
    rerender(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /^sources$/i }).className).toContain('node-detail-tab-active');
  });

  it('switching to a group without the active tab opens that group\'s first tab', () => {
    const { rerender } = render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /attributes/i }));
    expect(screen.getByRole('tab', { name: /attributes/i }).className).toContain('node-detail-tab-active');

    // 'why' doesn't contain 'attributes' — its first tab (lineage) opens instead.
    mockPrefsState.nodeDetailTabGroup = 'why';
    rerender(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /intellectual lineage/i }).className).toContain('node-detail-tab-active');
  });
});

// ── Simple-view last-edited line (t/3022, Option 3) ───────────────────────────
// The full History tab stays reachable from the How group; the footer shows the
// who/when last-edited datum inline regardless of rail viewMode (t/4574 spec §2.6).

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
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
    vi.clearAllMocks();
  });

  it('shows the last-edited line from _edit_meta (username, domain stripped)', () => {
    render(<NodeDetail pov="acc" node={nodeWithMeta} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText(/last edited by/i)).toBeInTheDocument();
    expect(screen.getByText('editor')).toBeInTheDocument();
  });

  it('falls back to the most-recent _edit_history entry when _edit_meta is absent', () => {
    render(<NodeDetail pov="acc" node={nodeWithHistoryOnly} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText(/last edited by/i)).toBeInTheDocument();
    expect(screen.getByText('histuser')).toBeInTheDocument();
  });

  it('shows the last-edited line in Advanced rail viewMode too', () => {
    mockPrefsState.viewMode = 'advanced';
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
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
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
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
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
// t/4826 §3: the metrics row, label error and POV tags moved to the top of the Attributes tab
// (from the retired Analysis/Content tab) — these tests now open Attributes first.
describe('NodeDetail — POV tag editing is admin-only (t/4167)', () => {
  const renderTagged = () => render(
    <NodeDetail pov="skeptic" node={{ ...mockNode, pov_tags: ['critical'] }} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
  );

  beforeEach(() => {
    tagPerm.canEdit = true;
    mockPrefsState.viewMode = 'simple';
    mockPrefsState.nodeDetailTabGroup = 'what';
  });

  it('without tag permission the chips show but there is no remove or add control', () => {
    tagPerm.canEdit = false;
    renderTagged();
    openAttributesTab();
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
    openAttributesTab();
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
    mockPrefsState.viewMode = 'advanced';
    mockPrefsState.nodeDetailTabGroup = 'what';
  });

  it('admin: sees the "..." menu (editable) when the rail is Advanced', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.getByTitle('More actions')).toBeInTheDocument();
  });

  it('non-admin: the "..." menu is hidden (editable) when the rail is Advanced', () => {
    adminState.isAdmin = false;
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByTitle('More actions')).not.toBeInTheDocument();
  });

  // t/4574 spec §2.2: the read-only Pin fallback is now a "⋯" menu item, not a separate button.
  it('admin: sees Pin for Comparison in the "⋯" menu in read-only Advanced rail mode', () => {
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle('More actions'));
    expect(screen.getByRole('menuitem', { name: /pin for comparison/i })).toBeInTheDocument();
  });

  it('non-admin: the "⋯" menu (and its Pin entry) is hidden in read-only Advanced rail mode', () => {
    adminState.isAdmin = false;
    render(
      <NodeDetail pov="acc" node={mockNode} readOnly onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />,
    );
    expect(screen.queryByTitle('More actions')).not.toBeInTheDocument();
  });
});

// ── t/4826: Steelman Vulnerability and Intellectual Lineage, promoted to standalone
// always-expanded tabs (retiring the t/4532 collapsible sections of the old Analysis tab).

describe('NodeDetail — Steelman Vulnerability and Intellectual Lineage tabs (t/4826)', () => {
  const nodeWithBoth: PovNode = {
    ...mockNode,
    graph_attributes: {
      steelman_vulnerability: 'A real vulnerability.',
      intellectual_lineage: ['Rawls', 'Nozick'],
    } as never,
  };

  beforeEach(() => {
    mockPrefsState.viewMode = 'advanced';
    mockPrefsState.nodeDetailTabGroup = 'what';
    vi.clearAllMocks();
  });

  it('Steelman Vulnerability is the default tab in the What group and renders expanded with no disclosure control', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /steelman vulnerability/i }).className).toContain('node-detail-tab-active');
    expect(screen.getByDisplayValue('A real vulnerability.')).toBeInTheDocument();
  });

  it('editing the Steelman Vulnerability textarea writes through updatePovNode', () => {
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    const textarea = screen.getByDisplayValue('A real vulnerability.');
    fireEvent.change(textarea, { target: { value: 'An updated vulnerability.' } });
    expect(mockTaxonomyStore.updatePovNode).toHaveBeenCalledWith(
      'acc', nodeWithBoth.id,
      { graph_attributes: expect.objectContaining({ steelman_vulnerability: 'An updated vulnerability.' }) },
    );
  });

  it('shows the empty state with an Add Vulnerability affordance when the node has graph_attributes but no vulnerability', () => {
    const nodeWithEmptyAttrs: PovNode = { ...mockNode, graph_attributes: {} as never };
    render(<NodeDetail pov="acc" node={nodeWithEmptyAttrs} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('No steelman analysis yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add Vulnerability' })).toBeInTheDocument();
  });

  it('shows the empty state with no Add affordance when the node has no graph_attributes at all', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('No steelman analysis yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add Vulnerability' })).not.toBeInTheDocument();
  });

  it('the Intellectual Lineage tab (Why group) renders expanded, and the chip drill-down still works', () => {
    mockPrefsState.nodeDetailTabGroup = 'why';
    render(<NodeDetail pov="acc" node={nodeWithBoth} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /intellectual lineage/i }).className).toContain('node-detail-tab-active');
    expect(screen.getByText('Rawls')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Rawls'));
    // getLineageInfo is mocked to return null (module mock above) — the "no detail" arm still proves the drill-down fired.
    expect(screen.getByText('No detailed information available for this lineage.')).toBeInTheDocument();
  });

  it('shows the empty state on the Intellectual Lineage tab when the node has none', () => {
    mockPrefsState.nodeDetailTabGroup = 'why';
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('No intellectual lineage recorded')).toBeInTheDocument();
  });
});

describe('NodeDetail — Intellectual Lineage default-expands its first chip (t/4919)', () => {
  const nodeWithLineage: PovNode = {
    ...mockNode,
    graph_attributes: { intellectual_lineage: ['Rawls', 'Nozick'] } as never,
  };
  const nodeWithOtherLineage: PovNode = {
    ...mockNode,
    id: 'acc-B-002',
    graph_attributes: { intellectual_lineage: ['Zed'] } as never,
  };

  beforeEach(() => {
    mockPrefsState.viewMode = 'advanced';
    mockPrefsState.nodeDetailTabGroup = 'why';
    vi.clearAllMocks();
  });

  // The chip's own label and the expanded detail panel's header can share text (e.g. the detail
  // panel also echoes the selected chip's label) — query by chip class to avoid ambiguous matches.
  const chip = (label: string) => screen.getByText(label, { selector: '.ga-promoted-chip' });

  it('expands the alphabetically-first chip (Nozick) on mount, aria-expanded set', () => {
    render(<NodeDetail pov="acc" node={nodeWithLineage} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(chip('Nozick')).toHaveAttribute('aria-expanded', 'true');
    expect(chip('Rawls')).toHaveAttribute('aria-expanded', 'false');
    // getLineageInfo mocked to null — "no detail" arm proves the default actually opened the chip.
    expect(screen.getByText('No detailed information available for this lineage.')).toBeInTheDocument();
  });

  it('collapsing the default-expanded chip holds across a re-render for the same node', () => {
    const { rerender } = render(<NodeDetail pov="acc" node={nodeWithLineage} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(chip('Nozick')); // user collapses the default-opened chip
    expect(chip('Nozick')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('No detailed information available for this lineage.')).toBeNull();

    // Re-render with the same node identity (equal, but not referentially identical, attrs) — must not reopen.
    const sameNodeNewRef: PovNode = { ...nodeWithLineage, graph_attributes: { intellectual_lineage: ['Rawls', 'Nozick'] } as never };
    rerender(<NodeDetail pov="acc" node={sameNodeNewRef} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(chip('Nozick')).toHaveAttribute('aria-expanded', 'false');
  });

  it('a node switch re-applies the default to the new node\'s first chip', () => {
    const { rerender } = render(<NodeDetail pov="acc" node={nodeWithLineage} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    fireEvent.click(chip('Nozick'));
    expect(chip('Nozick')).toHaveAttribute('aria-expanded', 'false');

    rerender(<NodeDetail pov="acc" node={nodeWithOtherLineage} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(chip('Zed')).toHaveAttribute('aria-expanded', 'true');
  });

  it('an empty lineage list renders the empty state without throwing (nothing to default-expand)', () => {
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('No intellectual lineage recorded')).toBeInTheDocument();
  });
});

describe('NodeDetail — issue-type chips (t/4834)', () => {
  beforeEach(() => {
    mockPrefsState.nodeDetailTabGroup = 'what';
    vi.clearAllMocks();
  });

  it('renders no chips when issue_types is absent', () => {
    mockPrefsState.viewMode = 'simple';
    render(<NodeDetail pov="acc" node={mockNode} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByText('Loss of Control')).not.toBeInTheDocument();
    expect(screen.queryByText('No issue type')).not.toBeInTheDocument();
  });

  it('renders a single chip with its label', () => {
    mockPrefsState.viewMode = 'simple';
    const node: PovNode = { ...mockNode, graph_attributes: { issue_types: ['misuse'] } as never };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('Misuse')).toBeInTheDocument();
  });

  it('renders three chips in array (primary-first) order', () => {
    mockPrefsState.viewMode = 'simple';
    const node: PovNode = {
      ...mockNode,
      graph_attributes: { issue_types: ['power_concentration', 'economic', 'social'] } as never,
    };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    const chips = screen.getAllByText(/Power Concentration|Economic|Social/);
    expect(chips.map((el) => el.textContent)).toEqual(['Power Concentration', 'Economic', 'Social']);
  });

  it('Advanced mode shows confidence and method per chip', () => {
    mockPrefsState.viewMode = 'advanced';
    const node: PovNode = {
      ...mockNode,
      graph_attributes: {
        issue_types: ['loss_of_control'],
        issue_types_provenance: {
          method: 'llm',
          model: 'gemini-3.5-flash-lite',
          prompt_version: 'v1',
          run_id: 'issue-types-full-2026-11-04',
          classified_at: '2026-11-04T00:00:00Z',
          confidence: { loss_of_control: 0.87 },
          rationale: 'Discusses AI systems acting outside human oversight.',
        },
      } as never,
    };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('Loss of Control')).toBeInTheDocument();
    expect(screen.getByText('87% · llm')).toBeInTheDocument();
  });

  it('Simple mode does not show confidence/method even when provenance is present', () => {
    mockPrefsState.viewMode = 'simple';
    const node: PovNode = {
      ...mockNode,
      graph_attributes: {
        issue_types: ['loss_of_control'],
        issue_types_provenance: {
          method: 'llm', model: 'm', prompt_version: 'v1', run_id: 'r1',
          classified_at: '2026-11-04T00:00:00Z', confidence: { loss_of_control: 0.87 }, rationale: 'x',
        },
      } as never,
    };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('Loss of Control')).toBeInTheDocument();
    expect(screen.queryByText('87% · llm')).not.toBeInTheDocument();
  });

  it('Advanced mode shows "No issue type" when issue_types is an empty array', () => {
    mockPrefsState.viewMode = 'advanced';
    const node: PovNode = { ...mockNode, graph_attributes: { issue_types: [] } as never };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.getByText('No issue type')).toBeInTheDocument();
  });

  it('Simple mode renders nothing when issue_types is an empty array', () => {
    mockPrefsState.viewMode = 'simple';
    const node: PovNode = { ...mockNode, graph_attributes: { issue_types: [] } as never };
    render(<NodeDetail pov="acc" node={node} readOnly={false} onPin={vi.fn()} onSimilarSearch={vi.fn()} onRelated={vi.fn()} />);
    expect(screen.queryByText('No issue type')).not.toBeInTheDocument();
  });
});

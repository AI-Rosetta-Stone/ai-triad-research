// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ConceptLinkRef, EntityLinkRef } from '@lib/entities/types';
import type { LogicalForm } from '@lib/entities/logicalForm';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const setToolbarPanel = vi.fn();

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    selectedNodeId: null,
    accelerationist: null,
    safetyist: null,
    skeptic: null,
    setToolbarPanel,
    ...overrides,
  };
}

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: vi.fn(),
}));
vi.mock('../taxonomy/SupersededBanner', () => ({
  SupersededBanner: ({ node }: { node: { id: string } }) => <div data-testid="superseded-banner">{node.id}</div>,
}));

import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
const mockStore = useTaxonomyStore as unknown as ReturnType<typeof vi.fn>;
// The component also calls useTaxonomyStore.getState() (non-reactive, for the superseded
// accessors) — our mock is a plain vi.fn() with no selector support, so getState() just
// returns the same configured state as a plain useTaxonomyStore() call would.
(mockStore as unknown as { getState: typeof mockStore }).getState = mockStore;

const { BdiGroundingPanel } = await import('./BdiGroundingPanel');

const CONCEPT_LINKED: ConceptLinkRef = {
  ref: 'term:alignment',
  surface: 'alignment',
  method: 'surface',
  link_confidence: 1.0,
  status: 'linked',
};

const CONCEPT_PROPOSED: ConceptLinkRef = {
  ref: 'term:autonomy_human',
  surface: 'autonomy',
  method: 'embedding',
  link_confidence: 0.59,
  status: 'proposed',
};

const ENTITY_LINKED: EntityLinkRef = {
  ref: 'ent-001',
  surface: 'Anthropic',
  method: 'alias',
  link_confidence: 1.0,
  match_level: 'exact',
  status: 'linked',
};

function makeNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-beliefs-001',
    label: 'Test Node',
    ...overrides,
  };
}

const LOGICAL_FORM: LogicalForm = {
  predicate: 'acquire',
  event_ref: 'e1',
  args: [
    { role: 'agent', ref: 'ent-034', sort: 'agentive-physical-object', match_level: 'exact' },
    { role: 'patient', ref: 'ent-055', sort: 'non-agentive-functional-artifact', match_level: 'exact' },
  ],
  polarity: 'positive',
  modality: { holder: 'camp:acc', attitude: 'belief' },
  temporal: { type: 'at', value: '2025-02' },
  about: [{ ref: 'ent-034', match_level: 'exact' }],
  formalization_confidence: 0.85,
  status: 'accepted',
};

describe('BdiGroundingPanel (t/3292)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows the no-node-selected empty state when selectedNodeId is null', () => {
    mockStore.mockReturnValue(makeStore());
    render(<BdiGroundingPanel />);
    expect(screen.getByText(/Select a BDI node/)).toBeInTheDocument();
  });

  it('shows the no-node-selected empty state when the node is not found in any POV file', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-999',
      accelerationist: { nodes: [] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText(/Select a BDI node/)).toBeInTheDocument();
  });

  it('renders Concepts and Entities section headers for a node with no refs', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode()] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText('Concepts')).toBeInTheDocument();
    expect(screen.getByText('Entities')).toBeInTheDocument();
  });

  it('renders DOLCE badges: "universal · kind" for concepts, "particular" for entities', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode()] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText('universal · kind')).toBeInTheDocument();
    expect(screen.getByText('particular')).toBeInTheDocument();
  });

  it('renders concept rows with surface, method, status, and confidence', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ concept_refs: [CONCEPT_LINKED] })] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText('alignment')).toBeInTheDocument();
    expect(screen.getByText('surface')).toBeInTheDocument();
    expect(screen.getByText('linked')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('applies --proposed class to proposed concept rows', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ concept_refs: [CONCEPT_PROPOSED] })] },
    }));
    render(<BdiGroundingPanel />);
    const row = screen.getByRole('button', { name: /autonomy/ });
    expect(row.className).toContain('bdi-gr-row--proposed');
    expect(screen.getByText('proposed')).toBeInTheDocument();
    expect(screen.getByText('59%')).toBeInTheDocument();
  });

  it('renders entity rows with surface, ref id, method, status, and confidence', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ entity_refs: [ENTITY_LINKED] })] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('ent-001')).toBeInTheDocument();
    expect(screen.getByText('alias')).toBeInTheDocument();
  });

  it('shows the normal "No entity links" empty state when entity_refs is absent', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ concept_refs: [CONCEPT_LINKED] })] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText(/No entity links/)).toBeInTheDocument();
  });

  it('shows "No concept links" when concept_refs is absent', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode()] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText(/No concept links/)).toBeInTheDocument();
  });

  it('calls setToolbarPanel("vocabulary") when a concept row is clicked', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ concept_refs: [CONCEPT_LINKED] })] },
    }));
    render(<BdiGroundingPanel />);
    fireEvent.click(screen.getByRole('button', { name: /alignment/ }));
    expect(setToolbarPanel).toHaveBeenCalledWith('vocabulary');
  });

  it('calls setToolbarPanel("entities") when an entity row is clicked', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'acc-beliefs-001',
      accelerationist: { nodes: [makeNode({ entity_refs: [ENTITY_LINKED] })] },
    }));
    render(<BdiGroundingPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/ }));
    expect(setToolbarPanel).toHaveBeenCalledWith('entities');
  });

  it('searches safetyist and skeptic files when node is not in accelerationist', () => {
    mockStore.mockReturnValue(makeStore({
      selectedNodeId: 'saf-beliefs-001',
      accelerationist: { nodes: [] },
      safetyist: { nodes: [{ id: 'saf-beliefs-001', label: 'Safety node', concept_refs: [CONCEPT_LINKED] }] },
    }));
    render(<BdiGroundingPanel />);
    expect(screen.getByText('alignment')).toBeInTheDocument();
  });

  describe('superseded nodes (t/4358)', () => {
    it('resolves a superseded node by id and shows it, read-only, with the banner', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-002',
        accelerationist: {
          nodes: [
            makeNode({ id: 'acc-beliefs-001', label: 'Live node' }),
            makeNode({ id: 'acc-beliefs-002', label: 'Old node', superseded_by: 'acc-beliefs-001', concept_refs: [CONCEPT_LINKED] }),
          ],
        },
      }));
      render(<BdiGroundingPanel />);
      // The superseded node itself renders (not the "not found" empty state), with its own content.
      expect(screen.getByText('alignment')).toBeInTheDocument();
      expect(screen.getByTestId('superseded-banner')).toHaveTextContent('acc-beliefs-002');
    });

    it('does not show the banner for a live (non-superseded) node', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode()] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.queryByTestId('superseded-banner')).not.toBeInTheDocument();
    });
  });

  describe('Formalization section (t/3397)', () => {
    it('renders nothing when the node has no logical_form', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode()] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.queryByText('Formalization')).not.toBeInTheDocument();
    });

    it('renders the collapsed header with an experimental badge when logical_form is present', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.getByText('Formalization')).toBeInTheDocument();
      expect(screen.getByText('experimental')).toBeInTheDocument();
      // Collapsed by default — body content not yet in the DOM.
      expect(screen.queryByText('acquire')).not.toBeInTheDocument();
    });

    it('expands on click and shows predicate/polarity/modality/temporal', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      expect(screen.getByText('acquire')).toBeInTheDocument();
      expect(screen.getByText('positive')).toBeInTheDocument();
      expect(screen.getByText(/Accelerationist.*belief/)).toBeInTheDocument();
      expect(screen.getByText(/at 2025-02/)).toBeInTheDocument();
    });

    it('shows the weak-axes note INSIDE the expanded section, not only on the header', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.queryByText(/predicate \(~0.68\)/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      expect(screen.getByText(/predicate \(~0.68\) and args \(~0.30\)/)).toBeInTheDocument();
      expect(screen.getByText(/low-reliability axis/)).toBeInTheDocument();
    });

    it('renders participant rows with role, ref, sort, and match_level', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      expect(screen.getByText('agent')).toBeInTheDocument();
      expect(screen.getAllByText('ent-034').length).toBeGreaterThan(0);
      expect(screen.getByText('agentive-physical-object')).toBeInTheDocument();
      expect(screen.getAllByText('exact').length).toBeGreaterThan(0);
    });

    it('renders about[] refs with the existing proposed-style treatment', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      const aboutChip = screen.getAllByText('ent-034').find(el => el.className.includes('bdi-gr-status--proposed'));
      expect(aboutChip).toBeTruthy();
    });

    it('renders formalization_confidence with a self-rated caveat', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      expect(screen.getByText(/confidence 85% \(self-rated\)/)).toBeInTheDocument();
    });

    it('keeps raw JSON hidden until the debug toggle is clicked', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ logical_form: LOGICAL_FORM })] },
      }));
      render(<BdiGroundingPanel />);
      fireEvent.click(screen.getByRole('button', { name: /Formalization/ }));
      expect(screen.queryByText(/"event_ref"/)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /View raw frame/ }));
      expect(screen.getByText(/"event_ref"/)).toBeInTheDocument();
    });
  });

  describe('Debate Grounding section (t/3466)', () => {
    it('shows the header, first-person badge, quoted text, and caption when debate_grounding is present', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({
          graph_attributes: { debate_grounding: 'I believe AI progress should accelerate.' },
        })] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.getByText('Debate Grounding')).toBeInTheDocument();
      expect(screen.getByText('first-person')).toBeInTheDocument();
      expect(screen.getByText(/I believe AI progress should accelerate\./)).toBeInTheDocument();
      expect(screen.getByText(/used by the debate engine as this node's grounding text/)).toBeInTheDocument();
    });

    it('shows the plain-language absent state when debate_grounding is missing, with no description fallback', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode({ description: 'Editorial description text.' })] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.getByText("Not yet grounded — this node doesn't have a first-person restatement yet.")).toBeInTheDocument();
      expect(screen.queryByText('Editorial description text.')).not.toBeInTheDocument();
    });

    it('shows the absent state when graph_attributes itself is missing (no crash)', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode()] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.getByText("Not yet grounded — this node doesn't have a first-person restatement yet.")).toBeInTheDocument();
    });

    it('never renders "backfilled" or other internal pipeline jargon in the absent copy', () => {
      mockStore.mockReturnValue(makeStore({
        selectedNodeId: 'acc-beliefs-001',
        accelerationist: { nodes: [makeNode()] },
      }));
      render(<BdiGroundingPanel />);
      expect(screen.queryByText(/backfill/i)).not.toBeInTheDocument();
    });
  });
});

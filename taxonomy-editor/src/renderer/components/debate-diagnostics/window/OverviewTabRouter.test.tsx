// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverviewTabRouter } from './OverviewTabRouter';
import type { OverviewTab } from './types';
import { usePreferencesStore } from '../../../store/preferencesStore';
import { api } from '@bridge';

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
  computeQbafStrengths: vi.fn().mockReturnValue([]),
}));

vi.mock('../../ExtractionTimelinePanel', () => ({
  ExtractionTimelinePanel: () => <div data-testid="extraction-panel">ExtractionTimelinePanel</div>,
}));
vi.mock('../../ConvergenceSignalsPanel', () => ({
  ConvergenceSignalsPanel: () => <div data-testid="convergence-panel">ConvergenceSignalsPanel</div>,
}));
vi.mock('../../TaxonomyGapPanel', () => ({
  TaxonomyGapPanel: () => <div data-testid="gap-panel">TaxonomyGapPanel</div>,
}));
vi.mock('../../GroundingPanel', () => ({
  GroundingPanel: () => <div data-testid="grounding-panel">GroundingPanel</div>,
}));
vi.mock('../../PovProgression/PovProgressionView', () => ({
  PovProgressionView: () => <div data-testid="pov-panel">PovProgressionView</div>,
}));
vi.mock('../../PromptDiffWindow', () => ({
  PromptDiffContent: () => <div data-testid="prompt-diff">PromptDiffContent</div>,
}));
vi.mock('./overview-tabs', () => ({
  ArgumentNetworkTab: () => <div data-testid="an-tab">ArgumentNetworkTab</div>,
  AdaptiveStagingTab: () => <div data-testid="adaptive-tab">AdaptiveStagingTab</div>,
  ReflectionsTab:     () => <div data-testid="reflections-tab">ReflectionsTab</div>,
  UtilityTab:         () => <div data-testid="utility-tab">UtilityTab</div>,
}));
vi.mock('./shared', () => ({
  CommitmentsPanel: () => <div data-testid="commitments-panel">CommitmentsPanel</div>,
}));
vi.mock('../../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(
    vi.fn().mockReturnValue({ nodes: [], edges: [] }),
    {
      getState: vi.fn().mockReturnValue({
        activeTab: 'taxonomy',
        toolbarPanel: null,
        selectedNodeId: null,
        aiBackend: 'gemini',
        geminiModel: 'gemini-flash',
        accelerationist: { nodes: [] },
        safetyist: { nodes: [] },
        skeptic: { nodes: [] },
        situations: { nodes: [] },
        edgesFile: { edges: [] },
        dirty: new Set(),
      }),
    },
  ),
}));
vi.mock('../../../lib/flightRecorderInit', () => ({
  triggerManualDump: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function makeDebate(transcriptOverride: unknown[] = []) {
  const transcript = transcriptOverride.length > 0
    ? transcriptOverride
    : [
        { id: 'e1', type: 'statement', speaker: 'accelerationist', content: 'Hello world, this is a test statement.', taxonomy_refs: [], policy_refs: [], metadata: {} },
        { id: 'e2', type: 'statement', speaker: 'safetyist', content: 'Another test statement for diagnostics.', taxonomy_refs: [], policy_refs: [], metadata: {} },
      ];
  return {
    id: 'test-debate-0000',
    topic: { scope: {} },
    transcript,
    phase: 'rounds',
    diagnostics: { entries: {} },
    argument_network: undefined,
    commitments: undefined,
  } as any;
}

function makeProps(overrides: Record<string, unknown> = {}) {
  return {
    debate: makeDebate(),
    an: undefined,
    commitments: undefined,
    effectiveOverviewTab: 'transcript' as OverviewTab,
    selectedEntry: null,
    setSelectedEntry: vi.fn(),
    setOverviewTab: vi.fn(),
    setLocalOverride: vi.fn(),
    focusedNodeId: null,
    setFocusedNodeId: vi.fn(),
    anFilterMode: 'all' as const,
    anFilterNodeId: '',
    setAnFilterMode: vi.fn(),
    setAnFilterNodeId: vi.fn(),
    handleUpdateSubScore: vi.fn(),
    transcriptSpeakerFilter: null,
    setTranscriptSpeakerFilter: vi.fn(),
    perTurnUtilities: [],
    nodeLabels: new Map(),
    searchQuery: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OverviewTabRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // TheoryLink gates on viewMode (t/2867); advanced view shows the doc-links these tests assert.
    usePreferencesStore.setState({ viewMode: 'advanced' });
  });

  it('renders without crash with transcript overview tab', () => {
    expect(() => {
      render(<OverviewTabRouter {...makeProps()} />);
    }).not.toThrow();
  });

  it('renders transcript list when effectiveOverviewTab is transcript and no selectedEntry', () => {
    render(
      <OverviewTabRouter
        {...makeProps({
          effectiveOverviewTab: 'transcript',
          selectedEntry: null,
        })}
      />,
    );

    // The All filter button should be present showing total statement count
    const allBtn = screen.getByRole('button', { name: /All/i });
    expect(allBtn).toBeInTheDocument();

    // Speaker filter buttons for each unique speaker should be rendered
    expect(screen.getByRole('button', { name: /Accelerationist \(1\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Safetyist \(1\)/i })).toBeInTheDocument();

    // Statement IDs should appear in the transcript list rows
    expect(screen.getByTitle('Statement S1')).toBeInTheDocument();
    expect(screen.getByTitle('Statement S2')).toBeInTheDocument();
  });

  it('renders argument network tab when effectiveOverviewTab is argument-network and an is provided', () => {
    const an = {
      nodes: [
        {
          id: 'an1',
          text: 'AI is beneficial',
          type: 'I-node',
          speaker: 'accelerationist',
          source_entry_id: 'e1',
          base_strength: 0.6,
        },
      ],
      edges: [],
    };

    render(
      <OverviewTabRouter
        {...makeProps({
          effectiveOverviewTab: 'argument-network',
          an,
          selectedEntry: null,
        })}
      />,
    );

    expect(screen.getByTestId('an-tab')).toBeInTheDocument();
  });

  it('renders transcript list even when selectedEntry is set (master-detail layout)', () => {
    render(
      <OverviewTabRouter
        {...makeProps({
          effectiveOverviewTab: 'transcript',
          selectedEntry: 'e1',
        })}
      />,
    );

    // The "All" filter button is rendered in the transcript list view,
    // which stays visible alongside the entry detail in master-detail layout
    expect(screen.queryByRole('button', { name: /All \(/i })).toBeInTheDocument();
  });

  it('shows pipeline error indicator on entries with failed post-pipeline processing', () => {
    const debate = makeDebate([
      { id: 'e1', type: 'statement', speaker: 'accelerationist', content: 'Good entry', taxonomy_refs: [], policy_refs: [], metadata: {} },
      { id: 'e2', type: 'statement', speaker: 'safetyist', content: 'Bad entry', taxonomy_refs: [], policy_refs: [], metadata: {} },
    ]);
    debate.diagnostics = {
      entries: {
        e1: { stage_diagnostics: [{ stage: 'draft' }], extracted_claims: [{ text: 'claim' }] },
        e2: { stage_diagnostics: [{ stage: 'draft' }] },
      },
    };

    render(
      <OverviewTabRouter
        {...makeProps({ debate, effectiveOverviewTab: 'transcript', selectedEntry: null })}
      />,
    );

    expect(screen.getByTitle('Statement S1')).toBeInTheDocument();
    expect(screen.getByTitle('Statement S2 — pipeline error')).toBeInTheDocument();
    expect(screen.getByTitle('Statement S2 — pipeline error').textContent).toContain('●');
  });

  // t/3593 — the Theory of Success doc-link (TheoryLink) renders beside the Topic Scope
  // heading and opens docs/topic-scope-theory-of-success.md through the bridge.
  it('renders the Topic Scope theory-of-success doc-link and opens it through the bridge', () => {
    const debate = makeDebate();
    debate.topic = {
      scope: {
        core_proposition: 'Test proposition',
        relevant_disciplines: [],
        on_scope_evidence: [],
        key_tensions: [],
        off_scope_topics: [],
        drift_signatures: [],
        example_ceiling: null,
        risk_level: 'low',
        domain: null,
        product_type: null,
        time_horizon: null,
        excluded_scenarios: [],
        explicit_qualifiers: [],
        constraint_confidence: 'explicit',
      },
    };

    render(
      <OverviewTabRouter
        {...makeProps({ debate, effectiveOverviewTab: 'topic-scope' })}
      />,
    );

    const link = screen.getByRole('button', { name: /topic scope theory of success/i });
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(api.openExternal).toHaveBeenCalledWith(
      'https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/topic-scope-theory-of-success.md',
    );
  });
});

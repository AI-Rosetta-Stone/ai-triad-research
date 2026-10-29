// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1724 — clicking a POV item (argument-structure taxonomy anchor) in the debate
// PLAN view toggles an inline TaxonomyRefDetail resolved from the client-side
// taxonomy store (no fetch). These tests cover the wiring: click → detail with
// the right node id, click again → toggle off, close button → dismiss.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// t/4651: TaxNodeDetail (rendered unmocked here) now calls scrollIntoView on open — jsdom
// doesn't implement it.
Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  nodeIdToTab: () => ({ tab: 'acc', colorVar: 'var(--color-acc)' }),
  getNodeLabel: (id: string) => `Label for ${id}`,
  getNodeWeight: () => null,
  focusMainWindowNode: vi.fn(),
  buildExplainPrompt: vi.fn(() => 'prompt'),
  buildSelectionExplainPrompt: vi.fn(() => 'selection prompt'),
  fixMarkdownLinks: (s: string) => s,
  resolvePolRef: () => ({ id: '', relevance: null }),
  getPolicyAction: () => undefined,
}));

vi.mock('../../utils/humanizeSpeakers', () => ({
  humanizeSpeakerIds: (ids: string) => ids,
}));

const lookupPinnedData = vi.fn((id: string) => ({
  type: 'pov' as const,
  pov: 'accelerationist' as const,
  node: { id, label: 'Test Node', category: 'Beliefs', description: 'A description' },
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));

// Stub the reused detail panel so the test targets TaxonomyRefs' wiring, not the
// panel's internals (which pull DescriptionToggle + store hooks of their own).
vi.mock('../taxonomy/TaxonomyRefDetail', () => ({
  TaxonomyRefDetail: ({ nodeId, onClose }: { nodeId: string; onClose: () => void }) => (
    <div data-testid="ref-detail" data-node={nodeId}>
      <button onClick={onClose}>close-detail</button>
    </div>
  ),
}));

import { TaxonomyRefsSection } from './TaxonomyRefs';
import { usePreferencesStore } from '../../store/preferencesStore';

const ANCHOR = 'acc-B-001';

function renderPlan() {
  const stageDiagnostics = [
    {
      stage: 'plan',
      raw_response: '',
      work_product: {
        strategic_goal: 'Win the point',
        argument_structure: [
          { point: 'P1', evidence: 'E1', taxonomy_anchor: ANCHOR },
        ],
      },
    },
  ];
  return render(<TaxonomyRefsSection refs={[]} stageDiagnostics={stageDiagnostics} forceExpanded />);
}

describe('TaxonomyRefsSection — PLAN anchor → inline POV detail (t/1724)', () => {
  // t/2867: TheoryLink now gates on viewMode; advanced view shows the help icons these tests assert.
  beforeEach(() => { vi.clearAllMocks(); usePreferencesStore.setState({ viewMode: 'advanced' }); });

  it('renders the anchor as a keyboard-accessible button, no detail until clicked', () => {
    renderPlan();
    const btn = screen.getByRole('button', { name: ANCHOR });
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });

  it('clicking the anchor shows the detail resolved for that node id', () => {
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: ANCHOR }));
    const detail = screen.getByTestId('ref-detail');
    expect(detail.getAttribute('data-node')).toBe(ANCHOR);
    expect(lookupPinnedData).toHaveBeenCalledWith(ANCHOR);
    expect(screen.getByRole('button', { name: ANCHOR }).getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking the same anchor again toggles the detail off', () => {
    renderPlan();
    const btn = () => screen.getByRole('button', { name: ANCHOR });
    fireEvent.click(btn());
    expect(screen.getByTestId('ref-detail')).toBeTruthy();
    fireEvent.click(btn());
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });

  it('the detail Close control dismisses the panel', () => {
    renderPlan();
    fireEvent.click(screen.getByRole('button', { name: ANCHOR }));
    fireEvent.click(screen.getByText('close-detail'));
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });
});

describe('AnticipatedBox — legacy object-shape items (t/3418, React #31 regression)', () => {
  beforeEach(() => { vi.clearAllMocks(); usePreferencesStore.setState({ viewMode: 'advanced' }); });

  it('renders without throwing when anticipated_challenges/responses are legacy {challenge, type} objects', () => {
    const stageDiagnostics = [
      {
        stage: 'plan',
        raw_response: '',
        work_product: {
          strategic_goal: 'Win the point',
          anticipated_challenges: [{ challenge: 'They will cite cost.', type: 'economic' }],
          anticipated_responses: [{ challenge: 'Point to long-run savings.' }],
        },
      },
    ];
    expect(() =>
      render(<TaxonomyRefsSection refs={[]} stageDiagnostics={stageDiagnostics} forceExpanded />)
    ).not.toThrow();
    expect(screen.getByText('economic: They will cite cost.')).toBeInTheDocument();
    expect(screen.getByText('Point to long-run savings.')).toBeInTheDocument();
  });

  it('still renders plain tagged-string items (new schema) unchanged', () => {
    const stageDiagnostics = [
      {
        stage: 'plan',
        raw_response: '',
        work_product: {
          strategic_goal: 'Win the point',
          anticipated_challenges: ['economic: They will cite cost.'],
        },
      },
    ];
    render(<TaxonomyRefsSection refs={[]} stageDiagnostics={stageDiagnostics} forceExpanded />);
    expect(screen.getByText('economic: They will cite cost.')).toBeInTheDocument();
  });
});

describe('TheoryLink help icons — mounts f + g (t/2347)', () => {
  it('renders the artifact-guide icon on BRIEF + PLAN and the citation-diagnostics icon in the statement footer, with distinct aria-labels', () => {
    const stageDiagnostics = [
      { stage: 'brief', raw_response: '', work_product: { situation_assessment: 'sa' } },
      { stage: 'plan', raw_response: '', work_product: { strategic_goal: 'g', argument_structure: [] } },
    ];
    const entry = { id: 'e1', timestamp: 't', type: 'statement', speaker: 'accelerationist', content: 'x', taxonomy_refs: [], caveats: ['c1'] } as unknown as Parameters<typeof TaxonomyRefsSection>[0]['entry'];

    render(<TaxonomyRefsSection refs={[]} entry={entry} stageDiagnostics={stageDiagnostics} forceExpanded />);

    // (f) artifact-guide help renders on both the BRIEF and PLAN artifact cards
    expect(screen.getAllByLabelText('Help: artifact guide')).toHaveLength(2);
    // (g) citation-diagnostics help renders in the statement footer
    expect(screen.getByLabelText('Help: citation diagnostics design')).toBeInTheDocument();
  });
});

// t/469: per-statement HOW (Layout A). The data model and the component, through the real render path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

vi.mock('../../utils/lineageMatcher', () => ({ extractLineageNames: () => [] }));
vi.mock('../shared/TaxNodeDetail', () => ({ TaxNodeDetail: () => <div data-testid="node-detail" /> }));
vi.mock('./VocabularyPanel', () => ({
  VocabTermsView: () => <div data-testid="vocab" />,
  LineageTermsView: () => <div data-testid="lineage" />,
}));

import { StatementHowLayout } from './StatementHowLayout';
import { buildStatementHow, collapseItems } from './statementHow';

const ENTRY = { id: 'e2', type: 'statement', speaker: 'skeptic', content: 'Body text.', metadata: {} } as never;

function node(id: string, source: string, text: string) {
  return { id, text, source_entry_id: source, taxonomy_refs: [] } as never;
}
function edge(source: string, target: string, type: 'attacks' | 'supports') {
  return { id: `AE-${source}-${target}`, source, target, type, weight: 1 } as never;
}

const CONVERGENCE = {
  entry_id: 'e2', round: 1, speaker: 'skeptic',
  move_polarity: { confrontational: 1, collaborative: 0, ratio: 1 },
  dialectical_engagement: { targeted: 1, standalone: 0, ratio: 1 },
  argument_redundancy: { avg_self_overlap: 0.2, max_self_overlap: 0.4 },
  dominant_counterargument: null,
  concession_opportunity: { strong_attacks_faced: 0, concession_used: false, outcome: 'none' },
  position_drift: { overlap_with_opening: 1, drift: 0 },
  crux_engagement_rate: { used_this_turn: false, cumulative_count: 0, cumulative_follow_through: 0 },
} as never;

const NODES = [
  node('AN-1', 'e2', 'Claim one'),
  node('AN-2', 'e2', 'Claim two'),
  node('AN-9', 'e1', 'Earlier attacker'),
  node('AN-10', 'e3', 'Attack A'), node('AN-11', 'e3', 'Attack B'), node('AN-12', 'e3', 'Attack C'), node('AN-13', 'e3', 'Attack D'),
];
const EDGES = [edge('AN-9', 'AN-1', 'attacks'), edge('AN-10', 'AN-2', 'attacks'), edge('AN-11', 'AN-2', 'attacks'), edge('AN-12', 'AN-2', 'attacks'), edge('AN-13', 'AN-2', 'attacks'), edge('AN-9', 'AN-2', 'supports')];

describe('collapseItems', () => {
  it('shows the first three and counts the rest', () => {
    expect(collapseItems([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], hidden: 2 });
    expect(collapseItems([1, 2])).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe('buildStatementHow', () => {
  it('counts a claim\'s incoming attacks and supports, and leaves absent fields empty', () => {
    const m = buildStatementHow(ENTRY, NODES, EDGES);
    expect(m.claims).toHaveLength(2);
    expect(m.claims[0].attacks.map(a => a.id)).toEqual(['AN-9']);
    expect(m.claims[1].attacks).toHaveLength(4);
    expect(m.claims[1].supports.map(s => s.id)).toEqual(['AN-9']);
    expect(m.attackCount).toBe(5);
    expect(m.supportCount).toBe(1);
    expect(m.focus).toBeUndefined();
    expect(m.moves).toEqual([]);
    expect(m.assumptions).toEqual([]);
    expect(m.anticipated).toEqual([]);
  });

  it('reads focus, moves, assumptions and anticipated responses from the statement\'s metadata', () => {
    const e = { ...ENTRY, metadata: {
      focus_point: 'Answer the audit point',
      move_types: [{ move: 'DISTINGUISH', target: 'AN-1', detail: 'Separate the cases' }, { move: 'BURDEN SHIFT' }],
      key_assumptions: [{ assumption: 'Audits can be staffed', if_wrong: 'Then pledges are unverifiable' }, { assumption: 'Labs stay in scope' }],
      anticipated_responses: ['Labs will argue X. I counter Y.'],
    } } as never;
    const m = buildStatementHow(e, NODES, EDGES);
    expect(m.focus).toBe('Answer the audit point');
    expect(m.moves[0]).toMatchObject({ move: 'DISTINGUISH', target: 'AN-1', detail: 'Separate the cases' });
    expect(m.moves[1].move).toBe('BURDEN SHIFT');
    expect(m.assumptions[0]).toEqual({ assumption: 'Audits can be staffed', if_wrong: 'Then pledges are unverifiable' });
    expect(m.assumptions[1].if_wrong).toBeUndefined();
    expect(m.anticipated).toEqual(['Labs will argue X. I counter Y.']);
  });
});

describe('StatementHowLayout', () => {
  beforeEach(() => vi.clearAllMocks());

  function renderHow(over: Record<string, unknown> = {}) {
    const props = { nodes: NODES, edges: EDGES, convergence: CONVERGENCE, entry: ENTRY, ...over };
    return render(
      <StatementHowLayout
        entry={props.entry as never}
        debate={{ argument_network: { nodes: props.nodes as never, edges: props.edges as never }, convergence_signals: props.convergence ? [props.convergence as never] : [] }}
        vocabResolutions={undefined}
        meta={undefined}
      />,
    );
  }

  it('shows the counts line and the speaker eyebrow, with zero terms left out', () => {
    const { container } = renderHow();
    expect(container.querySelector('.claim-map-eyebrow')?.textContent).toBe('SKEPTIC · STATEMENT');
    expect(container.querySelector('.claim-map-counts')?.textContent).toBe('2 claims · 5 attacks · 1 support');
  });

  it('collapses a claim to three items, and Show N more reveals the rest', () => {
    renderHow();
    const c2 = screen.getByRole('group', { name: 'Attacks and supports on C2' });
    // 4 attacks + 1 support = 5 items; three shown, two behind the control.
    expect(within(c2).getAllByText(/^← ATTACK ON C2$/)).toHaveLength(3);
    expect(within(c2).queryByText('SUPPORTS C2')).toBeNull();
    const more = within(c2).getByRole('button', { name: 'Show 2 more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(c2).queryByRole('button', { name: /Show/ })).toBeNull();
    expect(within(c2).getAllByText(/^← ATTACK ON C2$/)).toHaveLength(4);
    expect(within(c2).getByText('SUPPORTS C2')).toBeTruthy();
  });

  it('shows the no-attack slot for a claim with no attacks or supports', () => {
    renderHow({ edges: [], nodes: [node('AN-1', 'e2', 'Lonely claim')] });
    expect(screen.getByRole('group', { name: 'No attack mapped to C1' })).toBeTruthy();
  });

  it('hides the focus, moves, assumptions and responses when their fields are absent', () => {
    const { container } = renderHow();
    expect(screen.queryByText(/Focus:/)).toBeNull();
    expect(screen.queryByLabelText('Planned moves')).toBeNull();
    expect(container.querySelector('.claim-map-assumptions')).toBeNull();
    expect(screen.queryByText(/Anticipated responses/)).toBeNull();
  });

  it('shows Focus, moves with a linked claim, assumptions with If wrong, and anticipated responses when present', () => {
    const e = { ...ENTRY, metadata: {
      focus_point: 'Answer the audit point',
      move_types: [{ move: 'DISTINGUISH', target: 'AN-2', detail: 'Separate the cases' }],
      key_assumptions: [{ assumption: 'Audits can be staffed', if_wrong: 'Then pledges are unverifiable' }],
      anticipated_responses: ['Labs will argue X. I counter Y.'],
    } };
    const { container } = renderHow({ entry: e });
    expect(screen.getByText('Answer the audit point')).toBeTruthy();
    expect(screen.getByLabelText('Planned moves')).toBeTruthy();
    expect(screen.getByText('→ C2')).toBeTruthy();
    expect(screen.getByText('Audits can be staffed')).toBeTruthy();
    expect(screen.getByText('Then pledges are unverifiable', { exact: false })).toBeTruthy();
    expect(screen.getByText('Labs will argue X. I counter Y.')).toBeTruthy();
    expect(container.querySelector('.claim-map-assumptions')).not.toBeNull();
  });

  it('keeps the empty-state copy when there is no argument network', () => {
    renderHow({ nodes: undefined, edges: undefined });
    expect(screen.getByText('No argument network yet')).toBeTruthy();
  });

  it('keeps the empty-state copy when this statement has no claims', () => {
    renderHow({ nodes: [node('AN-9', 'e1', 'Other statement')] });
    expect(screen.getByText('No claims extracted for this statement')).toBeTruthy();
  });

  it('shows the absent-convergence copy, and reads a null counterargument as None', () => {
    renderHow({ convergence: undefined });
    expect(screen.getByText('No convergence data for this turn.')).toBeTruthy();
  });

  it('renders the seven convergence cells, with a null counterargument as None', () => {
    const { container } = renderHow();
    expect(container.querySelectorAll('.sh-convergence > li')).toHaveLength(7);
    expect(screen.getByText('None', { selector: '.sh-convergence-value' })).toBeTruthy();
  });

  it('hides the vocabulary and lineage section when both are empty', () => {
    const { container } = renderHow({ vocabResolutions: [] });
    expect(container.querySelector('[aria-label="Vocabulary and lineage"]')).toBeNull();
    expect(screen.queryByTestId('vocab')).toBeNull();
  });
});

describe('anchor chip and convergence rounding (t/469)', () => {
  it('toggles the node detail from the claim anchor chip, and keeps it a keyboard button', async () => {
    const anchored = [{ id: 'AN-1', text: 'Claim one', source_entry_id: 'e2', taxonomy_refs: ['skp-beliefs-001'] }] as never;
    render(<StatementHowLayout entry={ENTRY} debate={{ argument_network: { nodes: anchored, edges: [] } }} vocabResolutions={undefined} meta={undefined} />);
    const chip = screen.getByRole('button', { name: 'skp-beliefs-001' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('node-detail')).toBeNull();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(await screen.findByTestId('node-detail')).toBeTruthy();
  });

  it('rounds convergence values to two decimal places', () => {
    const { container } = render(<StatementHowLayout entry={ENTRY} debate={{ argument_network: { nodes: NODES, edges: EDGES }, convergence_signals: [{ ...CONVERGENCE, move_polarity: { confrontational: 2, collaborative: 1, ratio: 1 / 3 }, position_drift: { overlap_with_opening: 1, drift: 0.8114285714 } } as never] }} vocabResolutions={undefined} meta={undefined} />);
    expect(container.textContent).toContain('0.33 (2 confrontational, 1 collaborative)');
    expect(container.textContent).toContain('0.81');
    expect(container.textContent).not.toContain('0.3333');
  });
});

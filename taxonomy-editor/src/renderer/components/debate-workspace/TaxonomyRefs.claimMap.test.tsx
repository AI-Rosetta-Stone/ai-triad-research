// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/331 — the How → Plan claim map, rendered through the real path
// (TaxonomyRefsSection → PlanSection → PlanBody → ClaimMapLayout). These tests pin
// the thesis header, the lens cards and the claim↔attack grid, including the
// substring and second-attack cases that the first mapping got wrong.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// TaxNodeDetail calls scrollIntoView on open; jsdom doesn't implement it.
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

import { TaxonomyRefsSection } from './TaxonomyRefs';
import { usePreferencesStore } from '../../store/preferencesStore';
import { useDebateStore } from '../../hooks/useDebateStore';

const THESIS = 'Labs can be trusted to self-regulate';

const PLAN_WORK_PRODUCT = {
  core_thesis: THESIS,
  strategic_goal: 'Establish that voluntary commitments suffice',
  framing_choices: [
    { frame: 'Market incentives', why: 'Firms respond to reputation' },
    { frame: 'Governance', why: 'Regulators shape norms' },
  ],
  argument_structure: [
    { point: 'Commitments are kept', evidence: 'Track record', taxonomy_anchor: 'acc-B-001' },
    { point: 'Audits catch failures', evidence: 'Audit data', taxonomy_anchor: 'acc-B-002' },
  ],
  anticipated_challenges: [
    'ATTACK: Commitments are often broken targeting node acc-B-001',
    // Second attack on C1: must go to Unmapped, not overwrite the first.
    'ATTACK: Second objection to the first claim targeting node acc-B-001',
    // Names acc-B-0012, which contains acc-B-001 as a substring: must not attach to C1.
    'ATTACK: Sourcing for acc-B-0012 is thin targeting node acc-B-0012',
    'ASSUMPTION: Firms keep reputational stakes',
  ],
  directive_response_plan: 'Address the audit gap',
};

function renderPlan(workProduct: Record<string, unknown> = PLAN_WORK_PRODUCT) {
  const stageDiagnostics = [{ stage: 'plan', raw_response: '', work_product: workProduct }];
  return render(<TaxonomyRefsSection refs={[]} stageDiagnostics={stageDiagnostics} forceExpanded />);
}

describe('How → Plan claim map (t/331)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ viewMode: 'advanced' });
  });

  it('renders the thesis as the headline and the ask without its leading verb', () => {
    const { container } = renderPlan();
    expect(screen.getByRole('heading', { level: 2, name: THESIS })).toBeTruthy();
    const ask = container.querySelector('.claim-map-ask')?.textContent ?? '';
    expect(ask).toContain('voluntary commitments suffice');
    expect(ask).not.toContain('Establish that');
  });

  it('shows the counts line without a verified term and without zero terms', () => {
    renderPlan();
    // 2 claims; 3 attacks (1 mapped + 2 unmapped); 1 assumption.
    expect(screen.getByText('2 claims · 3 attacks · 1 assumption')).toBeTruthy();
    expect(screen.queryByText(/\d+ verified/)).toBeNull();
  });

  it('renders one lens card per framing choice with its frame and why', () => {
    renderPlan();
    expect(screen.getByRole('heading', { name: 'Market incentives' })).toBeTruthy();
    expect(screen.getByText('Firms respond to reputation')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Governance' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('undefined');
  });

  it('attaches the attack that names a claim to that claim\'s row', () => {
    renderPlan();
    const c1 = screen.getByRole('group', { name: 'Attack on C1' });
    expect(within(c1).getByText('Commitments are often broken')).toBeTruthy();
    expect(within(c1).getByText('← ATTACK ON C1')).toBeTruthy();
  });

  it('shows a dashed placeholder for a claim with no attack', () => {
    renderPlan();
    const c2 = screen.getByRole('group', { name: 'No attack mapped to C2' });
    expect(within(c2).getByText('No anticipated attack targets this claim.')).toBeTruthy();
  });

  it('does not attach an attack on acc-B-0012 to acc-B-001 (substring)', () => {
    renderPlan();
    const c1 = screen.getByRole('group', { name: 'Attack on C1' });
    expect(within(c1).queryByText(/Sourcing for acc-B-0012/)).toBeNull();
  });

  it('keeps a second attack on the same claim, and any unnamed attack, in the Unmapped section', () => {
    renderPlan();
    expect(screen.getAllByText('Unmapped attack')).toHaveLength(2);
    expect(screen.getByText('Second objection to the first claim')).toBeTruthy();
    expect(screen.getByText('Sourcing for acc-B-0012 is thin')).toBeTruthy();
    const c1 = screen.getByRole('group', { name: 'Attack on C1' });
    expect(within(c1).queryByText('Second objection to the first claim')).toBeNull();
  });

  it('renders the tagged assumption as load-bearing', () => {
    const { container } = renderPlan();
    const card = container.querySelector('.claim-map-assumption-card');
    expect(card?.textContent).toContain('LOAD-BEARING ASSUMPTION');
    expect(card?.textContent).toContain('Firms keep reputational stakes');
  });

  it('shows the moderator directive above the plan', () => {
    renderPlan();
    expect(screen.getByText('MODERATOR DIRECTIVE')).toBeTruthy();
    expect(screen.getByText('Address the audit gap')).toBeTruthy();
  });

  it('a section that throws does not hide the rest of the plan', () => {
    // A framing value whose String() throws makes the lens section fail on render.
    const broken = { toString() { throw new Error('lens render failure'); } };
    renderPlan({ ...PLAN_WORK_PRODUCT, framing_choices: broken });
    expect(screen.getByRole('heading', { level: 2, name: THESIS })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Attack on C1' })).toBeTruthy();
    expect(screen.getByText('MODERATOR DIRECTIVE')).toBeTruthy();
  });

  it('skips a null or frameless lens; the valid lens still renders and no empty heading appears', () => {
    const { container } = renderPlan({
      ...PLAN_WORK_PRODUCT,
      framing_choices: [null, { why: 'orphan reason' }, { frame: 'Governance', why: 'Regulators shape norms' }],
    });
    expect(screen.getByRole('heading', { name: 'Governance' })).toBeTruthy();
    expect(container.querySelectorAll('.claim-map-lens-title')).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Attack on C1' })).toBeTruthy();
  });

  it('skips a malformed anticipated item without rendering it as text', () => {
    renderPlan({ ...PLAN_WORK_PRODUCT, anticipated_challenges: [null, { foo: 1 }, 'ASSUMPTION: Real assumption'] });
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(document.body.textContent).not.toContain('null');
    expect(screen.getByText('Real assumption')).toBeTruthy();
  });

  it('falls back to the legacy stacked view when there is no thesis or goal', () => {
    const { container } = renderPlan({ argument_structure: [{ point: 'Legacy point', evidence: 'e', taxonomy_anchor: 'acc-B-001' }] });
    expect(container.querySelector('.claim-map-layout')).toBeNull();
    expect(screen.getByText('Legacy point')).toBeTruthy();
  });
});

describe('How → Plan claim map: motion, stage word, no synthetic ids (t/388)', () => {
  const MOTION = 'Frontier labs should be legally liable for model harms';
  const ENTRY = { id: 'entry-1', type: 'opening', speaker: 'skeptic' } as never;

  function renderFor(entry: unknown, activeDebate: unknown) {
    useDebateStore.setState({ activeDebate } as never);
    const stageDiagnostics = [{ stage: 'plan', raw_response: '', work_product: PLAN_WORK_PRODUCT }];
    return render(<TaxonomyRefsSection refs={[]} entry={entry as never} stageDiagnostics={stageDiagnostics} forceExpanded />);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    usePreferencesStore.setState({ viewMode: 'advanced' });
  });

  it('shows the session motion when the entry belongs to the active debate', () => {
    renderFor(ENTRY, { topic: { final: MOTION }, transcript: [{ id: 'entry-1' }] });
    expect(screen.getByText(`Motion — ${MOTION}`)).toBeTruthy();
  });

  it('omits the motion line when the entry is not in the active debate', () => {
    renderFor(ENTRY, { topic: { final: MOTION }, transcript: [{ id: 'other-entry' }] });
    expect(screen.queryByText(/Motion —/)).toBeNull();
  });

  it('omits the motion line when there is no active debate', () => {
    renderFor(ENTRY, null);
    expect(screen.queryByText(/Motion —/)).toBeNull();
  });

  it('labels an opening entry as OPENING PLAN, after the speaker camp', () => {
    const { container } = renderFor(ENTRY, null);
    expect(container.querySelector('.claim-map-eyebrow')?.textContent).toBe('SKEPTIC · OPENING PLAN');
  });

  it('does not show the stage as OPENING for a non-opening entry', () => {
    const { container } = renderFor({ id: 'entry-2', type: 'statement', speaker: 'skeptic' }, null);
    expect(container.querySelector('.claim-map-eyebrow')?.textContent).toBe('SKEPTIC · PLAN');
  });

  it('never shows an annotation id on an attack card', () => {
    const { container } = renderFor(ENTRY, null);
    expect(container.querySelector('.claim-map-attack-id')).toBeNull();
    expect(document.body.textContent).not.toMatch(/AN-\d/);
    // The attack still reads as Unverified.
    expect(screen.getByRole('group', { name: 'Attack on C1' }).textContent).toContain('Unverified');
  });
});

describe('claim-map steelman card (t/388)', () => {
  it('shows no id when an offered tag resolves to no steelman node', () => {
    useDebateStore.setState({ activeDebate: { transcript: [{ id: 'entry-2' }], argument_network: { nodes: [], edges: [] } } as never });
    const wp = { ...PLAN_WORK_PRODUCT, steelman_refs_offered: ['AN-7'], anticipated_challenges: ['ATTACK [AN-7]: Pledges erode targeting node acc-B-001'] };
    const stageDiagnostics = [{ stage: 'plan', raw_response: '', work_product: wp }];
    render(<TaxonomyRefsSection refs={[]} entry={{ id: 'entry-2', type: 'statement', speaker: 'skeptic' } as never} stageDiagnostics={stageDiagnostics} forceExpanded />);
    const c1 = screen.getByRole('group', { name: 'Attack on C1' });
    expect(within(c1).getByText('Pledges erode')).toBeTruthy();
    expect(within(c1).getByText('Unverified')).toBeTruthy();
    expect(document.body.textContent).not.toContain('AN-7');
    useDebateStore.setState({ activeDebate: null } as never);
  });

  it('labels the steelman on an unmapped attack too (a tagged attack that names no claim)', () => {
    useDebateStore.setState({
      activeDebate: {
        transcript: [{ id: 'entry-2' }],
        argument_network: {
          nodes: [{ id: 'AN-3', text: 'Publishing tests hands exploits to attackers', steelman_of: 'accelerationist', steelman_check: { verdict: 'unchecked' }, source_entry_id: 'entry-1' }],
          edges: [],
        },
      } as never,
    });
    const wp = {
      ...PLAN_WORK_PRODUCT,
      steelman_refs_offered: ['AN-3'],
      anticipated_challenges: ['ATTACK [AN-3]: Raw data helps attackers', 'ATTACK: A plain unmapped objection'],
    };
    const stageDiagnostics = [{ stage: 'plan', raw_response: '', work_product: wp }];
    const { container } = render(<TaxonomyRefsSection refs={[]} entry={{ id: 'entry-2', type: 'opening', speaker: 'safetyist' } as never} stageDiagnostics={stageDiagnostics} forceExpanded />);
    const cards = container.querySelectorAll('.claim-map-unmapped-row .claim-map-attack-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText('STEELMAN OF THE ACCELERATIONIST')).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText('Publishing tests hands exploits to attackers')).toBeTruthy();
    expect(within(cards[0] as HTMLElement).getByText('Unverified')).toBeTruthy();
    // The untagged attack keeps its own text and gets no steelman label.
    expect(within(cards[1] as HTMLElement).getByText('A plain unmapped objection')).toBeTruthy();
    expect(within(cards[1] as HTMLElement).queryByText(/STEELMAN OF/)).toBeNull();
    // An unchecked steelman adds no "N verified" term to the counts line.
    expect(screen.queryByText(/\d+ verified/)).toBeNull();
    // The id shows only on the card whose steelman resolved.
    expect(within(cards[0] as HTMLElement).getByText('AN-3')).toHaveClass('claim-map-attack-id');
    expect(cards[1].querySelector('.claim-map-attack-id')).toBeNull();
    useDebateStore.setState({ activeDebate: null } as never);
  });

  it('shows a linked steelman on the attack card, with its verdict and the verified term', () => {
    useDebateStore.setState({
      activeDebate: {
        transcript: [{ id: 'entry-2' }],
        argument_network: {
          nodes: [{ id: 'AN-7', text: 'Labs will keep their pledges', steelman_of: 'safetyist', steelman_check: { verdict: 'faithful' }, source_entry_id: 'entry-1' }],
          edges: [],
        },
      } as never,
    });
    const wp = {
      ...PLAN_WORK_PRODUCT,
      steelman_refs_offered: ['AN-7'],
      anticipated_challenges: ['ATTACK [AN-7]: Pledges erode targeting node acc-B-001'],
    };
    const stageDiagnostics = [{ stage: 'plan', raw_response: '', work_product: wp }];
    render(<TaxonomyRefsSection refs={[]} entry={{ id: 'entry-2', type: 'statement', speaker: 'skeptic' } as never} stageDiagnostics={stageDiagnostics} forceExpanded />);
    const c1 = screen.getByRole('group', { name: 'Attack on C1' });
    expect(within(c1).getByText('Labs will keep their pledges')).toBeTruthy();
    expect(within(c1).getByText(/STEELMAN OF THE SAFETYIST/)).toBeTruthy();
    expect(within(c1).getByText('Faithful to target')).toBeTruthy();
    expect(screen.getByText(/1 verified/)).toBeTruthy();
    expect(within(c1).getByText('AN-7')).toHaveClass('claim-map-attack-id');
    useDebateStore.setState({ activeDebate: null } as never);
  });
});

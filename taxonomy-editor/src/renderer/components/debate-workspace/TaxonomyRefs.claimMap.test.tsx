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

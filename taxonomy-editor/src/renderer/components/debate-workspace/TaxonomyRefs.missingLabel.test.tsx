// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/282 (Design): BdiRefItem must not repeat a node id that the pill already shows. A node that
// doesn't resolve reads "No longer in the taxonomy" once the taxonomy has loaded, and no label
// while it is still loading.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

Element.prototype.scrollIntoView = vi.fn();

const { taxState } = vi.hoisted(() => ({
  taxState: { loaded: true } as { loaded: boolean },
}));

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: {} }));

// getNodeLabel returns the bare id for a node that doesn't resolve, as in production.
vi.mock('./utils', () => ({
  nodeIdToTab: () => ({ tab: 'skp', colorVar: 'var(--color-skp)' }),
  getNodeLabel: (id: string) => (id === 'skp-beliefs-001' ? 'Resolved label' : id),
  getNodeWeight: () => null,
  focusMainWindowNode: vi.fn(),
  buildExplainPrompt: vi.fn(() => 'prompt'),
  buildSelectionExplainPrompt: vi.fn(() => 'selection prompt'),
  fixMarkdownLinks: (s: string) => s,
  resolvePolRef: (ref: string) => ({ id: ref, relevance: null }),
  getPolicyAction: () => 'Some policy action',
}));
vi.mock('../../utils/humanizeSpeakers', () => ({ humanizeSpeakerIds: (ids: string) => ids }));
vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector(
    taxState.loaded
      ? { accelerationist: {}, safetyist: {}, skeptic: {}, situations: {} }
      : { accelerationist: null, safetyist: null, skeptic: null, situations: null },
  ),
}));

// Detail components pull more named exports from the store than the mock above provides; the
// label tests never open a detail, so stub them at module level.
vi.mock('../taxonomy/NodeDetail', () => ({ NodeDetail: () => null }));
vi.mock('../debate/SituationDetail', () => ({ SituationDetail: () => null }));
vi.mock('../taxonomy/TaxonomyRefDetail', () => ({ TaxonomyRefDetail: () => null }));

import { BdiGroundingView } from './TaxonomyRefs';
import type { TaxonomyRef } from '../../types/debate';

const MISSING: TaxonomyRef = { node_id: 'skp-beliefs-999', relevance: 'gone node', relevance_score: 0.5 };
const RESOLVED: TaxonomyRef = { node_id: 'skp-beliefs-001', relevance: 'live node', relevance_score: 0.9 };

describe('BdiRefItem label for unresolved nodes (t/282, Design)', () => {
  beforeEach(() => { taxState.loaded = true; });

  it('shows "No longer in the taxonomy" once loaded, and does not repeat the id', () => {
    const { container } = render(<BdiGroundingView refs={[MISSING]} />);
    const missing = screen.getByText('No longer in the taxonomy');
    expect(missing).toHaveClass('debate-reasoning-label--missing');
    // The id appears once, as the row button; the label span holds only the missing text.
    expect(container.querySelectorAll('.debate-reasoning-label')[0].textContent).toBe('No longer in the taxonomy');
    expect(screen.getAllByRole('button', { name: 'skp-beliefs-999' })).toHaveLength(1);
  });

  it('shows no label while the taxonomy is still loading', () => {
    taxState.loaded = false;
    const { container } = render(<BdiGroundingView refs={[MISSING]} />);
    expect(screen.queryByText('No longer in the taxonomy')).toBeNull();
    expect(container.querySelector('.debate-reasoning-label')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'skp-beliefs-999' })).toHaveLength(1);
  });

  it('shows the resolved label for a node that exists, with no missing class', () => {
    render(<BdiGroundingView refs={[RESOLVED]} />);
    const label = screen.getByText('Resolved label');
    expect(label).toHaveClass('debate-reasoning-label');
    expect(label).not.toHaveClass('debate-reasoning-label--missing');
  });
});

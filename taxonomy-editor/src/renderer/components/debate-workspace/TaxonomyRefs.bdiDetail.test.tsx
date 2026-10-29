// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Clicking a BDI ref (chip or node-id link) in the debate PLAN view toggles an
// inline TaxonomyRefDetail resolved from the client-side taxonomy store — in
// place of the old behavior of navigating away to the main window. These tests
// pin the wiring: click → detail shown below, click again → toggle off, and the
// click must NOT trigger main-window navigation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// t/4651: TaxNodeDetail (rendered unmocked by TaxonomyRefsSection, below) now calls
// scrollIntoView on open — jsdom doesn't implement it.
Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  nodeIdToTab: () => ({ tab: 'skp', colorVar: 'var(--color-skp)' }),
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
  pov: 'skeptic' as const,
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
import { focusMainWindowNode } from './utils';
import type { TaxonomyRef } from '../../types/debate';

const NODE = 'skp-beliefs-164';
const REFS: TaxonomyRef[] = [{ node_id: NODE, relevance: 'why it matters', relevance_score: 0.66 }];

function renderBdi() {
  return render(<TaxonomyRefsSection refs={REFS} forceExpanded />);
}

describe('TaxonomyRefsSection — BDI ref → inline POV detail (not navigate)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the BDI node-id as a button, no detail until clicked', () => {
    renderBdi();
    const btn = screen.getByRole('button', { name: NODE });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });

  it('clicking the node-id shows the detail for that node and does NOT navigate', () => {
    renderBdi();
    fireEvent.click(screen.getByRole('button', { name: NODE }));
    const detail = screen.getByTestId('ref-detail');
    expect(detail.getAttribute('data-node')).toBe(NODE);
    expect(lookupPinnedData).toHaveBeenCalledWith(NODE);
    expect(focusMainWindowNode).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: NODE }).getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking the same node-id again toggles the detail off', () => {
    renderBdi();
    const btn = () => screen.getByRole('button', { name: NODE });
    fireEvent.click(btn());
    expect(screen.getByTestId('ref-detail')).toBeTruthy();
    fireEvent.click(btn());
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });

  it('clicking the chip (with score) also shows the detail without navigating', () => {
    renderBdi();
    fireEvent.click(screen.getByText(`${NODE} (0.66)`));
    expect(screen.getByTestId('ref-detail').getAttribute('data-node')).toBe(NODE);
    expect(focusMainWindowNode).not.toHaveBeenCalled();
  });

  it('the detail Close control dismisses the panel', () => {
    renderBdi();
    fireEvent.click(screen.getByRole('button', { name: NODE }));
    fireEvent.click(screen.getByText('close-detail'));
    expect(screen.queryByTestId('ref-detail')).toBeNull();
  });
});

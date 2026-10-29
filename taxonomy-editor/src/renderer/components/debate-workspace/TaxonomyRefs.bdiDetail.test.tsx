// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4625 follow-up (PI, t/4625#10): the How→Plan BDI section was removed as redundant with
// the always-visible Why tab. This used to test clicking a BDI ref in the Plan view (chip or
// node-id link) toggling an inline TaxonomyRefDetail; that interaction now lives exclusively
// in BdiGroundingView (covered by TaxonomyRefs.whyView.test.tsx). This file now just pins the
// removal: TaxonomyRefsSection, forceExpanded, with refs, renders no BDI content at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('../taxonomy/TaxonomyRefDetail', () => ({
  TaxonomyRefDetail: ({ nodeId, onClose }: { nodeId: string; onClose: () => void }) => (
    <div data-testid="ref-detail" data-node={nodeId}>
      <button onClick={onClose}>close-detail</button>
    </div>
  ),
}));

import { TaxonomyRefsSection } from './TaxonomyRefs';
import type { TaxonomyRef } from '../../types/debate';

const NODE = 'skp-beliefs-164';
const REFS: TaxonomyRef[] = [{ node_id: NODE, relevance: 'why it matters', relevance_score: 0.66 }];

describe('TaxonomyRefsSection — How→Plan no longer renders a BDI section (t/4625 follow-up)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders no BDI node-id button, chip, or "BDI" disclosure for a statement with BDI refs', () => {
    render(<TaxonomyRefsSection refs={REFS} forceExpanded />);
    expect(screen.queryByRole('button', { name: NODE })).not.toBeInTheDocument();
    expect(screen.queryByText(`${NODE} (0.66)`)).not.toBeInTheDocument();
    expect(screen.queryByText('BDI')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ref-detail')).not.toBeInTheDocument();
  });
});

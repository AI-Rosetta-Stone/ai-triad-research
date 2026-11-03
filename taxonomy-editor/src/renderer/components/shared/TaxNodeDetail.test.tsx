// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4651: clicking a BDI ref opened the detail below the ref list, often off-screen, with no
// scroll and no focus move — the click looked like it did nothing. Covers scroll-into-view,
// reduced-motion, and focus move-on-open / restore-on-close, in the shared wrapper so Debate Why,
// Chat replies and any other TaxNodeDetail consumer gets the fix for free.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TaxNodeDetail } from './TaxNodeDetail';

let pinnedData: Record<string, unknown> | undefined = {
  type: 'pov' as const,
  pov: 'skeptic' as const,
  node: { id: 'acc-beliefs-001', label: 'Test Node', category: 'Beliefs', description: 'A description' },
};
const lookupPinnedData = vi.fn((id: string) => pinnedData && { ...pinnedData, node: { ...(pinnedData.node as object), id } });

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));

// Stub the three detail panels so tests target the wrapper's branching/scroll/focus wiring,
// not any panel's own internals (t/4654: pov/situations now render NodeDetail/SituationDetail
// instead of the legacy TaxonomyRefDetail card; policy/unresolved still use TaxonomyRefDetail).
vi.mock('../taxonomy/NodeDetail', () => ({
  NodeDetail: ({ node }: { node: { id: string } }) => <div data-testid="node-detail">{node.id}</div>,
}));
vi.mock('../debate/SituationDetail', () => ({
  SituationDetail: ({ node }: { node: { id: string } }) => <div data-testid="situation-detail">{node.id}</div>,
}));
vi.mock('../taxonomy/TaxonomyRefDetail', () => ({
  TaxonomyRefDetail: ({ nodeId }: { nodeId: string }) => <div data-testid="ref-detail">{nodeId}</div>,
}));

describe('TaxNodeDetail — scroll + focus on open (t/4651)', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;
  let reducedMotion = false;

  beforeEach(() => {
    pinnedData = {
      type: 'pov' as const,
      pov: 'skeptic' as const,
      node: { id: 'acc-beliefs-001', label: 'Test Node', category: 'Beliefs', description: 'A description' },
    };
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    reducedMotion = false;
    // jsdom has no window.matchMedia — stub it directly (vi.spyOn requires an existing function).
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion') && reducedMotion,
        media: query,
        onchange: null,
        addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList),
    });
  });

  it('scrolls the detail into view and focuses it when it mounts', () => {
    render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    expect(screen.getByTestId('node-detail').closest('[tabindex="-1"]')).toHaveFocus();
  });

  // t/4651#3 (Design AC5 fix): the landing region needs a name, since focus moves here
  // programmatically rather than via a heading the user just activated.
  it('names the landing region for screen readers', () => {
    render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Test Node' })).toBeInTheDocument();
  });

  it('uses behavior: auto under prefers-reduced-motion', () => {
    reducedMotion = true;
    render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
  });

  it('re-scrolls and re-focuses when nodeId changes while mounted', () => {
    const { rerender } = render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    scrollSpy.mockClear();
    rerender(<TaxNodeDetail nodeId="saf-beliefs-002" onClose={vi.fn()} />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('saf-beliefs-002')).toBeInTheDocument();
  });

  it('returns focus to the triggering ref element on close (unmount)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(button).toHaveFocus();

    const { unmount } = render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    expect(button).not.toHaveFocus();

    unmount();
    expect(button).toHaveFocus();
    document.body.removeChild(button);
  });

  it('does not bounce focus back to the trigger on an in-place nodeId change (only on true close)', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const { rerender, unmount } = render(<TaxNodeDetail nodeId="acc-beliefs-001" onClose={vi.fn()} />);
    rerender(<TaxNodeDetail nodeId="saf-beliefs-002" onClose={vi.fn()} />);
    expect(button).not.toHaveFocus(); // still on the detail, not bounced back mid-switch

    unmount();
    expect(button).toHaveFocus();
    document.body.removeChild(button);
  });
});

describe('TaxNodeDetail — NodeDetail/SituationDetail swap (t/4654)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('AC1: a pov node renders the Taxonomy tool\'s NodeDetail, read-only', () => {
    pinnedData = { type: 'pov', pov: 'skeptic', node: { id: 'skp-beliefs-001', label: 'Test Node', category: 'Beliefs', description: 'A description' } };
    render(<TaxNodeDetail nodeId="skp-beliefs-001" onClose={vi.fn()} />);
    expect(screen.getByTestId('node-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('situation-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ref-detail')).not.toBeInTheDocument();
  });

  it('AC1: a situation node renders SituationDetail, read-only', () => {
    pinnedData = { type: 'situations', node: { id: 'sit-001', label: 'Test Situation' } };
    render(<TaxNodeDetail nodeId="sit-001" onClose={vi.fn()} />);
    expect(screen.getByTestId('situation-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('node-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ref-detail')).not.toBeInTheDocument();
  });

  it('AC2: a policy (pol-*) id still renders TaxonomyRefDetail, named for screen readers', () => {
    pinnedData = { type: 'policy', policy: { id: 'pol-001', action: 'Do the thing', source_povs: [], member_count: 0 }, referencingNodes: [] };
    render(<TaxNodeDetail nodeId="pol-001" onClose={vi.fn()} />);
    expect(screen.getByTestId('ref-detail')).toBeInTheDocument();
    expect(screen.queryByTestId('node-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('situation-detail')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Do the thing' })).toBeInTheDocument();
  });

  it('AC2: an unresolved id still renders TaxonomyRefDetail', () => {
    pinnedData = undefined;
    render(<TaxNodeDetail nodeId="unknown-999" onClose={vi.fn()} />);
    expect(screen.getByTestId('ref-detail')).toBeInTheDocument();
  });

  it('AC2: Close works on the NodeDetail arm (no close control of its own)', async () => {
    pinnedData = { type: 'pov', pov: 'skeptic', node: { id: 'skp-beliefs-001', label: 'Test Node', category: 'Beliefs', description: 'A description' } };
    const onClose = vi.fn();
    render(<TaxNodeDetail nodeId="skp-beliefs-001" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

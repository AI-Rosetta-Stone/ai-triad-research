// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4651: clicking a BDI ref opened the detail below the ref list, often off-screen, with no
// scroll and no focus move — the click looked like it did nothing. Covers scroll-into-view,
// reduced-motion, and focus move-on-open / restore-on-close, in the shared wrapper so Debate Why,
// Chat replies and any other TaxNodeDetail consumer gets the fix for free.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaxNodeDetail } from './TaxNodeDetail';

const lookupPinnedData = vi.fn((id: string) => ({
  type: 'pov' as const,
  pov: 'skeptic' as const,
  node: { id, label: 'Test Node', category: 'Beliefs', description: 'A description' },
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ lookupPinnedData }),
}));

// Stub the reused detail panel so the test targets the wrapper's scroll/focus wiring, not the
// panel's own internals.
vi.mock('../taxonomy/TaxonomyRefDetail', () => ({
  TaxonomyRefDetail: ({ nodeId }: { nodeId: string }) => <div data-testid="ref-detail">{nodeId}</div>,
}));

describe('TaxNodeDetail — scroll + focus on open (t/4651)', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;
  let reducedMotion = false;

  beforeEach(() => {
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
    expect(screen.getByTestId('ref-detail').closest('[tabindex="-1"]')).toHaveFocus();
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

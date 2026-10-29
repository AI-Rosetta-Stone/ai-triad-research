// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4561: shared getting-started card, generalized from Chat's ChatGettingStarted (t/4536
// round 3). ChatGettingStarted.test.tsx covers the Chat-specific wiring and stays unmodified as
// the parity proof; this file covers the shared mechanics directly (render, chip → callback,
// Hide persistence, per-tool storage-key isolation).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { LibraryGettingStarted } from './LibraryGettingStarted';

const STORAGE_KEY = 'taxonomy-editor-test-tool-intro-dismissed';

const chips = [
  { label: 'First starter', value: 'first' },
  { label: 'Second starter', value: 'second' },
];

function renderCard(overrides: Partial<React.ComponentProps<typeof LibraryGettingStarted<string>>> = {}) {
  return render(
    <LibraryGettingStarted
      storageKey={STORAGE_KEY}
      heading="Try the tool"
      why="One line explaining why."
      chips={chips}
      onSelectChip={vi.fn()}
      hasNoItems={false}
      hideAriaLabel="Hide introduction"
      {...overrides}
    />,
  );
}

describe('LibraryGettingStarted (t/4561)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the heading, why line, and every chip', () => {
    renderCard();
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Try the tool' })).toBeInTheDocument();
    expect(screen.getByText('One line explaining why.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First starter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Second starter' })).toBeInTheDocument();
  });

  it('omits the hint paragraph when none is supplied', () => {
    renderCard();
    expect(screen.queryByText(/hint/i)).not.toBeInTheDocument();
  });

  it('renders the hint when supplied, including a ReactNode hint', () => {
    renderCard({ hint: <>Plain hint with <strong>emphasis</strong>.</> });
    expect(screen.getByText(/Plain hint with/)).toBeInTheDocument();
    expect(screen.getByText('emphasis')).toBeInTheDocument();
  });

  it('clicking a chip calls onSelectChip with that chip\'s value, not a neighbor\'s', async () => {
    const onSelectChip = vi.fn();
    const user = userEvent.setup();
    renderCard({ onSelectChip });
    await user.click(screen.getByRole('button', { name: 'Second starter' }));
    expect(onSelectChip).toHaveBeenCalledTimes(1);
    expect(onSelectChip).toHaveBeenCalledWith('second');
  });

  it('Hide replaces the card with the configured show-link label, and persists the dismissal under storageKey', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard({ showLinkLabel: 'Show tool tips' });
    await user.click(screen.getByRole('button', { name: 'Hide introduction' }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show tool tips' })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    unmount();
    renderCard({ showLinkLabel: 'Show tool tips' });
    expect(screen.getByRole('button', { name: 'Show tool tips' })).toBeInTheDocument();
  });

  it('defaults the show-link label to "Show tips" when none is supplied', async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole('button', { name: 'Hide introduction' }));
    expect(screen.getByRole('button', { name: 'Show tips' })).toBeInTheDocument();
  });

  it('a different storageKey keeps dismissal state isolated per tool', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    renderCard({ storageKey: 'taxonomy-editor-other-tool-intro-dismissed' });
    // The OTHER tool's key was never set, so its card still shows (not the dismissed link).
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
  });

  it('hasNoItems shows the card even when dismissed', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    renderCard({ hasNoItems: true });
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
  });

  // t/4565 round 2: Chat's phone layout (MyChatsList) mounts this card outside
  // .library-list-page, where the lib-prefixed custom properties are undefined and each one
  // resolves to its initial value (transparent fill, no border) — jsdom doesn't apply
  // stylesheets or resolve custom properties, so a rendered-DOM assertion can't catch this;
  // assert on the CSS source instead, per the originally-landed fix's own test approach
  // (t/4565#1).
  it('declares lgs-prefixed fallback tokens so the card renders outside .library-list-page (t/4565)', () => {
    const css = readFileSync(join(__dirname, 'LibraryGettingStarted.css'), 'utf-8');
    expect(css).toMatch(/--lgs-bg:\s*var\(--lib-row-hover,\s*#ece6dd\)/);
    expect(css).toMatch(/--lgs-chip-bg:\s*var\(--lib-bg,\s*#f4f0ea\)/);
    expect(css).toMatch(/--lgs-border:\s*var\(--lib-border-control,\s*#ddd5ca\)/);
    expect(css).toMatch(/--lgs-text:\s*var\(--lib-text,\s*#2b2622\)/);
    expect(css).toMatch(/--lgs-text-secondary:\s*var\(--lib-text-secondary,\s*#5d554f\)/);
    expect(css).toMatch(/--lgs-accent:\s*var\(--lib-accent,\s*#9e2236\)/);
    // The card's own rules must read --lgs-*, not --lib-* directly — otherwise the fallback
    // chain above is declared but never consulted. Strip comments (prose referencing --lib-*)
    // and the fallback declarations themselves before checking.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutFallbackDecls = withoutComments.replace(/--lgs-[a-z-]+:\s*var\([^)]*\);/g, '');
    expect(withoutFallbackDecls).not.toMatch(/var\(--lib-/);
  });

  // t/4633: examplePool + exampleCount — the random-subset path, additive and backward
  // compatible (legacy `chips` callers are covered by every test above, unchanged).
  describe('examplePool + exampleCount (t/4633)', () => {
    const pool = Array.from({ length: 15 }, (_, i) => ({ label: `Example ${i}`, value: `v${i}` }));

    it('renders exactly exampleCount chips, not the whole pool', () => {
      render(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool"
          why="One line."
          examplePool={pool}
          exampleCount={3}
          onSelectChip={vi.fn()}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      const buttons = screen.getAllByRole('button').filter((b) => b.className.includes('lib-getting-started-chip'));
      expect(buttons).toHaveLength(3);
    });

    it('does not reshuffle the picked chips across re-renders of the same mount (AC2)', () => {
      const { rerender } = render(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool"
          why="One line."
          examplePool={pool}
          exampleCount={5}
          onSelectChip={vi.fn()}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      const firstPass = screen.getAllByRole('button')
        .filter((b) => b.className.includes('lib-getting-started-chip'))
        .map((b) => b.textContent);

      // Force a re-render of the SAME mount (prop identity changes, component doesn't remount).
      rerender(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool — updated"
          why="One line."
          examplePool={pool}
          exampleCount={5}
          onSelectChip={vi.fn()}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      const secondPass = screen.getAllByRole('button')
        .filter((b) => b.className.includes('lib-getting-started-chip'))
        .map((b) => b.textContent);

      expect(secondPass).toEqual(firstPass);
    });

    it('a pool at or under exampleCount shows every item (pickExamples\' own no-op path)', () => {
      const small = pool.slice(0, 2);
      render(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool"
          why="One line."
          examplePool={small}
          exampleCount={5}
          onSelectChip={vi.fn()}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      expect(screen.getByRole('button', { name: 'Example 0' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Example 1' })).toBeInTheDocument();
    });

    it('clicking a picked chip still calls onSelectChip with its own value', async () => {
      const onSelectChip = vi.fn();
      const user = userEvent.setup();
      render(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool"
          why="One line."
          examplePool={pool}
          exampleCount={3}
          onSelectChip={onSelectChip}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      const chipButtons = screen.getAllByRole('button').filter((b) => b.className.includes('lib-getting-started-chip'));
      await user.click(chipButtons[0]);
      expect(onSelectChip).toHaveBeenCalledTimes(1);
      expect(onSelectChip.mock.calls[0][0]).toMatch(/^v\d+$/);
    });

    it('examplePool takes priority over chips when both are given', () => {
      render(
        <LibraryGettingStarted
          storageKey={STORAGE_KEY}
          heading="Try the tool"
          why="One line."
          chips={chips}
          examplePool={pool}
          exampleCount={3}
          onSelectChip={vi.fn()}
          hasNoItems={false}
          hideAriaLabel="Hide introduction"
        />,
      );
      expect(screen.queryByRole('button', { name: 'First starter' })).not.toBeInTheDocument();
      const buttons = screen.getAllByRole('button').filter((b) => b.className.includes('lib-getting-started-chip'));
      expect(buttons).toHaveLength(3);
    });
  });
});

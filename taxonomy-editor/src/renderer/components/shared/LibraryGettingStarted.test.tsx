// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4561: shared getting-started card, generalized from Chat's ChatGettingStarted (t/4536
// round 3). ChatGettingStarted.test.tsx covers the Chat-specific wiring and stays unmodified as
// the parity proof; this file covers the shared mechanics directly (render, chip → callback,
// Hide persistence, per-tool storage-key isolation).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
});

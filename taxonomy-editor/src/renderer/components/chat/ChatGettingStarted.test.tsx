// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { ChatGettingStarted, CHAT_STARTERS } from './ChatGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-chat-intro-dismissed';

describe('CHAT_STARTERS pool (t/4635)', () => {
  it('has 15 starters, each with a mode (AC1)', () => {
    expect(CHAT_STARTERS).toHaveLength(15);
    for (const s of CHAT_STARTERS) {
      expect(['inform', 'brainstorm', 'decide']).toContain(s.mode);
    }
  });

  it('represents all three modes (AC1)', () => {
    const modes = new Set(CHAT_STARTERS.map(s => s.mode));
    expect(modes).toEqual(new Set(['inform', 'brainstorm', 'decide']));
  });

  it('has at least one non-inform starter (needed for mustInclude, AC2)', () => {
    expect(CHAT_STARTERS.some(s => s.mode !== 'inform')).toBe(true);
  });

  it('no label is longer than the pre-t/4635 baseline (AC3)', () => {
    const BASELINE_MAX = 'Strongest evidence for the Accelerationist case'.length;
    for (const s of CHAT_STARTERS) {
      expect(s.text.length).toBeLessThanOrEqual(BASELINE_MAX);
    }
  });

  it('has no duplicate labels', () => {
    const texts = CHAT_STARTERS.map(s => s.text);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

// Helper shared by the component tests below: the rendered chip buttons are whichever 4
// CHAT_STARTERS pickExamples chose this mount — never hard-code a specific label, since the
// selection is random (t/4635). `pickExamples` itself is exhaustively seeded-rng-tested in
// shared/pickExamples.test.ts (AC4's "seeded rng" requirement, including mustInclude under 20
// seeds) — these tests cover the component's wiring of it, not the algorithm.
function starterButtons() {
  return screen.getAllByRole('button').filter(b => CHAT_STARTERS.some(s => s.text === b.textContent));
}

describe('ChatGettingStarted (t/4536 round 3, t/4635)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the card with exactly 4 chips drawn from the pool, and the mode hint (AC1, AC2)', () => {
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText(/Ask anything about AI policy/)).toBeInTheDocument();
    const buttons = starterButtons();
    expect(buttons).toHaveLength(4);
    expect(new Set(buttons.map(b => b.textContent)).size).toBe(4); // no repeats
    expect(screen.getByText(/Every chat has a mode/)).toBeInTheDocument();
  });

  it('always shows at least one non-inform starter among the 4 (AC2, mustInclude wiring)', () => {
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    const shownTexts = starterButtons().map(b => b.textContent);
    const shownModes = CHAT_STARTERS.filter(s => shownTexts.includes(s.text)).map(s => s.mode);
    expect(shownModes.some(m => m !== 'inform')).toBe(true);
  });

  it('shows the same 4 chips across a re-render of the same mount (no reshuffle)', () => {
    const { rerender } = render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    const first = starterButtons().map(b => b.textContent);
    rerender(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    const second = starterButtons().map(b => b.textContent);
    expect(second).toEqual(first);
  });

  it('calls onPickStarter with the clicked chip\'s mode and text', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={onPickStarter} />);
    const button = starterButtons()[0];
    const starter = CHAT_STARTERS.find(s => s.text === button.textContent)!;
    await user.click(button);
    expect(onPickStarter).toHaveBeenCalledWith(starter.mode, starter.text);
  });

  // t/4639: the card is now an accordion — a single toggle collapses/expands the body in
  // place, instead of unmounting the card for a separate "Show tips" link. The toggle's
  // accessible name aggregates the heading text plus the fixed "Hide examples"/"Show examples"
  // label (Design's spec structure), so queries use a regex rather than an exact match.
  it('the toggle collapses the body and remembers the dismissal, across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Hide examples/ });

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(starterButtons()).toHaveLength(0);
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Show examples/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the toggle again re-expands and clears the stored dismissal', async () => {
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Hide examples/ }));
    await user.click(screen.getByRole('button', { name: /Show examples/ }));

    expect(screen.getByRole('button', { name: /Hide examples/ })).toHaveAttribute('aria-expanded', 'true');
    expect(starterButtons()).toHaveLength(4);
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  // t/4639 regression: hasNoChats no longer overrides an explicit collapse (was the bug).
  it('hasNoChats=true: an explicit toggle still collapses the card', async () => {
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Hide examples/ }));
    expect(starterButtons()).toHaveLength(0);
  });

  it('shows the card expanded by default when the user has no chats yet and never dismissed', () => {
    render(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide examples/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

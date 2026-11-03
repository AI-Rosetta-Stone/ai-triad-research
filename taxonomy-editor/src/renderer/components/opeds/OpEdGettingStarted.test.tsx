// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { OpEdGettingStarted, OPED_STARTERS } from './OpEdGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-oped-intro-dismissed';
const TEXTS = OPED_STARTERS.map(s => s.text);

describe('OPED_STARTERS pool (t/4637)', () => {
  it('has 15 starters, each with a text and a topic (AC1)', () => {
    expect(OPED_STARTERS).toHaveLength(15);
    for (const s of OPED_STARTERS) {
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.topic.length).toBeGreaterThan(0);
    }
  });

  it('no text (the displayed label) is longer than the pre-t/4637 baseline (AC3)', () => {
    const BASELINE_MAX = 'Is open-weight AI a security risk or a safety net?'.length;
    for (const s of OPED_STARTERS) {
      expect(s.text.length).toBeLessThanOrEqual(BASELINE_MAX);
    }
  });

  it('has no duplicate text or topic', () => {
    expect(new Set(TEXTS).size).toBe(TEXTS.length);
    expect(new Set(OPED_STARTERS.map(s => s.topic)).size).toBe(OPED_STARTERS.length);
  });
});

describe('OpEdGettingStarted (t/4562, t/4637)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the card with exactly 3 chips, each drawn from the 15-item pool (AC2)', () => {
    render(<OpEdGettingStarted hasNoOpEds={false} onPickStarter={vi.fn()} />);
    const buttons = screen.getAllByRole('button').filter(b => TEXTS.includes(b.textContent ?? ''));
    expect(buttons).toHaveLength(3);
    expect(new Set(buttons.map(b => b.textContent)).size).toBe(3);
  });

  it('calls onPickStarter with the clicked chip\'s topic (not its displayed text)', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<OpEdGettingStarted hasNoOpEds={false} onPickStarter={onPickStarter} />);
    const buttons = screen.getAllByRole('button').filter(b => TEXTS.includes(b.textContent ?? ''));
    await user.click(buttons[0]);
    const starter = OPED_STARTERS.find(s => s.text === buttons[0].textContent);
    expect(onPickStarter).toHaveBeenCalledWith(starter?.topic);
  });

  it('shows the same 3 chips across a re-render of the same mount (no reshuffle)', () => {
    const { rerender } = render(<OpEdGettingStarted hasNoOpEds={false} onPickStarter={vi.fn()} />);
    const firstLabels = screen.getAllByRole('button')
      .filter(b => TEXTS.includes(b.textContent ?? ''))
      .map(b => b.textContent);
    rerender(<OpEdGettingStarted hasNoOpEds={true} onPickStarter={vi.fn()} />);
    const secondLabels = screen.getAllByRole('button')
      .filter(b => TEXTS.includes(b.textContent ?? ''))
      .map(b => b.textContent);
    expect(secondLabels).toEqual(firstLabels);
  });

  it('the toggle collapses the body and remembers the dismissal, across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<OpEdGettingStarted hasNoOpEds={false} onPickStarter={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Hide examples/ });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<OpEdGettingStarted hasNoOpEds={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Show examples/ })).toHaveAttribute('aria-expanded', 'false');
  });
});

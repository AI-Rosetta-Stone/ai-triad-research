// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { InquiryGettingStarted, QUESTION_STARTERS } from './InquiryGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-inquiry-intro-dismissed';

describe('QUESTION_STARTERS pool (t/4637)', () => {
  it('has 15 starters (AC1)', () => {
    expect(QUESTION_STARTERS).toHaveLength(15);
  });

  it('no label is longer than the pre-t/4637 baseline (AC3)', () => {
    const BASELINE_MAX = 'Should frontier models be regulated like critical infrastructure?'.length;
    for (const q of QUESTION_STARTERS) {
      expect(q.length).toBeLessThanOrEqual(BASELINE_MAX);
    }
  });

  it('has no duplicate starters', () => {
    expect(new Set(QUESTION_STARTERS).size).toBe(QUESTION_STARTERS.length);
  });
});

describe('InquiryGettingStarted (t/4562, t/4637)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the card with exactly 3 chips, each drawn from the 15-item pool (AC2)', () => {
    render(<InquiryGettingStarted hasNoQuestions={false} onPickStarter={vi.fn()} />);
    const buttons = screen.getAllByRole('button').filter(b => QUESTION_STARTERS.includes(b.textContent ?? ''));
    expect(buttons).toHaveLength(3);
    const labels = buttons.map(b => b.textContent);
    expect(new Set(labels).size).toBe(3); // no repeats within the shown subset
  });

  it('calls onPickStarter with the clicked chip\'s question', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<InquiryGettingStarted hasNoQuestions={false} onPickStarter={onPickStarter} />);
    const buttons = screen.getAllByRole('button').filter(b => QUESTION_STARTERS.includes(b.textContent ?? ''));
    await user.click(buttons[0]);
    expect(onPickStarter).toHaveBeenCalledWith(buttons[0].textContent);
  });

  it('shows the same 3 chips across a re-render of the same mount (no reshuffle)', () => {
    const { rerender } = render(<InquiryGettingStarted hasNoQuestions={false} onPickStarter={vi.fn()} />);
    const firstLabels = screen.getAllByRole('button')
      .filter(b => QUESTION_STARTERS.includes(b.textContent ?? ''))
      .map(b => b.textContent);
    rerender(<InquiryGettingStarted hasNoQuestions={true} onPickStarter={vi.fn()} />);
    const secondLabels = screen.getAllByRole('button')
      .filter(b => QUESTION_STARTERS.includes(b.textContent ?? ''))
      .map(b => b.textContent);
    expect(secondLabels).toEqual(firstLabels);
  });

  it('the toggle collapses the body and remembers the dismissal, across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<InquiryGettingStarted hasNoQuestions={false} onPickStarter={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Hide examples/ });

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<InquiryGettingStarted hasNoQuestions={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Show examples/ })).toHaveAttribute('aria-expanded', 'false');
  });
});

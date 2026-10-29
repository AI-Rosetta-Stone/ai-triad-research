// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { DebateGettingStarted } from './DebateGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-debate-intro-dismissed';

describe('DebateGettingStarted (t/4563)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the card with its 4 starter chips and the hint', () => {
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText(/Argue it out across three perspectives/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Should frontier AI development be paused for six months?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accelerationist vs Safetyist/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Safetyist vs Skeptic/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Accelerationist vs Skeptic/ })).toBeInTheDocument();
    expect(screen.getByText(/Debates use all three perspectives by default/)).toBeInTheDocument();
  });

  it('a motion chip calls onPickStarter with the topic and no povers', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={onPickStarter} />);
    await user.click(screen.getByRole('button', { name: 'Should frontier AI development be paused for six months?' }));
    expect(onPickStarter).toHaveBeenCalledWith('Should frontier AI development be paused for six months?', undefined);
  });

  it('a camp-pairing chip calls onPickStarter with the topic and exactly those two povers', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={onPickStarter} />);
    await user.click(screen.getByRole('button', { name: /Accelerationist vs Safetyist/ }));
    expect(onPickStarter).toHaveBeenCalledWith(
      'Should AI labs self-regulate, or face binding government rules?',
      ['accelerationist', 'safetyist'],
    );
  });

  // t/4639: the card is now an accordion — a single toggle collapses/expands the body in
  // place, instead of unmounting for a separate "Show tips" link. The toggle's accessible
  // name aggregates the heading text plus the fixed "Hide examples"/"Show examples" label
  // (Design's spec structure), so queries use a regex rather than an exact match.
  it('the toggle collapses the body and remembers the dismissal, across a remount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Hide examples/ });

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Should frontier AI development be paused for six months?' })).not.toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Show examples/ })).toHaveAttribute('aria-expanded', 'false');
  });

  // t/4639 regression: hasNoDebates no longer overrides an explicit collapse (was the bug).
  it('hasNoDebates=true: an explicit toggle still collapses the card', async () => {
    const user = userEvent.setup();
    render(<DebateGettingStarted hasNoDebates={true} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Hide examples/ }));
    expect(screen.queryByRole('button', { name: 'Should frontier AI development be paused for six months?' })).not.toBeInTheDocument();
  });

  it('shows the card expanded by default when the user has no debates yet and never dismissed', () => {
    render(<DebateGettingStarted hasNoDebates={true} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide examples/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

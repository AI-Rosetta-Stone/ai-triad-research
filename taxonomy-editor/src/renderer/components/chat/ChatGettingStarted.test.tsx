// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

import { ChatGettingStarted } from './ChatGettingStarted';

const DISMISSED_KEY = 'taxonomy-editor-chat-intro-dismissed';

describe('ChatGettingStarted (t/4536 round 3)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the card with its 4 starter chips and the mode hint', () => {
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText(/Ask anything about AI policy/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'How would a Safetyist see compute caps?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Strongest evidence for the Accelerationist case' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Brainstorm counterarguments to my position' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Work through a policy decision' })).toBeInTheDocument();
    expect(screen.getByText(/Every chat has a mode/)).toBeInTheDocument();
  });

  it('calls onPickStarter with the chip\'s mode and text', async () => {
    const onPickStarter = vi.fn();
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={onPickStarter} />);
    await user.click(screen.getByRole('button', { name: 'Work through a policy decision' }));
    expect(onPickStarter).toHaveBeenCalledWith('decide', 'Work through a policy decision');
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
    expect(screen.queryByRole('button', { name: 'Work through a policy decision' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Work through a policy decision' })).toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  // t/4639 regression: hasNoChats no longer overrides an explicit collapse (was the bug).
  it('hasNoChats=true: an explicit toggle still collapses the card', async () => {
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Hide examples/ }));
    expect(screen.queryByRole('button', { name: 'Work through a policy decision' })).not.toBeInTheDocument();
  });

  it('shows the card expanded by default when the user has no chats yet and never dismissed', () => {
    render(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hide examples/ })).toHaveAttribute('aria-expanded', 'true');
  });
});

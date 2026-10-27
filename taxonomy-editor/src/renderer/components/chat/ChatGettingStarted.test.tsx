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
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask anything about AI policy/ })).toBeInTheDocument();
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

  it('Hide replaces the card with a "Show chat tips" link, and remembers the dismissal', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Hide chat introduction' }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show chat tips' })).toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Show chat tips' })).toBeInTheDocument();
  });

  it('moves focus to "Show chat tips" after Hide (t/4536#8)', async () => {
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Hide chat introduction' }));
    expect(screen.getByRole('button', { name: 'Show chat tips' })).toHaveFocus();
  });

  it('"Show chat tips" brings the card back and moves focus to the heading (t/4536#8)', async () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    const user = userEvent.setup();
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Show chat tips' }));
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Ask anything about AI policy/ })).toHaveFocus();
  });

  it('places the heading before the Hide button in DOM order (t/4536#8)', () => {
    render(<ChatGettingStarted hasNoChats={false} onPickStarter={vi.fn()} />);
    const region = screen.getByRole('region', { name: 'Getting started' });
    const heading = screen.getByRole('heading', { name: /Ask anything about AI policy/ });
    const hide = screen.getByRole('button', { name: 'Hide chat introduction' });
    const children = Array.from(region.children);
    expect(children.indexOf(heading)).toBeLessThan(children.indexOf(hide));
  });

  it('shows the card even when dismissed, if the user has no chats yet', () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    render(<ChatGettingStarted hasNoChats={true} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
  });
});

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
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Argue it out across three perspectives/ })).toBeInTheDocument();
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

  it('Hide replaces the card with a "Show debate tips" link, and remembers the dismissal', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Hide debate introduction' }));
    expect(screen.queryByRole('region', { name: 'Getting started' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show debate tips' })).toBeInTheDocument();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');

    unmount();
    render(<DebateGettingStarted hasNoDebates={false} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Show debate tips' })).toBeInTheDocument();
  });

  it('shows the card even when dismissed, if the user has no debates yet', () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    render(<DebateGettingStarted hasNoDebates={true} onPickStarter={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Getting started' })).toBeInTheDocument();
  });
});

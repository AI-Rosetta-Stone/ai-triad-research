// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBar } from './LocationBar';

describe('LocationBar', () => {
  const mockCrumbs = [
    { label: 'Rosetta Stone', placeKey: 'rosetta-stone' },
    { label: 'Chat', placeKey: 'chat:none' },
    { label: 'Conversation #42', placeKey: 'chat:conv-42' },
  ];

  it('renders all crumbs with separators', () => {
    const onNavigate = vi.fn();
    render(
      <LocationBar
        crumbs={mockCrumbs}
        currentPlaceKey="chat:conv-42"
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByText('Rosetta Stone')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Conversation #42')).toBeInTheDocument();
    // Separators (should have n-1 separators for n crumbs)
    expect(screen.getAllByText('/')).toHaveLength(2);
  });

  it('disables the current crumb', () => {
    const onNavigate = vi.fn();
    render(
      <LocationBar
        crumbs={mockCrumbs}
        currentPlaceKey="chat:conv-42"
        onNavigate={onNavigate}
      />
    );

    const currentCrumb = screen.getByText('Conversation #42');
    expect(currentCrumb).toBeDisabled();
    expect(currentCrumb).toHaveAttribute('aria-current', 'page');
  });

  it('calls onNavigate when a non-current crumb is clicked', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <LocationBar
        crumbs={mockCrumbs}
        currentPlaceKey="chat:conv-42"
        onNavigate={onNavigate}
      />
    );

    const chatCrumb = screen.getByText('Chat');
    await user.click(chatCrumb);

    expect(onNavigate).toHaveBeenCalledWith('chat:none');
  });

  it('does not call onNavigate when the current crumb is clicked', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(
      <LocationBar
        crumbs={mockCrumbs}
        currentPlaceKey="chat:conv-42"
        onNavigate={onNavigate}
      />
    );

    const currentCrumb = screen.getByText('Conversation #42');
    // Disabled buttons don't fire click events, but verify no call
    await user.click(currentCrumb);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('renders with empty crumbs gracefully', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <LocationBar
        crumbs={[]}
        currentPlaceKey="none"
        onNavigate={onNavigate}
      />
    );

    expect(container.querySelector('.nav-locbar')).toBeInTheDocument();
  });
});

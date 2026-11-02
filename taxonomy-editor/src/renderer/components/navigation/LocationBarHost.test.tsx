// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBarHost } from './LocationBarHost';
import { navHistory } from '../../navigation';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';

// Mock the store hooks
vi.mock('../../hooks/useTaxonomyStore');
vi.mock('../../hooks/useDebateStore');
vi.mock('../../hooks/useChatStore');
vi.mock('../../hooks/useOpEdStore');
vi.mock('../../hooks/useInquiryStore');
vi.mock('../../navigation');

describe('LocationBarHost', () => {
  beforeEach(() => {
    // Setup default mocks
    const mockTaxonomyState = {
      activeTab: 'rosetta-stone',
    };
    const mockDebateState = {
      loadDebate: vi.fn(),
    };
    const mockChatState = {
      loadChat: vi.fn(),
    };

    vi.mocked(useTaxonomyStore).mockReturnValue(mockTaxonomyState as any);
    vi.mocked(useDebateStore).mockReturnValue(mockDebateState as any);
    vi.mocked(useChatStore).mockReturnValue(mockChatState as any);

    vi.mocked(navHistory).canGoBack.mockReturnValue(false);
    vi.mocked(navHistory).canGoForward.mockReturnValue(false);
    vi.mocked(navHistory).subscribe.mockReturnValue(() => {});
  });

  it('renders LocationBar with breadcrumbs', () => {
    render(<LocationBarHost />);
    // The LocationBar should be rendered (location-bar-host is the wrapper)
    const host = screen.getByRole('navigation', { hidden: true });
    expect(host).toBeInTheDocument();
  });

  it('shows Recent menu button', () => {
    render(<LocationBarHost />);
    const menuBtn = screen.getByTitle('Recent navigation');
    expect(menuBtn).toBeInTheDocument();
  });

  it('opens Recent menu on click', async () => {
    render(<LocationBarHost />);
    const menuBtn = screen.getByTitle('Recent navigation');
    await userEvent.click(menuBtn);
    // Menu should be visible
    const menuDropdown = screen.getByText('No history');
    expect(menuDropdown).toBeInTheDocument();
  });

  it('closes Recent menu on outside click', async () => {
    const { container } = render(<LocationBarHost />);
    const menuBtn = screen.getByTitle('Recent navigation');
    await userEvent.click(menuBtn);

    // Click outside the menu
    fireEvent.mouseDown(container);

    // Menu should be hidden (would not have text)
    await waitFor(() => {
      expect(screen.queryByText('No history')).not.toBeInTheDocument();
    });
  });

  it('disables back button when canGoBack is false', () => {
    render(<LocationBarHost />);
    const backBtn = screen.getByTitle('Back');
    expect(backBtn).toBeDisabled();
  });

  it('enables back button when canGoBack is true', () => {
    vi.mocked(navHistory).canGoBack.mockReturnValue(true);
    render(<LocationBarHost />);
    const backBtn = screen.getByTitle('Back');
    expect(backBtn).not.toBeDisabled();
  });

  // go()'s own bounds (-99/+99 are no-ops, a valid delta moves and notifies once) are covered
  // directly against a real MemoryHistory in navHistory.test.ts. This test is the Back button's
  // reactivity to canGoBack(), which the UI actually renders from.
  it('Back button disabled state tracks canGoBack() across a rerender', () => {
    vi.mocked(navHistory).entries.mockReturnValue([
      { path: '/', placeKey: 'rosetta-stone', label: 'Rosetta Stone', timestamp: 1000 },
      { path: '/debate', placeKey: 'debate:123', label: 'Debate', timestamp: 2000 },
    ] as any);
    vi.mocked(navHistory).index.mockReturnValue(1);
    vi.mocked(navHistory).canGoBack.mockReturnValue(false);
    vi.mocked(navHistory).canGoForward.mockReturnValue(false);

    const { rerender } = render(<LocationBarHost />);
    const backBtn = screen.getByTitle('Back');
    expect(backBtn).toBeDisabled();

    // When canGoBack becomes true, button enables
    vi.mocked(navHistory).canGoBack.mockReturnValue(true);
    rerender(<LocationBarHost />);
    const backBtnEnabled = screen.getByTitle('Back');
    expect(backBtnEnabled).not.toBeDisabled();
  });

  it('Recent menu: clicking a future entry jumps forward by its delta', async () => {
    vi.mocked(navHistory).entries.mockReturnValue([
      { path: '/', placeKey: 'rosetta-stone', label: 'Rosetta Stone', timestamp: 1000 },
      { path: '/chat', placeKey: 'chat:none', label: 'Chat', timestamp: 2000 },
      { path: '/debate', placeKey: 'debate:123', label: 'Debate', timestamp: 3000 },
    ] as any);
    vi.mocked(navHistory).index.mockReturnValue(0); // at Rosetta Stone, index 0
    vi.mocked(navHistory).canGoBack.mockReturnValue(false);
    vi.mocked(navHistory).canGoForward.mockReturnValue(true);

    render(<LocationBarHost />);
    await userEvent.click(screen.getByTitle('Recent navigation'));
    // "Debate" is entries[2], 2 steps forward of the current index (0).
    await userEvent.click(screen.getByRole('button', { name: 'Debate →' }));

    expect(navHistory.go).toHaveBeenCalledWith(2);
  });

  it('Recent menu: clicking a past entry jumps back by its delta', async () => {
    vi.mocked(navHistory).entries.mockReturnValue([
      { path: '/', placeKey: 'rosetta-stone', label: 'Rosetta Stone', timestamp: 1000 },
      { path: '/chat', placeKey: 'chat:none', label: 'Chat', timestamp: 2000 },
      { path: '/debate', placeKey: 'debate:123', label: 'Debate', timestamp: 3000 },
    ] as any);
    vi.mocked(navHistory).index.mockReturnValue(1); // at Chat, index 1
    vi.mocked(navHistory).canGoBack.mockReturnValue(true);
    vi.mocked(navHistory).canGoForward.mockReturnValue(true);

    render(<LocationBarHost />);
    await userEvent.click(screen.getByTitle('Recent navigation'));
    // "Rosetta Stone" is entries[0], 1 step back of the current index (1).
    await userEvent.click(screen.getByRole('button', { name: '← Rosetta Stone' }));

    expect(navHistory.go).toHaveBeenCalledWith(-1);
  });
});

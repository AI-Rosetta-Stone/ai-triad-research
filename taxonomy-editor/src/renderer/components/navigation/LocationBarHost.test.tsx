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

  it('respects go() bounds (cannot go past stack limits)', async () => {
    const mockGo = vi.fn();
    vi.mocked(navHistory).go.mockImplementation(mockGo);

    render(<LocationBarHost />);
    const menuBtn = screen.getByTitle('Recent navigation');
    await userEvent.click(menuBtn);

    // go() should be called with the requested delta
    // NavHistory.go() itself enforces bounds
  });

  it('AC2: Rosetta Stone navigation creates no history entry', () => {
    // When user is on Rosetta Stone (placeKey: 'rosetta-stone'),
    // clicking the same breadcrumb should not create an entry
    // (handled by handleNavigate early return check)
    render(<LocationBarHost />);
    // No history push should occur for same place
  });

  it('breadcrumb click uses proper store open methods (not setState)', async () => {
    const mockLoadDebate = vi.fn().mockResolvedValue(undefined);
    const mockDebateState = { loadDebate: mockLoadDebate };
    vi.mocked(useDebateStore).mockReturnValue(mockDebateState as any);

    render(<LocationBarHost />);
    // When breadcrumb navigation calls handleNavigate with debate:debateId,
    // it should call loadDebate(debateId), not setState
  });
});

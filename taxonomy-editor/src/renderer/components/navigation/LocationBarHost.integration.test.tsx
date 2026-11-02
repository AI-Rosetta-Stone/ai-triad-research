// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640#31 and § Clickable breadcrumb: "an up-link click goes to the collection and adds exactly
// one history entry; Back afterwards returns to the item" — against the REAL navHistory singleton
// (MemoryHistory in the test env, since VITE_TARGET !== 'web'), the real routes and the real
// installNavSubscriber, not mocks. Kept separate from LocationBarHost.test.tsx, which mocks every
// store/navigation module for its render-only unit tests.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBarHost } from './LocationBarHost';
import { navHistory } from '../../navigation';
import { installNavSubscriber } from '../../navigation/subscriber';
import { restorePath } from '../../navigation/restore';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';

describe('LocationBarHost integration — real MemoryHistory + routes + installNavSubscriber', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    useTaxonomyStore.setState({
      activeTab: 'safetyist',
      selectedNodeId: 'saf-desires-001',
      safetyist: { nodes: [{ id: 'saf-desires-001', label: 'Keep humans in the loop' }] },
    } as never);
    unsubscribe = installNavSubscriber(
      {
        taxonomy: useTaxonomyStore,
        debate: useDebateStore,
        chat: useChatStore,
        opEd: useOpEdStore,
        inquiry: useInquiryStore,
      },
      navHistory,
      restorePath,
    );
  });

  afterEach(() => {
    unsubscribe();
  });

  it('the camp up-link pushes the camp place once, and Back returns to the node', async () => {
    render(<LocationBarHost />);
    expect(screen.getByText('Keep humans in the loop')).toBeInTheDocument();
    const entriesBefore = navHistory.entries().length;

    await userEvent.click(screen.getByRole('link', { name: 'Safetyist' }));

    expect(useTaxonomyStore.getState().selectedNodeId).toBeNull();
    expect(navHistory.entries()).toHaveLength(entriesBefore + 1);
    expect(navHistory.current()).toMatchObject({ path: '/taxonomy/saf', placeKey: 'taxonomy:none', label: 'Taxonomy: Safetyist' });

    await userEvent.click(screen.getByRole('button', { name: 'Back to Taxonomy: Keep humans in the loop' }));
    act(() => {}); // flush the restore's store updates into the bar

    expect(useTaxonomyStore.getState().selectedNodeId).toBe('saf-desires-001');
    expect(navHistory.current()?.placeKey).toBe('taxonomy:saf-desires-001');
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByText('Keep humans in the loop')).toBeInTheDocument();
    // § Announcements: the live region names the place after Back.
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Keep humans in the loop');
  });
});

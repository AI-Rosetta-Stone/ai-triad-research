// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640#31 and § Clickable breadcrumb: "an up-link click goes to the collection and adds exactly
// one history entry; Back afterwards returns to the item" — against the REAL navHistory singleton
// (MemoryHistory in the test env, since VITE_TARGET !== 'web'), the real routes and the real
// installNavSubscriber, not mocks. Kept separate from LocationBarHost.test.tsx, which mocks every
// store/navigation module for its render-only unit tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const mockLoadCommunityInquiry = vi.fn().mockResolvedValue({ request: { question: 'What counts as an AI harm?' } });
vi.mock('@bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bridge')>();
  return { ...actual, api: { ...actual.api, loadCommunityInquiry: (...args: unknown[]) => mockLoadCommunityInquiry(...args) } };
});

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
    // § Announcements: the live region names the place after Back. Scoped to .nav-locbar-live
    // (t/4786: the node is a POV node, so LocationBarShareButton also renders its own
    // aria-live region for copy feedback — a generic [aria-live] query would hit either one).
    expect(document.querySelector('.nav-locbar-live')).toHaveTextContent('Keep humans in the loop');
  });

  // t/4888 (Design review, prod regression, t/4888#6): Design found the up-crumb for a Community
  // op-ed showing only "Op-Ed Studies" with no item crumb and no up-link at all — a stale
  // useCallback closure in OpEdTab meant the item's title never reached the store. This drives
  // the REAL click (not a placeOf()-only assertion, which is how the regression got through).
  it('Op-Ed: a Community set gets a clickable up-crumb, and up goes to the library', async () => {
    render(<LocationBarHost />);

    act(() => {
      useTaxonomyStore.getState().setActiveTab('opeds');
      useOpEdStore.getState().selectSet('op-1', { title: 'A Shared Op-Ed', community: true });
    });
    expect(navHistory.current()).toMatchObject({ path: '/opeds/op-1?community=1', placeKey: 'opeds:op-1' });
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('A Shared Op-Ed')).toBeInTheDocument();
    const entriesAtItem = navHistory.entries().length;

    await userEvent.click(screen.getByRole('link', { name: 'Op-Ed Studies' }));

    expect(useOpEdStore.getState().selectedSetId).toBeNull();
    expect(navHistory.entries()).toHaveLength(entriesAtItem + 1);
    expect(navHistory.current()).toMatchObject({ path: '/opeds', placeKey: 'opeds:none' });
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).queryByText('A Shared Op-Ed')).toBeNull();
  });

  // t/4888 (Design review, prod regression, t/4888#6): Design found Ask a Question's up-crumb
  // click showing the list (correct tab) but leaving the URL on the item, then Back landing on
  // /inquiry while the breadcrumb still named the item — URL and view out of sync. Root cause:
  // openList() deliberately leaves `result` set (a My job must keep running in the background
  // while the user browses the list), so placeOf.ts needed to check `viewingList` too, not just
  // `result`. Drives the real click and Back, asserting both the URL and the breadcrumb.
  it('Ask a Question: up goes to the list (URL and breadcrumb in sync), and Back reopens the answer', async () => {
    render(<LocationBarHost />);

    act(() => {
      useTaxonomyStore.getState().setActiveTab('inquiry');
      useInquiryStore.setState({
        jobId: null, communityResultId: 'c-1', viewingList: false,
        result: { request: { question: 'What counts as an AI harm?' } },
      } as never);
    });
    expect(navHistory.current()).toMatchObject({ path: '/inquiry/c-1?community=1', placeKey: 'inquiry:c-1' });

    await userEvent.click(screen.getByRole('link', { name: 'Ask a Question' }));

    expect(useInquiryStore.getState().viewingList).toBe(true);
    expect(navHistory.current()).toMatchObject({ path: '/inquiry', placeKey: 'inquiry:none' });
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).queryByText('What counts as an AI harm?')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Back to Ask a Question: What counts as an AI harm?' }));
    await act(async () => { await Promise.resolve(); }); // flush openCommunityResult's api.loadCommunityInquiry()

    expect(mockLoadCommunityInquiry).toHaveBeenCalledWith('c-1');
    expect(navHistory.current()).toMatchObject({ path: '/inquiry/c-1?community=1', placeKey: 'inquiry:c-1' });
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('What counts as an AI harm?')).toBeInTheDocument();
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640#31: "a crumb click calls the tool's open action and leads to exactly one history
// entry, with the subscriber installed" — against the REAL navHistory singleton (MemoryHistory
// in the test env, since VITE_TARGET !== 'web') and the real installNavSubscriber, not mocks.
// Kept separate from LocationBarHost.test.tsx, which mocks every store/navigation module for
// its render-only unit tests — mixing a real subscriber into that file would make the other
// tests' store mocks ambiguous about whether they're "wired" or not.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationBarHost } from './LocationBarHost';
import { navHistory } from '../../navigation';
import { installNavSubscriber } from '../../navigation/subscriber';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useChatStore } from '../../hooks/useChatStore';
import { useOpEdStore } from '../../hooks/useOpEdStore';
import { useInquiryStore } from '../../hooks/useInquiryStore';

describe('LocationBarHost integration — real MemoryHistory + installNavSubscriber (t/4640#31)', () => {
  let unsubscribe: () => void;

  beforeEach(() => {
    useTaxonomyStore.setState({ activeTab: 'rosetta-stone', selectedNodeId: null } as never);
    unsubscribe = installNavSubscriber(
      {
        taxonomy: useTaxonomyStore,
        debate: useDebateStore,
        chat: useChatStore,
        opEd: useOpEdStore,
        inquiry: useInquiryStore,
      },
      navHistory,
    );
  });

  afterEach(() => {
    unsubscribe();
  });

  it('a breadcrumb click calls the open action and adds exactly one history entry', async () => {
    // On Debate with an item open, so the breadcrumb chain is [Rosetta Stone, Debate, <topic>]
    // and "Rosetta Stone" is an earlier, clickable crumb.
    useTaxonomyStore.setState({ activeTab: 'debate' } as never);
    useDebateStore.setState({
      activeDebate: { id: 'd1', topic: { original: 'Topic', final: null } },
    } as never);

    const entriesBefore = navHistory.entries().length;

    render(<LocationBarHost />);
    const crumb = screen.getByRole('button', { name: 'Rosetta Stone' });
    await userEvent.click(crumb);

    expect(useTaxonomyStore.getState().activeTab).toBe('rosetta-stone');
    expect(navHistory.entries()).toHaveLength(entriesBefore + 1);
    expect(navHistory.current()?.placeKey).toBe('rosetta-stone');
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4888 (Design review, prod regression, t/4888#6): Design found Op-Ed's breadcrumb showing
// only "Op-Ed Studies" with no item crumb and no up-link on a Community set, even though the
// reader was open. Root cause: openCommunity's useCallback deps omitted `communityOpeds`, so the
// closure stayed pinned to the EMPTY array from first render (before fetchOpeds() resolves) —
// selectSet's title meta was always undefined, and placeOf.ts's collectionPlace drops the item
// crumb entirely when title is falsy. Mirrors ChatTab.inPlaceOpen.test.tsx / DebateTab's own
// community-open regression tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useEffect, useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('@bridge', () => ({
  api: { loadOpEdSet: vi.fn(), loadCommunityOpEd: vi.fn().mockResolvedValue({ set_id: 'set-x' }), listOpEdSets: vi.fn() },
  isElectronMode: () => false,
}));
vi.mock('../../navigation', () => ({ replaceCurrentView: vi.fn() }));
vi.mock('./OpEdCampTags', () => ({ OpEdCampTags: () => null }));
vi.mock('./OpEdReader', () => ({ OpEdReader: () => <div data-testid="oped-reader" /> }));
vi.mock('./NewOpEdDialog', () => ({ NewOpEdDialog: () => null }));
vi.mock('./OpEdGettingStarted', () => ({ OpEdGettingStarted: () => null }));

let opEdStoreState: Record<string, unknown>;
vi.mock('../../hooks/useOpEdStore', () => ({
  useOpEdStore: (selector: (s: Record<string, unknown>) => unknown) => selector(opEdStoreState),
}));

let communityOpedsState: Array<{ id: string; topic: string }>;
// A real useState/useEffect, not a static object — starts EMPTY like the real store before
// fetchOpeds() resolves, then updates on a later tick. This is the exact timing window t/4888's
// stale closure missed: openCommunity's useCallback must have `communityOpeds` in its deps to
// pick up this update, or it keeps using the function reference captured from the empty render.
vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const [opeds, setOpeds] = useState<Array<{ id: string; topic: string }>>([]);
    useEffect(() => { void Promise.resolve().then(() => setOpeds(communityOpedsState)); }, []);
    return selector({ opeds, communityLoading: false, fetchOpeds: vi.fn().mockResolvedValue(undefined), submitItem: vi.fn(), copyItem: vi.fn() });
  },
}));

// A minimal stand-in exposing exactly what OpEdTab wires to it, mirroring
// DebateTab.inPlaceOpen.test.tsx / ChatTab.inPlaceOpen.test.tsx's own LibraryListPage stubs.
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ communityRows, onOpenCommunity }: {
    communityRows?: { id: string }[]; onOpenCommunity?: (id: string) => void;
  }) => (
    <div data-testid="library-list-page">
      {(communityRows ?? []).map(row => (
        <button key={row.id} data-testid={`community-row-${row.id}`} onClick={() => onOpenCommunity?.(row.id)}>
          {row.id}
        </button>
      ))}
    </div>
  ),
}));

import { OpEdTab } from './OpEdTab';

describe('OpEdTab — opening a Community set carries its title into selectSet (t/4888)', () => {
  const selectSet = vi.fn();

  beforeEach(() => {
    opEdStoreState = {
      sets: [], loading: false, editMode: false, selectedIds: new Set<string>(), selectedSetId: null,
      pendingOpen: null,
      loadSets: vi.fn().mockResolvedValue(undefined), selectSet, renameSet: vi.fn(),
      setEditMode: vi.fn(), toggleSelected: vi.fn(), clearSelected: vi.fn(), deleteSelected: vi.fn(),
      clearPendingOpen: vi.fn(),
    };
    // Populated from the first render, same as the real useCommunityStore before t/4888's fix —
    // this is exactly the state the stale closure used to capture permanently.
    communityOpedsState = [{ id: 'op-1', topic: 'A Shared Op-Ed' }];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('passes the real title and community:true, not an undefined title from a stale closure', async () => {
    render(<OpEdTab />);
    // The row only exists once communityOpeds has updated past its initial empty render —
    // by this point a stale (deps-missing) openCommunity closure would still be bound to [].
    await waitFor(() => screen.getByTestId('community-row-op-1'));
    fireEvent.click(screen.getByTestId('community-row-op-1'));

    expect(selectSet).toHaveBeenCalledWith('op-1', { title: 'A Shared Op-Ed', community: true });
  });
});

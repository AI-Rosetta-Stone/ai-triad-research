// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression test (t/3705#7 gap 1, p/501#22-25): anonymous sessions have real, server-persisted
// debates (debateStore.ts routes list/load/save/delete through anonymousSessionStore for
// isAnonymousUser()), so the My tab and "+ New Debate" must stay visible for anonymous users.
// Both were previously gated on `!auth?.anonymous` — a real, invisible-until-tested bug (TL,
// p/501#25: "a visibility bug that was invisible for however long will go invisible again
// without a test pinning it").

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

let mockAuth: { anonymous?: boolean } | null = { anonymous: true };

// t/4643: LibraryListPage (which DebateTab renders through) now also calls useUserProfile via
// useIsAdmin — not under test here, so a stub returning null (fails closed, matches no-profile).
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => mockAuth, useUserProfile: () => null }));

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: (selector: (s: Record<string, unknown>) => unknown) => selector({
    sessions: [],
    sessionsLoading: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    activeDebateId: null,
    activeDebate: null,
    loadDebate: vi.fn(),
    deleteDebate: vi.fn(),
    renameDebate: vi.fn(),
  }),
}));

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({
    debates: [],
    loading: false,
    fetchDebates: vi.fn().mockResolvedValue(undefined),
    copyItem: vi.fn(),
  }),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => ({ toolbarPanel: null }) }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: vi.fn(),
    openDebateWindow: vi.fn(),
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: vi.fn(),
    submitToCommunity: vi.fn(),
    exportDebateToFile: vi.fn(),
    openExternal: vi.fn(),
  },
  isElectronMode: () => false,
}));

vi.mock('./NewDebateDialog', () => ({ NewDebateDialog: () => null }));
vi.mock('../debate-workspace', () => ({ DebateWorkspace: () => null }));
vi.mock('../shared/TheoryLink', () => ({ TheoryLink: () => null }));
vi.mock('../edge-browser/SearchPreview', () => ({ SearchPreview: () => null }));
vi.mock('../chat/PromptsPanel', () => ({ PromptDetailPanel: () => null }));
vi.mock('../shared/ToolbarPaneRenderer', () => ({
  ToolbarPaneRenderer: () => null,
  isFullWidthPanel: () => false,
  PhoneToolClose: () => null,
}));
vi.mock('../shared/LineageDetailView', () => ({ LineageDetailView: () => null }));
vi.mock('../analysis/ParameterHistoryPanel', () => ({ ParameterHistoryPanel: () => null }));

import { DebateTab } from './DebateTab';

describe('DebateTab — anonymous session sees real My content (t/3705#7 gap 1)', () => {
  it('shows the My tab for an anonymous session', () => {
    mockAuth = { anonymous: true };
    render(<DebateTab />);
    expect(screen.getByRole('tab', { name: /^My/ })).toBeInTheDocument();
  });

  it('shows "+ New Debate" for an anonymous session', () => {
    mockAuth = { anonymous: true };
    render(<DebateTab />);
    expect(screen.getByRole('button', { name: '+ New Debate' })).toBeInTheDocument();
  });

  it('still shows both for a non-anonymous session (no regression the other direction)', () => {
    mockAuth = { anonymous: false };
    render(<DebateTab />);
    expect(screen.getByRole('tab', { name: /^My/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ New Debate' })).toBeInTheDocument();
  });
});

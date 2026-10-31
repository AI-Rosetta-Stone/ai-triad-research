// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4672 (PI): on mobile, tapping a community debate used to show an interstitial requiring a
// manual "Open in Window" tap instead of navigating straight to the debate view. Mirrors the
// mock scaffold proven in DebateTab.anon.test.tsx / DebateTab.gettingStarted.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => 'phone' }));

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

const COMMUNITY_DEBATE = { id: 'cd-1', title: 'A community debate', created_at: '2026-01-01', updated_at: '2026-01-01' };

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({
    debates: [COMMUNITY_DEBATE],
    loading: false,
    fetchDebates: vi.fn().mockResolvedValue(undefined),
    copyItem: vi.fn(),
  }),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => ({ toolbarPanel: null }) }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const mockLoadCommunityDebateSession = vi.hoisted(() => vi.fn().mockResolvedValue({ found: false }));
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: vi.fn(),
    openDebateWindow: vi.fn(),
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: mockLoadCommunityDebateSession,
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

async function selectTheCommunityDebate() {
  const user = userEvent.setup();
  render(<DebateTab />);
  await user.click(screen.getByRole('tab', { name: /^Community/ }));
  // useBreakpoint is mocked to 'phone', so LibraryListPage renders its phone list (one layout in
  // the DOM at a time, t/4571), not the desktop table.
  const list = screen.getByRole('list');
  const row = within(list).getAllByRole('listitem').find(li => /A community debate/.test(li.textContent ?? ''));
  expect(row).toBeDefined();
  await user.click(row!);
}

describe('DebateTab — mobile tapping a community debate (t/4672)', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    window.location.hash = '';
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
  });

  it('on a mobile user agent, navigates straight to the debate view — no "Open in Window" tap needed', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      configurable: true,
    });

    await selectTheCommunityDebate();

    expect(window.location.hash).toBe(`#debate-window?id=${COMMUNITY_DEBATE.id}&source=community`);
  });

  it('on a desktop user agent, still shows the manual "Open in Window" button and does not auto-navigate', async () => {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      configurable: true,
    });

    await selectTheCommunityDebate();

    expect(window.location.hash).toBe('');
    expect(screen.getByRole('button', { name: 'Open in Window' })).toBeInTheDocument();
  });
});

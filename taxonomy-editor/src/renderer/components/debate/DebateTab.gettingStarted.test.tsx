// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4563: the getting-started chip's prefill reaches NewDebateDialog, and the existing quota
// pre-check (handleNewDebate's prior behavior, now shared via checkDebateQuota) still gates the
// chip path too — a quota-exceeded click must not open the dialog. Mirrors the mock scaffold
// already proven to mount DebateTab in DebateTab.anon.test.tsx.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

// t/4643: LibraryListPage (which DebateTab renders through) now also calls useUserProfile via
// useIsAdmin — not under test here, so a stub returning null (fails closed, matches no-profile).
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));

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

const mockGetDebateQuotaStatus = vi.hoisted(() => vi.fn());
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: mockGetDebateQuotaStatus,
    openDebateWindow: vi.fn(),
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: vi.fn(),
    submitToCommunity: vi.fn(),
    exportDebateToFile: vi.fn(),
    openExternal: vi.fn(),
  },
  isElectronMode: () => false,
}));

const mockNewDebateDialog = vi.hoisted(() => vi.fn(() => null));
vi.mock('./NewDebateDialog', () => ({ NewDebateDialog: (props: unknown) => mockNewDebateDialog(props) }));
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

const PAIRING_CHIP = /Accelerationist vs Safetyist/;

describe('DebateTab — getting-started chip prefill reaches NewDebateDialog (t/4563)', () => {
  beforeEach(() => {
    mockGetDebateQuotaStatus.mockReset();
    mockNewDebateDialog.mockClear();
  });

  it('a camp-pairing chip opens NewDebateDialog prefilled with the topic and povers', async () => {
    mockGetDebateQuotaStatus.mockResolvedValue({ allowed: true, current: 0, limit: 5 });
    render(<DebateTab />);
    fireEvent.click(screen.getByRole('button', { name: PAIRING_CHIP }));

    await vi.waitFor(() => expect(mockNewDebateDialog).toHaveBeenCalled());
    const props = mockNewDebateDialog.mock.calls.at(-1)?.[0] as { initialTopic?: string; initialPovers?: string[] };
    expect(props.initialTopic).toBe('Should AI labs self-regulate, or face binding government rules?');
    expect(props.initialPovers).toEqual(['accelerationist', 'safetyist']);
  });

  it('a quota-exceeded chip click does not open NewDebateDialog, and surfaces the quota error', async () => {
    mockGetDebateQuotaStatus.mockResolvedValue({ allowed: false, current: 5, limit: 5 });
    render(<DebateTab />);
    fireEvent.click(screen.getByRole('button', { name: PAIRING_CHIP }));

    expect(await screen.findByText(/Debate limit reached \(5\/5\)/)).toBeInTheDocument();
    expect(mockNewDebateDialog).not.toHaveBeenCalled();
  });
});

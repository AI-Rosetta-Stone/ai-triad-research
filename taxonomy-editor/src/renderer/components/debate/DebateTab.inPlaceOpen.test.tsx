// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4691: table mode's row click now opens a debate in place (loadDebate), not a popout window
// (api.openDebateWindow). Ctrl/Cmd/middle-click and the ⧉ button still go through
// LibraryListPage's own openPlaceInNewWindow — that's t/4689's wiring, already covered by its own
// tests; here we only confirm DebateTab doesn't intercept or duplicate it. Also covers the
// detail-vs-library branch and the one-time first-open hint. Mirrors ChatTab.inPlaceOpen.test.tsx
// (t/4690) and the mock scaffold already proven to mount DebateTab in DebateTab.anon.test.tsx.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

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

vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));

let debateStoreState: Record<string, unknown>;
const mockLoadDebate = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(debateStoreState),
    { getState: () => debateStoreState },
  ),
}));

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({ debates: [], loading: false, fetchDebates: vi.fn().mockResolvedValue(undefined), copyItem: vi.fn() }),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => ({ toolbarPanel: null }) }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('../../store/preferencesStore', () => ({ usePreferencesStore: () => 'full' }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const mockOpenDebateWindow = vi.hoisted(() => vi.fn().mockResolvedValue({ atCap: false }));
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 5 }),
    openDebateWindow: mockOpenDebateWindow,
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: vi.fn(),
    submitToCommunity: vi.fn(),
    exportDebateToFile: vi.fn(),
    openExternal: vi.fn(),
  },
  isElectronMode: () => false,
}));

vi.mock('./NewDebateDialog', () => ({ NewDebateDialog: () => null }));
vi.mock('../debate-workspace', () => ({ DebateWorkspace: ({ onExport }: { onExport?: (format?: string) => void; exportStatus?: string | null }) => <div data-testid="debate-workspace">Debate Workspace</div> }));
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
vi.mock('./DebateBriefExports', () => ({
  useDebateBriefExports: () => ({ openBrief: vi.fn(), node: null }),
  useRowBriefExport: () => ({ openRowBrief: vi.fn(), rowBriefNode: null }),
}));
vi.mock('./ExportDropdown', () => ({ ExportDropdown: () => null }));

import { DebateTab } from './DebateTab';
import { DEBATE_IN_PLACE_HINT_STORAGE_KEY } from './DebateInPlaceHint';

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'debate-1',
    title: 'Test Debate',
    phase: 'debate',
    turn_count: 3,
    model: 'gemini-flash-lite-latest',
    updated_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    topic: { original: 'AI governance', refined: null, final: 'AI governance' },
    active_povers: ['accelerationist', 'safetyist'],
    source_type: 'topic',
    transcript: [],
    ...overrides,
  };
}

describe('DebateTab — table mode in-place open (t/4691)', () => {
  beforeEach(() => {
    debateStoreState = {
      sessions: [makeSession()],
      sessionsLoading: false,
      loadSessions: vi.fn().mockResolvedValue(undefined),
      activeDebateId: null,
      activeDebate: null,
      loadDebate: mockLoadDebate,
      deleteDebate: vi.fn(),
      renameDebate: vi.fn(),
    };
    try { localStorage.clear(); } catch { /* jsdom always has localStorage in this suite */ }
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('clicking a my-row calls loadDebate, not api.openDebateWindow', () => {
    render(<DebateTab />);
    fireEvent.click(screen.getByText('Test Debate'));

    expect(mockLoadDebate).toHaveBeenCalledWith('debate-1');
    expect(mockOpenDebateWindow).not.toHaveBeenCalled();
  });

  it('renders the debate workspace in place (not the library) once activeDebate is set (t/4799)', () => {
    debateStoreState.activeDebateId = 'debate-1';
    debateStoreState.activeDebate = makeSession();
    render(<DebateTab />);

    expect(screen.getByTestId('debate-workspace')).toBeInTheDocument();
    expect(screen.queryByText('+ New Debate')).toBeNull();
  });

  it('does not render the summary card on desktop (t/4799)', () => {
    debateStoreState.activeDebateId = 'debate-1';
    debateStoreState.activeDebate = makeSession();
    render(<DebateTab />);

    expect(screen.queryByRole('button', { name: 'Open in Window' })).toBeNull();
  });

  it('shows the first-open hint once, and never again after it is dismissed', () => {
    debateStoreState.activeDebateId = 'debate-1';
    debateStoreState.activeDebate = makeSession();
    const { unmount } = render(<DebateTab />);
    expect(screen.getByText(/Opens here now/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(localStorage.getItem(DEBATE_IN_PLACE_HINT_STORAGE_KEY)).toBe('ack');
    unmount();

    render(<DebateTab />);
    expect(screen.queryByText(/Opens here now/)).toBeNull();
  });

  it('returns to the library when activeDebate is cleared (t/4800)', () => {
    debateStoreState.activeDebateId = 'debate-1';
    debateStoreState.activeDebate = makeSession();
    const { rerender } = render(<DebateTab />);
    expect(screen.getByTestId('debate-workspace')).toBeInTheDocument();

    // Simulate Back navigation: store clears activeDebate
    debateStoreState.activeDebateId = null;
    debateStoreState.activeDebate = null;
    rerender(<DebateTab />);

    // Library should now be visible
    expect(screen.queryByTestId('debate-workspace')).toBeNull();
    expect(screen.getByText('+ New Debate')).toBeInTheDocument();
  });
});

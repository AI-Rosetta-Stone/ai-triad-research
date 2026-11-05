// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4899: a Community debate opens in place as a read-only workspace (no "Open in Window"
// interstitial). Design's required fixes (review at 2960b996) are pinned here:
//   1. opening it must not replace the reader's own RUNNING debate (it would discard the run's output);
//   2. Export is wired to the real export, never a no-op;
//   3. the community attribution line is shown.
// Scaffold mirrors DebateTab.communityMobile.test.tsx; the debate store is a real zustand store so
// loadDebateFromData -> re-render behaves like the app.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { registerRun, __resetRunningSignalForTest } from '../../navigation/runningSignal';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});

vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => 'phone' }));

const OWN_DEBATE = { id: 'own-1', title: 'My running debate', transcript: [] };
const COMMUNITY_SESSION = { id: 'cd-1', title: 'A community debate', transcript: [], phase: 'closed' };

vi.mock('../../hooks/useDebateStore', async () => {
  const { create } = await import('zustand');
  const store = create<Record<string, unknown>>(() => ({}));
  const reset = () => store.setState({
    sessions: [],
    sessionsLoading: false,
    loadSessions: vi.fn().mockResolvedValue(undefined),
    activeDebateId: null,
    activeDebate: null,
    debateGenerating: null,
    communityReadOnly: false,
    loadDebate: vi.fn(),
    deleteDebate: vi.fn(),
    renameDebate: vi.fn(),
    setActiveCommunityDebate: vi.fn(), // t/4888 (#4587): DebateTab publishes the open community debate for placeOf
    loadDebateFromData: vi.fn((raw: { id: string }) => store.setState({ activeDebate: raw, activeDebateId: raw.id, communityReadOnly: true })),
  }, true);
  reset();
  return { useDebateStore: Object.assign(store, { __reset: reset }) };
});
import { useDebateStore } from '../../hooks/useDebateStore';
const debateStore = useDebateStore as unknown as {
  setState: (s: Record<string, unknown>) => void;
  getState: () => Record<string, unknown>;
  __reset: () => void;
};

const COMMUNITY_DEBATE = {
  id: 'cd-1', title: 'A community debate', created_at: '2026-01-01', updated_at: '2026-01-01',
  community_metadata: { submitted_by_display: 'Ada', submitted_at: '2026-10-28T15:25:00Z', approved_at: '2026-10-28T15:25:00Z', original_id: 'x' },
};

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({ debates: [COMMUNITY_DEBATE], loading: false, fetchDebates: vi.fn().mockResolvedValue(undefined), copyItem: vi.fn() }),
}));
vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => ({ toolbarPanel: null }) }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => null }));

const bridge = vi.hoisted(() => ({
  loadCommunityDebateSession: vi.fn(),
  exportDebateToFile: vi.fn().mockResolvedValue({ cancelled: false, filePath: '/tmp/x.json' }),
}));
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: vi.fn(),
    openDebateWindow: vi.fn(),
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: bridge.loadCommunityDebateSession,
    submitToCommunity: vi.fn(),
    exportDebateToFile: bridge.exportDebateToFile,
    openExternal: vi.fn(),
  },
  isElectronMode: () => false,
}));

vi.mock('./NewDebateDialog', () => ({ NewDebateDialog: () => null }));
vi.mock('../debate-workspace', () => ({
  DebateWorkspace: ({ onExport }: { onExport: (f?: string) => void }) => (
    <div data-testid="workspace"><button type="button" onClick={() => onExport('json')}>Export</button></div>
  ),
}));
vi.mock('../shared/TheoryLink', () => ({ TheoryLink: () => null }));
vi.mock('../edge-browser/SearchPreview', () => ({ SearchPreview: () => null }));
vi.mock('../chat/PromptsPanel', () => ({ PromptDetailPanel: () => null }));
vi.mock('../shared/ToolbarPaneRenderer', () => ({ ToolbarPaneRenderer: () => null, isFullWidthPanel: () => false, PhoneToolClose: () => null }));
vi.mock('../shared/LineageDetailView', () => ({ LineageDetailView: () => null }));
vi.mock('../analysis/ParameterHistoryPanel', () => ({ ParameterHistoryPanel: () => null }));

import { DebateTab } from './DebateTab';

async function openTheCommunityDebate() {
  const user = userEvent.setup();
  render(<DebateTab />);
  await user.click(screen.getByRole('tab', { name: /^Community/ }));
  const row = within(screen.getByRole('list')).getAllByRole('listitem').find(li => /A community debate/.test(li.textContent ?? ''));
  await user.click(row!);
  return user;
}

describe('DebateTab — Community debate opens in place, read-only (t/4899)', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    window.location.hash = '';
    debateStore.__reset();
    __resetRunningSignalForTest();
    bridge.loadCommunityDebateSession.mockReset().mockResolvedValue(COMMUNITY_SESSION);
    bridge.exportDebateToFile.mockClear();
    // Desktop UA: the in-place path (mobile navigates to the popout hash, covered in communityMobile).
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: originalUserAgent, configurable: true });
    __resetRunningSignalForTest();
  });

  it('renders the workspace in place with no "Open in Window" interstitial', async () => {
    await openTheCommunityDebate();
    expect(await screen.findByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Window' })).not.toBeInTheDocument();
    expect(debateStore.getState().loadDebateFromData).toHaveBeenCalledWith(COMMUNITY_SESSION, { readOnly: true });
  });

  it('shows the community attribution line (Design #3)', async () => {
    await openTheCommunityDebate();
    const line = await screen.findByText(/Community debate/);
    expect(line.textContent).toMatch(/shared by Ada/);
    expect(line.textContent).toMatch(/read-only/);
  });

  it('Export calls the real export with the loaded community debate, not a no-op (Design #2)', async () => {
    const user = await openTheCommunityDebate();
    await user.click(await screen.findByRole('button', { name: 'Export' }));
    expect(bridge.exportDebateToFile).toHaveBeenCalledWith(COMMUNITY_SESSION, 'json', undefined);
  });

  it('does NOT replace the reader\'s own running debate, and opens once the run ends (Design #1)', async () => {
    debateStore.setState({ activeDebate: OWN_DEBATE, activeDebateId: OWN_DEBATE.id });
    let finish!: (o: 'done') => void;
    act(() => { finish = registerRun('debate', OWN_DEBATE.id, OWN_DEBATE.title); });

    await openTheCommunityDebate();

    expect(await screen.findByText(/Your debate is still running/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in a new window now' })).toBeInTheDocument();
    expect(bridge.loadCommunityDebateSession).not.toHaveBeenCalled();
    expect(debateStore.getState().loadDebateFromData).not.toHaveBeenCalled();
    expect(debateStore.getState().activeDebateId).toBe(OWN_DEBATE.id);

    act(() => finish('done'));
    expect(await screen.findByTestId('workspace')).toBeInTheDocument();
    expect(debateStore.getState().activeDebateId).toBe(COMMUNITY_SESSION.id);
  });

  it('also holds off while one of the reader\'s own debate steps is generating outside a leased run', async () => {
    debateStore.setState({ activeDebate: OWN_DEBATE, activeDebateId: OWN_DEBATE.id, debateGenerating: 'system', communityReadOnly: false });
    await openTheCommunityDebate();
    expect(await screen.findByText(/Your debate is still running/)).toBeInTheDocument();
    expect(debateStore.getState().loadDebateFromData).not.toHaveBeenCalled();
  });
});

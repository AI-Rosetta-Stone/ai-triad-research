// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4690: table mode's row click now opens a chat in place (loadChat), not a popout window
// (api.openChatWindow). Ctrl/Cmd/middle-click and the ⧉ button still go through LibraryListPage's
// own openPlaceInNewWindow — that's t/4689's wiring, already covered by its own tests; here we
// only confirm ChatTab doesn't intercept or duplicate it. Also covers the detail-vs-library branch
// and the one-time first-open hint.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    openChatWindow: vi.fn().mockResolvedValue(undefined),
    loadChatSession: vi.fn(),
    loadCommunityChatSession: vi.fn().mockResolvedValue({ found: false }),
    exportChatToFile: vi.fn(),
    submitToCommunity: vi.fn(),
  },
}));

vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => false }));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

let loadChatMock: ReturnType<typeof vi.fn>;
let chatStoreState: Record<string, unknown>;

vi.mock('../../hooks/useChatStore', () => ({
  useChatStore: Object.assign(() => chatStoreState, {
    getState: () => chatStoreState,
    setState: (partial: Record<string, unknown>) => Object.assign(chatStoreState, partial),
  }),
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(() => ({ toolbarPanel: null }), {
    getState: () => ({ toolbarPanel: null }),
  }),
  MODELS_BY_BACKEND: { gemini: [{ value: 'gemini-flash-lite-latest', label: 'Flash Lite' }] },
  getStoredModel: () => 'gemini-flash-lite-latest',
  backendForModel: () => 'gemini',
}));

vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: Object.assign(
    () => ({ chats: [], loading: false, fetchChats: vi.fn(), copyItem: vi.fn() }),
    { getState: () => ({ chats: [], loading: false, fetchChats: vi.fn(), copyItem: vi.fn() }) },
  ),
}));

// Stubs for the heavy real children not under test here — ChatWorkspace's own behavior is
// covered by its own test files; this test only cares whether ChatTab renders it vs. the library.
vi.mock('./ChatWorkspace', () => ({ ChatWorkspace: () => <div data-testid="chat-workspace" /> }));
vi.mock('./NewChatDialog', () => ({ NewChatDialog: () => null }));
vi.mock('./ChatGettingStarted', () => ({ ChatGettingStarted: () => null }));

vi.mock('../shared/LibraryListPage', () => ({
  // A minimal stand-in that exposes exactly what ChatTab wires to it — enough to assert the
  // in-place-vs-popout handler choice without re-testing LibraryListPage's own click semantics.
  LibraryListPage: ({ myRows, onOpenMy }: { myRows: { id: string }[]; onOpenMy: (id: string) => void }) => (
    <div data-testid="library-list-page">
      {myRows.map(row => (
        <button key={row.id} data-testid={`row-${row.id}`} onClick={() => onOpenMy(row.id)}>
          {row.id}
        </button>
      ))}
    </div>
  ),
}));

import { ChatTab } from './ChatTab';
import { CHAT_IN_PLACE_HINT_STORAGE_KEY } from './ChatTab';

describe('ChatTab — table mode in-place open (t/4690)', () => {
  beforeEach(() => {
    loadChatMock = vi.fn().mockResolvedValue(undefined);
    chatStoreState = {
      sessions: [{ id: 'chat-1', title: 'My Chat', mode: 'brainstorm', updated_at: '2026-01-01T00:00:00Z' }],
      sessionsLoading: false,
      loadSessions: vi.fn().mockResolvedValue(undefined),
      activeChatId: null,
      loadChat: loadChatMock,
      deleteChat: vi.fn(),
      renameChat: vi.fn(),
      chatGenerating: false,
      chatActivity: null,
      chatError: null,
      chatLoading: false,
    };
    try { localStorage.clear(); } catch { /* jsdom always has localStorage in this suite */ }
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('clicking a my-row calls loadChat, not api.openChatWindow', () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('row-chat-1'));

    expect(loadChatMock).toHaveBeenCalledWith('chat-1');
    expect(mockApi.openChatWindow).not.toHaveBeenCalled();
  });

  it('renders ChatWorkspace in place (not the library) once activeChatId is set', () => {
    chatStoreState.activeChatId = 'chat-1';
    render(<ChatTab />);

    expect(screen.getByTestId('chat-workspace')).toBeTruthy();
    expect(screen.queryByTestId('library-list-page')).toBeNull();
  });

  it('shows the first-open hint once, and never again after it is acknowledged', () => {
    chatStoreState.activeChatId = 'chat-1';
    const { unmount } = render(<ChatTab />);
    expect(screen.getByText(/Opens here now/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(localStorage.getItem(CHAT_IN_PLACE_HINT_STORAGE_KEY)).toBe('ack');
    unmount();

    render(<ChatTab />);
    expect(screen.queryByText(/Opens here now/)).toBeNull();
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4896: table-view edit mode (select + bulk delete), My rows only. Mocks LibraryListPage just
// enough to drive config.showEdit/config.editMode — same convention as ChatTab.inPlaceOpen's own
// mock, extended to expose the edit-mode surface that test doesn't touch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LibraryListPageConfig } from '../shared/LibraryListPage.types';

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

let deleteChatMock: ReturnType<typeof vi.fn>;
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

vi.mock('./ChatWorkspace', () => ({ ChatWorkspace: () => <div data-testid="chat-workspace" /> }));
vi.mock('./NewChatDialog', () => ({ NewChatDialog: () => null }));
vi.mock('./ChatGettingStarted', () => ({ ChatGettingStarted: () => null }));

type MyRow = { id: string };

vi.mock('../shared/LibraryListPage', () => ({
  // Exposes config.showEdit/config.editMode so these tests can drive edit mode, enter/select/
  // bulk-delete, without re-testing LibraryListPage's own rendering (covered by its own suite).
  LibraryListPage: ({ config, myRows }: { config: LibraryListPageConfig<MyRow, MyRow>; myRows: MyRow[] }) => (
    <div data-testid="library-list-page">
      <div data-testid="show-edit">{String(!!config.showEdit)}</div>
      {config.showEdit && (
        <button data-testid="enter-edit-mode" onClick={config.editMode?.onEnter}>Edit</button>
      )}
      {config.editMode?.active && (
        <div data-testid="edit-mode-bar">
          {config.editMode.actions.map(a => (
            <button key={a.label} data-testid={`action-${a.label}`} onClick={a.onClick}>{a.label}</button>
          ))}
        </div>
      )}
      {myRows.map(row => (
        <button
          key={row.id}
          data-testid={`row-${row.id}`}
          onClick={() => config.editMode?.active && config.editMode.onToggleSelect(row.id)}
        >
          {row.id}
          {config.editMode?.active && config.editMode.selectedIds.has(row.id) ? ' [selected]' : ''}
        </button>
      ))}
    </div>
  ),
}));

import { ChatTab } from './ChatTab';

describe('ChatTab — table-view edit mode delete (t/4896)', () => {
  beforeEach(() => {
    deleteChatMock = vi.fn().mockResolvedValue(undefined);
    chatStoreState = {
      sessions: [
        { id: 'chat-1', title: 'First chat', mode: 'brainstorm', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'chat-2', title: 'Second chat', mode: 'inform', updated_at: '2026-01-02T00:00:00Z' },
      ],
      sessionsLoading: false,
      loadSessions: vi.fn().mockResolvedValue(undefined),
      activeChatId: null,
      loadChat: vi.fn(),
      deleteChat: deleteChatMock,
      renameChat: vi.fn(),
      chatGenerating: false,
      chatActivity: null,
      chatError: null,
      chatLoading: false,
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('the table view declares showEdit', () => {
    render(<ChatTab />);
    expect(screen.getByTestId('show-edit')).toHaveTextContent('true');
  });

  it('entering edit mode shows the All/None/Done bar with no Delete action until something is selected', () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));

    expect(screen.getByTestId('action-All')).toBeInTheDocument();
    expect(screen.getByTestId('action-None')).toBeInTheDocument();
    expect(screen.getByTestId('action-Done')).toBeInTheDocument();
    expect(screen.queryByTestId(/^action-Delete/)).toBeNull();
  });

  it('selecting a row surfaces a Delete 1 action; selecting both shows Delete 2', () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    expect(screen.getByTestId('action-Delete 1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('row-chat-2'));
    expect(screen.getByTestId('action-Delete 2')).toBeInTheDocument();
  });

  it('bulk delete confirm dialog lists the selected chats and deletes each on confirm', async () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('row-chat-2'));
    fireEvent.click(screen.getByTestId('action-Delete 2'));

    expect(screen.getByText('First chat')).toBeInTheDocument();
    expect(screen.getByText('Second chat')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 Chats$/ }));
    await vi.waitFor(() => {
      expect(deleteChatMock).toHaveBeenCalledWith('chat-1');
      expect(deleteChatMock).toHaveBeenCalledWith('chat-2');
    });
    expect(deleteChatMock).toHaveBeenCalledTimes(2);
  });

  it('cancelling the confirm dialog leaves the selection and edit mode intact, deletes nothing', () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('action-Delete 1'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteChatMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('row-chat-1')).toHaveTextContent('[selected]');
    expect(screen.getByTestId('edit-mode-bar')).toBeInTheDocument();
  });

  it('Done exits edit mode and clears the selection', () => {
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('action-Done'));

    expect(screen.queryByTestId('edit-mode-bar')).toBeNull();
  });
});

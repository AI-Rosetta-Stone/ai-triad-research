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

    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 chats$/ }));
    await vi.waitFor(() => {
      expect(deleteChatMock).toHaveBeenCalledWith('chat-1');
      expect(deleteChatMock).toHaveBeenCalledWith('chat-2');
    });
    expect(deleteChatMock).toHaveBeenCalledTimes(2);
  });

  // t/4896 (Design): a failed delete must not strand the dialog on "Deleting…" or hide which ones
  // succeeded — the dialog stays open, shows a partial-failure message, and keeps only the failed
  // id(s) selected so the user can see what happened and retry.
  it('a failed delete keeps the dialog open, reports the partial result, and keeps the failed id selected', async () => {
    deleteChatMock.mockImplementation((id: string) =>
      id === 'chat-2' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
    );
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('row-chat-2'));
    fireEvent.click(screen.getByTestId('action-Delete 2'));
    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 chats$/ }));

    await vi.waitFor(() => {
      expect(screen.getByText("Deleted 1 of 2. Couldn't delete: Second chat.")).toBeInTheDocument();
    });
    // Dialog stayed open (not auto-closed/exited edit mode) and chat-1 is gone from it, since
    // only the failed id stays selected.
    expect(screen.queryByText('First chat')).toBeNull();
    expect(screen.getByText('Second chat')).toBeInTheDocument();
    expect(screen.getByTestId('edit-mode-bar')).toBeInTheDocument();
  });

  // t/89 (mirrors InquiryTab): a lone selected chat that fails gets its own mapped reason, not
  // the generic "Couldn't delete: <title>" aggregate. t/109: mapped as an 'operation', so a 429
  // gets the neutral text, not the AI "switch to a different model" advice.
  it('a single selected chat that fails shows its specific error, not the generic aggregate', async () => {
    deleteChatMock.mockRejectedValue(new Error('429 rate limit exceeded'));
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-2'));
    fireEvent.click(screen.getByTestId('action-Delete 1'));
    fireEvent.click(screen.getByRole('button', { name: /^Delete 1 chat$/ }));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Deleted 0 of 1. Too many requests. Wait a minute and try again.',
      );
    });
    expect(screen.queryByText(/Couldn't delete/)).toBeNull();
    expect(screen.queryByText(/different model/)).toBeNull();
  });

  it('a multi-item batch where every delete fails keeps the generic aggregate message', async () => {
    deleteChatMock.mockRejectedValue(new Error('429 rate limit exceeded'));
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('row-chat-2'));
    fireEvent.click(screen.getByTestId('action-Delete 2'));
    fireEvent.click(screen.getByRole('button', { name: /^Delete 2 chats$/ }));

    await vi.waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("Deleted 0 of 2. Couldn't delete: First chat, Second chat.");
    });
    expect(screen.queryByText(/Too many requests/)).toBeNull();
  });

  // t/4901: shared dialog a11y contract, including the deleting-in-progress Esc guard that
  // mirrors this dialog's pre-existing `!deleting &&` overlay-click guard.
  it('has role/aria-modal/aria-labelledby, and Esc is disabled while deleting (t/4901)', async () => {
    let resolveDelete!: () => void;
    deleteChatMock.mockImplementation(() => new Promise<void>(resolve => { resolveDelete = resolve; }));
    render(<ChatTab />);
    fireEvent.click(screen.getByTestId('enter-edit-mode'));
    fireEvent.click(screen.getByTestId('row-chat-1'));
    fireEvent.click(screen.getByTestId('action-Delete 1'));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', screen.getByText('Delete 1 chat?').id);

    fireEvent.click(screen.getByRole('button', { name: /^Delete 1 chat$/ }));
    fireEvent.keyDown(dialog, { key: 'Escape' }); // deleting is now true — must not close
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    resolveDelete();
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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

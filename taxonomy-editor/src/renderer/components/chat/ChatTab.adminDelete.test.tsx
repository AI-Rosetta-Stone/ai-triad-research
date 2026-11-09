// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/51: ChatTab's adminDelete returns removeItem's promise and rethrows after recording, so
// LibraryListPage's bulk admin-delete (t/49) can tell which rows failed. LibraryListPage's own
// handling of the promise is covered by its tests; here we only check what ChatTab hands it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { mockApi, recordMock } = vi.hoisted(() => ({
  mockApi: {
    openChatWindow: vi.fn().mockResolvedValue(undefined),
    loadChatSession: vi.fn(),
    loadCommunityChatSession: vi.fn().mockResolvedValue({ found: false }),
    exportChatToFile: vi.fn(),
    submitToCommunity: vi.fn(),
  },
  recordMock: vi.fn(),
}));

vi.mock('@bridge', () => ({ api: mockApi, isElectronMode: () => false }));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: recordMock }),
}));

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

let removeItemMock: ReturnType<typeof vi.fn>;
vi.mock('../../hooks/useCommunityStore', () => {
  const state = () => ({ chats: [{ id: 'cc-1', title: 'A shared chat' }], loading: false, fetchChats: vi.fn(), copyItem: vi.fn(), removeItem: removeItemMock, renameItem: vi.fn() });
  return { useCommunityStore: Object.assign(state, { getState: state }) };
});

vi.mock('./ChatWorkspace', () => ({ ChatWorkspace: () => null }));
vi.mock('./NewChatDialog', () => ({ NewChatDialog: () => null }));
vi.mock('./ChatGettingStarted', () => ({ ChatGettingStarted: () => null }));

type AdminDelete = (row: { id: string }, reason?: string) => void | Promise<unknown>;
let capturedAdminDelete: AdminDelete | undefined;
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ config }: { config: { adminDelete?: AdminDelete } }) => {
    capturedAdminDelete = config.adminDelete;
    return null;
  },
}));

import { ChatTab } from './ChatTab';

describe('ChatTab — adminDelete returns its promise (t/51)', () => {
  beforeEach(() => {
    chatStoreState = {
      sessions: [], sessionsLoading: false, loadSessions: vi.fn().mockResolvedValue(undefined),
      activeChatId: null, loadChat: vi.fn(), deleteChat: vi.fn(), renameChat: vi.fn(),
      chatGenerating: false, chatActivity: null, chatError: null, chatLoading: false,
      activeCommunityChat: null, setActiveCommunityChat: vi.fn(),
    };
    capturedAdminDelete = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('resolves when removeItem resolves, passing the id and reason through', async () => {
    removeItemMock = vi.fn().mockResolvedValue(undefined);
    render(<ChatTab />);

    await expect(capturedAdminDelete!({ id: 'cc-1' }, 'spam')).resolves.toBeUndefined();
    expect(removeItemMock).toHaveBeenCalledWith('chats', 'cc-1', 'spam');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('rejects with the original error when removeItem rejects, after recording it', async () => {
    const err = new Error('403 Forbidden');
    removeItemMock = vi.fn().mockRejectedValue(err);
    render(<ChatTab />);

    await expect(capturedAdminDelete!({ id: 'cc-1' }, 'spam')).rejects.toBe(err);
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.error', component: 'chat-tab', message: 'Failed to admin-delete community chat',
    }));
  });
});

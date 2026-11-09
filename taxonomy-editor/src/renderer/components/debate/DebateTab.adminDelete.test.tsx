// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/50: DebateTab's admin delete returns removeItem's promise and rethrows after recording, so
// LibraryListPage's bulk admin-delete (t/49) can report a partial failure instead of a ghost row.
// Mock scaffold mirrors DebateTab.inPlaceOpen.test.tsx; LibraryListPage is a stub that captures config.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));

const debateStoreState: Record<string, unknown> = {
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
  setActiveCommunityDebate: vi.fn(),
  loadDebateFromData: vi.fn(),
};
vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(debateStoreState),
    { getState: () => debateStoreState, setState: vi.fn() },
  ),
}));

const mockRemoveItem = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({
    debates: [], loading: false, fetchDebates: vi.fn().mockResolvedValue(undefined),
    copyItem: vi.fn(), removeItem: mockRemoveItem, renameItem: vi.fn(),
  }),
}));

type AdminDelete = (row: { id: string }, reason?: string) => void | Promise<unknown>;
const captured = vi.hoisted(() => ({ adminDelete: undefined as undefined | ((row: { id: string }, reason?: string) => unknown) }));
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ config }: { config: { adminDelete?: AdminDelete } }) => {
    captured.adminDelete = config.adminDelete;
    return null;
  },
}));

const mockRecord = vi.hoisted(() => vi.fn());
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: mockRecord }) }));

vi.mock('../../hooks/useTaxonomyStore', () => ({ useTaxonomyStore: () => ({ toolbarPanel: null }) }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('../../store/preferencesStore', () => ({ usePreferencesStore: () => 'full' }));
vi.mock('@bridge', () => ({
  api: {
    getDebateQuotaStatus: vi.fn().mockResolvedValue({ allowed: true, current: 0, limit: 5 }),
    openDebateWindow: vi.fn(),
    loadDebateSession: vi.fn(),
    loadCommunityDebateSession: vi.fn().mockResolvedValue({ found: false }),
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
vi.mock('../shared/ToolbarPaneRenderer', () => ({ ToolbarPaneRenderer: () => null, isFullWidthPanel: () => false, PhoneToolClose: () => null }));
vi.mock('../shared/LineageDetailView', () => ({ LineageDetailView: () => null }));
vi.mock('../analysis/ParameterHistoryPanel', () => ({ ParameterHistoryPanel: () => null }));
vi.mock('./DebateBriefExports', () => ({
  useDebateBriefExports: () => ({ openBrief: vi.fn(), node: null }),
  useRowBriefExport: () => ({ openRowBrief: vi.fn(), rowBriefNode: null }),
}));
vi.mock('./ExportDropdown', () => ({ ExportDropdown: () => null }));

import { DebateTab } from './DebateTab';

describe('DebateTab — adminDelete returns its promise (t/50)', () => {
  beforeEach(() => {
    mockRemoveItem.mockReset();
    mockRecord.mockReset();
    captured.adminDelete = undefined;
    render(<DebateTab />);
  });

  it('resolves when removeItem resolves, and records nothing', async () => {
    mockRemoveItem.mockResolvedValue(undefined);
    await expect(captured.adminDelete!({ id: 'cd-1' }, 'spam')).resolves.toBeUndefined();
    expect(mockRemoveItem).toHaveBeenCalledWith('debates', 'cd-1', 'spam');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects with the same error when removeItem rejects, after recording a system.error', async () => {
    const err = new Error('server said no');
    mockRemoveItem.mockRejectedValue(err);
    await expect(captured.adminDelete!({ id: 'cd-2' })).rejects.toBe(err);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.error', component: 'debate-tab', message: 'Failed to admin-delete community debate',
      error: expect.objectContaining({ message: 'Error: server said no' }),
    }));
  });
});

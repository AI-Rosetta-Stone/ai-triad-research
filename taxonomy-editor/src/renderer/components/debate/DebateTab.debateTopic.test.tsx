// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/824: the synthesis panel's "Debate this question" button opens the New debate dialog with the topic filled in.
// DebateWorkspace hides the button unless its host passes `onDebateTopic`; DebateTab passes it at the render sites
// it owns (table-mode detail and the phone detail pane). Mirrors the scaffold in DebateTab.inPlaceOpen.test.tsx.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
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
// t/4888#3: asserting this is NEVER called is the regression guard — DebateTab used to null
// activeDebate/activeDebateId here on a Community open, risking a round in flight.
const mockDebateStoreSetState = vi.hoisted(() => vi.fn());

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(debateStoreState),
    { getState: () => debateStoreState, setState: mockDebateStoreSetState },
  ),
}));

let communityDebatesState: Array<{ id: string; title: string }>;
vi.mock('../../hooks/useCommunityStore', () => ({
  useCommunityStore: () => ({ debates: communityDebatesState, loading: false, fetchDebates: vi.fn().mockResolvedValue(undefined), copyItem: vi.fn() }),
}));

// A minimal stand-in exposing exactly what DebateTab wires to it — the real LibraryListPage's
// own My/Community tab gating isn't under test here (mirrors ChatTab.inPlaceOpen.test.tsx).
vi.mock('../shared/LibraryListPage', () => ({
  LibraryListPage: ({ myRows, onOpenMy, communityRows, onOpenCommunity, intro, config }: {
    myRows: { id: string; title: string }[]; onOpenMy: (id: string) => void;
    communityRows?: { id: string }[]; onOpenCommunity?: (id: string) => void;
    intro?: React.ReactNode;
    config?: { newLabel: string; onNew?: () => void };
  }) => (
    <div data-testid="library-list-page">
      {config?.onNew && <button onClick={config.onNew}>{config.newLabel}</button>}
      {intro}
      {myRows.map(row => (
        <button key={row.id} data-testid={`row-${row.id}`} onClick={() => onOpenMy(row.id)}>
          {row.title}
        </button>
      ))}
      {(communityRows ?? []).map(row => (
        <button key={row.id} data-testid={`community-row-${row.id}`} onClick={() => onOpenCommunity?.(row.id)}>
          {row.id}
        </button>
      ))}
    </div>
  ),
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
    loadCommunityDebateSession: vi.fn().mockResolvedValue({ found: false }),
    submitToCommunity: vi.fn(),
    exportDebateToFile: vi.fn(),
    openExternal: vi.fn(),
  },
  isElectronMode: () => false,
}));

const mockNewDebateDialog = vi.hoisted(() => vi.fn(() => null));
vi.mock('./NewDebateDialog', () => ({ NewDebateDialog: (props: unknown) => mockNewDebateDialog(props) }));
vi.mock('../debate-workspace', () => ({
  DebateWorkspace: ({ onDebateTopic }: { onDebateTopic?: (topic: string) => void }) => (
    <div data-testid="debate-workspace">
      {onDebateTopic && <button onClick={() => onDebateTopic('What would settle the licensing dispute?')}>Debate this question</button>}
    </div>
  ),
}));
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


describe('DebateTab hands DebateWorkspace an onDebateTopic that opens the dialog prefilled (t/824)', () => {
  beforeEach(() => {
    const session = makeSession();
    debateStoreState = {
      sessions: [session], sessionsLoading: false, loadSessions: vi.fn().mockResolvedValue(undefined),
      activeDebateId: 'debate-1', activeDebate: session, loadDebate: mockLoadDebate, deleteDebate: vi.fn(), renameDebate: vi.fn(),
      setActiveCommunityDebate: vi.fn(), closeCommunityDebateSignal: 0, pendingOpenCommunityId: null, clearPendingOpenCommunity: vi.fn(),
    };
    communityDebatesState = [];
    mockNewDebateDialog.mockClear();
    try { localStorage.clear(); } catch { /* jsdom always has localStorage in this suite */ }
  });
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it('the workspace shows the button, and pressing it opens NewDebateDialog with that topic as initialTopic', async () => {
    render(<DebateTab />);
    const button = await screen.findByRole('button', { name: 'Debate this question' });
    fireEvent.click(button);
    await vi.waitFor(() => expect(mockNewDebateDialog).toHaveBeenCalled());
    const props = mockNewDebateDialog.mock.calls.at(-1)?.[0] as { initialTopic?: string };
    expect(props.initialTopic).toBe('What would settle the licensing dispute?');
  });

  it('the dialog is not opened until the button is pressed', async () => {
    render(<DebateTab />);
    await screen.findByRole('button', { name: 'Debate this question' });
    expect(mockNewDebateDialog).not.toHaveBeenCalled();
  });
});

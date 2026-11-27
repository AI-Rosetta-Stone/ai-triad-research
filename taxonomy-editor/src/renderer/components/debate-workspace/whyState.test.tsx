// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/840: two mutations of #5661 that the tests did not catch (Quality, p/13#81).
// (1) allOpen must mean EVERY row is open, so the control reads "Collapse all" only then.
// (2) The debate's Why panel keys its open rows by the statement (stateKey = entry.id), so they
//     survive the card being unmounted and mounted again within the session.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';

Element.prototype.scrollIntoView = vi.fn();

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: vi.fn() }) }));

const debateState = {
  activeDebate: { id: 'd1', transcript: [] as unknown[], speaker_models: {} },
  responseLength: 'detailed',
  defaultDisplayTier: 'why',
  setEntryDisplayTier: vi.fn(),
  askQuestion: vi.fn(),
  debateGenerating: null,
  diagnosticsEnabled: false,
  toggleDiagnostics: vi.fn(),
  selectDiagEntry: vi.fn(),
  deleteTranscriptEntries: vi.fn(),
};
vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: (s: typeof debateState) => unknown) => selector(debateState),
    { getState: () => debateState },
  ),
}));
vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }));
vi.mock('../../hooks/useFeatureFlags', () => ({ useFlag: () => false }));
vi.mock('../../hooks/useCommentStore', () => ({
  COMMENT_TYPE_META: {},
  useCommentStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      commentsFile: null,
      filters: { types: new Set(), authors: new Set(), searchText: '', showResolved: true },
      focusedCommentId: null, focusComment: vi.fn(), setSidebarOpen: vi.fn(), toggleSidebar: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('../../hooks/useTaxonomyStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTaxonomyStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({ policyRegistry: null }) },
  ),
}));
vi.mock('@bridge', () => ({
  api: { focusNodeInMainWindow: vi.fn(), clipboardWriteText: vi.fn(), openExternal: vi.fn() },
}));
vi.mock('./ClaimsView', () => ({ ClaimsView: () => null }));
vi.mock('./VocabularyPanel', () => ({ LineageTermsView: () => null, VocabTermsView: () => null }));
vi.mock('../../utils/lineageMatcher', () => ({ lineageMarkdownComponents: {}, extractLineageNames: () => [] }));
vi.mock('../../utils/vocabularyAnnotations', () => ({ getDebateMarkdownComponents: () => ({}) }));

import { StatementCard } from './StatementCard';
import { useWhyExplanations, resetWhyExplanations } from './whyExplanations';

beforeEach(() => resetWhyExplanations());

describe('allOpen (Expand all / Collapse all label)', () => {
  it('is true only when every row is open', () => {
    const ids = ['a', 'b'];
    const { result } = renderHook(() => useWhyExplanations('k', ids));
    expect(result.current.allOpen).toBe(false);
    act(() => result.current.toggle('a'));
    expect(result.current.allOpen).toBe(false); // one of two open: still "Expand all"
    act(() => result.current.toggle('b'));
    expect(result.current.allOpen).toBe(true);
    act(() => result.current.setAll(false));
    expect(result.current.allOpen).toBe(false);
  });

  it('is false with no rows', () => {
    const { result } = renderHook(() => useWhyExplanations('empty', []));
    expect(result.current.allOpen).toBe(false);
  });
});

describe('the debate Why panel keeps its open rows per statement', () => {
  const entry = {
    id: 'stmt-1', type: 'statement', speaker: 'accelerationist', content: 'A statement.', timestamp: '2026-01-01T00:00:00Z',
    display_tier: 'why', policy_refs: [],
    taxonomy_refs: [{ node_id: 'acc-beliefs-007', label: 'First belief', relevance: 'because first', relevance_score: 0.9 }],
  } as never;

  it('an opened row is still open after the card is unmounted and mounted again', () => {
    const first = render(<StatementCard entry={entry} statementId="S1" entryIndex={0} totalEntries={1} />);
    expect(screen.queryByText('because first')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'First belief' }));
    expect(screen.getByText('because first')).toBeInTheDocument();
    first.unmount();
    render(<StatementCard entry={entry} statementId="S1" entryIndex={0} totalEntries={1} />);
    expect(screen.getByText('because first')).toBeInTheDocument();
  });
});

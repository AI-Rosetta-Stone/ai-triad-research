// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4625: per-statement view-mode toggle — Text | Why | How. "Analysis" is a label-only rename
// to "How" (tier id stays `analysis`); "Why" is a new mode showing the statement's BDI
// grounding. Real ./utils (modeOfTier, TIER_LABELS, META_TIERS) is used — not mocked — since
// that is exactly the logic under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

const debateState = {
  activeDebate: { transcript: [], speaker_models: {} },
  responseLength: 'detailed',
  defaultDisplayTier: undefined as string | undefined,
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

const mockFlags: Record<string, boolean> = {};
vi.mock('../../hooks/useFeatureFlags', () => ({
  useFlag: (name: string) => mockFlags[name] ?? false,
}));

vi.mock('../../hooks/useCommentStore', () => ({
  COMMENT_TYPE_META: {},
  useCommentStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      commentsFile: null,
      filters: { types: new Set(), authors: new Set(), searchText: '', showResolved: true },
      focusedCommentId: null,
      focusComment: vi.fn(),
      setSidebarOpen: vi.fn(),
      toggleSidebar: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({ policyRegistry: null }) },
  ),
}));
vi.mock('@bridge', () => ({
  api: { focusNodeInMainWindow: vi.fn(), clipboardWriteText: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('./ClaimsView', () => ({ ClaimsView: () => <div data-testid="claims-view" /> }));
vi.mock('./VocabularyPanel', () => ({ LineageTermsView: () => null, VocabTermsView: () => null }));
vi.mock('./TaxonomyRefs', () => ({
  TaxonomyRefsSection: () => <div data-testid="taxonomy-refs" />,
  BdiGroundingView: () => <div data-testid="bdi-grounding-view" />,
}));
vi.mock('../../utils/lineageMatcher', () => ({ lineageMarkdownComponents: {}, extractLineageNames: () => [] }));
vi.mock('../../utils/vocabularyAnnotations', () => ({ getDebateMarkdownComponents: () => ({}) }));

import { StatementCard } from './StatementCard';
import type { TranscriptEntry } from '@lib/debate/types';

function makeEntry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: 'e1',
    timestamp: '2026-01-01T00:00:00Z',
    type: 'statement',
    speaker: 'accelerationist',
    content: 'One two three four five.',
    taxonomy_refs: [],
    display_tier: 'detailed',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  debateState.defaultDisplayTier = undefined;
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  }
});

describe('StatementCard view-mode toggle — Text | Why | How (t/4625)', () => {
  it('shows Text, Why and How — never Analysis', () => {
    render(<StatementCard entry={makeEntry()} />);
    expect(screen.getByRole('radio', { name: 'Text' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Why' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'How' })).toBeInTheDocument();
    expect(screen.queryByText('Analysis')).not.toBeInTheDocument();
  });

  it('clicking Why sets this entry\'s display tier to why (AC1/AC2)', async () => {
    const user = userEvent.setup();
    render(<StatementCard entry={makeEntry()} />);
    await user.click(screen.getByRole('radio', { name: 'Why' }));
    expect(debateState.setEntryDisplayTier).toHaveBeenCalledWith('e1', 'why');
  });

  it('clicking How still sets the reasoning tier (label-only rename, AC1)', async () => {
    const user = userEvent.setup();
    render(<StatementCard entry={makeEntry()} />);
    await user.click(screen.getByRole('radio', { name: 'How' }));
    expect(debateState.setEntryDisplayTier).toHaveBeenCalledWith('e1', 'reasoning');
  });

  it('when display_tier is why, marks Why active and renders BdiGroundingView in the body (AC2)', () => {
    // Note: the footer's TaxonomyRefsSection (Explain button + collapsible BDI-in-Plan) still
    // renders alongside it — unlike 'reasoning', 'why' doesn't suppress the footer, since its
    // simplified body view has no Explain/caveats affordance of its own.
    render(<StatementCard entry={makeEntry({ display_tier: 'why' })} />);
    expect(screen.getByRole('radio', { name: 'Why' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('bdi-grounding-view')).toBeInTheDocument();
  });

  it('an old saved entry with display_tier reasoning (pre-t/4625) still marks How active, not Why (AC4)', () => {
    render(<StatementCard entry={makeEntry({ display_tier: 'reasoning' })} />);
    expect(screen.getByRole('radio', { name: 'How' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Why' })).toHaveAttribute('aria-checked', 'false');
  });

  it('an entry with no display_tier override and no global default falls back to Text (AC4)', () => {
    render(<StatementCard entry={makeEntry({ display_tier: undefined })} />);
    expect(screen.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
  });
});

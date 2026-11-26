// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PhaseTransitionCard, PhaseHairline, HighlightedText, EntryCommentBadge } from './StatementCard';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('./utils', () => ({
  speakerLabel: (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
  speakerColor: () => '#999',
  pctFmt: (v: number) => `${Math.round(v * 100)}%`,
  focusMainWindowNode: vi.fn(),
  fixMarkdownLinks: (s: string) => s,
  stripLeadingHeadings: (s: string) => s,
}));

vi.mock('../../hooks/useDebateStore', () => ({
  useDebateStore: Object.assign(
    (selector: any) => selector({
      activeDebate: null,
      debateGenerating: null,
      deleteTranscriptEntry: vi.fn(),
      responseLength: 'detailed',
      setResponseLength: vi.fn(),
    }),
    { getState: () => ({ activeDebate: null }) },
  ),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}));

vi.mock('../../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: (selector: any) => selector({
    getLabelForId: (id: string) => `Label ${id}`,
    vocabTerms: [],
    lineageEnabled: false,
  }),
}));

vi.mock('./ClaimsView', () => ({
  ClaimsView: () => <div data-testid="claims-view" />,
}));
vi.mock('./VocabularyPanel', () => ({
  LineageTermsView: () => null,
  VocabTermsView: () => null,
}));
vi.mock('../CommentHighlights', () => ({
  CommentHighlightedText: ({ children }: { children: string }) => <span>{children}</span>,
  useEntryCommentCount: () => 0,
  useHasCommentHighlights: () => false,
}));
vi.mock('../../hooks/useCommentStore', () => ({
  useCommentStore: (selector: any) => selector({ toggleSidebar: vi.fn() }),
}));
vi.mock('./TaxonomyRefs', () => ({
  TaxonomyRefsSection: () => <div data-testid="taxonomy-refs" />,
}));
vi.mock('../../utils/lineageMatcher', () => ({
  lineageMarkdownComponents: {},
  extractLineageNames: () => [],
}));
vi.mock('../../utils/vocabularyAnnotations', () => ({
  getDebateMarkdownComponents: () => ({}),
}));

afterEach(() => { vi.clearAllMocks(); });

// ── PhaseTransitionCard (hairline) ──────────────────────────

describe('PhaseTransitionCard', () => {
  it('renders transition summary as labeled hairline', () => {
    render(<PhaseTransitionCard type="TRANSITION_SUMMARY" />);
    expect(screen.getByText('Entering Synthesis')).toBeInTheDocument();
  });

  it('renders regression notice as labeled hairline', () => {
    render(<PhaseTransitionCard type="REGRESSION_NOTICE" />);
    expect(screen.getByText('Returning to Exploration')).toBeInTheDocument();
  });

  it('renders final commit as labeled hairline', () => {
    render(<PhaseTransitionCard type="FINAL_COMMIT" />);
    expect(screen.getByText('Final Positions')).toBeInTheDocument();
  });
});

// ── PhaseHairline ───────────────────────────────────────────

describe('PhaseHairline', () => {
  it('renders labeled hairline', () => {
    render(<PhaseHairline label="Opening Statements" />);
    expect(screen.getByText('Opening Statements')).toBeInTheDocument();
  });

  it('uses hairline CSS class', () => {
    const { container } = render(<PhaseHairline label="Cross-Examination" />);
    expect(container.querySelector('.phase-hairline')).toBeTruthy();
    expect(container.querySelector('.phase-hairline-label')).toBeTruthy();
  });
});

// ── HighlightedText ─────────────────────────────────────────

describe('HighlightedText', () => {
  it('returns text unchanged when no query', () => {
    const { container } = render(<HighlightedText text="Hello world" query="" matchOffset={0} currentIndex={0} />);
    expect(container.textContent).toBe('Hello world');
  });

  it('highlights matching text', () => {
    const { container } = render(<HighlightedText text="Hello world" query="world" matchOffset={0} currentIndex={0} />);
    const mark = container.querySelector('mark');
    expect(mark).toBeTruthy();
    expect(mark?.textContent).toBe('world');
  });

  it('highlights multiple matches', () => {
    const { container } = render(<HighlightedText text="aa bb aa" query="aa" matchOffset={0} currentIndex={0} />);
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(2);
  });

  it('marks current index with active class', () => {
    const { container } = render(<HighlightedText text="aa bb aa" query="aa" matchOffset={0} currentIndex={1} />);
    const marks = container.querySelectorAll('mark');
    expect(marks[1]?.classList.contains('debate-find-match-current')).toBe(true);
    expect(marks[0]?.classList.contains('debate-find-match-current')).toBe(false);
  });
});

// ── EntryCommentBadge ───────────────────────────────────────

describe('EntryCommentBadge', () => {
  it('renders nothing when count is 0', () => {
    const { container } = render(<EntryCommentBadge entryId="e1" />);
    expect(container.innerHTML).toBe('');
  });
});

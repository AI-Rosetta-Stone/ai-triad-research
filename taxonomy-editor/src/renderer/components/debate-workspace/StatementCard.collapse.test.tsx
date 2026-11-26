// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/701 §8 (docs/ux/debate-statement-density.md): older turns collapse to their claim. In a
// debate with more than 3 turns, every turn except the 2 most recent starts collapsed to one
// row: caret, speaker, kind, claim. A hand-made choice wins, and nothing is saved with the
// debate. This replaces the flag-gated `collapsed · N words` chevron of t/2241: the caret is
// no longer behind DEBATE_CHAT_REDESIGN.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));

const debateState = {
  activeDebate: { id: 'd1', transcript: [] as TranscriptEntry[], speaker_models: {} },
  responseLength: 'detailed',
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

// Controllable flag mock — every flag defaults off, matching production.
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
vi.mock('./TaxonomyRefs', () => ({ TaxonomyRefsSection: () => <div data-testid="taxonomy-refs" /> }));
vi.mock('../../utils/lineageMatcher', () => ({ lineageMarkdownComponents: {}, extractLineageNames: () => [] }));
vi.mock('../../utils/vocabularyAnnotations', () => ({ getDebateMarkdownComponents: () => ({}) }));

import { StatementCard } from './StatementCard';
import { resetTurnCollapse, expandAllTurns, collapseEarlierTurns, turnIdsOf } from './turnCollapse';
import { act } from '@testing-library/react';
import type { TranscriptEntry } from '@lib/debate/types';

// ── Fixtures ─────────────────────────────────────────────────

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
  delete mockFlags.DEBATE_CHAT_REDESIGN;
  resetTurnCollapse();
  debateState.activeDebate = { id: 'd1', transcript: [], speaker_models: {} };
  // jsdom lacks matchMedia; StatementCard's tier-change effect reads it.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  }
});

/** A debate of n statement turns, e1..en, each with its own text. */
function setTranscript(n: number, over: (i: number) => Partial<TranscriptEntry> = () => ({})): TranscriptEntry[] {
  const transcript = Array.from({ length: n }, (_, k) => makeEntry({ id: `e${k + 1}`, content: `Turn ${k + 1} claim. More detail follows here.`, ...over(k + 1) }));
  debateState.activeDebate = { id: 'd1', transcript, speaker_models: {} };
  return transcript;
}
function renderAll(transcript: TranscriptEntry[], props: Record<string, unknown> = {}) {
  return render(<>{transcript.map(e => <StatementCard key={e.id} entry={e} {...props} />)}</>);
}
const collapsedIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.debate-statement-collapsed')).map(el => el.getAttribute('data-entry-id'));

describe('StatementCard collapse: which turns start collapsed (t/701 §8)', () => {
  it('3 turns or fewer: every turn is open, each with a caret', () => {
    const { container } = renderAll(setTranscript(3));
    expect(collapsedIds(container)).toEqual([]);
    expect(screen.getAllByRole('button', { name: /collapse this turn/i })).toHaveLength(3);
  });

  it('more than 3 turns: all but the 2 newest start collapsed', () => {
    const { container } = renderAll(setTranscript(5));
    expect(collapsedIds(container)).toEqual(['e1', 'e2', 'e3']);
    expect(container.querySelectorAll('.debate-statement-body')).toHaveLength(2);
  });

  it('is not behind DEBATE_CHAT_REDESIGN: the same with the flag on', () => {
    mockFlags.DEBATE_CHAT_REDESIGN = true;
    const { container } = renderAll(setTranscript(5));
    expect(collapsedIds(container)).toEqual(['e1', 'e2', 'e3']);
  });

  it('probing and fact-check cards are not turns and do not count', () => {
    const transcript = setTranscript(3);
    transcript.push(makeEntry({ id: 'p1', type: 'probing' }), makeEntry({ id: 'f1', type: 'fact-check' }));
    expect(turnIdsOf(transcript)).toEqual(['e1', 'e2', 'e3']);
    const { container } = renderAll(transcript.slice(0, 3));
    expect(collapsedIds(container)).toEqual([]);
  });

  it('when a new turn arrives, the third most recent collapses, unless the user opened it by hand', async () => {
    const user = userEvent.setup();
    const first = renderAll(setTranscript(4));
    expect(collapsedIds(first.container)).toEqual(['e1', 'e2']);
    // The user opens e2 by hand; e3 is open only because it is one of the 2 newest.
    await user.click(screen.getAllByRole('button', { name: /expand this turn/i })[1]);
    expect(collapsedIds(first.container)).toEqual(['e1']);
    first.unmount();
    const { container } = renderAll(setTranscript(5));
    expect(collapsedIds(container)).toEqual(['e1', 'e3']);
  });

  it('a turn appended to the same transcript array is counted: the third most recent collapses', () => {
    // The store can add a turn by mutating the transcript in place, so the array identity
    // the cards hold does not change. The rule must still see the new length.
    const transcript = setTranscript(4);
    const { container, rerender } = renderAll(transcript);
    expect(collapsedIds(container)).toEqual(['e1', 'e2']);

    transcript.push(makeEntry({ id: 'e5', content: 'Turn 5 claim. More detail follows here.' }));
    expect(debateState.activeDebate.transcript).toBe(transcript);
    rerender(<>{transcript.map(e => <StatementCard key={e.id} entry={e} />)}</>);

    expect(collapsedIds(container)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('StatementCard collapse: the collapsed row (t/701 §8)', () => {
  it('shows speaker, kind and the claim, and no body', () => {
    const transcript = setTranscript(4, (i) => (i === 1 ? { type: 'opening', summaries: { brief: 'Old brief first sentence. Second sentence.', medium: 'm' } } : {}));
    const { container } = renderAll(transcript);
    const row = container.querySelector('[data-entry-id="e1"]') as HTMLElement;
    expect(row.querySelector('.debate-statement-speaker')?.textContent).toBe('Accelerationist');
    expect(row.querySelector('.debate-statement-kind')?.textContent).toBe('· Opening statement');
    // An old debate has no brief_claim: the claim is the first sentence of the brief string.
    expect(row.querySelector('.debate-statement-collapsed-claim')?.textContent).toBe('Old brief first sentence.');
    expect(row.querySelector('.debate-statement-body')).toBeNull();
    expect(row.querySelector('.debate-tier-pills')).toBeNull();
  });

  it('puts the claim on its own line under speaker and kind (t/761)', () => {
    const { container } = renderAll(setTranscript(4, (i) => (i === 1 ? { type: 'opening' } : {})));
    const row = container.querySelector('[data-entry-id="e1"]') as HTMLElement;
    const line = row.querySelector('.debate-statement-collapsed-line') as HTMLElement;
    const claim = row.querySelector('.debate-statement-collapsed-claim') as HTMLElement;
    expect(line.querySelector('.debate-statement-speaker')).not.toBeNull();
    expect(line.querySelector('.debate-statement-kind')?.textContent).toBe('· Opening statement');
    expect(line.contains(claim)).toBe(false);
    expect(claim.parentElement).toBe(line.parentElement);
  });

  it('uses brief_claim when the entry has one', () => {
    const transcript = setTranscript(4, (i) => (i === 1 ? { summaries: { brief: 'b', medium: 'm', brief_claim: 'The structured claim.', brief_points: ['p1', 'p2'] } as TranscriptEntry['summaries'] } : {}));
    const { container } = renderAll(transcript);
    expect(container.querySelector('[data-entry-id="e1"] .debate-statement-collapsed-claim')?.textContent).toBe('The structured claim.');
  });

  it('an unsummarized turn falls back to the first sentence of the statement', () => {
    const { container } = renderAll(setTranscript(4));
    expect(container.querySelector('[data-entry-id="e1"] .debate-statement-collapsed-claim')?.textContent).toBe('Turn 1 claim.');
  });

  it('the caret says the row is collapsed (aria-expanded) and opens it on click', async () => {
    const user = userEvent.setup();
    const { container } = renderAll(setTranscript(4));
    const caret = screen.getAllByRole('button', { name: /expand this turn/i })[0];
    expect(caret).toHaveAttribute('aria-expanded', 'false');
    await user.click(caret);
    expect(collapsedIds(container)).toEqual(['e2']);
    expect(screen.getAllByRole('button', { name: /collapse this turn/i })[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('a click anywhere on the collapsed row opens it', async () => {
    const user = userEvent.setup();
    const { container } = renderAll(setTranscript(4));
    await user.click(container.querySelector('[data-entry-id="e1"] .debate-statement-collapsed-claim') as HTMLElement);
    expect(collapsedIds(container)).toEqual(['e2']);
  });

  it('toggles from the keyboard: Enter and Space on the caret', async () => {
    const user = userEvent.setup();
    const { container } = renderAll(setTranscript(4));
    await user.tab();
    expect(screen.getAllByRole('button', { name: /expand this turn/i })[0]).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(collapsedIds(container)).toEqual(['e2']);
    await user.keyboard(' ');
    expect(collapsedIds(container)).toEqual(['e1', 'e2']);
  });

  it('an open turn can be collapsed by hand, also one of the 2 newest', async () => {
    const user = userEvent.setup();
    const { container } = renderAll(setTranscript(2));
    await user.click(screen.getAllByRole('button', { name: /collapse this turn/i })[1]);
    expect(collapsedIds(container)).toEqual(['e2']);
  });

  it('a turn holding a find-in-debate match is shown open', () => {
    const { container } = renderAll(setTranscript(4), { findQuery: 'Turn 1' });
    expect(collapsedIds(container)).toEqual(['e2']);
  });
});

describe('Expand all turns / Collapse earlier turns (t/701 §8)', () => {
  it('expand all opens every turn; collapse earlier restores the rule', () => {
    const transcript = setTranscript(5);
    const { container } = renderAll(transcript);
    act(() => expandAllTurns('d1', turnIdsOf(transcript)));
    expect(collapsedIds(container)).toEqual([]);
    act(() => collapseEarlierTurns('d1'));
    expect(collapsedIds(container)).toEqual(['e1', 'e2', 'e3']);
  });

  it('the state belongs to one debate and is not written to the entries', () => {
    const transcript = setTranscript(5);
    act(() => expandAllTurns('other-debate', turnIdsOf(transcript)));
    const { container } = renderAll(transcript);
    expect(collapsedIds(container)).toEqual(['e1', 'e2', 'e3']);
    expect(debateState.setEntryDisplayTier).not.toHaveBeenCalled();
    expect(Object.keys(transcript[0])).not.toContain('collapsed');
  });
});

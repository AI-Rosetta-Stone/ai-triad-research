// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/701 (docs/ux/debate-statement-density.md): the statement card is less to take in at once.
// §1 structured Brief, §2 two lengths, §3 read-more link, §4 tab labels, §5 plain header,
// §6 turn symbols, §7 tagline. §8 (collapse) is in StatementCard.collapse.test.tsx.

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
vi.mock('./VocabularyPanel', () => ({ LineageTermsView: () => null, VocabTermsView: () => <div data-testid="vocab-terms-view" /> }));
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

const LONG = 'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
const structured = { brief: 'Old brief.', medium: 'Old medium.', brief_claim: 'Labs should be simulated by default.', brief_points: ['Holmes (2017): no exam gain.', 'Finkelstein (2005): simulations matched.'] } as TranscriptEntry['summaries'];

describe('§1 Brief has a shape', () => {
  it('renders brief_claim as the claim and brief_points as bullets', () => {
    const { container } = render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG, summaries: structured })} />);
    expect(container.querySelector('.debate-brief-claim')?.textContent).toBe('Labs should be simulated by default.');
    expect(Array.from(container.querySelectorAll('.debate-brief-points li')).map(li => li.textContent)).toEqual(['Holmes (2017): no exam gain.', 'Finkelstein (2005): simulations matched.']);
    expect(screen.queryByText('Old brief.')).not.toBeInTheDocument();
  });

  it('an old debate without brief_claim shows the brief string as a paragraph', () => {
    const { container } = render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG, summaries: { brief: 'Old brief.', medium: 'Old medium.' } })} />);
    expect(container.querySelector('.debate-brief-claim')).toBeNull();
    expect(screen.getByTestId('markdown').textContent).toBe('Old brief.');
  });

  it('ignores malformed structured fields and falls back to the brief string', () => {
    const summaries = { brief: 'Old brief.', medium: 'm', brief_claim: '   ', brief_points: 'not a list' } as unknown as TranscriptEntry['summaries'];
    render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG, summaries })} />);
    expect(screen.getByTestId('markdown').textContent).toBe('Old brief.');
  });

  it('a statement that was never summarized shows its first two sentences', () => {
    render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG })} />);
    expect(screen.getByTestId('markdown').textContent).toBe('First sentence here. Second sentence here.');
  });
});

describe('§2 two lengths, not three', () => {
  it('a stored medium, per card or global, shows the Brief', () => {
    const first = render(<StatementCard entry={makeEntry({ display_tier: 'medium', content: LONG, summaries: { brief: 'Old brief.', medium: 'Old medium.' } })} />);
    expect(screen.getByTestId('markdown').textContent).toBe('Old brief.');
    first.unmount();
    debateState.defaultDisplayTier = 'medium';
    render(<StatementCard entry={makeEntry({ display_tier: undefined, content: LONG, summaries: { brief: 'Old brief.', medium: 'Old medium.' } })} />);
    expect(screen.getByTestId('markdown').textContent).toBe('Old brief.');
  });

  it('a stored detailed shows the full statement', () => {
    render(<StatementCard entry={makeEntry({ display_tier: 'detailed', content: LONG, summaries: structured })} />);
    expect(screen.getByTestId('markdown').textContent).toBe(LONG);
  });

  it('the card has no length dropdown', () => {
    render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG, summaries: structured })} />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

describe('§3 every Brief says that more exists', () => {
  const words = Array.from({ length: 184 }, (_, i) => (i % 12 === 11 ? 'end.' : 'word')).join(' ');

  it('Brief: "Read full statement (≈N words)", N rounded to the nearest 10, not expanded', () => {
    debateState.defaultDisplayTier = 'brief';
    render(<StatementCard entry={makeEntry({ display_tier: undefined, content: words, summaries: structured })} />);
    const link = screen.getByRole('button', { name: 'Read full statement (≈180 words)' });
    expect(link).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking it shows this card in full: an override, because the debate is on Brief', async () => {
    const user = userEvent.setup();
    debateState.defaultDisplayTier = 'brief';
    render(<StatementCard entry={makeEntry({ display_tier: undefined, content: words, summaries: structured })} />);
    await user.click(screen.getByRole('button', { name: /Read full statement/ }));
    expect(debateState.setEntryDisplayTier).toHaveBeenCalledWith('e1', 'detailed');
  });

  it('Full: the link reads "Show brief" and is expanded; clicking it goes back to the debate-wide Brief by clearing the override', async () => {
    const user = userEvent.setup();
    debateState.defaultDisplayTier = 'medium';
    render(<StatementCard entry={makeEntry({ display_tier: 'detailed', content: words, summaries: structured })} />);
    const link = screen.getByRole('button', { name: 'Show brief' });
    expect(link).toHaveAttribute('aria-expanded', 'true');
    await user.click(link);
    expect(debateState.setEntryDisplayTier).toHaveBeenCalledWith('e1', undefined);
  });

  it('when the debate is on Full, cards read "Show brief", and clicking sets this card to Brief', async () => {
    const user = userEvent.setup();
    debateState.defaultDisplayTier = 'detailed';
    render(<StatementCard entry={makeEntry({ display_tier: undefined, content: words, summaries: structured })} />);
    await user.click(screen.getByRole('button', { name: 'Show brief' }));
    expect(debateState.setEntryDisplayTier).toHaveBeenCalledWith('e1', 'brief');
  });

  it('no link when there is nothing shorter to show, or off the Statement tab', () => {
    const first = render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: 'One sentence only.' })} />);
    expect(screen.queryByRole('button', { name: /Read full statement|Show brief/ })).toBeNull();
    first.unmount();
    render(<StatementCard entry={makeEntry({ display_tier: 'why', content: words, summaries: structured })} />);
    expect(screen.queryByRole('button', { name: /Read full statement|Show brief/ })).toBeNull();
  });

  it('the old "... show full" control is gone', () => {
    render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG })} />);
    expect(screen.queryByText('... show full')).toBeNull();
  });
});

describe('§4 tabs say what is behind them', () => {
  const ref = (id: string) => ({ node_id: id, relevance: 'r' }) as unknown as TranscriptEntry['taxonomy_refs'][number];

  it('Statement / Why · N sources / How, counting taxonomy and policy refs', () => {
    render(<StatementCard entry={makeEntry({ taxonomy_refs: [ref('acc-beliefs-001'), ref('acc-desires-002')], policy_refs: ['pol-001'] })} />);
    expect(screen.getAllByRole('radio').map(r => r.textContent)).toEqual(['Statement', 'Why · 3 sources', 'How']);
  });

  it('one source is singular; none is a bare Why', () => {
    const first = render(<StatementCard entry={makeEntry({ taxonomy_refs: [ref('acc-beliefs-001')] })} />);
    expect(screen.getAllByRole('radio')[1].textContent).toBe('Why · 1 source');
    first.unmount();
    render(<StatementCard entry={makeEntry()} />);
    expect(screen.getAllByRole('radio')[1].textContent).toBe('Why');
  });
});

describe('§5 plain header', () => {
  it('reads "{Speaker} · {Kind}", with the ids in the title and the stmt- anchor kept', () => {
    debateState.activeDebate = { transcript: [], speaker_models: {}, argument_network: { nodes: [{ id: 'AN-1', source_entry_id: 'e1' }] } } as unknown as typeof debateState.activeDebate;
    const { container } = render(<StatementCard entry={makeEntry({ type: 'opening' })} statementId="S2" />);
    const kind = container.querySelector('.debate-statement-kind') as HTMLElement;
    expect(container.querySelector('.debate-statement-speaker')?.textContent).toBe('Accelerationist');
    expect(kind.textContent).toBe('· Opening statement');
    expect(kind.getAttribute('title')).toBe('Statement S2 · argument node AN-1');
    expect(kind.id).toBe('stmt-S2');
    // The ids are not visible text anywhere in the header.
    const header = container.querySelector('.debate-statement-header') as HTMLElement;
    expect(header.textContent).not.toMatch(/S2|AN-1/);
    debateState.activeDebate = { transcript: [], speaker_models: {} };
  });

  it.each([
    ['opening', 'Opening statement'], ['statement', 'Response'], ['question', 'Question'],
    ['intervention', 'Intervention'], ['reflection', 'Reflection'], ['answer', 'Answer'],
  ])('%s reads %s', (type, label) => {
    const { container } = render(<StatementCard entry={makeEntry({ type: type as TranscriptEntry['type'] })} />);
    expect(container.querySelector('.debate-statement-kind')?.textContent).toBe(`· ${label}`);
  });

  it('the Synthesis card keeps its eyebrow', () => {
    const { container } = render(<StatementCard entry={makeEntry({ type: 'concluding' })} statementId="S9" />);
    expect(container.querySelector('.concluding-eyebrow')?.textContent).toBe('Synthesis');
    expect(container.querySelector('.debate-statement-kind')).toBeNull();
  });
});

describe('§6 turn symbols', () => {
  const metadata = { turn_symbols: [{ symbol: '🔁', tooltip: 'Swap the default.' }, { symbol: '📊', tooltip: 'Evidence decides.' }] };

  it('sit in the header as named images, with the analogy as the title', () => {
    const { container } = render(<StatementCard entry={makeEntry({ metadata })} />);
    const symbols = container.querySelectorAll('.debate-statement-header .debate-turn-symbol');
    expect(symbols).toHaveLength(2);
    expect(screen.getByRole('img', { name: 'Swap the default.' }).textContent).toBe('🔁');
    expect(symbols[1].getAttribute('title')).toBe('Evidence decides.');
  });

  it('are not a control: a click opens no list', async () => {
    const user = userEvent.setup();
    const { container } = render(<StatementCard entry={makeEntry({ metadata })} />);
    await user.click(screen.getByRole('img', { name: 'Swap the default.' }));
    expect(container.querySelector('.debate-turn-symbol-tooltips')).toBeNull();
    expect(screen.queryByText(/🔁 — /)).toBeNull();
  });
});

describe('§7 tagline (as corrected in t/701#4)', () => {
  it('an old brief string loses its Tagline line entirely', () => {
    const summaries = { brief: 'The bench has not proved its payoff. Tagline: Decades of habit, little proof.', medium: 'm' };
    render(<StatementCard entry={makeEntry({ display_tier: 'brief', content: LONG, summaries })} />);
    expect(screen.getByTestId('markdown').textContent).toBe('The bench has not proved its payoff.');
  });

  it('Full text is not touched', () => {
    const content = 'A statement. Tagline: this stays as written.';
    render(<StatementCard entry={makeEntry({ display_tier: 'detailed', content })} />);
    expect(screen.getByTestId('markdown').textContent).toBe(content);
  });
});

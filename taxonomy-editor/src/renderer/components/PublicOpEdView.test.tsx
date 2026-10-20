// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the public read-only op-ed share view (t/2728, sibling of PublicPovView).
// The load-bearing assertions are the TL binding invariants (t/1787#2): NO session
// is minted (raw fetch, no `/api/auth/anonymous`), and the view is read-only.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockRecord = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

const { PublicOpEdView, shareIdFromOpEdPath } = await import('./PublicOpEdView');

interface FakeResponseInit { status?: number; body?: unknown }
function fakeResponse({ status = 200, body = {} }: FakeResponseInit): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SHARE_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const SAMPLE = {
  schema_version: 1 as const,
  shareId: SHARE_ID,
  topic: 'The pace of AI capability',
  outlet: 'The Atlantic',
  created_at: '2026-08-17T00:00:00Z',
  opeds: [
    { pov: 'acc', status: 'complete', headline: 'Ship the future', subtitle: 'Why acceleration wins', body: 'Accelerate now, the body argues.', wordCount: 800 },
    { pov: 'saf', status: 'failed', headline: '', subtitle: '', body: '', wordCount: 0 },
  ],
};

function goTo(pathname: string): void {
  window.history.pushState({}, '', pathname);
}

describe('shareIdFromOpEdPath', () => {
  it('extracts a valid shareId (uuid), with or without trailing slash', () => {
    expect(shareIdFromOpEdPath(`/share/oped/${SHARE_ID}`)).toBe(SHARE_ID);
    expect(shareIdFromOpEdPath(`/share/oped/${SHARE_ID}/`)).toBe(SHARE_ID);
  });
  it('returns null for non-share or malformed paths', () => {
    expect(shareIdFromOpEdPath('/')).toBeNull();
    expect(shareIdFromOpEdPath('/share/oped/')).toBeNull();
    expect(shareIdFromOpEdPath('/share/oped/a b')).toBeNull();
    expect(shareIdFromOpEdPath('/share/oped/../etc')).toBeNull();
    expect(shareIdFromOpEdPath('/share/pov/acc-Beliefs-001')).toBeNull();
  });
});

describe('PublicOpEdView (t/2728)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goTo(`/share/oped/${SHARE_ID}`);
  });
  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('fetches via a raw GET to the public endpoint — no session minted', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicOpEdView />);

    await screen.findByText(SAMPLE.topic);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/public/oped/${SHARE_ID}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });

    // The binding invariant: the session-recovery path is NEVER touched.
    const hitAnonymous = mockFetch.mock.calls.some(([u]) => String(u).includes('/api/auth/anonymous'));
    expect(hitAnonymous).toBe(false);
  });

  it('renders the shared set read-only (topic, complete voice on the default tab; no inputs/buttons)', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicOpEdView />);

    await screen.findByText(SAMPLE.topic);
    expect(screen.getByText('For The Atlantic')).toBeInTheDocument();
    expect(screen.getByText('Ship the future')).toBeInTheDocument();
    expect(screen.getByText('Why acceleration wins')).toBeInTheDocument();
    expect(screen.getByText('Accelerate now, the body argues.')).toBeInTheDocument();

    // Read-only: no plain inputs/buttons on the public path — tab controls carry an explicit
    // role="tab", not "button", so they don't trip this invariant.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  // t/3485: PI feedback on the deployed t/3477 fix — stacking traded one burial (situation
  // wall) for another (only the first op-ed visible, no indication two more exist).
  describe('camp tabs (t/3485)', () => {
    it('shows a tab per voice and defaults to the first (no scrolling needed to discover the rest)', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
      expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
      // The failed voice's notice is NOT in the initial (first-tab) panel.
      expect(screen.queryByText(/failed to generate/)).toBeNull();
    });

    it('switches panels on click — the failed-voice notice appears behind its own tab', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
      const user = userEvent.setup();
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      const tabs = screen.getAllByRole('tab');
      await user.click(tabs[1]);

      expect(screen.getByText(/failed to generate/)).toBeInTheDocument();
      expect(screen.queryByText('Accelerate now, the body argues.')).toBeNull();
      expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    });

    it('supports ArrowRight/ArrowLeft keyboard navigation between tabs', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
      const user = userEvent.setup();
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      const tabs = screen.getAllByRole('tab');
      tabs[0].focus();
      await user.keyboard('{ArrowRight}');
      expect(screen.getByText(/failed to generate/)).toBeInTheDocument();
      await user.keyboard('{ArrowLeft}');
      expect(screen.getByText('Accelerate now, the body argues.')).toBeInTheDocument();
    });

    it('renders no tab strip for a single-voice set (matches the in-app ruling, t/2576#3)', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: { ...SAMPLE, opeds: [SAMPLE.opeds[0]] } }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      expect(screen.queryByRole('tab')).toBeNull();
      expect(screen.getByText('Ship the future')).toBeInTheDocument();
    });
  });

  // t/3489: grounding chips + detail cards from projection-embedded snapshots (SO-approved
  // contract, t/3487#1). Locks version tolerance, ref-without-snapshot omission, and the
  // "grounding as of" snapshot-semantics label.
  describe('grounding chips + detail cards (t/3489)', () => {
    const GROUNDED_SAMPLE = {
      ...SAMPLE,
      grounded_at: '2026-09-01T00:00:00Z',
      grounding_nodes: {
        'acc-beliefs-001': {
          id: 'acc-beliefs-001', label: 'Acceleration compounds safety', pov: 'acc',
          category: 'beliefs', description_excerpt: 'Faster iteration surfaces failure modes sooner.',
        },
      },
      opeds: [
        {
          ...SAMPLE.opeds[0],
          grounding: [
            { node_id: 'acc-beliefs-001', label: 'Acceleration compounds safety', category: 'beliefs', pov: 'acc', relevance: 'high', how_reflected: 'Cited directly in paragraph 2.' },
            { node_id: 'acc-beliefs-999-retired', label: 'stale', category: 'beliefs', pov: 'acc', relevance: 'low', how_reflected: 'no longer resolvable' },
          ],
        },
        SAMPLE.opeds[1],
      ],
    };

    it('renders a chip for a resolvable ref and the "grounding as of" date label', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: GROUNDED_SAMPLE }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      expect(screen.getByText('Acceleration compounds safety')).toBeInTheDocument();
      expect(screen.getByText(/grounding as of/i)).toBeInTheDocument();
    });

    it('omits a ref with no matching snapshot — no error, no partial chip', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: GROUNDED_SAMPLE }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      // Only ONE chip renders (the resolvable ref) — the retired ref is silently omitted.
      const chips = screen.getAllByRole('button', { name: 'Acceleration compounds safety' });
      expect(chips).toHaveLength(1);
      expect(screen.queryByText('stale')).toBeNull();
      expect(screen.queryByText(/acc-beliefs-999-retired/)).toBeNull();
    });

    it('clicking a chip opens a detail card with the snapshot fields + how_reflected; click again closes it', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: GROUNDED_SAMPLE }));
      const user = userEvent.setup();
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      const chip = screen.getByRole('button', { name: 'Acceleration compounds safety' });
      expect(chip).toHaveAttribute('aria-expanded', 'false');

      await user.click(chip);
      expect(chip).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByText('acc-beliefs-001')).toBeInTheDocument();
      expect(screen.getByText('beliefs · acc')).toBeInTheDocument();
      expect(screen.getByText('Faster iteration surfaces failure modes sooner.')).toBeInTheDocument();
      expect(screen.getByText('Cited directly in paragraph 2.')).toBeInTheDocument();

      await user.click(chip);
      expect(chip).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('Faster iteration surfaces failure modes sooner.')).toBeNull();
    });

    it('version tolerance: an old projection with no grounding fields renders exactly as before, no section, no errors', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      expect(screen.queryByText(/grounding as of/i)).toBeNull();
      expect(screen.queryByText(/^Grounding$/)).toBeNull();
      expect(mockRecord).not.toHaveBeenCalled();
    });

    it('a member with an empty grounding array also renders no section', async () => {
      mockFetch.mockResolvedValue(fakeResponse({ body: { ...SAMPLE, opeds: [{ ...SAMPLE.opeds[0], grounding: [] }, SAMPLE.opeds[1]] } }));
      render(<PublicOpEdView />);
      await screen.findByText(SAMPLE.topic);

      expect(screen.queryByText(/^Grounding$/)).toBeNull();
    });
  });

  it('leads with the op-eds — the situation topic renders after them, not as the lead heading (t/3477)', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicOpEdView />);

    const headline = await screen.findByText('Ship the future');
    const topic = screen.getByText(SAMPLE.topic);

    // DOCUMENT_POSITION_FOLLOWING (4): topic comes after the op-ed headline in source order.
    expect(headline.compareDocumentPosition(topic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('shows a not-found state on 404 without erroring', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ status: 404 }));
    render(<PublicOpEdView />);
    await screen.findByText('Not available');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not fetch for a malformed shareId', async () => {
    goTo('/share/oped/..');
    render(<PublicOpEdView />);
    await screen.findByText('Not available');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows an error state and records to the flight recorder on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    render(<PublicOpEdView />);
    await screen.findByText(/Couldn’t load this op-ed/);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system.error', component: 'PublicOpEdView', level: 'error' }),
    );
  });

  it('aborts the in-flight fetch when the component unmounts (t/2755)', async () => {
    let resolveResponse!: (r: Response) => void;
    mockFetch.mockReturnValue(new Promise(res => { resolveResponse = res; }));

    const { unmount } = render(<PublicOpEdView />);
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const signal = mockFetch.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);

    // Regression guard: cleanup must call controller.abort(), not merely
    // clearTimeout (which would suppress the timer-driven abort).
    unmount();
    expect(signal.aborted).toBe(true);

    resolveResponse(fakeResponse({ body: SAMPLE }));
  });
});

// t/3992 (t/3990 projection): a shared one-wing op-ed says so. The projection carries counts but no
// label, so the wing name comes from the committed registry (skeptic "critical", t/3956).
describe('PublicOpEdView — wing scope (t/3992)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goTo(`/share/oped/${SHARE_ID}`);
  });
  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });
  const share = (tag?: Record<string, unknown>) => ({
    ...SAMPLE,
    opeds: [{ ...SAMPLE.opeds[0], pov: 'skeptic', ...(tag ? { tag } : {}) }],
  });

  it('a Scope member shows the wing and the excluded count', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: share({ pov: 'skeptic', tag: 'critical', mode: 'scope', included: 12, excludedUntagged: 31 }) }));
    render(<PublicOpEdView />);
    await screen.findByText(SAMPLE.topic);
    expect(screen.getByText('Skeptic · Critical wing (scope; 31 not tagged Critical excluded)')).toBeInTheDocument();
  });

  it('a Prioritize member shows no count (0 by construction would read as full coverage)', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: share({ pov: 'skeptic', tag: 'critical', mode: 'prioritize', included: 12, excludedUntagged: 0 }) }));
    render(<PublicOpEdView />);
    await screen.findByText(SAMPLE.topic);
    expect(screen.getByText('Skeptic · Critical wing (prioritized)')).toBeInTheDocument();
    expect(screen.queryByText(/not tagged .* excluded/)).toBeNull();
  });

  it('an untagged member, or a share projected before t/3990, shows no scope line', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: share() }));
    render(<PublicOpEdView />);
    await screen.findByText(SAMPLE.topic);
    expect(screen.queryByText(/ wing \(/)).toBeNull();
  });

  it('a tag the registry no longer lists shows its id instead of failing the page', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: share({ pov: 'skeptic', tag: 'retired-wing', mode: 'scope', included: 5, excludedUntagged: 2 }) }));
    render(<PublicOpEdView />);
    await screen.findByText(SAMPLE.topic);
    expect(screen.getByText('Skeptic · retired-wing wing (scope; 2 not tagged retired-wing excluded)')).toBeInTheDocument();
  });
});

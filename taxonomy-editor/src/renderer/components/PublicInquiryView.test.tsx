// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the public read-only inquiry share view (t/3628, sibling of PublicOpEdView).
// The load-bearing assertions are the TL binding invariants (t/1787#2): NO session
// is minted (raw fetch, no `/api/auth/anonymous`), and the view is read-only. Also
// locks the SO must-include fields (t/3628#2): singleRunCaveat, TrustState.reason,
// fidelity/model/rounds provenance.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mockRecord = vi.fn();
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.stubGlobal('fetch', mockFetch);

const { PublicInquiryView, shareIdFromInquiryPath } = await import('./PublicInquiryView');

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
  version: 1 as const,
  request: { question: 'What counts as an AI harm?', fidelity: 'standard' as const },
  campVerdicts: [
    { camp: 'acc' as const, verdict: 'Harm requires realized, measurable damage.', nodes: [{ label: 'Move fast', camp: 'acc' as const }] },
  ],
  convergences: [
    { claim: 'All camps agree intent matters less than outcome.', nodes: [] },
  ],
  evidenceLayers: [
    { title: 'Baseline framing', role: 'grounds the debate', solves: 'defines harm', sources: ['https://example.com/paper'] },
  ],
  unresolvedGaps: [
    { description: 'No consensus on counterfactual harm.', confidence: 'low' },
  ],
  calibration: [
    { metric: 'engagement', value: 0.8, displayValue: '80%', trust: { verdict: 'trusted' as const, reason: 'Both camps directly rebutted the crux.' } },
  ],
  derivation: { fidelity: 'standard' as const, models: { debaters: 'claude-sonnet-5', evaluator: 'claude-opus-5' }, rounds: 4 },
  grounding: { nodesByCamp: {} },
  singleRunCaveat: 'This is one run of a stochastic process, not a repeated-measures finding.',
};

function goTo(pathname: string): void {
  window.history.pushState({}, '', pathname);
}

describe('shareIdFromInquiryPath', () => {
  it('extracts a valid shareId (uuid), with or without trailing slash', () => {
    expect(shareIdFromInquiryPath(`/inquiries/${SHARE_ID}`)).toBe(SHARE_ID);
    expect(shareIdFromInquiryPath(`/inquiries/${SHARE_ID}/`)).toBe(SHARE_ID);
  });
  it('returns null for non-share or malformed paths', () => {
    expect(shareIdFromInquiryPath('/')).toBeNull();
    expect(shareIdFromInquiryPath('/inquiries/')).toBeNull();
    expect(shareIdFromInquiryPath('/inquiries/a b')).toBeNull();
    expect(shareIdFromInquiryPath('/inquiries/../etc')).toBeNull();
    expect(shareIdFromInquiryPath('/share/oped/set-1')).toBeNull();
  });
});

describe('PublicInquiryView (t/3628)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    goTo(`/inquiries/${SHARE_ID}`);
  });
  afterEach(() => {
    goTo('/');
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  it('fetches via a raw GET to the public endpoint — no session minted', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicInquiryView />);

    await screen.findByText(SAMPLE.request.question);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`/api/public/inquiry/${SHARE_ID}`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store' });

    // The binding invariant: the session-recovery path is NEVER touched.
    const hitAnonymous = mockFetch.mock.calls.some(([u]) => String(u).includes('/api/auth/anonymous'));
    expect(hitAnonymous).toBe(false);
  });

  it('renders the shared question read-only (question, provenance, camp verdict, caveat; no inputs/buttons)', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicInquiryView />);

    await screen.findByText(SAMPLE.request.question);
    expect(screen.getByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-5')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-5')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('Harm requires realized, measurable damage.')).toBeInTheDocument();
    expect(screen.getByText(SAMPLE.singleRunCaveat)).toBeInTheDocument();

    expect(screen.queryByRole('textbox')).toBeNull();
    // t/280: the How disclosure is a read-only control (it expands methods links only), so it is the one
    // button this view may show. Matched by role and name, and the list must be exactly that button: any
    // other button fails here.
    const howDisclosure = screen.getByRole('button', { name: /How/ });
    expect(screen.getAllByRole('button')).toEqual([howDisclosure]);
  });

  // SO review must-includes (t/3628#2) — omitting these would let a reader unfamiliar with
  // the Ask screen misread the answer.
  it('renders TrustState.reason verbatim, not just the verdict badge', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ body: SAMPLE }));
    render(<PublicInquiryView />);

    await screen.findByText(SAMPLE.request.question);
    expect(screen.getByText('Both camps directly rebutted the crux.')).toBeInTheDocument();
    expect(screen.getByText('trust')).toBeInTheDocument();
  });

  // Adjacency (t/3734, SO condition via t/3667#6) — end-to-end through the real fetch→render
  // path, since PublicInquiryView.tsx itself has no template and only proves the fix by way of
  // the component it delegates to (PublicInquiryShareContent.tsx).
  it('renders synthesizedHeadline immediately adjacent to singleRunCaveat', async () => {
    const WITH_HEADLINE = { ...SAMPLE, synthesizedHeadline: 'Camps converge on outcome, diverge on intent.' };
    mockFetch.mockResolvedValue(fakeResponse({ body: WITH_HEADLINE }));
    render(<PublicInquiryView />);

    await screen.findByText(SAMPLE.request.question);
    const headline = screen.getByText(WITH_HEADLINE.synthesizedHeadline);
    const caveat = screen.getByText(SAMPLE.singleRunCaveat, { exact: false });
    expect(headline.parentElement).toBe(caveat.parentElement);
    expect(caveat.previousElementSibling).toBe(headline);
  });

  it('shows a zero-result banner when campVerdicts/convergences/evidenceLayers are all empty', async () => {
    const ZERO = { ...SAMPLE, campVerdicts: [], convergences: [], evidenceLayers: [] };
    mockFetch.mockResolvedValue(fakeResponse({ body: ZERO }));
    render(<PublicInquiryView />);

    await screen.findByText(SAMPLE.request.question);
    expect(screen.getByText('NO RESULT')).toBeInTheDocument();
  });

  it('shows a not-found state on 404 without erroring', async () => {
    mockFetch.mockResolvedValue(fakeResponse({ status: 404 }));
    render(<PublicInquiryView />);
    await screen.findByText('Not available');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not fetch for a malformed shareId', async () => {
    goTo('/inquiries/..');
    render(<PublicInquiryView />);
    await screen.findByText('Not available');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows an error state and records to the flight recorder on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    render(<PublicInquiryView />);
    await screen.findByText(/Couldn’t load this question/);
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system.error', component: 'PublicInquiryView', level: 'error' }),
    );
  });

  it('aborts the in-flight fetch when the component unmounts (mirrors t/2755)', async () => {
    let resolveResponse!: (r: Response) => void;
    mockFetch.mockReturnValue(new Promise(res => { resolveResponse = res; }));

    const { unmount } = render(<PublicInquiryView />);
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const signal = mockFetch.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal).toBeDefined();
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);

    resolveResponse(fakeResponse({ body: SAMPLE }));
  });
});

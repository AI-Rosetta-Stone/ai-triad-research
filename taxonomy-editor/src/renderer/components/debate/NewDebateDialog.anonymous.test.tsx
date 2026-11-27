// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/725 (t/723; Design t/725#3, p/25#221): an anonymous visitor runs Quick take debates only. Deep dive and Socratic
// are visible but not selectable, and Customise fixes rounds, protocol and step mode while model, temperature and
// tags stay live. Signed-in users see no change.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ anonymous: false, createDebate: vi.fn() }));

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow: vi.fn() }),
}));
vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
  isFreeTier: () => false,
}));
vi.mock('../../hooks/useDebateStore', () => {
  const hook = () => ({ createDebate: h.createDebate, loadDebate: vi.fn() });
  hook.getState = () => ({ updatePhase: vi.fn(), saveDebate: vi.fn().mockResolvedValue(undefined) });
  return { useDebateStore: hook };
});
vi.mock('../../hooks/useTaxonomyStore', () => {
  const hook = () => ({ aiBackend: 'gemini', geminiModel: 'gemini-flash', situations: [] });
  hook.getState = () => ({});
  return {
    useTaxonomyStore: hook,
    MODELS_BY_BACKEND: { gemini: [{ value: 'gemini-flash', label: 'Flash' }] },
    AI_BACKENDS: [{ value: 'gemini', label: 'Gemini' }],
    DEBATE_TIERS: [],
    FALLBACK_CHAINS: {},
    initAIModels: vi.fn().mockResolvedValue(undefined),
    backendForModel: () => 'gemini',
    backendForModelWithFallback: () => 'gemini',
  };
});
vi.mock('@bridge', () => ({
  api: {
    hasApiKey: vi.fn().mockResolvedValue(true),
    getAvailableBackends: vi.fn().mockResolvedValue([]),
    refreshAIModels: vi.fn().mockResolvedValue(undefined),
    generateText: vi.fn().mockResolvedValue({ text: '' }),
    pickDocumentFile: vi.fn(),
    fetchUrlContent: vi.fn(),
    openDebateWindow: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../settings/GeminiOnboardingModal', () => ({ GeminiOnboardingModal: () => null }));
vi.mock('../../hooks/useAuthStatus', () => ({
  useAuthStatus: () => ({ anonymous: h.anonymous }),
  useUserProfile: () => null,
}));
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
});

const { NewDebateDialog } = await import('./NewDebateDialog');

const card = (name: RegExp) => screen.getByRole('radio', { name });
const PRESET_LINE = 'Without signing in, you can run Quick take debates.';
const CUSTOMISE_LINE = 'Without signing in, debates are Quick take only, so rounds and protocol are fixed.';

beforeEach(() => {
  vi.clearAllMocks();
  h.anonymous = false;
  h.createDebate.mockResolvedValue('deb-1');
  localStorage.clear();
});

describe('NewDebateDialog — preset cards for an anonymous visitor (t/725)', () => {
  it('selects Quick take; Deep dive and Socratic are aria-disabled, focusable, and say "Sign in to use"', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    expect(card(/Quick take/).getAttribute('aria-checked')).toBe('true');
    for (const name of [/Deep dive/, /Socratic/]) {
      const c = card(name);
      expect(c.getAttribute('aria-disabled')).toBe('true');
      expect(c.getAttribute('aria-checked')).toBe('false');
      expect(c.hasAttribute('tabindex')).toBe(true); // focusable, never `disabled`
      expect(within(c).getByText('Sign in to use')).toBeTruthy();
      expect(within(c).queryByText(/min$/)).toBeNull();
    }
    expect(within(card(/Quick take/)).getByText('~4 min')).toBeTruthy();
  });

  it('clicking a locked card does nothing', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(card(/Deep dive/));
    fireEvent.click(card(/Socratic/));
    expect(card(/Quick take/).getAttribute('aria-checked')).toBe('true');
    expect(card(/Deep dive/).getAttribute('aria-checked')).toBe('false');
    expect(card(/Socratic/).getAttribute('aria-checked')).toBe('false');
  });

  it('arrow keys never select a locked card', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.keyDown(card(/Quick take/), { key: 'ArrowRight' });
    expect(card(/Quick take/).getAttribute('aria-checked')).toBe('true');
    expect(card(/Deep dive/).getAttribute('aria-checked')).toBe('false');
  });

  it('shows the group line with both sign-in links', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    expect(screen.getByText(PRESET_LINE)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in with GitHub' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in with Google' })).toBeTruthy();
  });

  it('a signed-in user sees no lock, no line, and the time estimates', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    expect(screen.queryByText(PRESET_LINE)).toBeNull();
    expect(screen.queryByText('Sign in to use')).toBeNull();
    expect(card(/Deep dive/).getAttribute('aria-disabled')).toBeNull();
    expect(within(card(/Deep dive/)).getByText('~12 min')).toBeTruthy();
    fireEvent.click(card(/Deep dive/));
    expect(card(/Deep dive/).getAttribute('aria-checked')).toBe('true');
  });

  it('a session that turns out to be anonymous after a Deep dive was chosen puts the dialog back on Quick take', () => {
    const view = render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(card(/Deep dive/));
    expect(card(/Deep dive/).getAttribute('aria-checked')).toBe('true');
    h.anonymous = true;
    view.rerender(<NewDebateDialog onClose={() => {}} />);
    expect(card(/Quick take/).getAttribute('aria-checked')).toBe('true');
    expect(card(/Deep dive/).getAttribute('aria-checked')).toBe('false');
  });
});

describe('NewDebateDialog — Customise for an anonymous visitor (t/725)', () => {
  const openFormat = () => fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }));

  it('fixes protocol, rounds and step mode under the line, and leaves model, temperature and tags live', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    openFormat();
    expect(screen.getByText(CUSTOMISE_LINE)).toBeTruthy();
    const protocol = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(protocol.getAttribute('aria-disabled')).toBe('true');
    expect(protocol.disabled).toBe(false); // focusable
    expect(protocol.getAttribute('aria-describedby')).toBe('ndd-anon-customise-note');
    const rounds = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    expect(rounds).toHaveLength(3);
    for (const r of rounds) {
      expect(r.getAttribute('aria-disabled')).toBe('true');
      expect(r.readOnly).toBe(true);
    }
    const step = screen.getByLabelText(/Pause between phases/) as HTMLInputElement;
    expect(step.getAttribute('aria-disabled')).toBe('true');
    // the dialectical style radios are not something the server refuses: still live
    expect(screen.getAllByRole('radio', { name: /./ }).some(r => (r as HTMLInputElement).name === 'ndd-style' && !r.getAttribute('aria-disabled'))).toBe(true);
  });

  it('typing in a fixed control changes nothing', () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    openFormat();
    const protocol = screen.getByLabelText('Protocol') as HTMLSelectElement;
    const before = protocol.value;
    fireEvent.change(protocol, { target: { value: 'deliberation' } });
    expect(protocol.value).toBe(before);
    const first = (screen.getAllByRole('spinbutton') as HTMLInputElement[])[1];
    fireEvent.change(first, { target: { value: '5' } });
    expect(first.value).toBe('1');
    const step = screen.getByLabelText(/Pause between phases/) as HTMLInputElement;
    fireEvent.click(step);
    expect(step.checked).toBe(false);
  });

  it('a signed-in user can change protocol, rounds and step mode, with no line', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    openFormat();
    expect(screen.queryByText(CUSTOMISE_LINE)).toBeNull();
    const protocol = screen.getByLabelText('Protocol') as HTMLSelectElement;
    expect(protocol.getAttribute('aria-disabled')).toBeNull();
    fireEvent.change(protocol, { target: { value: 'deliberation' } });
    expect(protocol.value).toBe('deliberation');
    const first = (screen.getAllByRole('spinbutton') as HTMLInputElement[])[1];
    fireEvent.change(first, { target: { value: '5' } });
    expect(first.value).toBe('5');
    const step = screen.getByLabelText(/Pause between phases/) as HTMLInputElement;
    fireEvent.click(step);
    expect(step.checked).toBe(true);
  });
});

describe('NewDebateDialog — an anonymous start sends a Quick take (t/725)', () => {
  it('creates with the structured protocol and 1/1/1 rounds, no step mode', async () => {
    h.anonymous = true;
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: /topic/i }), { target: { value: 'Should labs publish evaluations?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    await waitFor(() => expect(h.createDebate).toHaveBeenCalledTimes(1));
    const args = h.createDebate.mock.calls[0];
    expect(args[7]).toBe('structured'); // protocolId
    const options = args[10] as { phaseBoundsOverride?: Record<string, number>; stepMode?: boolean } | undefined;
    expect(options?.phaseBoundsOverride).toEqual({ maxConfrontationRounds: 1, maxArgumentationRounds: 1, maxConcludingRounds: 1 });
    expect(options?.stepMode).toBeFalsy();
  });
});

describe('NewDebateDialog — a refused start shows the line, never the server text (t/725)', () => {
  const refused = (body: Record<string, unknown>, status = 403) =>
    h.createDebate.mockRejectedValue(Object.assign(new Error('SERVER SENTENCE'), {
      httpStatus: status,
      problem: `PUT /api/debates failed with HTTP ${status}: ${JSON.stringify({ error: 'SERVER SENTENCE', ...body })}`,
    }));
  const start = async () => {
    fireEvent.change(screen.getByRole('textbox', { name: /topic/i }), { target: { value: 'Should labs publish evaluations?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
  };

  it('403 anon_debate_kind: the Deep dive line with both sign-in links', async () => {
    h.anonymous = true;
    refused({ reason: 'anon_limit', code: 'anon_debate_kind', signInRequired: true });
    render(<NewDebateDialog onClose={() => {}} />);
    await start();
    await waitFor(() => expect(screen.getByText('Sign in to run Deep dive and Socratic debates.')).toBeTruthy());
    expect(within(screen.getByRole('alert')).getByRole('link', { name: 'Sign in with GitHub' })).toBeTruthy();
    expect(within(screen.getByRole('alert')).getByRole('link', { name: 'Sign in with Google' })).toBeTruthy();
    expect(screen.queryByText(/SERVER SENTENCE/)).toBeNull();
  });

  it('403 anon_debate_daily: the per-day line', async () => {
    h.anonymous = true;
    refused({ reason: 'anon_limit', code: 'anon_debate_daily' });
    render(<NewDebateDialog onClose={() => {}} />);
    await start();
    await waitFor(() => expect(screen.getByText("You've started all the debates allowed per day without signing in. Sign in to start more, or try again tomorrow.")).toBeTruthy());
  });

  it('403 anon_debate_unsaved: plain text, no sign-in links (signing in does not fix it)', async () => {
    h.anonymous = true;
    refused({ reason: 'anon_limit', code: 'anon_debate_unsaved' });
    render(<NewDebateDialog onClose={() => {}} />);
    await start();
    await waitFor(() => expect(screen.getByText("This debate couldn't be saved, so it can't continue. Try starting it again.")).toBeTruthy());
    expect(within(screen.getByRole('alert')).queryByRole('link')).toBeNull();
  });

  it('a start that fails for another reason keeps its own message', async () => {
    h.anonymous = true;
    h.createDebate.mockRejectedValue(new Error('disk full'));
    render(<NewDebateDialog onClose={() => {}} />);
    await start();
    await waitFor(() => expect(screen.getByText(/disk full/)).toBeTruthy());
  });
});

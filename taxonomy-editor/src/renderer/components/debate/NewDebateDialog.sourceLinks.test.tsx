// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4646: "Attach a document" / "Use a URL" moved from the bottom adders to two compact links
// under the Topic input (Design spec, t/4646#1). Reuses the mock scaffold from
// NewDebateDialog.prefill.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow: vi.fn() }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
  isFreeTier: () => false,
}));

vi.mock('../../hooks/useDebateStore', () => {
  const hook = () => ({ createDebate: vi.fn().mockResolvedValue('deb-1'), loadDebate: vi.fn() });
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
    DEBATE_TIERS: { basic: { gemini: 'gemini-flash' } },
    FALLBACK_CHAINS: {},
    initAIModels: vi.fn().mockResolvedValue(undefined),
    backendForModel: () => 'gemini',
    backendForModelWithFallback: () => 'gemini',
  };
});

vi.mock('@bridge', () => ({
  api: {
    hasApiKey: vi.fn().mockResolvedValue(true),
    getAvailableBackends: vi.fn().mockResolvedValue([{ id: 'gemini', available: true }]),
    refreshAIModels: vi.fn().mockResolvedValue(undefined),
    generateText: vi.fn().mockResolvedValue({ text: '' }),
    pickDocumentFile: vi.fn(),
    fetchUrlContent: vi.fn(),
    openDebateWindow: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../settings/GeminiOnboardingModal', () => ({ GeminiOnboardingModal: () => null }));

let mockAuth: { anonymous: boolean } = { anonymous: false };
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => mockAuth, useUserProfile: () => null }));

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

const { NewDebateDialog } = await import('./NewDebateDialog');

describe('NewDebateDialog — source links under Topic (t/4646)', () => {
  beforeEach(() => { mockAuth = { anonymous: false }; });
  afterEach(() => { vi.clearAllMocks(); });

  it('shows the links under the topic, and no bottom "+ Use a document or URL" adder', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    expect(screen.getByText('Or debate a source instead of a topic:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach a document' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a URL' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Use a document or URL/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add background context' })).toBeInTheDocument();
  });

  it('"Attach a document" enters source mode on the document tab', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach a document' }));
    expect(screen.getByText('Source (replaces the topic)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Document' })).toHaveClass('active');
    expect(screen.getByText('The debaters will argue over what this document claims.')).toBeInTheDocument();
  });

  it('"Use a URL" enters source mode on the URL tab for a signed-in user', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a URL' }));
    expect(screen.getByText('Source (replaces the topic)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'URL' })).toHaveClass('active');
    expect(screen.getByText('The debaters will argue over what this page claims.')).toBeInTheDocument();
  });

  it('anonymous: "Use a URL" is aria-disabled with a sign-in note, and does not enter source mode', () => {
    mockAuth = { anonymous: true };
    render(<NewDebateDialog onClose={() => {}} />);
    const urlLink = screen.getByRole('button', { name: 'Use a URL' });
    expect(urlLink).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('(sign in to use URLs)')).toBeInTheDocument();
    fireEvent.click(urlLink);
    expect(screen.queryByText('Source (replaces the topic)')).not.toBeInTheDocument();
  });

  it('anonymous: "Attach a document" still works normally', () => {
    mockAuth = { anonymous: true };
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach a document' }));
    expect(screen.getByText('Source (replaces the topic)')).toBeInTheDocument();
  });

  it('signed-in: no sign-in note is rendered', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    expect(screen.queryByText('(sign in to use URLs)')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use a URL' })).not.toHaveAttribute('aria-disabled');
  });

  it('"← Use topic instead" still reverts to the topic field', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Attach a document' }));
    fireEvent.click(screen.getByRole('button', { name: '← Use topic instead' }));
    expect(screen.queryByText('Source (replaces the topic)')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('What should the AI debate?')).toBeInTheDocument();
  });
});

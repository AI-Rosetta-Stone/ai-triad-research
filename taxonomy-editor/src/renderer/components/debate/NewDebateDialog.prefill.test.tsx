// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4563: initialTopic/initialPovers seed NewDebateDialog's state (mirrors NewChatDialog's
// initialMode/initialTopic). Reuses the mock scaffold proven in NewDebateDialog.eligibleBackends.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow: vi.fn() }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
  isFreeTier: () => false,
}));

const mockCreateDebate = vi.hoisted(() => vi.fn().mockResolvedValue('deb-1'));

vi.mock('../../hooks/useDebateStore', () => {
  const hook = () => ({ createDebate: mockCreateDebate, loadDebate: vi.fn() });
  hook.getState = () => ({ updatePhase: vi.fn(), saveDebate: vi.fn().mockResolvedValue(undefined) });
  return { useDebateStore: hook };
});

vi.mock('../../hooks/useTaxonomyStore', () => {
  const hook = () => ({ aiBackend: 'gemini', geminiModel: 'gemini-flash', situations: [] });
  hook.getState = () => ({});
  return {
    useTaxonomyStore: hook,
    MODELS_BY_BACKEND: { gemini: [{ value: 'gemini-flash', label: 'Flash' }] },
    AI_BACKENDS: [{ value: 'gemini', label: 'Gemini' }, { value: 'claude', label: 'Claude' }],
    DEBATE_TIERS: { basic: { gemini: 'gemini-flash', claude: 'claude-haiku' } },
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
vi.mock('../../hooks/useAuthStatus', () => ({ useAuthStatus: () => ({ anonymous: false }), useUserProfile: () => null }));

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

describe('NewDebateDialog — starter-chip prefill (t/4563)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockCreateDebate.mockResolvedValue('deb-1'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('seeds the topic field from initialTopic', () => {
    render(<NewDebateDialog onClose={() => {}} initialTopic="Does X cause Y?" />);
    expect(screen.getByPlaceholderText('What should the AI debate?')).toHaveValue('Does X cause Y?');
  });

  it('passes initialPovers through to createDebate as the debater set, in order', async () => {
    render(<NewDebateDialog onClose={() => {}} initialTopic="Does X cause Y?" initialPovers={['accelerationist', 'safetyist']} />);
    fireEvent.click(screen.getByRole('button', { name: /start debate/i }));

    await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
    const call = mockCreateDebate.mock.calls[0];
    expect(call[0]).toBe('Does X cause Y?');
    expect(call[1]).toEqual(['accelerationist', 'safetyist']);
  });

  it('control: omitted prefill keeps today\'s unprefilled defaults (empty topic, all three debaters)', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    expect(screen.getByPlaceholderText('What should the AI debate?')).toHaveValue('');
    fireEvent.change(screen.getByPlaceholderText('What should the AI debate?'), { target: { value: 'Does X cause Y?' } });
    fireEvent.click(screen.getByRole('button', { name: /start debate/i }));

    await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
    const call = mockCreateDebate.mock.calls[0];
    expect(call[1]).toEqual(['accelerationist', 'safetyist', 'skeptic']);
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// t/4773: the New Debate dialog's model choice is a single ModelPicker. The tier and
// multi-provider controls are gone, so a new debate must never send speakerModels,
// eligibleBackends or modelTier (sessionSlice still reads them for older debates only).
// This replaces NewDebateDialog.eligibleBackends.test.tsx (t/4046), whose multi-provider
// path no longer exists in this dialog.

const mockCreateDebate = vi.hoisted(() => vi.fn().mockResolvedValue('deb-1'));

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow: vi.fn() }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
  isFreeTier: () => false,
}));

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
    MODELS_BY_BACKEND: { gemini: [{ value: 'gemini-pro', label: 'Pro' }, { value: 'gemini-flash', label: 'Flash' }] },
    AI_BACKENDS: [{ value: 'gemini', label: 'Gemini' }],
    FALLBACK_CHAINS: {},
    initAIModels: vi.fn().mockResolvedValue(undefined),
    backendForModel: () => 'gemini',
    backendForModelWithFallback: () => 'gemini',
  };
});

vi.mock('../shared/ModelPicker', () => ({
  ModelPicker: () => null,
}));

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

vi.mock('../settings/GeminiOnboardingModal', () => ({
  GeminiOnboardingModal: () => null,
}));

vi.mock('../../hooks/useAuthStatus', () => ({
  useAuthStatus: () => ({ anonymous: false }),
  useUserProfile: () => null,
}));

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

// createDebate(topic, povers, userIsPover, sourceType, sourceRef, content, modelOverride, protocolId, temperature, audience, options)
const MODEL_OVERRIDE_ARG = 6;
const OPTIONS_ARG = 10;

function enterTopic() {
  fireEvent.change(screen.getByPlaceholderText('What should the AI debate?'), { target: { value: 'Does X cause Y?' } });
}

describe('NewDebateDialog — single model picker (t/4773)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockCreateDebate.mockResolvedValue('deb-1'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a default debate uses the global model and sends no multi-provider fields', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));

    await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
    const call = mockCreateDebate.mock.calls[0];
    expect(call[MODEL_OVERRIDE_ARG]).toBeUndefined();
    const options = call[OPTIONS_ARG];
    expect(options.speakerModels).toBeUndefined();
    expect(options.eligibleBackends).toBeUndefined();
    expect(options.modelTier).toBeUndefined();
  });

  it('ticking "Custom model" in settings sends that model as the override', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /model & providers/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /custom model/i }));
    fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));

    await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
    // The checkbox picks the family's first model (gemini-pro), which differs from the global gemini-flash.
    expect(mockCreateDebate.mock.calls[0][MODEL_OVERRIDE_ARG]).toBe('gemini-pro');
  });

  it('the multi-provider and tier controls are not rendered', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
    fireEvent.click(screen.getByRole('button', { name: /model & providers/i }));
    expect(screen.queryByRole('checkbox', { name: /multi-provider/i })).toBeNull();
    expect(screen.queryByText(/frontier model|basic model/i)).toBeNull();
  });
});

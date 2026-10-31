// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4717 (PI): "Model & providers" moved from third to last in the Debate settings sidebar.
// Panels are selected by id, so this pins only the display order and the by-id deep link —
// mirrors the mock scaffold proven in NewDebateDialog.socratic.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

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

function openAdvancedSettings() {
  fireEvent.click(screen.getByText('Advanced settings'));
}

describe('NewDebateDialog — settings sidebar order (t/4717)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists sections Format, Voices, Sourcing, Material, Model — "Model & providers" last', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    openAdvancedSettings();

    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const labels = within(nav).getAllByRole('button').map(b => b.textContent);

    expect(labels).toEqual([
      'Format & pacing',
      'Voices & audience',
      'Argument sourcing',
      'Source material',
      'Model & providers',
    ]);
  });

  it('"Change voices" still opens directly on the Voices panel (by-id selection unaffected by order)', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /change voices/i }));

    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const active = within(nav).getByRole('button', { name: 'Voices & audience' });
    expect(active.className).toContain('active');
  });
});

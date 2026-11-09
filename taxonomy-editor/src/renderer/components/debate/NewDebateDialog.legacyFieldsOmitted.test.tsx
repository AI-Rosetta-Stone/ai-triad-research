// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4941 (t/4773 follow-up item 4, GitHub #4474): the debate.created flight-recorder event
// (built by the module-private buildDebateCreatedData, NewDebateDialog.tsx ~115) must never
// carry multi_provider, model_tier or speaker_models — those were dropped from the dialog in
// t/4773/#4478, and nothing should resurrect them into new-debate telemetry. Mirrors the
// mock scaffold from NewDebateDialog.modelPicker.test.tsx, adding a flight-recorder spy since
// that file asserts on createDebate's options arg, not on the telemetry payload.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockCreateDebate = vi.hoisted(() => vi.fn().mockResolvedValue('deb-1'));
const mockRecord = vi.hoisted(() => vi.fn());

vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: mockRecord }),
}));

vi.mock('../../hooks/useGeminiOnboarding', () => ({
  useGeminiOnboarding: () => ({ modalProps: { open: false, onClose: () => {} }, checkAndShow: vi.fn() }),
}));

vi.mock('../../hooks/useTierInfo', () => ({
  useTierInfo: () => ({ tier: null, usage: null, loading: false, refresh: vi.fn() }),
  isFreeTier: () => false,
}));

vi.mock('../../hooks/useDebateStore', () => {
  const hook = () => ({ createDebate: mockCreateDebate, loadDebate: vi.fn().mockResolvedValue(undefined) });
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
  ModelPicker: (p: { model: string; onModelChange: (m: string) => void; defaultModelId?: string; temperature?: { value: number; onChange: (v: number) => void } }) => (
    <div>
      <select aria-label="Model" value={p.model} onChange={(e) => p.onModelChange(e.target.value)}>
        {['gemini-pro', 'gemini-flash'].map((m) => <option key={m} value={m}>{m === p.defaultModelId ? `${m} (default)` : m}</option>)}
      </select>
    </div>
  ),
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

function enterTopic() {
  fireEvent.change(screen.getByPlaceholderText('What should the AI debate?'), { target: { value: 'Does X cause Y?' } });
}

async function createdEventData(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => {
    const call = mockRecord.mock.calls.find(([arg]) => arg.message === 'debate.created');
    expect(call).toBeDefined();
  });
  const [call] = mockRecord.mock.calls.find(([arg]) => arg.message === 'debate.created')!;
  return call.data as Record<string, unknown>;
}

describe('NewDebateDialog — debate.created telemetry omits legacy fields (t/4941)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockCreateDebate.mockResolvedValue('deb-1'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a new debate\'s debate.created event carries none of multi_provider, model_tier or speaker_models', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));

    const data = await createdEventData();
    expect(data).not.toHaveProperty('multi_provider');
    expect(data).not.toHaveProperty('model_tier');
    expect(data).not.toHaveProperty('speaker_models');
  });

  it('the event still carries the fields it is meant to (regression guard against an empty payload)', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));

    const data = await createdEventData();
    expect(data.debate_id).toBe('deb-1');
    expect(data.model).toBe('gemini-flash');
    expect(data.temperature).toBe(0.8);
  });
});

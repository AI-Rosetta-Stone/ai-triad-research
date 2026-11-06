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

// A stand-in with the real ModelPicker's contract: model select + optional temperature slider.
// It lets these tests drive the dialog's wiring without the picker's own store and bridge.
vi.mock('../shared/ModelPicker', () => ({
  ModelPicker: (p: { model: string; onModelChange: (m: string) => void; defaultModelId?: string; temperature?: { value: number; onChange: (v: number) => void } }) => (
    <div>
      <select aria-label="Model" value={p.model} onChange={(e) => p.onModelChange(e.target.value)}>
        {['gemini-pro', 'gemini-flash'].map((m) => <option key={m} value={m}>{m === p.defaultModelId ? `${m} (default)` : m}</option>)}
      </select>
      {p.temperature && (
        <input aria-label="Temperature" type="range" min={0} max={2} step={0.1} value={p.temperature.value}
          onChange={(e) => p.temperature!.onChange(parseFloat(e.target.value))} />
      )}
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

// createDebate(topic, povers, userIsPover, sourceType, sourceRef, content, modelOverride, protocolId, temperature, audience, options)
const MODEL_OVERRIDE_ARG = 6;
const TEMPERATURE_ARG = 8;
const OPTIONS_ARG = 10;

function enterTopic() {
  fireEvent.change(screen.getByPlaceholderText('What should the AI debate?'), { target: { value: 'Does X cause Y?' } });
}

function openModelSettings() {
  fireEvent.click(screen.getByRole('button', { name: /advanced settings/i }));
  fireEvent.click(screen.getByRole('button', { name: /model & providers/i }));
}

async function applyAndStart() {
  fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));
  fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));
  await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
  return mockCreateDebate.mock.calls[0];
}

describe('NewDebateDialog — single model picker (t/4773)', () => {
  beforeEach(() => { vi.clearAllMocks(); mockCreateDebate.mockResolvedValue('deb-1'); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('a default debate uses the global model at temperature 0.8 and sends no multi-provider fields', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    fireEvent.click(await screen.findByRole('button', { name: /start debate/i }));

    await vi.waitFor(() => expect(mockCreateDebate).toHaveBeenCalled());
    const call = mockCreateDebate.mock.calls[0];
    expect(call[MODEL_OVERRIDE_ARG]).toBeUndefined();
    expect(call[TEMPERATURE_ARG]).toBe(0.8);
    const options = call[OPTIONS_ARG];
    expect(options.speakerModels).toBeUndefined();
    expect(options.eligibleBackends).toBeUndefined();
    expect(options.modelTier).toBeUndefined();
  });

  it('the picker is always shown (no "Custom model" gate) with the global model marked default', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    openModelSettings();
    expect(screen.queryByRole('checkbox', { name: /custom model/i })).toBeNull();
    expect(screen.getByRole('combobox', { name: /model/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'gemini-flash (default)' })).toBeTruthy();
  });

  it('choosing a different model sends it as the override', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    openModelSettings();
    fireEvent.change(screen.getByRole('combobox', { name: /model/i }), { target: { value: 'gemini-pro' } });
    const call = await applyAndStart();
    expect(call[MODEL_OVERRIDE_ARG]).toBe('gemini-pro');
  });

  it('the temperature slider value is sent to createDebate', async () => {
    render(<NewDebateDialog onClose={() => {}} />);
    enterTopic();
    openModelSettings();
    fireEvent.change(screen.getByRole('slider', { name: /temperature/i }), { target: { value: '1.3' } });
    const call = await applyAndStart();
    expect(call[TEMPERATURE_ARG]).toBe(1.3);
  });

  it('the multi-provider and tier controls are not rendered', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    openModelSettings();
    expect(screen.queryByRole('checkbox', { name: /multi-provider/i })).toBeNull();
    expect(screen.queryByText(/frontier model|basic model/i)).toBeNull();
  });
});

// t/4909: shared dialog a11y contract (role/aria-modal/aria-labelledby, Esc), via useDialog —
// Screen A only; Screen B (DebateSettingsDialog) is a different overlay class, out of scope.
describe('NewDebateDialog a11y (t/4909)', () => {
  it('has role="dialog", aria-modal, and aria-labelledby pointing at the heading', () => {
    render(<NewDebateDialog onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', screen.getByText('New debate').id);
  });

  it('Esc calls onClose', () => {
    const onClose = vi.fn();
    render(<NewDebateDialog onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

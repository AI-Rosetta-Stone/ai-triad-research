// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4770: tests for the shared ModelPicker (family/refresh/model/temperature), extracted out of
// NewOpEdDialog.tsx and NewDebateDialog.tsx so Inquiry (t/4770), Debate (t/4773) and Chat
// (t/4774) share one component instead of three copies.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { refreshAIModelsMock, initAIModelsMock, recordMock } = vi.hoisted(() => ({
  refreshAIModelsMock: vi.fn(),
  initAIModelsMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('@bridge', () => ({ api: { refreshAIModels: refreshAIModelsMock } }));
vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => ({ record: recordMock }) }));
vi.mock('../../hooks/useTaxonomyStore/slices/settingsSlice', () => ({
  AI_BACKENDS: [
    { value: 'claude', label: 'Claude' },
    { value: 'gemini', label: 'Gemini' },
  ],
  MODELS_BY_BACKEND: {
    claude: [
      { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    gemini: [
      { value: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    ],
  },
  initAIModels: initAIModelsMock,
}));

const { ModelPicker } = await import('./ModelPicker');

function renderPicker(overrides: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const onFamilyChange = vi.fn();
  const onModelChange = vi.fn();
  const props = {
    idPrefix: 'test-model',
    family: 'claude' as const,
    model: 'claude-sonnet-5',
    onFamilyChange,
    onModelChange,
    ...overrides,
  };
  return { onFamilyChange, onModelChange, ...render(<ModelPicker {...props} />) };
}

beforeEach(() => {
  refreshAIModelsMock.mockReset().mockResolvedValue(undefined);
  initAIModelsMock.mockReset().mockResolvedValue(undefined);
  recordMock.mockClear();
});

describe('ModelPicker — basic rendering', () => {
  it('renders the family and model selects at their given values', () => {
    renderPicker();
    expect(screen.getByLabelText('Model family')).toHaveValue('claude');
    expect(screen.getByLabelText('Model')).toHaveValue('claude-sonnet-5');
  });

  it('lists only the models for the current family', () => {
    renderPicker();
    expect(screen.getByRole('option', { name: 'Claude Sonnet 5' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude Haiku 4.5' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Gemini 3.5 Pro' })).not.toBeInTheDocument();
  });

  it('does not render a temperature slider when the prop is omitted', () => {
    renderPicker();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });
});

describe('ModelPicker — family/model change', () => {
  it('changing family fires onFamilyChange and onModelChange (that family\'s first model)', async () => {
    const { onFamilyChange, onModelChange } = renderPicker();
    await userEvent.selectOptions(screen.getByLabelText('Model family'), 'gemini');
    expect(onFamilyChange).toHaveBeenCalledWith('gemini');
    expect(onModelChange).toHaveBeenCalledWith('gemini-3.5-pro');
  });

  it('changing the model select fires onModelChange with the chosen value', async () => {
    const { onModelChange } = renderPicker();
    await userEvent.selectOptions(screen.getByLabelText('Model'), 'claude-haiku-4-5');
    expect(onModelChange).toHaveBeenCalledWith('claude-haiku-4-5');
  });
});

describe('ModelPicker — defaultModelId (t/4774)', () => {
  it('appends " (default)" to the matching option, nowhere else', () => {
    renderPicker({ defaultModelId: 'claude-haiku-4-5' });
    expect(screen.getByRole('option', { name: 'Claude Haiku 4.5 (default)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude Sonnet 5' })).toBeInTheDocument();
  });
});

describe('ModelPicker — backendState gating (t/4774)', () => {
  it('disables a non-selectable backend and shows its suffix', () => {
    renderPicker({
      backendState: (b) => (b === 'gemini' ? { selectable: false, suffix: '(sign in to use)' } : { selectable: true, suffix: '' }),
    });
    const geminiOption = screen.getByRole('option', { name: 'Gemini (sign in to use)' }) as HTMLOptionElement;
    expect(geminiOption.disabled).toBe(true);
    const claudeOption = screen.getByRole('option', { name: 'Claude' }) as HTMLOptionElement;
    expect(claudeOption.disabled).toBe(false);
  });
});

describe('ModelPicker — temperature (t/4751/t/4774)', () => {
  it('renders the slider with the given value and default hint when the prop is present', () => {
    renderPicker({ temperature: { value: 0.8, onChange: vi.fn() } });
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.value).toBe('0.8');
    expect(screen.getByText(/0 = deterministic, 2 = most varied\. Default 0\.8\./)).toBeInTheDocument();
  });

  it('uses a custom hint when provided (e.g. Chat\'s per-mode default)', () => {
    renderPicker({ temperature: { value: 0.9, onChange: vi.fn(), hint: 'Default 0.9 for Brainstorm.' } });
    expect(screen.getByText('Default 0.9 for Brainstorm.')).toBeInTheDocument();
    expect(screen.queryByText(/Default 0\.8\./)).not.toBeInTheDocument();
  });

  it('fires onChange with the new numeric value when the slider moves', () => {
    const onChange = vi.fn();
    renderPicker({ temperature: { value: 0.8, onChange } });
    fireEvent.change(screen.getByRole('slider'), { target: { value: '1.4' } });
    expect(onChange).toHaveBeenCalledWith(1.4);
  });
});

describe('ModelPicker — refresh (t/4770#3)', () => {
  it('calls refreshAIModels then initAIModels, showing "Refreshing…" meanwhile', async () => {
    let resolveRefresh: () => void = () => {};
    refreshAIModelsMock.mockReturnValue(new Promise<void>((resolve) => { resolveRefresh = resolve; }));
    renderPicker();
    const btn = screen.getByRole('button', { name: 'Refresh models' });
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    resolveRefresh();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh models' })).not.toBeDisabled());
    expect(refreshAIModelsMock).toHaveBeenCalledWith({ dryRun: true });
    expect(initAIModelsMock).toHaveBeenCalled();
  });

  it('logs a warning (not silent) when refresh fails, and still re-enables the button', async () => {
    refreshAIModelsMock.mockRejectedValue(new Error('network down'));
    renderPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh models' })).not.toBeDisabled());
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn', component: 'ModelPicker' }));
    expect(initAIModelsMock).not.toHaveBeenCalled();
  });
});

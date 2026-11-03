// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4770: Model family / Refresh / Model (+ optional Temperature) picker, extracted out of
// NewOpEdDialog.tsx (~:382-424) and NewDebateDialog.tsx (~:601), which each had their own copy
// of this block. Don't add a third copy — use this component. Moving those two dialogs onto it
// is a follow-up (not required for t/4770), so their markup/classes are untouched here.

import { useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { AI_BACKENDS, MODELS_BY_BACKEND, initAIModels, type AIBackend } from '../../hooks/useTaxonomyStore/slices/settingsSlice';
import './ModelPicker.css';

export interface ModelPickerBackendState {
  selectable: boolean;
  suffix: string;
}

export interface ModelPickerTemperature {
  value: number;
  onChange: (v: number) => void;
  /** Overrides the default "0 = deterministic, 2 = most varied. Default 0.8." hint — e.g. Chat's
   *  per-mode default (t/4774). */
  hint?: string;
}

export interface ModelPickerProps {
  /** Unique id prefix for this instance's `<label htmlFor>`/`<select id>` pairs — callers may
   *  render more than one picker on a page. */
  idPrefix: string;
  family: AIBackend;
  model: string;
  onFamilyChange: (family: AIBackend) => void;
  onModelChange: (model: string) => void;
  /** Per-backend selectable/suffix gating (t/4774: tier + key-state, "(bring your own key)" /
   *  "(sign in to use)"). Omit for "every backend selectable, no suffix" (today's Inquiry/Debate
   *  behavior). */
  backendState?: (backend: AIBackend) => ModelPickerBackendState;
  /** Appends " (default)" to this model's option label wherever it appears. */
  defaultModelId?: string;
  /** Omit to hide the slider entirely — e.g. while the backend has no request field for it yet
   *  (t/4770/t/4771). Never render a slider that doesn't do anything. */
  temperature?: ModelPickerTemperature;
}

export function ModelPicker({
  idPrefix, family, model, onFamilyChange, onModelChange, backendState, defaultModelId, temperature,
}: ModelPickerProps) {
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh(): Promise<void> {
    setRefreshing(true);
    try {
      await api.refreshAIModels({ dryRun: true });
      await initAIModels();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'ModelPicker',
        level: 'warn',
        message: 'Failed to refresh AI models',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
    setRefreshing(false);
  }

  const modelLabel = (m: { value: string; label: string }): string => (m.value === defaultModelId ? `${m.label} (default)` : m.label);

  return (
    <div className="model-picker">
      <div className="model-picker-row">
        <div className="model-picker-field">
          <label className="model-picker-label" htmlFor={`${idPrefix}-family`}>Model family</label>
          <select
            id={`${idPrefix}-family`}
            className="model-picker-select"
            value={family}
            onChange={(e) => {
              const fam = e.target.value as AIBackend;
              onFamilyChange(fam);
              onModelChange(MODELS_BY_BACKEND[fam]?.[0]?.value ?? model);
            }}
          >
            {AI_BACKENDS.map((b) => {
              const state = backendState?.(b.value);
              return (
                <option key={b.value} value={b.value} disabled={state ? !state.selectable : undefined}>
                  {state?.suffix ? `${b.label} ${state.suffix}` : b.label}
                </option>
              );
            })}
          </select>
        </div>
        <button type="button" className="model-picker-refresh-btn" disabled={refreshing} onClick={() => void handleRefresh()}>
          {refreshing ? 'Refreshing…' : 'Refresh models'}
        </button>
      </div>
      <div className="model-picker-field">
        <label className="model-picker-label" htmlFor={`${idPrefix}-model`}>Model</label>
        <select id={`${idPrefix}-model`} className="model-picker-select" value={model} onChange={(e) => onModelChange(e.target.value)}>
          {(MODELS_BY_BACKEND[family] ?? []).map((m) => <option key={m.value} value={m.value}>{modelLabel(m)}</option>)}
        </select>
      </div>
      {temperature && (
        <div className="model-picker-field">
          <label className="model-picker-label" htmlFor={`${idPrefix}-temp`}>Temperature: {temperature.value.toFixed(1)}</label>
          <input
            id={`${idPrefix}-temp`}
            className="model-picker-temp"
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={temperature.value}
            onChange={(e) => temperature.onChange(parseFloat(e.target.value))}
          />
          <p className="model-picker-hint">{temperature.hint ?? '0 = deterministic, 2 = most varied. Default 0.8.'}</p>
        </div>
      )}
    </div>
  );
}

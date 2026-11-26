// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useEffect } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useStore } from '../store/useStore';
import type { AIBackend, AIModel } from '../store/aiModels';
import { AI_BACKENDS, MODELS_BY_BACKEND, initAIModels } from '../store/aiModels';
import type { Theme } from '../types/types';
import type { RefreshResult } from '@lib/electron-shared/modelDiscovery';

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const { theme, setTheme, aiBackend, setAIBackend, aiModel, setAIModel } = useStore();
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [keyInput, setKeyInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySuccess, setKeySuccess] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [, forceUpdate] = useState(0);

  const models = MODELS_BY_BACKEND[aiBackend] || [];

  useEffect(() => {
    Promise.all(
      AI_BACKENDS.map(async (b) => {
        const has = await window.electronAPI.hasApiKey(b.value);
        return [b.value, has] as [string, boolean];
      }),
    ).then((results) => setHasKey(Object.fromEntries(results)));
  }, [keySuccess]);

  const handleSaveKey = async () => {
    if (!keyInput.trim()) return;
    setSavingKey(true);
    setKeyError(null);
    setKeySuccess(null);
    try {
      await window.electronAPI.setApiKey(keyInput.trim(), aiBackend);
      setKeyInput('');
      setKeySuccess(`${AI_BACKENDS.find(b => b.value === aiBackend)?.label} key saved`);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'settings',
        level: 'error',
        message: 'Failed to save API key in settings',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      setKeyError(String(err));
    } finally {
      setSavingKey(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    setRefreshError(null);
    try {
      const result = await window.electronAPI.refreshAIModels() as RefreshResult;
      await initAIModels();
      useStore.getState().revalidateAIModel();
      setRefreshResult(result);
      forceUpdate(n => n + 1);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'settings',
        level: 'error',
        message: 'Failed to refresh AI models',
        error: { name: (err as Error).name ?? 'Error', message: String(err) },
      });
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const keyPlaceholder: Record<AIBackend, string> = {
    gemini: 'AIza...',
    claude: 'sk-ant-...',
    groq: 'gsk_...',
    openai: 'sk-...',
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <div className="settings-row">
          <label className="settings-label">AI Backend</label>
          <select
            className="settings-select"
            value={aiBackend}
            onChange={(e) => setAIBackend(e.target.value as AIBackend)}
          >
            {AI_BACKENDS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}{hasKey[b.value] ? '' : ' (no key)'}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-row">
          <label className="settings-label">Model</label>
          <div className="settings-model-row">
            <select
              className="settings-select"
              value={aiModel}
              onChange={(e) => setAIModel(e.target.value as AIModel)}
            >
              {models.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
            <button
              className="btn btn-sm settings-refresh-btn"
              onClick={handleRefresh}
              disabled={refreshing}
              title="Query provider APIs for available models and update ai-models.json"
            >
              {refreshing ? 'Refreshing...' : 'Refresh Models'}
            </button>
          </div>
        </div>

        {refreshResult && (
          <div className="settings-refresh-result">
            {(['gemini', 'claude', 'groq', 'openai'] as const).map((b) => {
              const r = refreshResult[b];
              return (
                <div key={b} className={`settings-refresh-line ${r.ok ? '' : 'settings-refresh-warn'}`}>
                  <span className="settings-refresh-backend">{b}</span>
                  <span>{r.ok ? `${r.count} models` : r.error || 'failed'}</span>
                </div>
              );
            })}
            <div className="settings-refresh-total">
              Total: {refreshResult.totalModels} models saved to ai-models.json
            </div>
          </div>
        )}
        {refreshError && <div className="settings-key-error">{refreshError}</div>}

        <div className="settings-divider" />

        <div className="settings-key-section">
          <label className="settings-label">
            {AI_BACKENDS.find(b => b.value === aiBackend)?.label} API Key
            {hasKey[aiBackend] && <span className="settings-key-status"> (set)</span>}
          </label>
          <div className="settings-key-row">
            <input
              type="password"
              className="settings-key-input"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={keyPlaceholder[aiBackend]}
            />
            <button
              className="btn btn-sm"
              onClick={handleSaveKey}
              disabled={!keyInput.trim() || savingKey}
            >
              {savingKey ? '...' : 'Save'}
            </button>
          </div>
          {keyError && <div className="settings-key-error">{keyError}</div>}
          {keySuccess && <div className="settings-key-success">{keySuccess}</div>}
        </div>

        <div className="settings-divider" />

        <div className="settings-row">
          <label className="settings-label">Theme</label>
          <select
            className="settings-select"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="bkc">BKC</option>
            <option value="system">System</option>
          </select>
        </div>

        <div className="dialog-actions">
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import './ApiKeyDialog.css';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

interface ApiKeyDialogProps {
  onClose: () => void;
}

export function ApiKeyDialog({ onClose }: ApiKeyDialogProps) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.setApiKey(key.trim());
      onClose();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'api-key-dialog',
        level: 'warn',
        message: 'failed to save API key',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Configure API Key</h3>
        <p>
          Semantic search uses the Gemini gemini-embedding-001 model.
          Enter your Google Gemini API key below. Your key is stored securely — how it&apos;s
          protected depends on how you&apos;re running the app; see{' '}
          <a
            href="#"
            onClick={(e) => { e.preventDefault(); void api.openExternal('https://github.com/AI-Rosetta-Stone/ai-triad-research/blob/main/docs/security/api-key-protection.md'); }}
            className="api-key-dialog-protection-link"
          >
            how is my API key protected?
          </a>
        </p>
        <div className="form-group">
          <label>API Key</label>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="AIza..."
            autoFocus
          />
        </div>
        {error && <div className="error-text api-key-dialog-error">{error}</div>}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={!key.trim() || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

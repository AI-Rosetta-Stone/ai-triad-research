// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import {
  AI_BACKENDS,
  MODELS_BY_BACKEND,
  backendForModelWithFallback,
  type AIBackend,
} from '../../hooks/useTaxonomyStore';
import { useDialog } from '../shared/useDialog'; // t/4909
import './BriefTimeoutDialog.css';

interface BriefTimeoutDialogProps {
  speakerLabel: string;
  totalAttempts: number;
  currentModel: string;
  onRetry: (model: string) => void;
  onAbort: () => void;
}

export function BriefTimeoutDialog({
  speakerLabel, totalAttempts, currentModel, onRetry, onAbort,
}: BriefTimeoutDialogProps) {
  const [family, setFamily] = useState<AIBackend>(() => backendForModelWithFallback(currentModel));
  const [model, setModel] = useState(currentModel);
  const { dialogRef, titleId } = useDialog({ onCancel: onAbort }); // t/4909

  const modelOptions = MODELS_BY_BACKEND[family] ?? [];

  return (
    <div className="dialog-overlay" onClick={onAbort}>
      <div ref={dialogRef} className="dialog brief-timeout-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 className="brief-timeout-dialog-title" id={titleId}>Brief timed out</h3>
        <p className="brief-timeout-dialog-desc">
          The <strong>{speakerLabel}</strong> brief did not complete after{' '}
          {totalAttempts} {totalAttempts === 1 ? 'attempt' : 'attempts'}.
          Choose a different model to retry, or abort the debate.
        </p>

        <div className="brief-timeout-dialog-picker">
          <div className="brief-timeout-dialog-field">
            <label className="brief-timeout-dialog-label">Model family</label>
            <select
              className="ndd-input"
              value={family}
              onChange={e => {
                const fam = e.target.value as AIBackend;
                setFamily(fam);
                setModel(MODELS_BY_BACKEND[fam]?.[0]?.value ?? model);
              }}
            >
              {AI_BACKENDS.map(b => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>

          <div className="brief-timeout-dialog-field">
            <label className="brief-timeout-dialog-label">Model</label>
            <select
              className="ndd-input"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              {modelOptions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onAbort}>
            Abort debate
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onRetry(model)}
            disabled={!model}
          >
            Retry with this model
          </button>
        </div>
      </div>
    </div>
  );
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4514: answer the debate-statement "Explain" prompt inline, in-app, via api.generateText —
// replacing the old copy-to-clipboard-and-open-Gemini flow (kept as a secondary escape hatch).
// Renders inline wherever the caller places it (the transcript scroll column, via the existing
// taxonomy-refs/eval inline-detail pattern) — no overlay, no portal.

import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { TOAST_DURATION_FEEDBACK } from '../../constants';
import { useDebateStore } from '../../hooks/useDebateStore';
import { useTaxonomyStore, getStoredModel } from '../../hooks/useTaxonomyStore';
import { fixMarkdownLinks, openPromptInGemini } from './utils';
import './ExplainPanel.css';

/** Normalize a thrown error to the ActionableError shape (Goal/Problem/Location/Next Steps) —
 *  same approach as NewOpEdDialog's toActionable; not shared, both are small and local. */
interface ActionableShape { goal?: string; problem: string; location?: string; nextSteps: string[] }
function toActionable(err: unknown): ActionableShape {
  const e = err as { goal?: string; problem?: string; location?: string; nextSteps?: unknown; message?: string };
  if (e && Array.isArray(e.nextSteps)) {
    return { goal: e.goal, problem: e.problem ?? e.message ?? 'The explanation could not be generated.', location: e.location, nextSteps: e.nextSteps as string[] };
  }
  return { problem: err instanceof Error ? err.message : String(err), nextSteps: [] };
}

type ExplainState = 'loading' | 'result' | 'error';

export interface ExplainPanelProps {
  /** The explain prompt (built by the caller — buildExplainPrompt or buildSelectionExplainPrompt,
   *  per t/4514's scoping rule: card explains the whole exchange, right-click explains the
   *  selection). This component is prompt-agnostic. */
  prompt: string;
  /** "this exchange" or "this selection" — shown in the panel header. */
  scopeLabel: string;
  onClose: () => void;
}

export function ExplainPanel({ prompt, scopeLabel, onClose }: ExplainPanelProps) {
  const [state, setState] = useState<ExplainState>('loading');
  const [text, setText] = useState('');
  const [servedModel, setServedModel] = useState<string | undefined>(undefined);
  const [error, setError] = useState<ActionableShape | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const run = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState('loading');
    setError(null);
    const model = useDebateStore.getState().debateModel || getStoredModel();
    api.generateText(prompt, model, undefined, undefined, { signal: controller.signal, purpose: 'explain' })
      .then((res) => {
        if (controller.signal.aborted) return;
        setText(res.text);
        setServedModel(res.servedModel);
        setState('result');
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // cancelled — Esc/Cancel already closed the panel
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'debate-workspace',
          level: 'warn',
          message: 'Explain generation failed — showing inline error',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setError(toActionable(err));
        setState('error');
      });
  }, [prompt]);

  // Fetch once on mount; a fresh explanation on a later re-open is fine (t/4514 spec) since the
  // caller remounts this component (new key) rather than keeping it mounted across closes.
  useEffect(() => {
    run();
    return () => abortRef.current?.abort();
  }, [run]);

  useEffect(() => {
    if (state === 'result') resultRef.current?.focus();
  }, [state]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (state === 'loading') handleCancel();
    else onClose();
  };

  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void api.clipboardWriteText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), TOAST_DURATION_FEEDBACK);
  };
  const handleOpenInGemini = () => openPromptInGemini(prompt);

  return (
    <div className="debate-explain-panel" onKeyDown={handleKeyDown}>
      <div className="debate-explain-panel-header">
        <span className="debate-explain-panel-title">Explaining {scopeLabel}</span>
        <button
          type="button"
          className="debate-explain-gemini-link"
          onClick={handleOpenInGemini}
          title="Copy this prompt and open Gemini in your browser instead"
        >
          Open in Gemini
        </button>
      </div>

      {state === 'loading' && (
        <div className="debate-explain-loading" aria-live="polite">
          <span className="debate-explain-spinner" aria-hidden="true" />
          <span>Explaining…</span>
          <button type="button" className="btn btn-sm" onClick={handleCancel}>Cancel</button>
        </div>
      )}

      {state === 'error' && error && (
        <div className="debate-explain-error" role="alert">
          {error.goal && <div className="debate-explain-error-line"><strong>Goal:</strong> {error.goal}</div>}
          <div className="debate-explain-error-line"><strong>Problem:</strong> {error.problem}</div>
          {error.nextSteps.length > 0 && (
            <ul className="debate-explain-error-steps">
              {error.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          )}
          <div className="debate-explain-actions">
            <button type="button" className="btn btn-sm" onClick={run}>Retry</button>
            <button type="button" className="btn btn-sm" onClick={onClose}>Dismiss</button>
          </div>
        </div>
      )}

      {state === 'result' && (
        <div className="debate-explain-result" tabIndex={-1} ref={resultRef}>
          <div className="markdown-body prose">
            <Markdown remarkPlugins={[remarkGfm]}>{fixMarkdownLinks(text)}</Markdown>
          </div>
          <div className="debate-explain-meta">
            {servedModel && <span className="debate-explain-model-tag">via {servedModel}</span>}
            <div className="debate-explain-actions">
              <button type="button" className="btn btn-sm" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className="btn btn-sm" onClick={run}>Regenerate</button>
              <button type="button" className="btn btn-sm" onClick={onClose}>Collapse</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

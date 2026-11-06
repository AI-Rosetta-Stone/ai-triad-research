// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect, useRef, useState } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { DISMISS_KEY } from './geminiOnboardingState';
import { useFocusTrap } from '../shared/useDialog'; // t/4909
import './GeminiOnboardingModal.css';

const isWeb = import.meta.env.VITE_TARGET === 'web';
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';

type ModalState = 'idle' | 'validating' | 'success' | 'error';
type CloseResult = 'saved' | 'later' | 'permanent-dismiss';

interface GeminiOnboardingModalProps {
  open: boolean;
  onClose: (result: CloseResult) => void;
  /** t/3495 epic (admin-managed shared Gemini key): when true, the caller has
   *  been granted access to the admin's registered Gemini key (t/3500's
   *  `useGeminiOnboarding` threads this from `UserProfile.geminiAllowlisted`).
   *  Renders a confirmation in place of the key-entry flow — no input,
   *  no Save. */
  geminiAllowlisted?: boolean;
}

export function GeminiOnboardingModal({ open, onClose, geminiAllowlisted = false }: GeminiOnboardingModalProps) {
  const [key, setKey] = useState('');
  const [state, setState] = useState<ModalState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [hasOtherKeys, setHasOtherKeys] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // t/4909: this dialog is mounted once (`open` toggles as a prop, not a conditional render —
  // same shape as NewOpEdDialog's Screen A), so it can't take the full useDialog hook (its
  // mount-bookended focus management doesn't fit a prop that toggles repeatedly over one
  // mount) — only the Tab trap above, and this matching open-keyed restore-focus effect. Esc and
  // role/aria-modal/aria-labelledby are already handled by this component's own code below.
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus(); };
  }, [open]);

  useEffect(() => {
    if (!open || geminiAllowlisted) return;
    setKey('');
    setState('idle');
    setErrorMsg('');
    // TL note: default to strong headline (false) if this throws
    api.getApiKeySummary()
      .then((summary) => {
        setHasOtherKeys(summary.some((s) => s.hasKey));
      })
      .catch((err) => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'gemini-onboarding',
          level: 'warn',
          message: 'Failed to fetch API key summary',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        setHasOtherKeys(false);
      });
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [open, geminiAllowlisted]);

  if (!open) return null;

  const headline = geminiAllowlisted
    ? 'Gemini Access Provided'
    : hasOtherKeys ? 'Add Gemini for Free-Tier Access' : 'Get Free AI Features';

  const handleOpenStudio = () => {
    if (isWeb) {
      window.open(AI_STUDIO_URL, '_blank');
    } else {
      api.openExternal(AI_STUDIO_URL).catch((err) => {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'gemini-onboarding',
          level: 'warn',
          message: 'Failed to open AI Studio',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      });
    }
  };

  const handleSave = async () => {
    if (!key.trim() || state === 'validating') return;
    setState('validating');
    setErrorMsg('');
    try {
      const result = await api.validateApiKey(key.trim(), 'gemini');
      if (!result.valid) {
        setState('error');
        setErrorMsg(result.error ?? 'Invalid key — check that you copied the full key');
        return;
      }
      await api.addApiKey(key.trim(), 'gemini');
      setState('success');
      setTimeout(() => onClose('saved'), 1500);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'gemini-onboarding',
        level: 'error',
        message: 'Key validation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setState('error');
      setErrorMsg('Something went wrong — please try again');
    }
  };

  const handleDismiss = (result: CloseResult) => {
    if (result === 'later') {
      localStorage.setItem(DISMISS_KEY, 'once');
    } else if (result === 'permanent-dismiss') {
      localStorage.setItem(DISMISS_KEY, 'permanent');
    }
    onClose(result);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') handleDismiss('later');
    if (e.key === 'Enter' && key.trim() && state !== 'validating') void handleSave();
  };

  return (
    <div
      className="dialog-overlay"
      onClick={() => handleDismiss('later')}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        className="dialog gemini-onboarding-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gemini-onboarding-title"
      >
        <h3 id="gemini-onboarding-title">{headline}</h3>

        {geminiAllowlisted ? (
          <>
            <div className="gemini-onboarding-intro">
              <p className="gemini-onboarding-intro-text">
                Your admin has granted you access to run debates with Gemini models using their
                registered key — no personal API key needed.
              </p>
            </div>

            <div className="dialog-actions gemini-onboarding-actions">
              <button
                className="btn btn-primary"
                onClick={() => handleDismiss('permanent-dismiss')}
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="gemini-onboarding-intro">
              <p className="gemini-onboarding-intro-text">
                Gemini offers a generous free tier for AI features like debate, chat, and fact-checking.
                Get your API key in three steps:
              </p>
              <ol className="gemini-onboarding-steps">
                <li>
                  <button
                    className="btn btn-sm gemini-onboarding-studio-btn"
                    onClick={handleOpenStudio}
                  >
                    Open Google AI Studio
                  </button>
                </li>
                <li>Click <strong>"Create API Key"</strong> and copy the key</li>
                <li>Paste the key below and click Save</li>
              </ol>
            </div>

            <div className="form-group">
              <label htmlFor="gemini-key-input">API Key</label>
              <input
                id="gemini-key-input"
                ref={inputRef}
                type="password"
                value={key}
                onChange={(e) => { setKey(e.target.value); if (state === 'error') setState('idle'); }}
                placeholder="AIza..."
                disabled={state === 'validating' || state === 'success'}
                autoComplete="off"
              />
            </div>

            {state === 'error' && (
              <div className="error-text gemini-onboarding-error">
                {errorMsg}
              </div>
            )}

            {state === 'success' && (
              <div className="gemini-onboarding-success">
                &#10003; Key saved!
              </div>
            )}

            <div className="dialog-actions gemini-onboarding-actions">
              <button
                className="btn gemini-onboarding-dismiss-btn"
                onClick={() => handleDismiss('permanent-dismiss')}
                disabled={state === 'validating' || state === 'success'}
              >
                I use a different AI
              </button>
              <button
                className="btn"
                onClick={() => handleDismiss('later')}
                disabled={state === 'validating' || state === 'success'}
              >
                I'll do this later
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={!key.trim() || state === 'validating' || state === 'success'}
              >
                {state === 'validating' ? 'Validating...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

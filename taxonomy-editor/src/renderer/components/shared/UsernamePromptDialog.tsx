// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useRef, useEffect } from 'react';
import { useUsernameStore, validateUsername } from '../../hooks/useUsernameStore';
import { useFocusTrap } from './useDialog'; // t/4909

export function UsernamePromptDialog() {
  const { promptOpen, username, closePrompt, confirmPrompt } = useUsernameStore();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // t/4909: mounted once by DebateWorkspace (promptOpen toggles via the store, not a conditional
  // render), so useDialog's own mount-bookended focus management doesn't fit — only the shared
  // Tab trap plus a matching promptOpen-keyed restore-focus effect. Esc moves from the input's
  // own onKeyDown (narrower — only fired with focus in the input) to this dialog-wide listener.
  useFocusTrap(dialogRef, promptOpen);

  useEffect(() => {
    if (!promptOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closePrompt(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [promptOpen, closePrompt]);

  useEffect(() => {
    if (promptOpen) {
      setValue(username ?? '');
      setError(null);
      // Focus after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [promptOpen, username]);

  if (!promptOpen) return null;

  const handleSubmit = () => {
    const validationError = validateUsername(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    confirmPrompt(value.trim());
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="dialog-overlay" onClick={closePrompt}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby="username-prompt-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="username-prompt-title">{username ? 'Change Username' : 'Set Username'}</h3>
        <p>
          {username
            ? 'Enter a new display name for your comments.'
            : 'Enter a display name for your comments. This will be saved for future sessions.'}
        </p>
        <div className={`form-group ${error ? 'has-error' : ''}`}>
          <input
            ref={inputRef}
            type="text"
            className="form-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Your name"
            maxLength={50}
          />
          {error && <div className="error-text">{error}</div>}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={closePrompt}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {username ? 'Update' : 'Set Username'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Inline badge that shows the current username. Click to change. */
export function UsernameBadge() {
  const { username, requestUsername } = useUsernameStore();
  if (!username) return null;

  return (
    <button
      className="username-badge"
      onClick={() => requestUsername()}
      title="Click to change username"
    >
      {username}
    </button>
  );
}

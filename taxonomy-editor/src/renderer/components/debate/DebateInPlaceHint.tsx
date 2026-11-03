// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4691: one-time first-open hint (copy from Design's amended spec, t/4686#1), shown once per
// browser the first time a debate opens in place, never on phone (table mode is desktop-only).
// Read/write pattern matches ChatInPlaceHint (t/4690) / FreeTierDisclosure.tsx — a storage
// failure shows the hint again next visit, the safe failure for a one-time disclosure.

import { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './DebateInPlaceHint.css';

export const DEBATE_IN_PLACE_HINT_STORAGE_KEY = 'aitriad.debateInPlaceHint.v1';

function readDebateHintAcknowledged(): boolean {
  try {
    return localStorage.getItem(DEBATE_IN_PLACE_HINT_STORAGE_KEY) === 'ack';
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'debate-tab', level: 'warn',
      message: 'localStorage unreadable; showing the debate in-place hint (WARN: fallback to show)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

function writeDebateHintAcknowledged(): void {
  try {
    localStorage.setItem(DEBATE_IN_PLACE_HINT_STORAGE_KEY, 'ack');
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'debate-tab', level: 'warn',
      message: 'localStorage unwritable; the debate in-place hint will show again next visit (WARN: fallback)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

export function DebateInPlaceHint() {
  const [acknowledged, setAcknowledged] = useState(readDebateHintAcknowledged);

  const handleDismiss = () => { writeDebateHintAcknowledged(); setAcknowledged(true); };

  // t/4801: dismiss on navigation away from the item place
  useEffect(() => {
    const handleHashChange = () => {
      if (!/^#.*\/debate\//.test(window.location.hash)) {
        handleDismiss();
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  if (acknowledged) return null;
  return (
    <div className="debate-in-place-hint" role="status">
      <span><strong>Opens here now.</strong> Use <ExternalLink aria-hidden="true" className="debate-in-place-hint-icon" /> to open it in a separate window.</span>
      <button
        type="button"
        className="btn btn-xs btn-ghost debate-in-place-hint-dismiss"
        onClick={handleDismiss}
      >
        Got it
      </button>
    </div>
  );
}

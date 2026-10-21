// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4387: an open tab used to keep running the previous build after a deploy. The service worker only
// re-checked for a new sw.js on navigation, which a long-lived single-page tab never does. Now:
//   - check for an update hourly (only while polling is allowed: visible and not idle, t/4251) and
//     whenever the tab becomes visible again (throttled);
//   - a new version waits (registerType 'prompt', vite.config.ts) until the user reloads from here;
//   - Reload is held back while there are unsaved taxonomy edits, so a reload never discards work.

import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { gatedInterval } from '../../lib/pollGate';
import './UpdatePrompt.css';

export const UPDATE_CHECK_MS = 60 * 60_000;
/** A returning tab re-checks at most this often (visibility can flap quickly). */
export const VISIBLE_RECHECK_MIN_MS = 60_000;

const recordSw = (message: string, level: 'info' | 'warn' = 'info', data?: Record<string, unknown>) =>
  getGlobalRecorder()?.record({ type: 'state.change', component: 'service-worker', level, message, data });

/** Start the update checks for a registration. Returns a stop function. */
export function startUpdateChecks(registration: ServiceWorkerRegistration): () => void {
  let lastCheck = 0;
  const check = () => {
    lastCheck = Date.now();
    registration.update().catch((err: unknown) => {
      // Offline or a transient network error: the next check retries. Recorded, not shown to the user.
      recordSw('service worker update check failed', 'warn', { error: String(err) });
    });
  };
  const stopInterval = gatedInterval(check, UPDATE_CHECK_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastCheck >= VISIBLE_RECHECK_MIN_MS) check();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => { stopInterval(); document.removeEventListener('visibilitychange', onVisible); };
}

export function UpdatePrompt() {
  const stopChecks = useRef<(() => void) | null>(null);
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      if (!registration || stopChecks.current) return;
      stopChecks.current = startUpdateChecks(registration);
    },
  });
  const hasUnsavedEdits = useTaxonomyStore(s => s.dirty.size > 0);

  useEffect(() => () => { stopChecks.current?.(); stopChecks.current = null; }, []);
  useEffect(() => {
    if (needRefresh) recordSw('new app version waiting; showing the reload prompt', 'info', { unsaved_edits: hasUnsavedEdits });
    // Record once per new version, not on every dirty-state change.
  }, [needRefresh]);

  if (!needRefresh) return null;
  return (
    <div className="pwa-update-toast" role="status">
      <span>A new version is available.</span>
      {hasUnsavedEdits && <span className="pwa-update-hint">Save your changes first, then reload.</span>}
      <button
        className="btn btn-sm"
        disabled={hasUnsavedEdits}
        title={hasUnsavedEdits ? 'You have unsaved changes. Save them before reloading.' : undefined}
        onClick={() => { recordSw('user reloading into the new app version'); void updateServiceWorker(true); }}
      >
        Reload
      </button>
    </div>
  );
}

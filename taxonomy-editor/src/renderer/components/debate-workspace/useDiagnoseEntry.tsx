// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4642: clicking a card's Diagnose button (or a transcript row, once diagnostics is already
// enabled) looked broken when the Diagnostics tab/window was already open elsewhere — it updated
// that tab's state but gave no visible sign of doing so. This hook is the single place both call
// sites (StatementCard's Diagnose button, DebateWorkspace's TranscriptEntryRow onClick) route
// through: it preserves the existing "not yet enabled" first-open path unchanged, and for the
// "already enabled" path also asks the bridge to focus the open tab/window, surfacing a notice
// when that's not possible (never-opened or closed-reference) instead of failing silently.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@bridge';
import { useDebateStore } from '../../hooks/useDebateStore';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './useDiagnoseEntry.css';

const NOTICE_DURATION_MS = 5000;

function DiagnoseNotice({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return (
    <div className="diagnose-notice" role="status">
      <span className="diagnose-notice-text">Shown in the Diagnostics tab</span>
      <button className="diagnose-notice-btn" onClick={onOpen}>Open</button>
      <button className="diagnose-notice-btn" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

export function useDiagnoseEntry() {
  const diagnosticsEnabled = useDebateStore(s => s.diagnosticsEnabled);
  const toggleDiagnostics = useDebateStore(s => s.toggleDiagnostics);
  const selectDiagEntry = useDebateStore(s => s.selectDiagEntry);

  const [noticeVisible, setNoticeVisible] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current); }, []);

  const dismissNotice = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setNoticeVisible(false);
  }, []);

  const showNotice = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setNoticeVisible(true);
    dismissTimerRef.current = setTimeout(() => setNoticeVisible(false), NOTICE_DURATION_MS);
  }, []);

  const diagnose = useCallback((entryId: string) => {
    if (!diagnosticsEnabled) {
      // Today's existing first-open path, unchanged: enabling diagnostics opens the tab/window,
      // so there's nothing to focus yet — the delayed select gives that open time to complete.
      toggleDiagnostics();
      setTimeout(() => selectDiagEntry(entryId, true), 1200);
      return;
    }
    selectDiagEntry(entryId, true);
    void api.focusDiagnosticsWindow().then((result) => {
      if (result === 'not-open') showNotice();
    }).catch((err: unknown) => {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-workspace',
        level: 'warn',
        message: 'focusDiagnosticsWindow failed — showing the fallback notice',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      showNotice();
    });
  }, [diagnosticsEnabled, toggleDiagnostics, selectDiagEntry, showNotice]);

  const openDiagnostics = useCallback(() => {
    dismissNotice();
    void api.openDiagnosticsWindow();
  }, [dismissNotice]);

  return {
    diagnose,
    notice: noticeVisible ? <DiagnoseNotice onOpen={openDiagnostics} onDismiss={dismissNotice} /> : null,
  };
}

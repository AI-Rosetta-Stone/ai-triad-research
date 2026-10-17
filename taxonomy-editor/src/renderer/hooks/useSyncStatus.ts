// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Polls /api/sync/status so the status bar can surface unsynced-change counts.
 *
 * Polls only while the tab is visible and the user is active (pollGate, t/4251), every 45 s.
 *
 * When the server reports `enabled: false` (i.e. GIT_SYNC_ENABLED is off or the
 * data root is not a git working tree) polling stops after the first response —
 * there's nothing to show and no reason to keep hitting the server.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { getSyncStatus, type SyncStatus } from '../utils/syncApi';
import { gatedInterval } from '../lib/pollGate';

/** t/4251: was 10 s. The status bar count tolerates 45 s, and a visible-again refresh is immediate. */
export const SYNC_POLL_MS = 45_000;

const DISABLED: SyncStatus = {
  enabled: false,
  unsynced_count: 0,
  session_branch: null,
  pr_number: null,
  pr_url: null,
  push_pending: false,
  github_configured: false,
  main_updated_available: false,
  rebase_in_progress: false,
};

export function useSyncStatus(): { status: SyncStatus; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<SyncStatus>(DISABLED);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getSyncStatus();
    if (mountedRef.current) setStatus(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let stopPolling: (() => void) | null = null;

    void (async () => {
      const first = await getSyncStatus();
      if (!mountedRef.current) return;
      setStatus(first);
      if (!first.enabled) return; // don't start polling if the feature is off
      stopPolling = gatedInterval(() => { void refresh(); }, SYNC_POLL_MS);
    })();

    return () => {
      mountedRef.current = false;
      stopPolling?.();
    };
  }, [refresh]);

  return { status, refresh };
}

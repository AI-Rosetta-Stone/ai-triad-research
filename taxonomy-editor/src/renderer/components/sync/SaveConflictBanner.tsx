// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4314 — non-dismissable banner shown while `overlay_commit.state === 'conflict'`
 * (contract: #3467, design: t/4313#1-#6). Both actions act on the user's whole
 * staged batch (Server Storage confirmed whole-batch, p/641#11) — "Use theirs"
 * discards every unsaved change, not just the conflicted files.
 *
 * WORDING NOTE: the copy below is t/4313#5's draft (v3), pending PI approval.
 * Don't merge this ahead of that approval being recorded on t/4313 (AC 3).
 */

import { useRef, useEffect, useState } from 'react';
import {
  useSyncStatus,
} from '../../hooks/useSyncStatus';
import {
  overlayConflictPaths,
  resolveOverlayConflictUseTheirs,
  resolveOverlayConflictKeepMine,
} from '../../utils/syncApi';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import './SaveConflictBanner.css';

// t/4313#1's "Success, a toast" step has no shared toast utility to call yet (none
// exists in this codebase today) — flagged to Rosetta Stone (p/580) as an open gap
// rather than built here. The banner clearing is itself the success signal for now.

const MAX_LISTED_FILES = 5;

function fileListSummary(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_FILES);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

type Busy = 'theirs' | 'mine' | null;

export function SaveConflictBanner() {
  const { status, refresh } = useSyncStatus();
  const loadAll = useTaxonomyStore(s => s.loadAll);
  const paths = overlayConflictPaths(status);

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingMine, setConfirmingMine] = useState(false);
  const [confirmingTheirs, setConfirmingTheirs] = useState(false);
  const useTheirsRef = useRef<HTMLButtonElement>(null);

  // Default focus on "Use theirs" (t/4313#1), each time a new conflict appears.
  const hasConflict = paths !== null;
  useEffect(() => {
    if (hasConflict && busy === null) useTheirsRef.current?.focus();
  }, [hasConflict, busy]);

  if (!paths) return null;

  const onUseTheirs = async () => {
    setBusy('theirs');
    setError(null);
    try {
      await resolveOverlayConflictUseTheirs();
      await Promise.all([refresh(), loadAll(true)]);
      setConfirmingTheirs(false);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'save-conflict-banner',
        level: 'error',
        message: 'Use-theirs conflict resolution failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(mapErrorToUserMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onKeepMine = async () => {
    setBusy('mine');
    setError(null);
    try {
      const res = await resolveOverlayConflictKeepMine();
      await refresh();
      if (res.stillConflicted.length > 0) {
        // Another change landed in the gap — the hook's next status reports
        // `conflict` again with the new set; don't re-call this ourselves.
        setConfirmingMine(false);
        return;
      }
      setConfirmingMine(false);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'save-conflict-banner',
        level: 'error',
        message: 'Keep-mine conflict resolution failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setError(mapErrorToUserMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const working = busy !== null;

  return (
    <div className="save-conflict-banner" role="alert" aria-live="assertive">
      <div className="save-conflict-banner-body">
        <div className="save-conflict-banner-title">Your recent changes haven't been saved</div>
        <div className="save-conflict-banner-text">
          Some files you edited were changed elsewhere after you started: <b>{fileListSummary(paths)}</b>.
          Until you choose, none of your recent changes can be saved.
        </div>
        {error && <div className="save-conflict-banner-error">That didn't work: {error}. Nothing was discarded or saved; try again.</div>}
      </div>
      <div className="save-conflict-banner-actions">
        <button
          ref={useTheirsRef}
          className="btn btn-ghost save-conflict-banner-btn"
          disabled={working}
          onClick={() => setConfirmingTheirs(true)}
          title="Discard all my unsaved changes and load the latest version."
        >
          {busy === 'theirs' ? 'Working…' : 'Use theirs'}
        </button>
        <button
          className="btn btn-primary save-conflict-banner-btn"
          disabled={working}
          onClick={() => setConfirmingMine(true)}
          title="Save all my changes, replacing the newer version of those files."
        >
          {busy === 'mine' ? 'Working…' : 'Keep mine'}
        </button>
      </div>

      {confirmingTheirs && (
        <div className="dialog-overlay" onClick={() => !working && setConfirmingTheirs(false)}>
          <div className="dialog save-conflict-confirm" onClick={e => e.stopPropagation()}>
            <h3 className="dialog-title">Discard your unsaved changes?</h3>
            <div className="dialog-description">
              This discards all your unsaved changes, including changes to files that weren't in conflict.
              This can't be undone.
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" disabled={working} onClick={() => setConfirmingTheirs(false)}>Cancel</button>
              <button className="btn btn-danger" disabled={working} onClick={() => void onUseTheirs()}>
                {busy === 'theirs' ? 'Working…' : 'Discard my changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmingMine && (
        <div className="dialog-overlay" onClick={() => !working && setConfirmingMine(false)}>
          <div className="dialog save-conflict-confirm" onClick={e => e.stopPropagation()}>
            <h3 className="dialog-title">Replace the newer version?</h3>
            <div className="dialog-description">
              This saves all your changes and replaces the newer version of {paths.length} file{paths.length === 1 ? '' : 's'}.
              Changes made elsewhere to those files will be lost.
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" disabled={working} onClick={() => setConfirmingMine(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={working} onClick={() => void onKeepMine()}>
                {busy === 'mine' ? 'Working…' : 'Save mine'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

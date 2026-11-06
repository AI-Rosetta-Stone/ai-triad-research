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
import type { ReactNode } from 'react';
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
import { useDialog } from '../shared/useDialog'; // t/4909
import './SaveConflictBanner.css';

// t/4313#1's "Success, a toast" step has no shared toast utility in this codebase —
// every component rolls its own local one (p/580#8: CommunityLibrary, LibraryListPage,
// CalibrationReviewViewer). Rosetta Stone's call (p/580#8): follow that local pattern
// here too — show the message in place of the banner's actions, then hide the whole
// banner — rather than add a global utility.
const SUCCESS_MESSAGE_MS = 3_000;

const MAX_LISTED_FILES = 5;

function fileListSummary(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED_FILES);
  const more = paths.length - shown.length;
  return more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ');
}

type Busy = 'theirs' | 'mine' | null;

// t/4909: both confirms here share the same shape; extracted so each gets its own useDialog
// mount boundary — a hook call can't live inside the `{confirming... && <div>}` blocks
// themselves (conditional), and one shared call at SaveConflictBanner's own top level would
// fire its mount effect once at the banner's own mount, not when a confirm actually opens.
function SaveConflictConfirm({
  title, description, confirmLabel, confirmVariant, busyLabel, working, onConfirm, onCancel,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant: 'btn-danger' | 'btn-primary';
  busyLabel: string | null;
  working: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { dialogRef, titleId } = useDialog({ onCancel, closeOnEscape: !working });
  return (
    <div className="dialog-overlay" onClick={() => !working && onCancel()}>
      <div ref={dialogRef} className="dialog save-conflict-confirm" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 className="dialog-title" id={titleId}>{title}</h3>
        <div className="dialog-description">{description}</div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" disabled={working} onClick={onCancel}>Cancel</button>
          <button className={`btn ${confirmVariant}`} disabled={working} onClick={onConfirm}>
            {busyLabel ?? confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SaveConflictBanner() {
  const { status, refresh } = useSyncStatus();
  const loadAll = useTaxonomyStore(s => s.loadAll);
  const paths = overlayConflictPaths(status);

  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingMine, setConfirmingMine] = useState(false);
  const [confirmingTheirs, setConfirmingTheirs] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const useTheirsRef = useRef<HTMLButtonElement>(null);
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Default focus on "Use theirs" (t/4313#1), each time a new conflict appears.
  const hasConflict = paths !== null;
  useEffect(() => {
    if (hasConflict && busy === null) useTheirsRef.current?.focus();
  }, [hasConflict, busy]);

  useEffect(() => () => { if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current); }, []);

  const showSuccess = (text: string) => {
    setSuccessMsg(text);
    if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current);
    successTimeoutRef.current = setTimeout(() => setSuccessMsg(null), SUCCESS_MESSAGE_MS);
  };

  if (successMsg) {
    return (
      <div className="save-conflict-banner save-conflict-banner--success" role="status" aria-live="polite">
        <div className="save-conflict-banner-body">
          <div className="save-conflict-banner-success-text">{successMsg}</div>
        </div>
      </div>
    );
  }

  if (!paths) return null;

  const onUseTheirs = async () => {
    setBusy('theirs');
    setError(null);
    try {
      await resolveOverlayConflictUseTheirs();
      await Promise.all([refresh(), loadAll(true)]);
      setConfirmingTheirs(false);
      showSuccess('Loaded the latest version');
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
      showSuccess('Saved your changes');
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
        <SaveConflictConfirm
          title="Discard your unsaved changes?"
          description={<>This discards all your unsaved changes, including changes to files that weren't in conflict. This can't be undone.</>}
          confirmLabel="Discard my changes"
          confirmVariant="btn-danger"
          busyLabel={busy === 'theirs' ? 'Working…' : null}
          working={working}
          onConfirm={() => void onUseTheirs()}
          onCancel={() => setConfirmingTheirs(false)}
        />
      )}

      {confirmingMine && (
        <SaveConflictConfirm
          title="Replace the newer version?"
          description={<>This saves all your changes and replaces the newer version of {paths.length} file{paths.length === 1 ? '' : 's'}. Changes made elsewhere to those files will be lost.</>}
          confirmLabel="Save mine"
          confirmVariant="btn-primary"
          busyLabel={busy === 'mine' ? 'Working…' : null}
          working={working}
          onConfirm={() => void onKeepMine()}
          onCancel={() => setConfirmingMine(false)}
        />
      )}
    </div>
  );
}

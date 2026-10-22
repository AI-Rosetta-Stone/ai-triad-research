// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState, useMemo, useEffect, useRef } from 'react';
import { nodePovFromId } from '@lib/debate/nodeIdUtils';
import { useTaxonomyStore } from '../../hooks/useTaxonomyStore';
import { useSyncStatus } from '../../hooks/useSyncStatus';
import { resyncTracked, type SyncStatus } from '../../utils/syncApi';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useFlag } from '../../hooks/useFeatureFlags';
import { TheoryLink } from '../shared';
import { UnsyncedChangesDrawer } from './UnsyncedChangesDrawer';
import { SyncDiagnosticsDialog } from './SyncDiagnosticsDialog';
import { TaxonomyDiffPanel } from './TaxonomyDiffPanel';
import { TaxonomyUpdateToast } from './TaxonomyUpdateToast';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { StaleBranchHint } from '../../hooks/useTaxonomyStore/slices/staleBranchHint';
import './SaveBar.css';

function formatFileKey(key: string): string {
  if (key === 'situations') return 'Situations';
  if (key.startsWith('conflict-')) return key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function SaveBar() {
  const { dirty, save, saveError, dismissSaveError, validationErrors, integrityIssues, fixIntegrityErrors, staleBranchHint } = useTaxonomyStore();
  const adminFlag = useFlag('permission-admin-features');
  const isOnline = useOnlineStatus();
  const isDirty = dirty.size > 0;
  const [showErrors, setShowErrors] = useState(false);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [diffPanelOpen, setDiffPanelOpen] = useState(false);
  const [syncDiagOpen, setSyncDiagOpen] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncError, setResyncError] = useState<string | null>(null);
  const { status: syncStatus, refresh: refreshSync } = useSyncStatus();

  // t/4346: resync the session branch onto main from the save-bar error, when the failure
  // is a stale-branch shape (t/4325). Conflicts hand off to the drawer's RebaseConflictModal.
  const onResync = async () => {
    setResyncing(true);
    setResyncError(null);
    try {
      const res = await resyncTracked('rebase');
      if (res.conflicts) {
        setResyncError('Resync hit conflicts — resolve them in the sync panel.');
        setSyncDrawerOpen(true);
        return;
      }
      // Fix-forward (t/4346, PR #3731 comment 6335280772): the Resync button only ever shows
      // right after a failed save, so a forced loadAll() here would wipe the user's live
      // unsaved edits (loadAll resets `dirty`). Keep them; the user retries Save themselves.
      dismissSaveError();
      await refreshSync();
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'save-bar',
        level: 'error',
        message: 'Resync from save-bar failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      setResyncError(mapErrorToUserMessage(err));
    } finally {
      setResyncing(false);
    }
  };

  // Refresh sync status after a save completes (dirty transitions non-zero → 0).
  const prevDirtyCountRef = useRef(dirty.size);
  useEffect(() => {
    const prev = prevDirtyCountRef.current;
    const now = dirty.size;
    if (prev > 0 && now === 0 && syncStatus.enabled) {
      // Slight delay so the server-side commit has landed.
      const t = setTimeout(() => { void refreshSync(); }, 500);
      return () => clearTimeout(t);
    }
    prevDirtyCountRef.current = now;
    return undefined;
  }, [dirty.size, syncStatus.enabled, refreshSync]);

  const hasErrors = Object.keys(validationErrors).length > 0;

  const dirtyList = useMemo(() => [...dirty].map(formatFileKey).join(', '), [dirty]);

  const groupedErrors = useMemo(() => {
    const groups: Record<string, { path: string; message: string }[]> = {};
    for (const [path, message] of Object.entries(validationErrors)) {
      // path looks like "nodes.acc-goal-001.label" or "conflict-xyz.description"
      const parts = path.split('.');
      let fileKey: string;
      let fieldPath: string;
      if (parts[0] === 'nodes' && parts.length >= 3) {
        // POV / situations: nodes.NODE_ID.field
        const nodeId = parts[1];
        fileKey = nodePovFromId(nodeId) ?? 'unknown';
        fieldPath = `${nodeId} → ${parts.slice(2).join('.')}`;
      } else if (parts[0].startsWith('conflict-')) {
        fileKey = parts[0];
        fieldPath = parts.slice(1).join('.');
      } else {
        fileKey = parts[0];
        fieldPath = parts.slice(1).join('.') || parts[0];
      }
      const displayKey = formatFileKey(fileKey);
      if (!groups[displayKey]) groups[displayKey] = [];
      groups[displayKey].push({ path: fieldPath, message });
    }
    return groups;
  }, [validationErrors]);

  if (!adminFlag) return null;

  return (
    <div className="save-bar">
      {!isOnline && <span className="save-bar-offline">Offline</span>}
      <span className={`save-bar-status ${isDirty ? 'dirty' : ''}`}>
        {isDirty
          ? `Unsaved: ${dirtyList}`
          : 'All changes saved'}
      </span>
      <SaveBarErrorSection
        saveError={saveError}
        hasErrors={hasErrors}
        showErrors={showErrors}
        setShowErrors={setShowErrors}
        integrityIssues={integrityIssues}
        fixIntegrityErrors={fixIntegrityErrors}
        dismissSaveError={dismissSaveError}
        groupedErrors={groupedErrors}
        staleBranchHint={staleBranchHint}
        resyncing={resyncing}
        resyncError={resyncError}
        onResync={() => void onResync()}
      />
      <div className="save-bar-right">
        <SaveBarSyncBadges
          syncStatus={syncStatus}
          onOpenDrawer={() => setSyncDrawerOpen(true)}
          onOpenDiffPanel={() => setDiffPanelOpen(true)}
        />
        {adminFlag && (
          <button
            type="button"
            className="save-bar-sync-diag"
            onClick={() => setSyncDiagOpen(true)}
            title="Sync diagnostics (admin)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        )}
        {adminFlag && (
          <button
            type="button"
            className="save-bar-sync-diag"
            onClick={() => { window.location.hash = '#analytics'; }}
            title="Usage Analytics (admin)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
          </button>
        )}
        {adminFlag && (
          <button
            type="button"
            className="save-bar-sync-diag"
            onClick={() => { window.location.hash = '#engagement'; }}
            title="Engagement Analytics (admin)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </button>
        )}
        <TheoryLink
          docPath="docs/architecture-overview.md"
          label="Help: architecture overview"
        />
        <button
          className="btn btn-primary"
          onClick={save}
          disabled={!isDirty}
        >
          Save
        </button>
      </div>
      <TaxonomyUpdateToast />
      <TaxonomyDiffPanel
        open={diffPanelOpen}
        onClose={() => setDiffPanelOpen(false)}
        status={syncStatus}
        onManageChanges={() => setSyncDrawerOpen(true)}
        onSubmitted={() => { void refreshSync(); }}
      />
      <UnsyncedChangesDrawer
        open={syncDrawerOpen}
        onClose={() => setSyncDrawerOpen(false)}
        status={syncStatus}
        onChanged={() => { void refreshSync(); }}
      />
      <SyncDiagnosticsDialog
        open={syncDiagOpen}
        onClose={() => setSyncDiagOpen(false)}
      />
    </div>
  );
}

// ── Sync badges + error section (extracted for complexity, t/1918) ──

function SaveBarSyncBadges({ syncStatus, onOpenDrawer, onOpenDiffPanel }: {
  syncStatus: SyncStatus; onOpenDrawer: () => void; onOpenDiffPanel: () => void;
}) {
  return (
    <>
      {syncStatus.enabled && syncStatus.has_conflicts && (
        <span
          className="save-bar-conflict-banner"
          title="Your session branch has merge conflicts with main — open the sync panel to resolve"
          onClick={onOpenDrawer}
        >
          Conflicts detected
        </span>
      )}
      {syncStatus.enabled && syncStatus.unsynced_count > 0 && (
        <button
          type="button"
          className="save-bar-unsynced"
          onClick={onOpenDiffPanel}
          title={`${syncStatus.unsynced_count} pending change${syncStatus.unsynced_count === 1 ? '' : 's'} on ${syncStatus.session_branch ?? 'session branch'} — click to review the diff`}
        >
          <span className="save-bar-unsynced-dot" aria-hidden="true" />
          {syncStatus.unsynced_count} pending change{syncStatus.unsynced_count === 1 ? '' : 's'}
        </button>
      )}
      {syncStatus.enabled && syncStatus.main_updated_available && (
        <button
          type="button"
          className="save-bar-upstream"
          onClick={onOpenDrawer}
          title="origin/main has new commits — click to resync"
        >
          <span className="save-bar-upstream-dot" aria-hidden="true" />
          Upstream updated
        </button>
      )}
      {syncStatus.enabled && syncStatus.rebase_in_progress && (
        <button
          type="button"
          className="save-bar-rebase"
          onClick={onOpenDrawer}
          title="Rebase paused on conflicts — click to resolve"
        >
          <span className="save-bar-rebase-dot" aria-hidden="true" />
          Rebase paused
        </button>
      )}
    </>
  );
}

function SaveBarErrorSection({
  saveError, hasErrors, showErrors, setShowErrors, integrityIssues, fixIntegrityErrors, dismissSaveError, groupedErrors,
  staleBranchHint, resyncing, resyncError, onResync,
}: {
  saveError: string | null; hasErrors: boolean; showErrors: boolean;
  setShowErrors: React.Dispatch<React.SetStateAction<boolean>>;
  integrityIssues: unknown[]; fixIntegrityErrors: () => void; dismissSaveError: () => void;
  groupedErrors: Record<string, { path: string; message: string }[]>;
  staleBranchHint: StaleBranchHint | null; resyncing: boolean; resyncError: string | null; onResync: () => void;
}) {
  return (
    <>
      {saveError && (
        <span className="save-bar-error-wrap">
          <span
            className={`save-bar-error ${hasErrors ? 'clickable' : ''}`}
            onClick={() => hasErrors && setShowErrors(v => !v)}
            title={hasErrors ? 'Click to see error details' : undefined}
          >
            {saveError}{hasErrors && (showErrors ? ' ▾' : ' ▸')}
          </span>
          {integrityIssues.length > 0 && (
            <button
              type="button"
              className="save-bar-fix-btn"
              onClick={(e) => { e.stopPropagation(); fixIntegrityErrors(); }}
              title="Auto-fix integrity errors (removes dangling references)"
            >
              Fix it
            </button>
          )}
          {staleBranchHint && (
            <button
              type="button"
              className="save-bar-fix-btn"
              onClick={(e) => { e.stopPropagation(); onResync(); }}
              disabled={resyncing}
              title={`Fetch and merge main into ${staleBranchHint.sessionBranch} (${staleBranchHint.behindBy} commit${staleBranchHint.behindBy === 1 ? '' : 's'} behind)`}
            >
              {resyncing ? 'Resyncing…' : 'Resync'}
            </button>
          )}
          {resyncError && <span className="save-bar-resync-error">{resyncError}</span>}
          <button
            type="button"
            className="save-bar-error-dismiss"
            onClick={(e) => { e.stopPropagation(); setShowErrors(false); dismissSaveError(); }}
            disabled={resyncing}
            title="Dismiss error"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </span>
      )}
      {showErrors && hasErrors && (
        <div className="save-bar-error-panel">
          {Object.entries(groupedErrors).map(([file, errs]) => (
            <div key={file} className="save-bar-error-group">
              <div className="save-bar-error-file">{file}</div>
              {errs.map((e, i) => (
                <div key={i} className="save-bar-error-item" title={`${e.path}: ${e.message}`}>
                  <span className="save-bar-error-path">{e.path}</span>
                  <span className="save-bar-error-msg">{e.message}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

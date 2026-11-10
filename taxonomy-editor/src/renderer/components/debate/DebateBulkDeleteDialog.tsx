// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Bulk delete confirmation dialog ──
// Moved verbatim out of DebateTab.tsx (t/87) to take that file off its max-lines cap.
// t/88: partial failure mirrors BulkDeleteInquiryDialog — stay open, show "Deleted X of Y", keep the
// failed ones selected, and give a lone failure its own reason. deleteDebate rejects when the delete
// itself fails (t/94), which is what the per-item catch below reports.

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { useDebateStore } from '../../hooks/useDebateStore';
import { mapErrorToUserMessage } from '../../utils/errorMessages';
import { useDialog } from '../shared/useDialog'; // t/4901
import '../shared/BulkDeleteDialog.css'; // t/114: shared with BulkDeleteInquiryDialog

type SessionSummary = ReturnType<typeof useDebateStore.getState>['sessions'][number];

interface PartialError { deletedCount: number; total: number; failedTitles: string; message?: string }

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sessionTitle(s: SessionSummary): string {
  return typeof s.title === 'string' ? s.title : (s.title as any)?.final ?? (s.title as any)?.original ?? '(Untitled)';
}

export function BulkDeleteDialog({
  sessions, selectedIds, setShowBulkDeleteConfirm, setEditMode, setSelectedIds, deleteDebate,
}: {
  sessions: SessionSummary[];
  selectedIds: Set<string>;
  setShowBulkDeleteConfirm: Dispatch<SetStateAction<boolean>>;
  setEditMode: Dispatch<SetStateAction<boolean>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  deleteDebate: (id: string) => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [partialError, setPartialError] = useState<PartialError | null>(null);
  const { dialogRef, titleId } = useDialog({ onCancel: () => setShowBulkDeleteConfirm(false), closeOnEscape: !deleting }); // t/4901

  const handleConfirm = async () => {
    setDeleting(true);
    setPartialError(null);
    const ids = Array.from(selectedIds);
    const failedIds: string[] = [];
    let lastErr: unknown = null;
    let deletedCount = 0;
    for (const id of ids) {
      try {
        await deleteDebate(id);
        deletedCount++;
      } catch (err) {
        failedIds.push(id);
        lastErr = err;
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'debate-tab', level: 'warn',
          message: `Failed to delete debate ${id} during bulk delete (WARN: continuing with the remaining selected debates)`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      }
    }
    setDeleting(false);
    if (failedIds.length === 0) {
      setShowBulkDeleteConfirm(false);
      setEditMode(false);
      setSelectedIds(new Set());
      return;
    }
    setSelectedIds(new Set(failedIds));
    const failedTitles = failedIds.map(id => {
      const s = sessions.find(x => x.id === id);
      return s ? sessionTitle(s) : id;
    }).join(', ');
    // A single-item selection that fails gets its own reason; a multi-item batch keeps the generic
    // aggregate message even if only one failed (matches BulkDeleteInquiryDialog).
    const message = ids.length === 1 ? mapErrorToUserMessage(lastErr) : undefined;
    setPartialError({ deletedCount, total: ids.length, failedTitles, message });
  };

  return (
    <div className="dialog-overlay" onClick={() => { if (!deleting) setShowBulkDeleteConfirm(false); }}>
      <div ref={dialogRef} className="dialog bulk-delete-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Delete {selectedIds.size} debate{selectedIds.size !== 1 ? 's' : ''}?</h3>
        <div className="bulk-delete-list">
          {sessions.filter(s => selectedIds.has(s.id)).map(s => (
            <div key={s.id} className="bulk-delete-item">
              <span className="bulk-delete-item-title">{sessionTitle(s)}</span>
              <span className="bulk-delete-item-meta">{s.phase} &middot; {formatDate(s.updated_at)}</span>
            </div>
          ))}
        </div>
        <div className="bulk-delete-note">
          Session files will be permanently deleted. Harvested items (conflicts, steelman refinements, debate refs) are preserved.
        </div>
        {partialError ? (
          <div className="bulk-delete-error" role="alert">
            {partialError.message
              ? `Deleted ${partialError.deletedCount} of ${partialError.total}. ${partialError.message}`
              : `Deleted ${partialError.deletedCount} of ${partialError.total}. Couldn't delete: ${partialError.failedTitles}.`}
          </div>
        ) : null}
        <div className="dialog-actions">
          <button className="btn" disabled={deleting} onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</button>
          <button
            className="btn btn-danger"
            disabled={deleting}
            onClick={() => void handleConfirm()}
          >
            {deleting ? 'Deleting…' : `Delete ${selectedIds.size} Debate${selectedIds.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

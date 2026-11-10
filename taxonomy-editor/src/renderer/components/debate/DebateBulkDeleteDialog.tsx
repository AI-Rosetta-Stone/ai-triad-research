// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// ── Bulk delete confirmation dialog ──
// Moved verbatim out of DebateTab.tsx (t/87) to take that file off its max-lines cap.

import type { Dispatch, SetStateAction } from 'react';
import type { useDebateStore } from '../../hooks/useDebateStore';
import { useDialog } from '../shared/useDialog'; // t/4901

type SessionSummary = ReturnType<typeof useDebateStore.getState>['sessions'][number];

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
  const { dialogRef, titleId } = useDialog({ onCancel: () => setShowBulkDeleteConfirm(false) }); // t/4901
  return (
    <div className="dialog-overlay" onClick={() => setShowBulkDeleteConfirm(false)}>
      <div ref={dialogRef} className="dialog bulk-delete-dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>Delete {selectedIds.size} debate{selectedIds.size !== 1 ? 's' : ''}?</h3>
        <div className="bulk-delete-list">
          {sessions.filter(s => selectedIds.has(s.id)).map(s => (
            <div key={s.id} className="bulk-delete-item">
              <span className="bulk-delete-item-title">{typeof s.title === 'string' ? s.title : (s.title as any)?.final ?? (s.title as any)?.original ?? '(Untitled)'}</span>
              <span className="bulk-delete-item-meta">{s.phase} &middot; {formatDate(s.updated_at)}</span>
            </div>
          ))}
        </div>
        <div className="bulk-delete-note">
          Session files will be permanently deleted. Harvested items (conflicts, steelman refinements, debate refs) are preserved.
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => setShowBulkDeleteConfirm(false)}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              for (const id of selectedIds) {
                await deleteDebate(id);
              }
              setShowBulkDeleteConfirm(false);
              setEditMode(false);
              setSelectedIds(new Set());
            }}
          >
            Delete {selectedIds.size} Debate{selectedIds.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useRef } from 'react';
import { useDialog } from './useDialog';

interface DeleteConfirmDialogProps {
  itemLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** t/3852: pre-formatted "this will orphan N edge(s), M situation reference(s)..." text —
   *  the caller computes its own counts (edges/situations/children mean different things
   *  per node type) and passes ready-to-render text. Omit when there's nothing to warn about. */
  danglingWarning?: string;
}

export function DeleteConfirmDialog({ itemLabel, onConfirm, onCancel, danglingWarning }: DeleteConfirmDialogProps) {
  // t/4901: Cancel, not Delete, gets initial focus — the safe control for a destructive confirm.
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, titleId } = useDialog({ onCancel, initialFocusRef: cancelRef });
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>Delete Node</h3>
        <p>
          Are you sure you want to delete <strong>{itemLabel || '(untitled)'}</strong>?
          This action cannot be undone until you save.
        </p>
        {danglingWarning && (
          <p className="dialog-warning">{danglingWarning}</p>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useState } from 'react';
import type { Category } from '../../types/taxonomy';
import { useDialog } from './useDialog'; // t/4909

interface NewNodeDialogProps {
  onConfirm: (category: Category) => void;
  onCancel: () => void;
}

const CATEGORIES: Category[] = ['Desires', 'Beliefs', 'Intentions'];

export function NewNodeDialog({ onConfirm, onCancel }: NewNodeDialogProps) {
  const [category, setCategory] = useState<Category>('Desires');
  const { dialogRef, titleId } = useDialog({ onCancel }); // t/4909

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <h3 id={titleId}>New Node</h3>
        <div className="form-group">
          <label>Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as Category)}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(category)}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

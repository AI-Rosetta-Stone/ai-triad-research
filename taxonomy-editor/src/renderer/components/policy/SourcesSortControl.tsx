// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4389 (PI request): the Sources panels' row order. Title A–Z by default, or references (most first).
// One remembered choice per viewer, shared by SourcesPanel and PolicySourcesPanel. Browser storage is a
// convenience only: if it can't be read or written, the panel still works with the default order.

import { useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { DocumentSortMode } from './sourceGrouping';
import './SourcesSortControl.css';

export const SOURCES_SORT_STORAGE_KEY = 'sources-panel.sort';

function readSortMode(): DocumentSortMode {
  try {
    return localStorage.getItem(SOURCES_SORT_STORAGE_KEY) === 'count' ? 'count' : 'title';
  } catch (err) {
    // Storage blocked (private window, cleared site data): not a fault, so debug level. Default order.
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'sources-panel', level: 'debug',
      message: 'sources sort preference read failed; using the default order',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return 'title';
  }
}

/** The viewer's remembered sort order (default 'title'), and a setter that remembers the change. */
export function useSourcesSortMode(): [DocumentSortMode, (mode: DocumentSortMode) => void] {
  const [mode, setMode] = useState<DocumentSortMode>(readSortMode);
  const update = (next: DocumentSortMode) => {
    setMode(next);
    try {
      localStorage.setItem(SOURCES_SORT_STORAGE_KEY, next);
    } catch (err) {
      // The choice still applies for this visit; it just isn't remembered.
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'sources-panel', level: 'debug',
        message: 'sources sort preference write failed; the choice applies to this visit only',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
    }
  };
  return [mode, update];
}

const OPTIONS: { mode: DocumentSortMode; label: string }[] = [
  { mode: 'title', label: 'Title (A–Z)' },
  { mode: 'count', label: 'References (most first)' },
];

export function SourcesSortControl({ mode, onChange }: { mode: DocumentSortMode; onChange: (mode: DocumentSortMode) => void }) {
  return (
    <div className="sources-sort" role="group" aria-label="Sort documents">
      <span className="sources-sort-label">Sort:</span>
      {OPTIONS.map(o => (
        <button
          key={o.mode}
          type="button"
          className={`sources-sort-option${mode === o.mode ? ' active' : ''}`}
          aria-pressed={mode === o.mode}
          onClick={() => onChange(o.mode)}
        >{o.label}</button>
      ))}
    </div>
  );
}

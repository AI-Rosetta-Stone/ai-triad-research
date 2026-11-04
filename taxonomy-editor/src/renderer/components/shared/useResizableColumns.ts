// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4830 (TL design, t/4830#2): drag/keyboard/persistence for LibraryListPage's opt-in
// resizable-column affordance. A column (or the title column) opts in by declaring
// `{ min, max }`; columns that don't are completely unaffected — their width stays whatever
// the page config already declares ('1fr', '150px', ...). Shared here (not per-page) so every
// LibraryListPage consumer gets the same drag/keyboard/clamp/persistence behavior for free.

import { useCallback, useMemo, useRef, useState } from 'react';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export interface ResizableSpec {
  min: number;
  max: number;
}

const STEP_PX = 16;

function storageKey(pageId: string, columnId: string): string {
  return `lib-col-width:${pageId}:${columnId}`;
}

function readPersisted(pageId: string | undefined, columnId: string, spec: ResizableSpec): number | null {
  if (!pageId) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(pageId, columnId));
    if (raw === null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'useResizableColumns', level: 'warn',
        message: `Discarding corrupt or out-of-range persisted width for column "${columnId}"`,
        error: { name: 'Error', message: `raw value: ${raw}` },
      });
      return null;
    }
    return n;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'useResizableColumns', level: 'warn',
      message: `Failed to read persisted width for column "${columnId}"`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

function writePersisted(pageId: string | undefined, columnId: string, px: number | null): void {
  if (!pageId) return;
  try {
    if (px === null) window.localStorage.removeItem(storageKey(pageId, columnId));
    else window.localStorage.setItem(storageKey(pageId, columnId), String(Math.round(px)));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'useResizableColumns', level: 'warn',
      message: `Failed to persist width for column "${columnId}"`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

function initialWidths(pageId: string | undefined, specs: Record<string, ResizableSpec>): Record<string, number | null> {
  const init: Record<string, number | null> = {};
  for (const id of Object.keys(specs)) init[id] = readPersisted(pageId, id, specs[id]);
  return init;
}

export interface ResizeHandleProps {
  role: 'separator';
  tabIndex: 0;
  'aria-label': string;
  'aria-valuenow': number;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-orientation': 'vertical';
  onPointerDown: (e: React.PointerEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDoubleClick: () => void;
}

/**
 * `pageId` keys persistence (`lib-col-width:<pageId>:<columnId>`); omit it (a page with no
 * `restoreKey`) and resizing still works for the session, just without persistence. `specs`
 * maps columnId -> {min, max} for every resizable column on this render — the title column
 * uses the id `'title'`. Returns the current px per column (absent/null = not yet resized; the
 * caller keeps its own declared default width), a cell ref-callback for measuring the column's
 * rendered width on first drag/keypress, and a handle-props factory for the drag/keyboard
 * affordance itself.
 */
export function useResizableColumns(pageId: string | undefined, specs: Record<string, ResizableSpec>) {
  const specsKey = Object.keys(specs).map(id => `${id}:${specs[id].min}-${specs[id].max}`).join(',');
  const [widths, setWidths] = useState<Record<string, number | null>>(() => initialWidths(pageId, specs));
  // Re-seed if the set of resizable columns changes shape (e.g. a different page config mounts
  // in the same component instance in tests) — specsKey captures identity cheaply without a
  // deep-equal.
  const seededKey = useRef(specsKey);
  if (seededKey.current !== specsKey) {
    seededKey.current = specsKey;
    setWidths(initialWidths(pageId, specs));
  }

  const cellRefs = useRef<Record<string, HTMLElement | null>>({});
  const dragRef = useRef<{ id: string; startX: number; startPx: number } | null>(null);

  const registerCell = useCallback((id: string) => (el: HTMLElement | null) => {
    cellRefs.current[id] = el;
  }, []);

  const measure = useCallback((id: string): number => {
    const current = widths[id];
    if (current !== null && current !== undefined) return current;
    const el = cellRefs.current[id];
    return el ? el.getBoundingClientRect().width : specs[id].min;
  }, [widths, specs]);

  const commit = useCallback((id: string, next: number) => {
    const spec = specs[id];
    const clamped = Math.min(spec.max, Math.max(spec.min, next));
    setWidths(w => ({ ...w, [id]: clamped }));
    writePersisted(pageId, id, clamped);
  }, [pageId, specs]);

  const reset = useCallback((id: string) => {
    setWidths(w => ({ ...w, [id]: null }));
    writePersisted(pageId, id, null);
  }, [pageId]);

  const getHandleProps = useCallback((id: string, label: string): ResizeHandleProps => ({
    role: 'separator',
    tabIndex: 0,
    'aria-label': label,
    'aria-valuenow': Math.round(widths[id] ?? measure(id)),
    'aria-valuemin': specs[id].min,
    'aria-valuemax': specs[id].max,
    'aria-orientation': 'vertical',
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { id, startX: e.clientX, startPx: measure(id) };
      const onMove = (ev: PointerEvent) => {
        if (!dragRef.current || dragRef.current.id !== id) return;
        commit(id, dragRef.current.startPx + (ev.clientX - dragRef.current.startX));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); commit(id, measure(id) - STEP_PX); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); commit(id, measure(id) + STEP_PX); }
    },
    onDoubleClick: () => reset(id),
  }), [widths, specs, measure, commit, reset]);

  // Memoized so GridHeaderRow's prop identity is stable when nothing resizable changed.
  return useMemo(() => ({ widths, registerCell, getHandleProps }), [widths, registerCell, getHandleProps]);
}

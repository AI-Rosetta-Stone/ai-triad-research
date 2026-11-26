// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/778: which rows of a statement's Why panel show their explanation. Every row starts
// collapsed. A row toggles on its own, and "Expand all" / "Collapse all" sets every row at once.
//
// The choice is a reading aid for this session, not debate state: it lives in module memory
// keyed by statement, is never saved with the debate, and is gone on reload.

import { useCallback, useId, useSyncExternalStore } from 'react';

// state key → ids of the rows that are open.
const openByKey = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getVersion(): number { return version; }

/** Test hook: forget every statement's choices. */
export function resetWhyExplanations(): void {
  openByKey.clear();
  emit();
}

export interface WhyExplanations {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  /** True when every row in `ids` is open, which is when the panel control reads "Collapse all". */
  allOpen: boolean;
  setAll: (open: boolean) => void;
}

/** The open rows of one statement's Why panel. With no `stateKey` (a panel rendered on its own)
 *  the state is still kept, under a key private to this component instance. */
export function useWhyExplanations(stateKey: string | undefined, ids: readonly string[]): WhyExplanations {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const ownKey = useId();
  const key = stateKey ?? ownKey;
  const open = openByKey.get(key);
  const isOpen = useCallback((id: string) => open?.has(id) ?? false, [open]);
  const toggle = useCallback((id: string) => {
    const next = new Set(openByKey.get(key));
    if (next.has(id)) next.delete(id); else next.add(id);
    openByKey.set(key, next);
    emit();
  }, [key]);
  const setAll = useCallback((value: boolean) => {
    openByKey.set(key, new Set(value ? ids : []));
    emit();
  }, [key, ids]);
  const allOpen = ids.length > 0 && ids.every(id => open?.has(id));
  return { isOpen, toggle, allOpen, setAll };
}

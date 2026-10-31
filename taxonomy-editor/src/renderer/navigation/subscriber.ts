// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { NavHistory } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';
import { placeOf } from './placeOf';

/**
 * Global restoring guard: when true, store subscribers skip pushing/replacing.
 * Set during restore() so that setActiveTab() and other store mutations don't
 * trigger the subscriber and create unwanted history entries.
 */
let isRestoring = false;

export function setRestoringFlag(value: boolean): void {
  isRestoring = value;
}

export function getRestoringFlag(): boolean {
  return isRestoring;
}

/**
 * Install a state→URL subscriber that maintains the history stack.
 * Compares current state against navHistory.current() (not previousPlace),
 * so async opens are handled correctly even when restore clears synchronously.
 *
 * Boot: calls navHistory.replace(initialPlace) to establish first entry
 * without pushing (AC6 no-trap rule).
 *
 * Call this once at app boot, after stores and navHistory are initialized.
 */
export function installNavSubscriber(store: {
  // Zustand's plain subscribe(listener). useTaxonomyStore is NOT created with
  // subscribeWithSelector, so the (selector, listener) form never calls the listener.
  subscribe: (listener: (state: TaxonomyStore, prevState: TaxonomyStore) => void) => () => void;
  getState: () => TaxonomyStore;
}, navHistory: NavHistory): () => void {
  // Boot: apply initial place to history state (replaceState, not push)
  const initialState = store.getState();
  const initialPlace = placeOf(initialState);
  navHistory.replace({
    path: initialPlace.path,
    placeKey: initialPlace.placeKey,
    label: initialPlace.label,
  });

  return store.subscribe(
    (state: TaxonomyStore) => {
      if (isRestoring) {
        // During restore, ignore store changes — don't push/replace
        return;
      }
      const newPlace = placeOf(state);

      const currentEntry = navHistory.current();
      if (!currentEntry) {
        // No history entry yet (shouldn't happen after boot)
        navHistory.replace({
          path: newPlace.path,
          placeKey: newPlace.placeKey,
          label: newPlace.label,
        });
        return;
      }

      // Blocker 1 fix: Compare against navHistory.current(), not previousPlace.
      // After popstate/back(), current() already reflects restored URL.
      // Async opens (pendingOpen) firing later compare against that restored state,
      // not a stale previousPlace from before the restore.
      if (newPlace.placeKey !== currentEntry.placeKey) {
        // Different place → push
        navHistory.push({
          path: newPlace.path,
          placeKey: newPlace.placeKey,
          label: newPlace.label,
        });
      } else if (newPlace.path !== currentEntry.path) {
        // Same place, different path (e.g., POV switch within Taxonomy) → replace
        navHistory.replace({
          path: newPlace.path,
          placeKey: newPlace.placeKey,
          label: newPlace.label,
        });
      }
      // else: same place, same path — no-op
    }
  );
}

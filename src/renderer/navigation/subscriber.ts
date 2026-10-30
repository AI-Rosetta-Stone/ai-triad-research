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
 * Watches for store changes, compares placeKey, and decides push vs. replace.
 *
 * Call this once at app boot, after stores are initialized.
 */
export function installNavSubscriber(store: {
  subscribe: (selector: (state: TaxonomyStore) => any, listener: (value: any) => void) => () => void;
}, navHistory: NavHistory): () => void {
  let previousPlace = placeOf(store.getState() as TaxonomyStore);

  return store.subscribe(
    (state: TaxonomyStore) => placeOf(state),
    (newPlace) => {
      if (isRestoring) {
        // During restore, ignore store changes — don't push/replace
        return;
      }

      if (!previousPlace) {
        // Boot — no previous state, just update
        previousPlace = newPlace;
        return;
      }

      if (newPlace.placeKey !== previousPlace.placeKey) {
        // Different place → push
        navHistory.push({
          path: newPlace.path,
          placeKey: newPlace.placeKey,
          label: newPlace.label,
        });
      } else if (newPlace.path !== previousPlace.path) {
        // Same place, different path (e.g., POV switch within Taxonomy) → replace
        navHistory.replace({
          path: newPlace.path,
          placeKey: newPlace.placeKey,
          label: newPlace.label,
        });
      }
      // else: same place, same path — no-op

      previousPlace = newPlace;
    }
  );
}

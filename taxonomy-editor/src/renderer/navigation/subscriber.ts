// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { NavHistory } from './types';
import type { TaxonomyStore } from '../hooks/useTaxonomyStore';
import { placeOf, type AppState } from './placeOf';

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
 * A Zustand store's plain subscribe(listener) + getState(). None of these stores is created with
 * subscribeWithSelector, so the (selector, listener) form would never call the listener (t/4640).
 */
export interface SubscribableStore<S> {
  subscribe: (listener: (state: S, prevState: S) => void) => () => void;
  getState: () => S;
}

/**
 * The stores a "place" is read from. Which item is open lives in each tool's own store (t/4640
 * PR 4), so the subscriber must listen to all of them — listening to the taxonomy store alone
 * would miss opening a chat, debate, op-ed set or question answer.
 */
export interface NavStores {
  taxonomy: SubscribableStore<TaxonomyStore>;
  debate?: SubscribableStore<NonNullable<AppState['debateStore']>>;
  chat?: SubscribableStore<NonNullable<AppState['chatStore']>>;
  opEd?: SubscribableStore<NonNullable<AppState['opEdStore']>>;
  inquiry?: SubscribableStore<NonNullable<AppState['inquiryStore']>>;
}

export function readAppState(stores: NavStores): AppState {
  const taxonomyStore = stores.taxonomy.getState();
  return {
    taxonomyStore,
    debateStore: stores.debate?.getState(),
    chatStore: stores.chat?.getState(),
    opEdStore: stores.opEd?.getState(),
    inquiryStore: stores.inquiry?.getState(),
    activeTab: taxonomyStore.activeTab,
  };
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
 * Returns a function that unsubscribes from every store.
 */
export function installNavSubscriber(stores: NavStores, navHistory: NavHistory): () => void {
  // Boot: apply initial place to history state (replaceState, not push)
  const initialPlace = placeOf(readAppState(stores));
  navHistory.replace({
    path: initialPlace.path,
    placeKey: initialPlace.placeKey,
    label: initialPlace.label,
  });

  const onStoreChange = () => {
    if (isRestoring) {
      // During restore, ignore store changes — don't push/replace
      return;
    }
    const newPlace = placeOf(readAppState(stores));

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
  };

  const unsubscribes = [
    stores.taxonomy.subscribe(onStoreChange),
    stores.debate?.subscribe(onStoreChange),
    stores.chat?.subscribe(onStoreChange),
    stores.opEd?.subscribe(onStoreChange),
    stores.inquiry?.subscribe(onStoreChange),
  ].filter((u): u is () => void => typeof u === 'function');

  return () => unsubscribes.forEach(unsubscribe => unsubscribe());
}

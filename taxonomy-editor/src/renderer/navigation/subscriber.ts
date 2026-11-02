// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { NavHistory, HistoryEntry, PlaceInfo } from './types';
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
 * A place the app is about to reach on its own, not by a user action (t/4640#40 item 6): a
 * restore's async open landing, the Chat tab auto-opening the newest chat, Taxonomy
 * auto-selecting its first node. Reaching it REPLACES the current entry instead of pushing,
 * so it never adds a Back step. Cleared once reached, or by the next real push (the user
 * moved on before it arrived).
 */
let expectedPlaceKey: string | null = null;

export function expectReplace(placeKey: string | null): void {
  expectedPlaceKey = placeKey;
}

const toolOf = (placeKey: string) => placeKey.split(':')[0];

/** Set by installNavSubscriber; lets resyncToState() reach the installed subscriber. */
let resyncHook: (() => void) | null = null;

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
 * A view's query (e.g. an op-ed's `?pov=`, written by replaceView) belongs to the entry until the
 * place itself names a query. Without this, the next unrelated store change in the same place
 * would strip it again.
 */
function samePath(place: PlaceInfo, entry: HistoryEntry): boolean {
  if (place.path === entry.path) return true;
  return !place.path.includes('?') && entry.path.split('?')[0] === place.path;
}

/**
 * Install the two-way sync between app state and the history stack.
 *
 * - **State → history:** a new place pushes; the same place with a new path or label replaces
 *   (a label change is a title arriving, never a Back step). Compares against
 *   navHistory.current(), so async opens compare against the restored entry.
 * - **History → state:** when the history moves on its own (Back, Forward, Recent, browser
 *   popstate) to an entry whose place isn't the current one, `restorePath(entry.path)` brings
 *   the app there (t/4640#40 item 5: before this, the URL moved and the view stuck).
 *
 * Boot: replaces (never pushes) the first entry — the AC6 no-trap rule.
 * Returns a function that unsubscribes from every store and the history.
 */
export function installNavSubscriber(
  stores: NavStores,
  navHistory: NavHistory,
  restorePath: (path: string) => void = () => {},
): () => void {
  // True while this subscriber writes to the history itself, so its own push/replace
  // notifications aren't mistaken for a history move to restore.
  let writing = false;
  const write = (kind: 'push' | 'replace', entry: Omit<HistoryEntry, 'timestamp'>) => {
    writing = true;
    try {
      navHistory[kind](entry);
    } finally {
      writing = false;
    }
  };

  /** A restore that landed synchronously has nothing left to wait for — drop the expectation. */
  const clearExpectedIfReached = () => {
    if (expectedPlaceKey === placeOf(readAppState(stores)).placeKey) expectedPlaceKey = null;
  };

  const initialPlace = placeOf(readAppState(stores));
  write('replace', { path: initialPlace.path, placeKey: initialPlace.placeKey, label: initialPlace.label });
  clearExpectedIfReached();

  resyncHook = () => {
    expectedPlaceKey = null;
    const place = placeOf(readAppState(stores));
    const currentEntry = navHistory.current();
    if (currentEntry && currentEntry.placeKey !== place.placeKey) {
      write('replace', { path: place.path, placeKey: place.placeKey, label: place.label });
    }
  };

  const onStoreChange = () => {
    if (isRestoring) return;
    const newPlace = placeOf(readAppState(stores));
    const entry = { path: newPlace.path, placeKey: newPlace.placeKey, label: newPlace.label };
    const currentEntry = navHistory.current();
    if (!currentEntry) {
      write('replace', entry);
      return;
    }

    // The current entry is a restored item still loading (e.g. Back to /chat/:id clears the old
    // chat, then loads this one). Until it lands, placeOf() reports the tool's library; recording
    // that would push a new place and drop every Forward entry (Electron AC4 walk, t/4640).
    // Only the interim place is skipped; the item itself arriving falls through (title update).
    const stillLoading = expectedPlaceKey === currentEntry.placeKey
      && newPlace.placeKey !== currentEntry.placeKey
      && toolOf(newPlace.placeKey) === toolOf(currentEntry.placeKey);
    if (stillLoading) return;

    if (newPlace.placeKey !== currentEntry.placeKey) {
      if (newPlace.placeKey === expectedPlaceKey) {
        expectedPlaceKey = null;
        write('replace', entry);
      } else {
        expectedPlaceKey = null;
        write('push', entry);
      }
      return;
    }
    if (newPlace.placeKey === expectedPlaceKey) expectedPlaceKey = null;
    const keepPath = samePath(newPlace, currentEntry);
    if (!keepPath || newPlace.label !== currentEntry.label) {
      write('replace', { ...entry, path: keepPath ? currentEntry.path : newPlace.path });
    }
  };

  const onHistoryMove = (moved: HistoryEntry) => {
    if (writing) return;
    if (moved.placeKey === placeOf(readAppState(stores)).placeKey) return;
    restorePath(moved.path);
    clearExpectedIfReached();
  };

  const unsubscribes = [
    stores.taxonomy.subscribe(onStoreChange),
    stores.debate?.subscribe(onStoreChange),
    stores.chat?.subscribe(onStoreChange),
    stores.opEd?.subscribe(onStoreChange),
    stores.inquiry?.subscribe(onStoreChange),
    navHistory.subscribe(onHistoryMove),
  ].filter((u): u is () => void => typeof u === 'function');

  return () => {
    unsubscribes.forEach(unsubscribe => unsubscribe());
    resyncHook = null;
  };
}

/**
 * A restored item failed to load (t/4640 AC3): stop waiting for it, and replace the current
 * entry with the place the app is actually showing — the tool's library — so the URL and the
 * Back tooltip don't keep naming an item that isn't there. No Back step is added.
 */
export function resyncToState(): void {
  resyncHook?.();
}

/**
 * Record a view change inside the current place (t/4640: camp tabs, filters) — replaces the
 * current entry's path, never adds a Back step. With `placeKey`, applies only while that place
 * is current, so a late call can't rewrite some other entry's URL.
 */
export function replaceView(navHistory: NavHistory, path: string, placeKey?: string): void {
  const current = navHistory.current();
  if (!current || (placeKey && current.placeKey !== placeKey)) return;
  navHistory.replace({ path, placeKey: current.placeKey, label: current.label });
}

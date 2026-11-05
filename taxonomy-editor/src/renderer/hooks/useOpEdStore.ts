// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';
import type { OpEdSetSummary } from '../../../../lib/oped/types';

// Personal Op-Ed library store (t/2576). A lean list/load/delete/rename surface over
// the bridge trio — deliberately NOT a mirror of useDebateStore's state machine: an
// op-ed set is static text, so there is no live-generation loop to model here. The
// PR#2 create flow adds the generation actions; PR#1 is the library + reader only.
//
// Personal op-eds come through `api.*OpEd*` (Electron: local fs via t/2575 IPC; web:
// t/2573 routes). Community op-eds live in useCommunityStore alongside debates/chats.

interface OpEdStore {
  /** Personal op-ed sets as lightweight index rows (no body/params — load on open). */
  sets: OpEdSetSummary[];
  /** set_id of the row open in the reader, or null for the table view. */
  selectedSetId: string | null;
  /** t/4888: a community set's title isn't in `sets` (My-only), and whether it's a community
   *  item at all isn't recoverable from `selectedSetId` alone — both come from `selectSet`'s
   *  `meta`, mirroring OpEdTab's own readerSource/readerCommunityId, so placeOf.ts (store-only
   *  visibility) can give an open community set an up-crumb. */
  selectedSetTitle: string | null;
  selectedSetIsCommunity: boolean;
  loading: boolean;
  error: string | null;
  /** Edit mode enables the bulk-select checkbox column + inline rename (My only). */
  editMode: boolean;
  selectedIds: Set<string>;
  /**
   * t/3486: a deep-link route restore's request to open a set — bridges `appRoutes.ts`'s
   * `restore()` (a pure store action) to `OpEdTab.tsx`'s reader-open logic, which is
   * component-local state (readerSet/readerLoading), not store-owned. `OpEdTab` watches
   * this field and clears it once consumed; "my" sets only for now (t/3486#4).
   */
  pendingOpen: { setId: string; pov?: string } | null;

  loadSets: () => Promise<void>;
  selectSet: (id: string | null, meta?: { title?: string; community?: boolean }) => void;
  deleteSet: (id: string) => Promise<void>;
  renameSet: (id: string, topic: string) => Promise<void>;
  setEditMode: (on: boolean) => void;
  toggleSelected: (id: string) => void;
  clearSelected: () => void;
  deleteSelected: () => Promise<void>;
  requestOpen: (setId: string, pov?: string) => void;
  clearPendingOpen: () => void;
}

export const useOpEdStore = create<OpEdStore>((set, get) => ({
  sets: [],
  selectedSetId: null,
  selectedSetTitle: null,
  selectedSetIsCommunity: false,
  loading: false,
  error: null,
  editMode: false,
  selectedIds: new Set<string>(),
  pendingOpen: null,

  loadSets: async () => {
    set({ loading: true, error: null });
    try {
      const sets = await api.listOpEdSets();
      set({ sets, loading: false });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'oped-store', level: 'error', message: 'Failed to load op-ed sets',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ error: String(err), loading: false });
    }
  },

  selectSet: (id, meta) => set({
    selectedSetId: id,
    selectedSetTitle: id ? meta?.title ?? null : null,
    selectedSetIsCommunity: id ? !!meta?.community : false,
  }),

  requestOpen: (setId, pov) => set({ pendingOpen: { setId, pov } }),
  clearPendingOpen: () => set({ pendingOpen: null }),

  deleteSet: async (id) => {
    const prev = get().sets;
    // Optimistic removal; roll back on failure. Mutations never auto-retry — the
    // error is re-thrown so the caller surfaces user-visible feedback (toast/inline).
    set({
      sets: prev.filter(s => s.set_id !== id),
      selectedSetId: get().selectedSetId === id ? null : get().selectedSetId,
    });
    try {
      await api.deleteOpEdSet(id);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'oped-store', level: 'error', message: 'Failed to delete op-ed set',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ sets: prev, error: String(err) });
      throw err;
    }
  },

  renameSet: async (id, topic) => {
    const prev = get().sets;
    const target = prev.find(s => s.set_id === id);
    if (!target) return;
    // Optimistically patch the visible index row (topic is on the summary), but the
    // persisted doc is the FULL set — the index carries no body, so we load-then-save
    // the whole doc (a summary-only save would truncate opeds/params). t/2605.
    set({ sets: prev.map(s => (s.set_id === id ? { ...s, topic } : s)) });
    try {
      const full = await api.loadOpEdSet(id);
      await api.saveOpEdSet({ ...full, topic });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'oped-store', level: 'error', message: 'Failed to rename op-ed set',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      set({ sets: prev, error: String(err) });
      throw err;
    }
  },

  setEditMode: (on) => set({ editMode: on, selectedIds: on ? get().selectedIds : new Set<string>() }),

  toggleSelected: (id) => {
    const next = new Set(get().selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ selectedIds: next });
  },

  clearSelected: () => set({ selectedIds: new Set<string>() }),

  deleteSelected: async () => {
    const ids = Array.from(get().selectedIds);
    // Sequential, not parallel: mutations must not race, and a mid-batch failure
    // should stop rather than fire the rest blind. deleteSet re-throws on failure.
    for (const id of ids) {
      await get().deleteSet(id);
    }
    set({ selectedIds: new Set<string>(), editMode: false });
  },
}));

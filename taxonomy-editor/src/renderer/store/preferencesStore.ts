// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import type { ViewMode, UserPreferences } from '../bridge/types';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

export type NodeDetailTabGroup = 'what' | 'why' | 'how';

const VALID_TAB_GROUPS: readonly NodeDetailTabGroup[] = ['what', 'why', 'how'];

interface PreferencesState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => Promise<void>;
  /** t/4826: the node detail panel's What/Why/How tab-group filter. Independent of `viewMode`
   *  (never reads or writes it) and panel-wide, not per-node — a reading choice, not a node
   *  property, so it follows the reader from node to node. Retires the per-node `nodeDetailModes`
   *  override (t/4736), which existed only to back the now-removed per-node Simple/Advanced
   *  toggle. */
  nodeDetailTabGroup: NodeDetailTabGroup;
  setNodeDetailTabGroup: (group: NodeDetailTabGroup) => Promise<void>;
  /** Load persisted preferences from the bridge and hydrate the store. */
  hydrate: () => Promise<void>;
}

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
  viewMode: 'simple',
  nodeDetailTabGroup: 'what',

  setViewMode: async (mode: ViewMode) => {
    set({ viewMode: mode });
    try {
      const { api } = await import('@bridge'); // alias — resolves to web-bridge on web, electron-bridge on desktop (t/2651)
      const state = get();
      await api.setPreferences({ viewMode: mode, nodeDetailTabGroup: state.nodeDetailTabGroup });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to persist view mode preference', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },

  setNodeDetailTabGroup: async (group: NodeDetailTabGroup) => {
    set({ nodeDetailTabGroup: group });
    try {
      const { api } = await import('@bridge');
      const state = get();
      await api.setPreferences({ viewMode: state.viewMode, nodeDetailTabGroup: group });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to persist node detail tab group preference', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },

  hydrate: async () => {
    try {
      const { api } = await import('@bridge'); // alias — resolves to web-bridge on web, electron-bridge on desktop (t/2651)
      const prefs: UserPreferences | null = await api.getPreferences();
      if (prefs?.viewMode) {
        set({ viewMode: prefs.viewMode });
      }
      // t/4826: passthrough field (UserPreferencesSchema.passthrough()), so it's `unknown` on
      // the inferred type — validate before trusting it, same pattern the retired
      // nodeDetailModes read used.
      if (typeof prefs?.nodeDetailTabGroup === 'string' && VALID_TAB_GROUPS.includes(prefs.nodeDetailTabGroup as NodeDetailTabGroup)) {
        set({ nodeDetailTabGroup: prefs.nodeDetailTabGroup as NodeDetailTabGroup });
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to hydrate preferences from bridge', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },
}));

((window as unknown as { __ZUSTAND_STORES__?: Record<string, unknown> }).__ZUSTAND_STORES__ ??= {} as Record<string, unknown>).preferences = usePreferencesStore;

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { create } from 'zustand';
import type { ViewMode, UserPreferences } from '../bridge/types';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

interface PreferencesState {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => Promise<void>;
  /** Per-node Simple/Advanced mode map (t/4574). Plain Record for persist compatibility. */
  nodeDetailModes: Record<string, 'simple' | 'advanced'>;
  /** Get the mode for a node, defaulting to 'simple'. */
  getNodeDetailMode: (nodeId: string) => 'simple' | 'advanced';
  /** Set the mode for a node, with LRU eviction at 500 entries. */
  setNodeDetailMode: (nodeId: string, mode: 'simple' | 'advanced') => Promise<void>;
  /** Load persisted preferences from the bridge and hydrate the store. */
  hydrate: () => Promise<void>;
}

const NODE_DETAIL_MODES_CAP = 500;

export const usePreferencesStore = create<PreferencesState>()((set, get) => ({
  viewMode: 'simple',
  nodeDetailModes: {},

  setViewMode: async (mode: ViewMode) => {
    set({ viewMode: mode });
    try {
      const { api } = await import('@bridge'); // alias — resolves to web-bridge on web, electron-bridge on desktop (t/2651)
      await api.setPreferences({ viewMode: mode });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to persist view mode preference', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },

  getNodeDetailMode: (nodeId: string): 'simple' | 'advanced' => {
    return get().nodeDetailModes[nodeId] ?? 'simple';
  },

  setNodeDetailMode: async (nodeId: string, mode: 'simple' | 'advanced') => {
    const current = get().nodeDetailModes;
    // Delete first to remove from position, then re-add at end (LRU bump)
    const { [nodeId]: _, ...rest } = current;
    const updated = { ...rest, [nodeId]: mode };

    // LRU eviction: if we exceed cap, remove oldest entry (by key order)
    if (Object.keys(updated).length > NODE_DETAIL_MODES_CAP) {
      const keys = Object.keys(updated);
      delete updated[keys[0]];
    }

    set({ nodeDetailModes: updated });
    try {
      const { api } = await import('@bridge');
      const state = get(); await api.setPreferences({ viewMode: state.viewMode, nodeDetailModes: updated });
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to persist node detail mode', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },

  hydrate: async () => {
    try {
      const { api } = await import('@bridge'); // alias — resolves to web-bridge on web, electron-bridge on desktop (t/2651)
      const prefs: UserPreferences | null = await api.getPreferences();
      if (prefs?.viewMode) {
        set({ viewMode: prefs.viewMode });
      }
      if (prefs?.nodeDetailModes && typeof prefs.nodeDetailModes === 'object') {
        // Validate and filter to only valid modes
        const validated = Object.entries(prefs.nodeDetailModes).reduce((acc, [nodeId, mode]) => {
          if (mode === 'simple' || mode === 'advanced') {
            acc[nodeId] = mode;
          }
          return acc;
        }, {} as Record<string, 'simple' | 'advanced'>);
        set({ nodeDetailModes: validated });
      }
    } catch (err) {
      getGlobalRecorder()?.record({ type: 'system.error', component: 'preferencesStore', level: 'error', message: 'Failed to hydrate preferences from bridge', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } });
    }
  },
}));

((window as unknown as { __ZUSTAND_STORES__?: Record<string, unknown> }).__ZUSTAND_STORES__ ??= {} as Record<string, unknown>).preferences = usePreferencesStore;



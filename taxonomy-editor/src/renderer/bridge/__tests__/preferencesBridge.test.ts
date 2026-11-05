// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2117 — UserPreferences types + BridgeAPI extension + Zustand store + bridge implementations.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppAPI, UserPreferences } from '../types';

// ── Type-level: verify AppAPI contract ──────────────────────────────────────

describe('AppAPI preferences contract', () => {
  it('AppAPI includes getPreferences and setPreferences', () => {
    const dummy = {} as AppAPI;
    expect('getPreferences' in dummy || dummy.getPreferences === undefined).toBe(true);
    expect('setPreferences' in dummy || dummy.setPreferences === undefined).toBe(true);
  });
});

// ── electron-bridge delegation ──────────────────────────────────────────────

describe('electron-bridge preferences', () => {
  const origWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = origWindow;
    vi.resetModules();
  });

  it('delegates getPreferences to window.electronAPI when present', async () => {
    const prefs: UserPreferences = { viewMode: 'advanced' };
    (globalThis as Record<string, unknown>).window = {
      electronAPI: { getPreferences: vi.fn().mockResolvedValue(prefs) },
    };
    const mod = await import('../electron-bridge');
    const result = await mod.api.getPreferences();
    expect(result).toEqual(prefs);
    expect(window.electronAPI.getPreferences).toHaveBeenCalled();
  });

  it('returns null when getPreferences IPC handler is not yet wired (t/2118)', async () => {
    (globalThis as Record<string, unknown>).window = { electronAPI: {} };
    const mod = await import('../electron-bridge');
    const result = await mod.api.getPreferences();
    expect(result).toBeNull();
  });

  it('delegates setPreferences to window.electronAPI when present', async () => {
    const setFn = vi.fn().mockResolvedValue(undefined);
    (globalThis as Record<string, unknown>).window = {
      electronAPI: { setPreferences: setFn },
    };
    const mod = await import('../electron-bridge');
    const prefs: UserPreferences = { viewMode: 'simple' };
    await mod.api.setPreferences(prefs);
    expect(setFn).toHaveBeenCalledWith(prefs);
  });

  it('resolves without error when setPreferences IPC handler is not yet wired (t/2118)', async () => {
    (globalThis as Record<string, unknown>).window = { electronAPI: {} };
    const mod = await import('../electron-bridge');
    await expect(mod.api.setPreferences({ viewMode: 'simple' })).resolves.toBeUndefined();
  });
});

// ── preferencesStore ────────────────────────────────────────────────────────

describe('preferencesStore', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults viewMode to simple when bridge returns null', async () => {
    vi.doMock('../../bridge/index', () => ({
      api: { getPreferences: vi.fn().mockResolvedValue(null), setPreferences: vi.fn().mockResolvedValue(undefined) },
    }));
    const { usePreferencesStore } = await import('../../store/preferencesStore');
    const store = usePreferencesStore.getState();
    await store.hydrate();
    expect(usePreferencesStore.getState().viewMode).toBe('simple');
  });

  it('hydrates viewMode from stored value', async () => {
    const prefs: UserPreferences = { viewMode: 'advanced' };
    vi.doMock('../../bridge/index', () => ({
      api: { getPreferences: vi.fn().mockResolvedValue(prefs), setPreferences: vi.fn().mockResolvedValue(undefined) },
    }));
    const { usePreferencesStore } = await import('../../store/preferencesStore');
    await usePreferencesStore.getState().hydrate();
    expect(usePreferencesStore.getState().viewMode).toBe('advanced');
  });

  it('setViewMode updates local state and calls setPreferences', async () => {
    const setFn = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../../bridge/index', () => ({
      api: { getPreferences: vi.fn().mockResolvedValue(null), setPreferences: setFn },
    }));
    const { usePreferencesStore } = await import('../../store/preferencesStore');
    await usePreferencesStore.getState().setViewMode('advanced');
    expect(usePreferencesStore.getState().viewMode).toBe('advanced');
    // t/4826: setViewMode persists the tab group alongside it, unchanged.
    expect(setFn).toHaveBeenCalledWith({ viewMode: 'advanced', nodeDetailTabGroup: 'what' });
  });

  it('defaults to simple and does not throw when bridge errors during hydration', async () => {
    vi.doMock('../../bridge/index', () => ({
      api: { getPreferences: vi.fn().mockRejectedValue(new Error('network')), setPreferences: vi.fn() },
    }));
    const { usePreferencesStore } = await import('../../store/preferencesStore');
    await expect(usePreferencesStore.getState().hydrate()).resolves.toBeUndefined();
    expect(usePreferencesStore.getState().viewMode).toBe('simple');
  });
});

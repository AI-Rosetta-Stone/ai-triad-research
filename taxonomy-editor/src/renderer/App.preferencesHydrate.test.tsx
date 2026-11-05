// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression test for t/4863: usePreferencesStore.hydrate() was never called outside tests, so
// saved preferences (the rail's Simple/Advanced, node-detail's What/Why/How tab group) always
// reset to their defaults on every launch — only the write side (set-preferences) ever ran.
// Covers both builds: MainApp is the same component tree on web and Electron, so one assertion
// that MainApp's bootstrap calls hydrate() on mount covers both AC bullets.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { hydrateMock } = vi.hoisted(() => ({ hydrateMock: vi.fn() }));

// Must be declared before the deferred App import so vitest hoists them.
vi.mock('@bridge', () => ({
  api: {
    getCliFileArg: vi.fn().mockResolvedValue(null),
    isDataAvailable: vi.fn().mockResolvedValue(true),
    getDataRoot: vi.fn().mockResolvedValue(''),
    checkAnonymousSession: vi.fn().mockResolvedValue(false),
  },
  isElectronMode: () => false,
  emitBriefTimeout: vi.fn(),
  emitBriefRetriesExhausted: vi.fn(),
  setActiveDebateId: vi.fn(),
}));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: vi.fn() }),
}));
vi.mock('./lib/clientConfig', () => ({ initClientConfig: vi.fn() }));
vi.mock('./lib/flightRecorderInit', () => ({ initFlightRecorder: vi.fn() }));
vi.mock('./lib/swEventListener', () => ({ initSwEventListener: vi.fn() }));
vi.mock('./lib/initAnalyticsSession', () => ({ initAnalyticsSession: vi.fn() }));
vi.mock('./hooks/useFeatureFlags', () => {
  const state = { refresh: vi.fn().mockResolvedValue(undefined), flags: {} };
  const useFeatureFlagStore = Object.assign(() => state, { getState: () => state });
  return { useFeatureFlagStore, useFlag: () => false };
});
vi.mock('./hooks/useTheoryLinkHotkey', () => ({ useTheoryLinkHotkey: vi.fn() }));
// initAIModels is real MainApp bootstrap work (network-dependent) — stub it so the bootstrap
// effect resolves without it, same as the data-availability mocks above.
vi.mock('./hooks/useTaxonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hooks/useTaxonomyStore')>();
  return { ...actual, initAIModels: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('./store/preferencesStore', () => {
  const state = { viewMode: 'simple' as const, nodeDetailTabGroup: 'what' as const, hydrate: hydrateMock };
  const usePreferencesStore = Object.assign((selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state), { getState: () => state });
  return { usePreferencesStore };
});

// Deferred import — mocks above must be hoisted before App.tsx loads.
const { App } = await import('./App');

describe('App preferences hydration (t/4863)', () => {
  beforeEach(() => {
    hydrateMock.mockClear();
    // Bridge-ready gate (t/2767): present electronAPI so App doesn't block on it.
    (window as unknown as { electronAPI?: unknown }).electronAPI = {};
    window.location.hash = '';
    // jsdom doesn't implement matchMedia; MainApp's useIsTouchDevice() needs it to mount.
    window.matchMedia = window.matchMedia ?? vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as Record<string, unknown>).electronAPI;
  });

  it('calls usePreferencesStore.hydrate() once at main-window startup', async () => {
    render(<App />);
    await waitFor(() => expect(hydrateMock).toHaveBeenCalledTimes(1));
  });
});

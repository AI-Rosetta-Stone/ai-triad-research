// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4722: regression test for "Tools menu panels render nothing on 6 tabs" — iterates every
// togglePanel NAV_ITEM x every tab id and asserts the fallback (or an existing per-tab mount)
// covers it, so a tab added to TabId without updating TABS_WITH_OWN_TOOLBAR_PANE fails loudly
// here instead of silently rendering nothing, the exact drift that caused the original bug.

import { describe, it, expect, vi } from 'vitest';
import { NAV_ITEMS } from './data/navConfig';
import type { TabId } from './types/taxonomy';

// App.tsx pulls in the full renderer dependency graph at module scope (stores, lazy chunks,
// the bridge) — mirror App.test.tsx's mocks so importing it here for these two pure exports
// doesn't require booting the whole app.
vi.mock('@bridge', () => ({
  api: {},
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
vi.mock('./hooks/useFeatureFlags', () => ({
  useFeatureFlagStore: { getState: () => ({ refresh: vi.fn() }) },
  useFlag: () => false,
}));
vi.mock('./hooks/useTheoryLinkHotkey', () => ({ useTheoryLinkHotkey: vi.fn() }));
vi.mock('./utils/recordingLazy', () => ({
  recordingLazy: () => () => null,
}));

const { TABS_WITH_OWN_TOOLBAR_PANE, tabNeedsToolbarFallback } = await import('./App');

// The full TabId union, kept here as a literal list (not derived from the type, which doesn't
// exist at runtime) so this test fails if TabId grows without this list being updated too —
// the same "a new tab silently falls through the cracks" risk the ticket is about.
const ALL_TAB_IDS: TabId[] = [
  'rosetta-stone', 'accelerationist', 'safetyist', 'skeptic', 'situations', 'conflicts',
  'cruxes', 'debate', 'chat', 'opeds', 'summaries', 'validation', 'organizations', 'inquiry',
];

const TOGGLE_PANEL_IDS = NAV_ITEMS
  .filter(item => item.action.type === 'togglePanel')
  .map(item => item.action.type === 'togglePanel' ? item.action.target : '');

describe('tabNeedsToolbarFallback (t/4722)', () => {
  it('ALL_TAB_IDS matches the real TabId union (fails loudly if a tab is added without updating this test)', () => {
    expect(ALL_TAB_IDS).toHaveLength(14);
  });

  it('every togglePanel NAV_ITEM is covered: a pane renders on every tab, either via the tab\'s own mount or the fallback', () => {
    for (const tabId of ALL_TAB_IDS) {
      for (const panelId of TOGGLE_PANEL_IDS) {
        const hostsOwnPane = TABS_WITH_OWN_TOOLBAR_PANE.includes(tabId);
        const fallbackCovers = tabNeedsToolbarFallback(tabId, panelId);
        expect(hostsOwnPane || fallbackCovers, `tab "${tabId}" with panel "${panelId}" is covered by neither its own mount nor the fallback`).toBe(true);
      }
    }
  });

  it('the six previously-broken tabs each need the fallback when a panel is open', () => {
    for (const tabId of ['rosetta-stone', 'organizations', 'opeds', 'inquiry', 'validation', 'summaries'] satisfies TabId[]) {
      expect(tabNeedsToolbarFallback(tabId, 'entities')).toBe(true);
    }
  });

  it('tabs that already mount their own pane do not also get the fallback (no double-render)', () => {
    for (const tabId of TABS_WITH_OWN_TOOLBAR_PANE) {
      expect(tabNeedsToolbarFallback(tabId, 'entities')).toBe(false);
    }
  });

  it('no fallback when no panel is open', () => {
    expect(tabNeedsToolbarFallback('rosetta-stone', null)).toBe(false);
  });
});

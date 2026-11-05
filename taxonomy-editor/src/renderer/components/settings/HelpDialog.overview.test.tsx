// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect } from 'vitest';
import {
  OVERVIEW_TAB_ITEMS,
  OVERVIEW_PANEL_ITEMS,
  OVERVIEW_TAB_DESCRIPTIONS,
  OVERVIEW_PANEL_DESCRIPTIONS,
} from './HelpDialog';

// t/4887: Help > Overview is generated from NAV_ITEMS (navConfig.ts) rather than hand-written
// prose. These tests fail the moment a nav/panel id and its Overview description fall out of
// sync in either direction — a new tab/panel with no Overview line, or a stale Overview line
// for an id the registry no longer has (the drift class that went unnoticed for years before
// t/4887).
describe('HelpDialog Overview content tracks the nav registry', () => {
  it('has a description for every tab-type NAV_ITEMS entry', () => {
    for (const item of OVERVIEW_TAB_ITEMS) {
      expect(OVERVIEW_TAB_DESCRIPTIONS[item.id], `missing Overview description for tab "${item.id}"`).toBeTruthy();
    }
  });

  it('has a description for every panel-type NAV_ITEMS entry', () => {
    for (const item of OVERVIEW_PANEL_ITEMS) {
      expect(OVERVIEW_PANEL_DESCRIPTIONS[item.id], `missing Overview description for panel "${item.id}"`).toBeTruthy();
    }
  });

  it('carries no stale tab description for an id the registry no longer has', () => {
    const tabIds = new Set(OVERVIEW_TAB_ITEMS.map(i => i.id));
    for (const id of Object.keys(OVERVIEW_TAB_DESCRIPTIONS)) {
      expect(tabIds.has(id), `"${id}" has an Overview description but is no longer a tab-type nav item`).toBe(true);
    }
  });

  it('carries no stale panel description for an id the registry no longer has', () => {
    const panelIds = new Set(OVERVIEW_PANEL_ITEMS.map(i => i.id));
    for (const id of Object.keys(OVERVIEW_PANEL_DESCRIPTIONS)) {
      expect(panelIds.has(id), `"${id}" has an Overview description but is no longer a panel-type nav item`).toBe(true);
    }
  });
});

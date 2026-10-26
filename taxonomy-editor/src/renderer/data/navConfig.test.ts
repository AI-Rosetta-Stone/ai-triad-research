// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regression for t/2599: the Op-Eds nav item is gated on `env-electron-opeds`. The bug
// was that Toolbar/HamburgerMenu READ the flag but omitted it from the `navCtx.flags`
// passed to getVisibleNavItems — and getVisibleNavItems treats an absent flag as falsy
// (`!ctx.flags[item.gate.flag]`), so the gate could never pass, hiding the tool even
// with the flag ON. These assert the gate BOTH ways plus the omitted-flag case, which
// is the class of miss that hid this (flag read but not threaded into the nav context).

import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, getVisibleNavItems, getItemsByTier } from './navConfig';

const hasOpeds = (flags: Record<string, boolean>): boolean =>
  getVisibleNavItems(NAV_ITEMS, { flags, isAdmin: false }).some(i => i.id === 'opeds');

describe('navConfig — env-electron-opeds gate (t/2599)', () => {
  it('shows the Op-Eds item when the flag is present and true', () => {
    expect(hasOpeds({ 'env-electron-opeds': true })).toBe(true);
  });

  it('hides the Op-Eds item when the flag is present and false', () => {
    expect(hasOpeds({ 'env-electron-opeds': false })).toBe(false);
  });

  it('hides the Op-Eds item when the flag is OMITTED from navCtx — the t/2599 bug', () => {
    // Toolbar/HamburgerMenu built navCtx.flags without env-electron-opeds; an absent
    // flag is falsy, so the item was always filtered out even with the flag on.
    expect(hasOpeds({ 'env-electron-summaries': true })).toBe(false);
  });

  it('gate is independent — the summaries flag does not reveal Op-Eds', () => {
    expect(hasOpeds({ 'env-electron-summaries': true, 'env-electron-opeds': false })).toBe(false);
  });
});

describe('navConfig — Op-Eds OR-of-flags per-build reveal (t/2633)', () => {
  // Op-Eds is gated on anyFlag ['env-electron-opeds','env-web-opeds'] so each build reveals
  // it via its OWN flag: Electron delivers env-electron-opeds, web delivers env-web-opeds.
  it('shows Op-Eds when only the WEB flag is on (web reveal; electron flag absent)', () => {
    expect(hasOpeds({ 'env-web-opeds': true })).toBe(true);
  });

  it('shows Op-Eds when only the ELECTRON flag is on (desktop reveal; web flag absent)', () => {
    expect(hasOpeds({ 'env-electron-opeds': true })).toBe(true);
  });

  it('hides Op-Eds when BOTH build flags are off/absent', () => {
    expect(hasOpeds({ 'env-electron-opeds': false, 'env-web-opeds': false })).toBe(false);
    expect(hasOpeds({})).toBe(false);
  });

  it('shows Op-Eds when both flags are on', () => {
    expect(hasOpeds({ 'env-electron-opeds': true, 'env-web-opeds': true })).toBe(true);
  });
});

describe('navConfig — primary tier order (t/4535, PI request p/351#29)', () => {
  it('is search, chat, opeds, inquiry, debate, taxonomy', () => {
    expect(getItemsByTier(NAV_ITEMS, 'primary').map(i => i.id)).toEqual([
      'search', 'chat', 'opeds', 'inquiry', 'debate', 'taxonomy',
    ]);
  });
});

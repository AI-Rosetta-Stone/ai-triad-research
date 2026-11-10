// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect } from 'react';
import { api, isElectronMode } from '@bridge';

/** 112.5% (18px root) is the comfortable web baseline (t/2416). "Zoom 100%" equals the baseline, so
 *  taxonomy-editor-zoom still round-trips as a percentage (default 100). */
export const BASE_FONT_PCT = 112.5;

/**
 * The app's single zoom model (t/163). The store's `zoomLevel` is the source of truth:
 * - **Desktop:** it drives a real page zoom (webFrame), which scales px and vh sizes too. The root
 *   font-size only scaled rem, so px-sized panes stayed put. The View menu's Ctrl+= / Ctrl+- / Ctrl+0
 *   accelerators send commands back here, so menu and toolbar share one persisted level.
 * - **Web:** there's no page-zoom API, and CSS `zoom` breaks 100vh panes (t/163#3), so the root
 *   font-size stays the fallback and the page handles the shortcuts itself.
 */
export function useAppZoom(zoomLevel: number, zoomIn: () => void, zoomOut: () => void, zoomReset: () => void): void {
  useEffect(() => {
    const paged = api.setZoomFactor(zoomLevel / 100);
    document.documentElement.style.fontSize = `${paged ? BASE_FONT_PCT : (BASE_FONT_PCT * zoomLevel) / 100}%`;
  }, [zoomLevel]);

  useEffect(() => api.onZoomCommand((command) => {
    if (command === 'in') zoomIn();
    else if (command === 'out') zoomOut();
    else zoomReset();
  }), [zoomIn, zoomOut, zoomReset]);

  // On desktop the menu accelerators own these keys; handling them here too would step twice.
  useEffect(() => {
    if (isElectronMode()) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [zoomIn, zoomOut, zoomReset]);
}

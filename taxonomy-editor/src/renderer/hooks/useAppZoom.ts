// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { useEffect } from 'react';
import { api } from '@bridge';
import { getGlobalRecorder } from '@lib/flight-recorder/index';

/** 112.5% (18px root) is the comfortable web baseline (t/2416). "Zoom 100%" equals the baseline, so
 *  taxonomy-editor-zoom still round-trips as a percentage (default 100). */
export const BASE_FONT_PCT = 112.5;

let warnedStoredWebZoom = false;
/** Test seam: reset the once-per-session WARN. */
export function __resetZoomWarnForTests(): void { warnedStoredWebZoom = false; }

/**
 * The app's single zoom model (t/163). Both profiles use whole-page zoom, so every pane scales (px and vh too):
 * - **Desktop:** the store's `zoomLevel` drives a real page zoom (webFrame). The View menu's Ctrl+= / Ctrl+- /
 *   Ctrl+0 accelerators send commands back here, so menu and level share one persisted value.
 * - **Web (TL p/10#53, Design t/163#6):** the browser's own zoom. The page doesn't intercept Ctrl +/−/0, and the
 *   root font stays at the baseline. A page can't set the browser's zoom, and the old root font-size fallback
 *   only scaled rem sizes, so a zoom level stored from before is ignored (WARN once).
 */
export function useAppZoom(zoomLevel: number, zoomIn: () => void, zoomOut: () => void, zoomReset: () => void): void {
  useEffect(() => {
    const paged = api.setZoomFactor(zoomLevel / 100);
    document.documentElement.style.fontSize = `${BASE_FONT_PCT}%`;
    if (!paged && zoomLevel !== 100 && !warnedStoredWebZoom) {
      warnedStoredWebZoom = true;
      getGlobalRecorder()?.record({ type: 'system.error', component: 'app-zoom', level: 'warn', message: `WARN: stored zoom ${zoomLevel}% ignored on web; the browser's zoom (Ctrl +/−/0) applies instead (t/163)` });
    }
  }, [zoomLevel]);

  useEffect(() => api.onZoomCommand((command) => {
    if (command === 'in') zoomIn();
    else if (command === 'out') zoomOut();
    else zoomReset();
  }), [zoomIn, zoomOut, zoomReset]);
}

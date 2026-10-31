// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { getGlobalRecorder } from '@lib/flight-recorder/index';
import { api, isElectronMode } from '@bridge';

export type ItemToolId = 'chat' | 'debate' | 'opeds' | 'inquiry';

export interface ItemPlace {
  tool: ItemToolId;
  id: string;
  path: string;
}

/**
 * Whether `openPlaceInNewWindow` can honor this place. The shell uses this to decide
 * whether to render ⧉ and to allow Ctrl/Cmd/middle-click on a library row.
 *
 * Electron: chat and debate only — they're the only tools with a popout window type.
 * Web: every tool, since a new tab needs no per-tool window support.
 */
export function canOpenInNewWindow(place: ItemPlace): boolean {
  if (isElectronMode()) {
    return place.tool === 'chat' || place.tool === 'debate';
  }
  return true;
}

/**
 * Opens `place` in a new window/tab, or focuses one already open for it.
 *
 * Callers must check `canOpenInNewWindow` first (it gates ⧉ visibility and the
 * click handlers). An unsupported call — Electron with opeds/inquiry — logs a WARN
 * and returns rather than silently doing nothing (docs/error-handling.md).
 */
export function openPlaceInNewWindow(place: ItemPlace): void {
  if (!canOpenInNewWindow(place)) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'openInWindow',
      level: 'warn',
      message: `Ignored openPlaceInNewWindow: no Electron popout window type for '${place.tool}'`,
      error: { name: 'UnsupportedPlaceError', message: `tool=${place.tool} id=${place.id}` },
    });
    return;
  }

  if (isElectronMode()) {
    // Both already focus an existing popout instead of opening a duplicate.
    if (place.tool === 'chat') { void api.openChatWindow(place.id); return; }
    if (place.tool === 'debate') { void api.openDebateWindow(place.id); return; }
    return;
  }

  // Web: a named target per item, so a second ⧉ on the same item reuses that tab
  // instead of opening a duplicate. Falls back to a new tab if the browser doesn't
  // honor the named target with `noopener` (acceptable per the spec's original
  // "new tab each time" behavior).
  window.open(`${location.origin}${place.path}`, `aitriad-${place.tool}-${place.id}`, 'noopener');
}

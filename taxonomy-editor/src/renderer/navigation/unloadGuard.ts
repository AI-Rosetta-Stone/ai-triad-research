// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import type { TaxonomyStore } from '../hooks/useTaxonomyStore';
import type { SubscribableStore } from './subscriber';

/**
 * t/4640 AC6: leaving the app with unsaved taxonomy edits asks for confirmation — on the web the
 * browser's own "Leave site?" prompt; in Electron the main process's `will-prevent-unload`
 * Stay/Leave dialog (t/4758, main.ts). The running-debate half of the guard lives with the debate
 * store (useDebateStore/shared/guards.ts).
 *
 * This replaces a check inside the debate guard that loaded the taxonomy store with `require()`.
 * The renderer has no `require` in either build (Vite ESM, contextIsolation on, nodeIntegration
 * off), so that check threw on every unload, fell into its catch and allowed navigation — the
 * prompt never appeared. Taking the store as a parameter avoids the circular import it was
 * working around, and makes the guard testable.
 *
 * No back-trapping: this only fires on a real unload (close, reload, leaving the site); it never
 * touches in-app history.
 *
 * Both builds. It was web-only until t/4758: without the main-process dialog, a cancelled
 * beforeunload cancels the Electron window close silently.
 */
export function installUnsavedEditsGuard(taxonomy: SubscribableStore<TaxonomyStore>): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (taxonomy.getState().dirty.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4640 AC6: unsaved taxonomy edits ask before the page unloads, in both builds (Electron since
// t/4758 added the main-process confirm dialog). The previous check loaded the store with
// require(), which doesn't exist in the renderer, so it never fired.

// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { installUnsavedEditsGuard } from '../unloadGuard';
import type { TaxonomyStore } from '../../hooks/useTaxonomyStore';
import type { SubscribableStore } from '../subscriber';

function storeWithDirty(keys: string[]): SubscribableStore<TaxonomyStore> {
  const state = { dirty: new Set(keys) } as unknown as TaxonomyStore;
  return { getState: () => state, subscribe: () => () => {} };
}

/** Dispatch a cancelable beforeunload; true when a handler asked to confirm. */
function unloadAsksToConfirm(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('installUnsavedEditsGuard', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => { uninstall?.(); uninstall = undefined; });

  it('asks to confirm when there are unsaved edits — in whichever build it runs', () => {
    uninstall = installUnsavedEditsGuard(storeWithDirty(['accelerationist']));
    expect(unloadAsksToConfirm()).toBe(true);
  });

  it('lets the page unload when nothing is unsaved', () => {
    uninstall = installUnsavedEditsGuard(storeWithDirty([]));
    expect(unloadAsksToConfirm()).toBe(false);
  });

  it('uninstalling removes the guard', () => {
    installUnsavedEditsGuard(storeWithDirty(['accelerationist']))();
    expect(unloadAsksToConfirm()).toBe(false);
  });
});

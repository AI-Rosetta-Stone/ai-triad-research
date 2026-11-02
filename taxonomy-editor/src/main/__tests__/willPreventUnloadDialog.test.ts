// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4758: the 'will-prevent-unload' handler installed on the main window's webContents in
 * main.ts — without it, a cancelled renderer beforeunload (a running debate, unsaved taxonomy
 * edits) cancels the window close SILENTLY. This shows a native Stay/Leave confirm and calls
 * event.preventDefault() only on Leave, overriding the renderer's cancel.
 *
 * main.ts can't be imported here (it loads Electron's `app` at module init — see
 * mainRecorderForwarding.test.ts), so this reproduces the exact handler logic against a fake
 * dialog + event.
 */

import { describe, it, expect, vi } from 'vitest';

interface FakeEvent {
  preventDefault(): void;
}

// Mirrors the 'will-prevent-unload' handler installed in main.ts.
function handleWillPreventUnload(
  event: FakeEvent,
  showMessageBoxSync: () => number,
): void {
  const choice = showMessageBoxSync();
  if (choice === 1) event.preventDefault(); // Leave: override the renderer's cancel.
  // Stay (choice === 0): do nothing — the renderer's beforeunload cancel stands.
}

function makeFakeEvent(): FakeEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() };
}

describe('will-prevent-unload confirm dialog (t/4758)', () => {
  it('calls event.preventDefault() on Leave (choice 1), overriding the renderer cancel', () => {
    const event = makeFakeEvent();
    handleWillPreventUnload(event, () => 1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Stay (choice 0) — the window stays open', () => {
    const event = makeFakeEvent();
    handleWillPreventUnload(event, () => 0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('treats dialog dismissal (cancelId, choice 0) the same as Stay — never calls preventDefault', () => {
    // showMessageBoxSync returns cancelId (0, matching Stay) when the dialog is dismissed
    // (Esc, window-manager close) rather than a button click.
    const event = makeFakeEvent();
    handleWillPreventUnload(event, () => 0);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

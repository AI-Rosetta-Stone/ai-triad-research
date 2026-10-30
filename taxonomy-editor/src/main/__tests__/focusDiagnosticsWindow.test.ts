// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/4642/t/4663: the 'focus-diagnostics-window' IPC handler installed in main.ts — brings an
 * already-open diagnostics popout to the front on a repeat card click, mirroring
 * 'open-diagnostics-window''s existing show/focus lines without the create-if-absent branch.
 *
 * main.ts can't be imported here (it loads Electron's `app` at module init — see
 * mainRecorderForwarding.test.ts), so this reproduces the exact handler logic against a fake
 * BrowserWindow-shaped object.
 */

import { describe, it, expect, vi } from 'vitest';

interface FakeDiagWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

// Mirrors the 'focus-diagnostics-window' handler installed in main.ts.
function focusDiagnosticsWindow(diagWindow: FakeDiagWindow | null): 'focused' | 'not-open' {
  if (diagWindow && !diagWindow.isDestroyed()) {
    if (diagWindow.isMinimized()) diagWindow.restore();
    diagWindow.show();
    diagWindow.focus();
    return 'focused';
  }
  return 'not-open';
}

function makeFakeWindow(opts: { destroyed?: boolean; minimized?: boolean } = {}): FakeDiagWindow {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  };
}

describe('focus-diagnostics-window IPC handler (t/4642/t/4663)', () => {
  it('returns not-open when the window was never opened', () => {
    expect(focusDiagnosticsWindow(null)).toBe('not-open');
  });

  it('returns not-open when the tracked window was destroyed', () => {
    const w = makeFakeWindow({ destroyed: true });
    expect(focusDiagnosticsWindow(w)).toBe('not-open');
    expect(w.show).not.toHaveBeenCalled();
    expect(w.focus).not.toHaveBeenCalled();
  });

  it('returns focused and calls show()+focus() when the window is open', () => {
    const w = makeFakeWindow();
    expect(focusDiagnosticsWindow(w)).toBe('focused');
    expect(w.show).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
    expect(w.restore).not.toHaveBeenCalled();
  });

  it('restores a minimized window before showing/focusing', () => {
    const w = makeFakeWindow({ minimized: true });
    expect(focusDiagnosticsWindow(w)).toBe('focused');
    expect(w.restore).toHaveBeenCalledTimes(1);
    expect(w.show).toHaveBeenCalledTimes(1);
    expect(w.focus).toHaveBeenCalledTimes(1);
  });
});

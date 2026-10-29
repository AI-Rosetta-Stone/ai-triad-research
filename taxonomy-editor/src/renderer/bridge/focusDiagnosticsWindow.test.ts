// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// focusDiagnosticsWindow (t/4642) — brings an already-open diagnostics surface to the front.
// Covers the three bridge-contract arms (focused / not-open / inline) in both builds, plus the
// closed-reference arm that motivated the ticket (a stale Window reference whose tab was closed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lib/flight-recorder/index', () => ({ getGlobalRecorder: () => undefined }));

describe('web-bridge focusDiagnosticsWindow', () => {
  let openSpy: ReturnType<typeof vi.spyOn>;
  let innerWidthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    window.location.hash = '';
    innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
  });

  afterEach(() => {
    openSpy?.mockRestore();
    innerWidthSpy.mockRestore();
    window.location.hash = '';
  });

  it('returns not-open when the window was never opened', async () => {
    const { api } = await import('./web-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('not-open');
  });

  it('returns focused and calls .focus() on the kept reference after opening', async () => {
    const focusFn = vi.fn();
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: false, focus: focusFn }) as unknown as Window);
    const { api } = await import('./web-bridge');
    await api.openDiagnosticsWindow();
    expect(await api.focusDiagnosticsWindow()).toBe('focused');
    expect(focusFn).toHaveBeenCalledTimes(1);
  });

  it('returns not-open when the kept reference points at a closed window (t/4642 motivating case)', async () => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => ({ closed: true, focus: vi.fn() }) as unknown as Window);
    const { api } = await import('./web-bridge');
    await api.openDiagnosticsWindow();
    expect(await api.focusDiagnosticsWindow()).toBe('not-open');
  });

  it('returns inline on a narrow main window without opening anything', async () => {
    innerWidthSpy.mockReturnValue(800);
    openSpy = vi.spyOn(window, 'open');
    const { api } = await import('./web-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('inline');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('is never inline inside a debate popout, even when narrow', async () => {
    innerWidthSpy.mockReturnValue(800);
    window.location.hash = '#debate-window?id=abc';
    const { api } = await import('./web-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('not-open');
  });
});

describe('electron-bridge focusDiagnosticsWindow', () => {
  let innerWidthSpy: ReturnType<typeof vi.spyOn>;
  let electronFocus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    window.location.hash = '';
    innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    electronFocus = vi.fn().mockResolvedValue('focused');
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
      focusDiagnosticsWindow: electronFocus,
    };
  });

  afterEach(() => {
    innerWidthSpy.mockRestore();
    window.location.hash = '';
  });

  it('delegates to window.electronAPI.focusDiagnosticsWindow on a wide window', async () => {
    const { api } = await import('./electron-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('focused');
    expect(electronFocus).toHaveBeenCalledTimes(1);
  });

  it('returns inline on a narrow main window without an IPC round-trip', async () => {
    innerWidthSpy.mockReturnValue(800);
    const { api } = await import('./electron-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('inline');
    expect(electronFocus).not.toHaveBeenCalled();
  });

  it('passes through not-open from the main process when no BrowserWindow exists', async () => {
    electronFocus.mockResolvedValue('not-open');
    const { api } = await import('./electron-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('not-open');
  });
});

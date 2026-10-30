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
    expect(await api.openDiagnosticsWindow()).toBe('popout'); // t/4648
    expect(await api.focusDiagnosticsWindow()).toBe('focused');
    expect(focusFn).toHaveBeenCalledTimes(1);
  });

  // t/4648: diagPopoutOpen conflated a real popout with the narrow-window drawer, since
  // openDiagnosticsWindow resolved void either way. It now reports which path it took.
  it('t/4648: openDiagnosticsWindow resolves inline on a narrow window, without opening anything', async () => {
    innerWidthSpy.mockReturnValue(800);
    openSpy = vi.spyOn(window, 'open');
    const { api } = await import('./web-bridge');
    expect(await api.openDiagnosticsWindow()).toBe('inline');
    expect(openSpy).not.toHaveBeenCalled();
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

  beforeEach(() => {
    vi.resetModules();
    window.location.hash = '';
    innerWidthSpy = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
  });

  afterEach(() => {
    innerWidthSpy.mockRestore();
    window.location.hash = '';
  });

  // t/4642: ElectronMain's 'focus-diagnostics-window' IPC handler + preload exposure haven't
  // landed yet (see the comment on focusDiagnosticsWindow in electron-bridge.ts), so this side
  // always resolves 'not-open' on a wide window today — accurate, since no handler exists to
  // delegate to. Once ElectronMain's PR adds window.electronAPI.focusDiagnosticsWindow, this
  // method delegates to it and this test gets a 'focused'/real-not-open arm added alongside.
  it('resolves not-open on a wide window pending ElectronMain\'s IPC handler', async () => {
    const { api } = await import('./electron-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('not-open');
  });

  it('returns inline on a narrow main window', async () => {
    innerWidthSpy.mockReturnValue(800);
    const { api } = await import('./electron-bridge');
    expect(await api.focusDiagnosticsWindow()).toBe('inline');
  });

  // t/4648: same report-which-path-was-taken fix as the web bridge.
  it('t/4648: openDiagnosticsWindow resolves inline on a narrow window, without an IPC call', async () => {
    innerWidthSpy.mockReturnValue(800);
    const { api } = await import('./electron-bridge');
    expect(await api.openDiagnosticsWindow()).toBe('inline');
  });
});

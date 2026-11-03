// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { isElectronModeMock, openChatWindowMock, openDebateWindowMock, recordMock } = vi.hoisted(() => ({
  isElectronModeMock: vi.fn(() => false),
  openChatWindowMock: vi.fn(),
  openDebateWindowMock: vi.fn(),
  recordMock: vi.fn(),
}));

vi.mock('@bridge', () => ({
  isElectronMode: isElectronModeMock,
  api: {
    openChatWindow: openChatWindowMock,
    openDebateWindow: openDebateWindowMock,
  },
}));
vi.mock('@lib/flight-recorder/index', () => ({
  getGlobalRecorder: () => ({ record: recordMock }),
}));

import { canOpenInNewWindow, openPlaceInNewWindow, type ItemPlace } from '../openInWindow';

const chatPlace: ItemPlace = { tool: 'chat', id: 'chat-1', path: '/chat/chat-1' };
const debatePlace: ItemPlace = { tool: 'debate', id: 'debate-1', path: '/debate/debate-1' };
const opedsPlace: ItemPlace = { tool: 'opeds', id: 'oped-1', path: '/opeds/oped-1' };
const inquiryPlace: ItemPlace = { tool: 'inquiry', id: 'q-1', path: '/inquiry/q-1' };

describe('canOpenInNewWindow', () => {
  afterEach(() => { isElectronModeMock.mockReturnValue(false); });

  it('is true for every tool on web', () => {
    isElectronModeMock.mockReturnValue(false);
    expect(canOpenInNewWindow(chatPlace)).toBe(true);
    expect(canOpenInNewWindow(debatePlace)).toBe(true);
    expect(canOpenInNewWindow(opedsPlace)).toBe(true);
    expect(canOpenInNewWindow(inquiryPlace)).toBe(true);
  });

  it('is true only for chat/debate on Electron', () => {
    isElectronModeMock.mockReturnValue(true);
    expect(canOpenInNewWindow(chatPlace)).toBe(true);
    expect(canOpenInNewWindow(debatePlace)).toBe(true);
    expect(canOpenInNewWindow(opedsPlace)).toBe(false);
    expect(canOpenInNewWindow(inquiryPlace)).toBe(false);
  });
});

describe('openPlaceInNewWindow', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
    isElectronModeMock.mockReturnValue(false);
    openChatWindowMock.mockClear();
    openDebateWindowMock.mockClear();
    recordMock.mockClear();
  });

  it('web: opens a named target per item so a second call reuses the tab', () => {
    openPlaceInNewWindow(chatPlace);
    expect(windowOpenSpy).toHaveBeenCalledWith(`${location.origin}/chat/chat-1`, 'aitriad-chat-chat-1', 'noopener');
  });

  it('web: works for opeds/inquiry too (no window type restriction)', () => {
    openPlaceInNewWindow(opedsPlace);
    openPlaceInNewWindow(inquiryPlace);
    expect(windowOpenSpy).toHaveBeenCalledWith(`${location.origin}/opeds/oped-1`, 'aitriad-opeds-oped-1', 'noopener');
    expect(windowOpenSpy).toHaveBeenCalledWith(`${location.origin}/inquiry/q-1`, 'aitriad-inquiry-q-1', 'noopener');
  });

  it('Electron: dispatches chat/debate to the existing focus-or-create bridge methods', () => {
    isElectronModeMock.mockReturnValue(true);
    openPlaceInNewWindow(chatPlace);
    openPlaceInNewWindow(debatePlace);
    expect(openChatWindowMock).toHaveBeenCalledWith('chat-1');
    expect(openDebateWindowMock).toHaveBeenCalledWith('debate-1');
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('Electron: opeds/inquiry log a WARN and do nothing — never a silent no-op', () => {
    isElectronModeMock.mockReturnValue(true);
    openPlaceInNewWindow(opedsPlace);
    expect(windowOpenSpy).not.toHaveBeenCalled();
    expect(openChatWindowMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'system.error',
      level: 'warn',
    }));
  });
});

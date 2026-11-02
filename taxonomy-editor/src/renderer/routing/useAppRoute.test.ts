// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the deep-link boot hook (t/3486, t/4640). Locks: a routed URL restores once at
// mount (path + query), `/` and unrouted paths don't, Electron no-ops, and popstate is NOT
// handled here — the nav subscriber restores history moves, so a listener here would restore
// twice.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockIsElectronMode = vi.fn(() => false);
vi.mock('@bridge', () => ({ isElectronMode: () => mockIsElectronMode() }));

const mockRestorePath = vi.fn();
vi.mock('../navigation/restore', () => ({ restorePath: (p: string) => mockRestorePath(p) }));

vi.mock('./appRoutes', () => ({
  findRoute: (pathname: string) => (pathname === '/chat/c-1' ? { route: {}, params: { chatId: 'c-1' } } : null),
}));

const { useAppRoute } = await import('./useAppRoute');

function goTo(pathname: string, search = ''): void {
  window.history.pushState({}, '', pathname + search);
}

describe('useAppRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsElectronMode.mockReturnValue(false);
  });
  afterEach(() => { goTo('/'); });

  it('restores a routed URL once at mount, with its query', () => {
    goTo('/chat/c-1', '?x=1');
    renderHook(() => useAppRoute());
    expect(mockRestorePath).toHaveBeenCalledTimes(1);
    expect(mockRestorePath).toHaveBeenCalledWith('/chat/c-1?x=1');
  });

  it('does nothing at mount on / or a path no route owns', () => {
    goTo('/');
    renderHook(() => useAppRoute());
    goTo('/share/pov/1');
    renderHook(() => useAppRoute());
    expect(mockRestorePath).not.toHaveBeenCalled();
  });

  it('does not handle popstate — the nav subscriber owns history moves', () => {
    goTo('/');
    renderHook(() => useAppRoute());
    goTo('/chat/c-1');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(mockRestorePath).not.toHaveBeenCalled();
  });

  it('no-ops entirely in Electron — no address bar for a restore to react to', () => {
    mockIsElectronMode.mockReturnValue(true);
    goTo('/chat/c-1');
    renderHook(() => useAppRoute());
    expect(mockRestorePath).not.toHaveBeenCalled();
  });
});

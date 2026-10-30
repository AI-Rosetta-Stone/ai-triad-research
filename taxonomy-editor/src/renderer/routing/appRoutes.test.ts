// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Tests for the in-app deep-link route registry (t/3486). The load-bearing assertions
// are: the dual-build guard (navigateTo/replaceRoute no-op in Electron — pushState there
// has no observer to react to it) and the op-eds route's restore contract.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIsElectronMode = vi.fn(() => false);
vi.mock('@bridge', () => ({ isElectronMode: () => mockIsElectronMode() }));

const mockSetActiveTab = vi.fn();
vi.mock('../hooks/useTaxonomyStore', () => ({
  useTaxonomyStore: { getState: () => ({ setActiveTab: mockSetActiveTab }) },
}));

const mockRequestOpen = vi.fn();
vi.mock('../hooks/useOpEdStore', () => ({
  useOpEdStore: { getState: () => ({ requestOpen: mockRequestOpen }) },
}));

const { OPED_ROUTE, findRoute, opedRoutePath, navigateTo, replaceRoute } = await import('./appRoutes');

describe('OPED_ROUTE.match', () => {
  it('matches /opeds/:setId, with or without a trailing slash', () => {
    expect(OPED_ROUTE.match('/opeds/set-1')).toEqual({ setId: 'set-1' });
    expect(OPED_ROUTE.match('/opeds/set-1/')).toEqual({ setId: 'set-1' });
  });
  it('decodes a URL-encoded setId', () => {
    expect(OPED_ROUTE.match('/opeds/a%20b')).toEqual({ setId: 'a b' });
  });
  it('returns null for non-matching paths', () => {
    expect(OPED_ROUTE.match('/')).toBeNull();
    expect(OPED_ROUTE.match('/opeds')).toBeNull();
    expect(OPED_ROUTE.match('/opeds/')).toBeNull();
    expect(OPED_ROUTE.match('/share/oped/set-1')).toBeNull();
  });
});

describe('OPED_ROUTE.restore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('switches to the opeds tab and requests opening the set', () => {
    OPED_ROUTE.restore({ setId: 'set-1' }, new URLSearchParams());
    expect(mockSetActiveTab).toHaveBeenCalledWith('opeds');
    expect(mockRequestOpen).toHaveBeenCalledWith('set-1', undefined);
  });

  it('passes the pov query param through', () => {
    OPED_ROUTE.restore({ setId: 'set-1' }, new URLSearchParams('pov=acc'));
    expect(mockRequestOpen).toHaveBeenCalledWith('set-1', 'acc');
  });
});

describe('findRoute', () => {
  it('finds the registered op-eds route', () => {
    const match = findRoute('/opeds/set-1');
    expect(match?.route.id).toBe('opeds');
    expect(match?.params).toEqual({ setId: 'set-1' });
  });
  it('strips query strings before matching', () => {
    const match = findRoute('/opeds/set-1?pov=acc');
    expect(match?.route.id).toBe('opeds');
    expect(match?.params).toEqual({ setId: 'set-1' });
  });
  it('strips query strings with multiple params', () => {
    const match = findRoute('/opeds/set-1?pov=acc&tab=overview');
    expect(match?.route.id).toBe('opeds');
    expect(match?.params).toEqual({ setId: 'set-1' });
  });
  it('returns null for an unregistered path', () => {
    expect(findRoute('/debates/anything')).toBeNull();
  });
});

describe('opedRoutePath', () => {
  it('builds a path with no query when pov is omitted', () => {
    expect(opedRoutePath('set-1')).toBe('/opeds/set-1');
  });
  it('builds a path with a pov query param', () => {
    expect(opedRoutePath('set-1', 'acc')).toBe('/opeds/set-1?pov=acc');
  });
  it('encodes special characters in the setId', () => {
    expect(opedRoutePath('a b')).toBe('/opeds/a%20b');
  });
});

describe('navigateTo / replaceRoute (dual-build guard)', () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  let replaceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockIsElectronMode.mockReturnValue(false);
    pushSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    replaceSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('pushes state on the web build', () => {
    navigateTo('/opeds/set-1');
    expect(pushSpy).toHaveBeenCalledWith({}, '', '/opeds/set-1');
  });

  it('replaces state on the web build', () => {
    replaceRoute('/opeds/set-1?pov=acc');
    expect(replaceSpy).toHaveBeenCalledWith({}, '', '/opeds/set-1?pov=acc');
  });

  it('no-ops in Electron — pushState has no observer there', () => {
    mockIsElectronMode.mockReturnValue(true);
    navigateTo('/opeds/set-1');
    replaceRoute('/opeds/set-1');
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
  });
});

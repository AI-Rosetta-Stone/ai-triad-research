// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4559: admin check shared by every admin-only UI surface (extracted from useCanEditPovTags,
// t/4167). Same cases as useCanEditPovTags.test.ts — this is the hook those cases now exercise.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserProfile } from './useAuthStatus';

const state = vi.hoisted(() => ({ electron: false, profile: null as UserProfile | null }));
vi.mock('@bridge', () => ({ isElectronMode: () => state.electron }));
vi.mock('./useAuthStatus', () => ({ useUserProfile: () => state.profile }));

const { useIsAdmin } = await import('./useIsAdmin');

const profile = (over: Partial<UserProfile>): UserProfile => ({
  userId: 'u1', displayName: 'User', idp: 'github', isAnonymous: false, isAdmin: false, quotas: null, geminiAllowlisted: false, ...over,
});

beforeEach(() => { state.electron = false; state.profile = null; });

describe('useIsAdmin (t/4559)', () => {
  it('desktop (Electron): the single local user is admin, with no profile at all', () => {
    state.electron = true;
    expect(renderHook(() => useIsAdmin()).result.current).toBe(true);
  });

  it('web admin: is admin', () => {
    state.profile = profile({ isAdmin: true });
    expect(renderHook(() => useIsAdmin()).result.current).toBe(true);
  });

  it('web signed-in non-admin: not admin', () => {
    state.profile = profile({ isAdmin: false });
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false);
  });

  it('web anonymous: not admin', () => {
    state.profile = profile({ isAnonymous: true, displayName: 'Anonymous', idp: null });
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false);
  });

  it('web with the profile still loading or failed: not admin (fails closed)', () => {
    state.profile = null;
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false);
  });
});

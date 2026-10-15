// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4167: who may edit POV tags in the UI, for each auth state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { UserProfile } from './useAuthStatus';

const state = vi.hoisted(() => ({ electron: false, profile: null as UserProfile | null }));
vi.mock('@bridge', () => ({ isElectronMode: () => state.electron }));
vi.mock('./useAuthStatus', () => ({ useUserProfile: () => state.profile }));

const { useCanEditPovTags } = await import('./useCanEditPovTags');

const profile = (over: Partial<UserProfile>): UserProfile => ({
  userId: 'u1', displayName: 'User', idp: 'github', isAnonymous: false, isAdmin: false, quotas: null, geminiAllowlisted: false, ...over,
});

beforeEach(() => { state.electron = false; state.profile = null; });

describe('useCanEditPovTags (t/4167)', () => {
  it('desktop (Electron): the single local user may edit, with no profile at all', () => {
    state.electron = true;
    expect(renderHook(() => useCanEditPovTags()).result.current).toBe(true);
  });

  it('web admin: may edit', () => {
    state.profile = profile({ isAdmin: true });
    expect(renderHook(() => useCanEditPovTags()).result.current).toBe(true);
  });

  it('web signed-in non-admin: read-only', () => {
    state.profile = profile({ isAdmin: false });
    expect(renderHook(() => useCanEditPovTags()).result.current).toBe(false);
  });

  it('web anonymous: read-only', () => {
    state.profile = profile({ isAnonymous: true, displayName: 'Anonymous', idp: null });
    expect(renderHook(() => useCanEditPovTags()).result.current).toBe(false);
  });

  it('web with the profile still loading or failed: read-only (fails closed)', () => {
    state.profile = null;
    expect(renderHook(() => useCanEditPovTags()).result.current).toBe(false);
  });
});

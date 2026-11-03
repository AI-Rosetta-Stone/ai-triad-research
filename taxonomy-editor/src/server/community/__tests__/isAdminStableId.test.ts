// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { isAdmin, getAdminUsers, validateAdminEntries } from '../community.js';

// Mock UserContext functions
vi.mock('../../security/userContext.js', () => ({
  getStableId: vi.fn(),
  getCurrentUser: vi.fn(),
  getStorageUserId: vi.fn(),
  isAnonymousUser: vi.fn(),
}));

describe('isAdmin() stableId matching (t/4328, SO C1-C3)', () => {
  const userContext = vi.mocked(await import('../../security/userContext.js'));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADMIN_USERS', 'github:12345,aad:tenant-oid-123');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('C1: Exact stableId match against idp-qualified entries', () => {
    it('matches github:<stableId>', () => {
      userContext.getStableId.mockReturnValue('12345');
      userContext.getCurrentUser.mockReturnValue({ idp: 'github' } as any);
      expect(isAdmin()).toBe(true);
    });

    it('matches aad:<tid>-<oid>', () => {
      userContext.getStableId.mockReturnValue('tenant-oid-123');
      userContext.getCurrentUser.mockReturnValue({ idp: 'aad' } as any);
      expect(isAdmin()).toBe(true);
    });

    it('case-insensitive (lowercased)', () => {
      userContext.getStableId.mockReturnValue('TENANT-OID-123');
      userContext.getCurrentUser.mockReturnValue({ idp: 'AAD' } as any);
      expect(isAdmin()).toBe(true);
    });
  });

  describe('C1: Bare entries never match', () => {
    it('bare entry does not match GitHub principal', () => {
      vi.stubEnv('ADMIN_USERS', 'jpsnover,github:12345');
      userContext.getStableId.mockReturnValue('54321');
      userContext.getCurrentUser.mockReturnValue({ idp: 'github' } as any);
      expect(isAdmin()).toBe(false);
    });

    it('unknown idp not admin', () => {
      userContext.getStableId.mockReturnValue('12345');
      userContext.getCurrentUser.mockReturnValue({ idp: 'google' } as any);
      expect(isAdmin()).toBe(false);
    });
  });

  describe('C1: Undefined stableId never admin', () => {
    it('undefined stableId → not admin', () => {
      userContext.getStableId.mockReturnValue(undefined);
      userContext.getCurrentUser.mockReturnValue({ idp: 'github' } as any);
      expect(isAdmin()).toBe(false);
    });

    it('missing idp → not admin', () => {
      userContext.getStableId.mockReturnValue('12345');
      userContext.getCurrentUser.mockReturnValue({ idp: undefined } as any);
      expect(isAdmin()).toBe(false);
    });
  });

  describe('getAdminUsers: no default', () => {
    it('unset ADMIN_USERS returns empty array', () => {
      vi.stubEnv('ADMIN_USERS', undefined);
      expect(getAdminUsers()).toEqual([]);
    });
  });

  describe('validateAdminEntries: boot check', () => {
    it('identifies unmatchable bare entries with @', () => {
      const entries = ['admin@example.com', 'github:12345'];
      // Should warn on unmatchable entry
      validateAdminEntries(entries);
    });

    it('accepts valid idp-qualified entries', () => {
      const entries = ['github:12345', 'aad:tenant-oid'];
      validateAdminEntries(entries);
    });
  });
});

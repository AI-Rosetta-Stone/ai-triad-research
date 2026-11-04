// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock UserContext functions. stableId fixtures use the REAL shape UserContext.stableId carries
// (`github:<id>` / `aad:<tid>-<oid>`, set from principalName.ts) — a bare-id fixture hid a
// double-prefix bug that never matched in production (t/4328).
vi.mock('../security/userContext.js', () => ({
  getStableId: vi.fn(),
  getStorageUserId: vi.fn(),
  isAnonymousUser: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  log: { security: { warn: vi.fn() } },
}));

const { isAdmin, isAdminStableId, getAdminUsers, validateAdminEntries } = await import('../community/community.js');
const userContext = vi.mocked(await import('../security/userContext.js'));
const { log } = vi.mocked(await import('../logger.js'));

describe('isAdmin() stableId matching (t/4328, SO C1-C3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('ADMIN_USERS', 'github:12345, aad:tenant-oid-123');
    userContext.getStorageUserId.mockReturnValue('jpsnover');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('C1: exact stableId match against idp-qualified entries', () => {
    it('matches a github stableId', () => {
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin()).toBe(true);
    });

    it('matches an aad stableId (entry whitespace trimmed)', () => {
      userContext.getStableId.mockReturnValue('aad:tenant-oid-123');
      expect(isAdmin()).toBe(true);
    });

    it('is case-insensitive on both sides', () => {
      vi.stubEnv('ADMIN_USERS', 'AAD:Tenant-OID-123');
      userContext.getStableId.mockReturnValue('aad:TENANT-oid-123');
      expect(isAdmin()).toBe(true);
    });

    it('a different id under the same idp is not admin', () => {
      userContext.getStableId.mockReturnValue('github:54321');
      expect(isAdmin()).toBe(false);
    });

    it('the same id under a different idp is not admin', () => {
      userContext.getStableId.mockReturnValue('aad:12345');
      expect(isAdmin()).toBe(false);
    });
  });

  describe('C1: bare entries never match', () => {
    it('a bare entry equal to the storage id does not grant admin', () => {
      vi.stubEnv('ADMIN_USERS', 'jpsnover');
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin()).toBe(false);
      expect(isAdmin('jpsnover')).toBe(false); // the legacy userId call shape must not fall back to bare matching
    });

    it('a bare (unqualified) stableId never matches a bare entry', () => {
      vi.stubEnv('ADMIN_USERS', '12345');
      userContext.getStableId.mockReturnValue('12345');
      expect(isAdmin()).toBe(false);
    });
  });

  describe('C1: undefined stableId is never admin', () => {
    it('anonymous / unsupported idp (stableId undefined)', () => {
      userContext.getStableId.mockReturnValue(undefined);
      expect(isAdmin()).toBe(false);
    });
  });

  describe('isAdmin(userId): existing call sites pass the current storageUserId', () => {
    it('current user: same result as isAdmin()', () => {
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin('jpsnover')).toBe(true);
    });

    it('a third-party userId is never admin, even when the current principal is', () => {
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin('someone-else')).toBe(false);
    });

    it("'_local' is never admin", () => {
      userContext.getStorageUserId.mockReturnValue('_local');
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin('_local')).toBe(false);
    });
  });

  describe('isAdminStableId: out-of-context callers (terminal WS upgrade)', () => {
    it('matches a qualified stableId and rejects undefined', () => {
      expect(isAdminStableId('github:12345')).toBe(true);
      expect(isAdminStableId(undefined)).toBe(false);
      expect(isAdminStableId('github:99999')).toBe(false);
    });
  });

  describe('getAdminUsers: no default', () => {
    it('unset ADMIN_USERS returns an empty array, so nobody is admin', () => {
      vi.stubEnv('ADMIN_USERS', '');
      expect(getAdminUsers()).toEqual([]);
      userContext.getStableId.mockReturnValue('github:12345');
      expect(isAdmin()).toBe(false);
    });

    it('never logs: it runs on every quota check (warnings are boot-time only)', () => {
      vi.stubEnv('ADMIN_USERS', '');
      getAdminUsers();
      vi.stubEnv('ADMIN_USERS', 'jpsnover');
      getAdminUsers();
      expect(log.security.warn).not.toHaveBeenCalled();
    });
  });

  describe('validateAdminEntries: boot check (C3, counts only)', () => {
    it('warns when ADMIN_USERS is unset or empty', () => {
      validateAdminEntries([]);
      expect(log.security.warn).toHaveBeenCalledWith(expect.stringContaining('unset or empty'));
    });

    it('warns with a count, not the values, when bare entries are present', () => {
      validateAdminEntries(['jpsnover', 'admin@example.com', 'github:12345']);
      expect(log.security.warn).toHaveBeenCalledWith({ bareEntries: 2 }, expect.stringContaining('never match'));
      expect(JSON.stringify(vi.mocked(log.security.warn).mock.calls)).not.toContain('jpsnover');
    });

    it('also warns when no entry is qualified', () => {
      validateAdminEntries(['jpsnover']);
      expect(log.security.warn).toHaveBeenCalledWith(expect.stringContaining('no idp-qualified entries'));
    });

    it('is silent for idp-qualified entries', () => {
      validateAdminEntries(['github:12345', 'aad:tenant-oid']);
      expect(log.security.warn).not.toHaveBeenCalled();
    });
  });
});

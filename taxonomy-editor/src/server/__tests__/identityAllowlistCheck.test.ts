// @vitest-environment node
//
// t/4505 (t/4504 incident follow-up): an ADMIN_USERS/READ_ONLY_PRINCIPALS entry that no
// current sign-in can produce under IDENTITY_MAP fails SILENTLY — the guard just never
// matches. This file covers the three ACs verbatim. The ADMIN_USERS rule follows t/43: only an
// idp-qualified entry isAdminStableId can match is reachable (it superseded t/4505#3's email rule).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, security: { ...orig.log.security, warn: warnMock } } };
});

import { findUnreachableAllowlistEntries, logUnreachableAllowlistEntriesAtBoot } from '../identityAllowlistCheck.js';
import { _resetPrincipalNameForTest } from '../principalName.js';
import { getAdminUsers, isAdminStableId } from '../community/community.js';

let prevMap: string | undefined;
beforeEach(() => {
  prevMap = process.env.IDENTITY_MAP;
  delete process.env.IDENTITY_MAP;
  warnMock.mockClear();
  _resetPrincipalNameForTest();
});
afterEach(() => {
  if (prevMap === undefined) delete process.env.IDENTITY_MAP; else process.env.IDENTITY_MAP = prevMap;
  _resetPrincipalNameForTest();
});

describe('findUnreachableAllowlistEntries — READ_ONLY_PRINCIPALS (AC: the three required cases)', () => {
  it('IDENTITY_MAP empty: github:ai-triad-smoke is reported unreachable', () => {
    const unreachable = findUnreachableAllowlistEntries([], new Set(['github:ai-triad-smoke']));
    expect(unreachable).toEqual([
      { source: 'READ_ONLY_PRINCIPALS', idp: 'github', name: 'ai-triad-smoke', reason: 'no map entry for legacy github name' },
    ]);
  });

  it('with the map entry present, it is not reported', () => {
    process.env.IDENTITY_MAP = 'github:12345=ai-triad-smoke';
    _resetPrincipalNameForTest();
    const unreachable = findUnreachableAllowlistEntries([], new Set(['github:ai-triad-smoke']));
    expect(unreachable).toEqual([]);
  });

  it('github-<id>-shaped entries are always reachable, map or no map', () => {
    const unreachable = findUnreachableAllowlistEntries([], new Set(['github:github-999']));
    expect(unreachable).toEqual([]);
  });

  it('a non-github/aad idp prefix is never checked (out of scope today, no false positive)', () => {
    const unreachable = findUnreachableAllowlistEntries([], new Set(['google:user@gmail.com']));
    expect(unreachable).toEqual([]);
  });
});

const BARE_REASON = 'bare entry with no idp: prefix; isAdminStableId never matches it (t/4328)';
const BAD_QUALIFIED_REASON = 'idp-qualified, but no sign-in records this stableId (expected github:<id> or aad:<tid>-<oid>)';
const GITHUB_SHAPE_REASON = 'github: id must be the numeric GitHub user id, not a login; no sign-in records this stableId';
const AAD_SHAPE_REASON = 'aad: id must be <tenant-guid>-<object-guid>; no sign-in records this stableId';
const TID = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const OID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AAD_ENTRY = `aad:${TID}-${OID}`;

describe('findUnreachableAllowlistEntries — ADMIN_USERS (t/43: aligned with isAdminStableId)', () => {
  it("prod's qualified github:<id> entry is reachable — not flagged", () => {
    expect(findUnreachableAllowlistEntries(['github:6188114'], new Set())).toEqual([]);
  });

  it('a qualified aad:<tid>-<oid> entry is reachable, and case is ignored like getAdminUsers', () => {
    expect(findUnreachableAllowlistEntries([`AAD:${TID.toUpperCase()}-${OID}`, 'GitHub:42'], new Set())).toEqual([]);
  });

  it('t/47: a github login instead of the numeric user id is flagged with its own reason', () => {
    expect(findUnreachableAllowlistEntries(['github:jpsnover'], new Set()).map(u => u.reason)).toEqual([GITHUB_SHAPE_REASON]);
  });

  it('t/47: an aad oid without its tenant id, or a non-GUID pair, is flagged with its own reason', () => {
    const unreachable = findUnreachableAllowlistEntries([`aad:${OID}`, 'aad:tenant-1-obj-1'], new Set());
    expect(unreachable.map(u => u.reason)).toEqual([AAD_SHAPE_REASON, AAD_SHAPE_REASON]);
  });

  it('a bare legacy name is flagged, even when IDENTITY_MAP maps a sign-in onto it', () => {
    process.env.IDENTITY_MAP = 'github:1234=jpsnover';
    _resetPrincipalNameForTest();
    expect(findUnreachableAllowlistEntries(['jpsnover'], new Set())).toEqual([
      { source: 'ADMIN_USERS', idp: null, name: 'jpsnover', reason: BARE_REASON },
    ]);
  });

  it('bare emails and github-<id> names are flagged too', () => {
    const unreachable = findUnreachableAllowlistEntries(['jsnover13-at-gmail-com@gmail.com', 'github-999'], new Set());
    expect(unreachable.map(u => u.reason)).toEqual([BARE_REASON, BARE_REASON]);
  });

  it('a qualified entry no sign-in records as a stableId is flagged', () => {
    const unreachable = findUnreachableAllowlistEntries(['google:user@gmail.com', 'github:', 'github:a b'], new Set());
    expect(unreachable.map(u => u.reason)).toEqual([BAD_QUALIFIED_REASON, GITHUB_SHAPE_REASON, GITHUB_SHAPE_REASON]);
  });

  it('a whitespace-only entry is skipped, not flagged', () => {
    expect(findUnreachableAllowlistEntries(['  '], new Set())).toEqual([]);
  });
});

describe('AGREEMENT GUARD: canProduceStableId must agree with community.isAdminStableId (t/43)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  // If you changed isAdminStableId (or its private isQualifiedEntry parser) and this fails, the
  // /health identityAllowlistUnreachable count no longer reflects who can actually be admin:
  // update canProduceStableId / adminUserUnreachableReason to match.
  // Every entry the check passes must be one isAdminStableId grants when that stableId signs in;
  // every bare entry it flags must be one isAdminStableId never grants.
  it.each(['github:6188114', AAD_ENTRY, 'GitHub:42'])('%s: reachable, and isAdminStableId matches it', (entry) => {
    vi.stubEnv('ADMIN_USERS', entry);
    expect(findUnreachableAllowlistEntries(getAdminUsers(), new Set())).toEqual([]);
    expect(isAdminStableId(entry.toLowerCase())).toBe(true);
  });

  it.each(['jpsnover', 'user@gmail.com', 'github-999'])('%s: flagged bare, and isAdminStableId never matches it', (entry) => {
    vi.stubEnv('ADMIN_USERS', entry);
    expect(findUnreachableAllowlistEntries(getAdminUsers(), new Set()).map(u => u.reason)).toEqual([BARE_REASON]);
    expect(isAdminStableId(entry)).toBe(false);
    expect(isAdminStableId(`github:${entry}`)).toBe(false);
  });
});

describe('logUnreachableAllowlistEntriesAtBoot', () => {
  it('WARNs once with the count, entries, and identityMapEmpty when something is unreachable', () => {
    const count = logUnreachableAllowlistEntriesAtBoot(['jpsnover'], new Set(['github:ai-triad-smoke']));
    expect(count).toBe(2);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const [fields] = warnMock.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ count: 2, identityMapEmpty: true });
    expect(fields.entries).toHaveLength(2);
  });

  it('does not WARN when everything is reachable', () => {
    const count = logUnreachableAllowlistEntriesAtBoot(['github:6188114'], new Set());
    expect(count).toBe(0);
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('identityMapEmpty is false once IDENTITY_MAP has any entry, even an unrelated one', () => {
    process.env.IDENTITY_MAP = 'github:1=someone-else';
    _resetPrincipalNameForTest();
    logUnreachableAllowlistEntriesAtBoot(['jpsnover'], new Set());
    const [fields] = warnMock.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ identityMapEmpty: false });
  });
});

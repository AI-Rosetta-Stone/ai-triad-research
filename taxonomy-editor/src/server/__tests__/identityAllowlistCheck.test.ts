// @vitest-environment node
//
// t/4505 (t/4504 incident follow-up): an ADMIN_USERS/READ_ONLY_PRINCIPALS entry that no
// current sign-in can produce under IDENTITY_MAP fails SILENTLY — the guard just never
// matches. This file covers the three ACs verbatim, plus the ADMIN_USERS email-reachability
// fix from the TL's design review (t/4505#3).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock('../logger.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../logger.js')>();
  return { ...orig, log: { ...orig.log, security: { ...orig.log.security, warn: warnMock } } };
});

import { findUnreachableAllowlistEntries, logUnreachableAllowlistEntriesAtBoot } from '../identityAllowlistCheck.js';
import { _resetPrincipalNameForTest } from '../principalName.js';

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

describe('findUnreachableAllowlistEntries — ADMIN_USERS (TL review t/4505#3: the email-reachability fix)', () => {
  it('a Google email admin is reachable (verified email, not map-derived) — not flagged', () => {
    const unreachable = findUnreachableAllowlistEntries(['jsnover13-at-gmail-com@gmail.com'], new Set());
    expect(unreachable).toEqual([]);
  });

  it('a bare legacy name with no map entry is flagged', () => {
    const unreachable = findUnreachableAllowlistEntries(['jpsnover'], new Set());
    expect(unreachable).toEqual([
      { source: 'ADMIN_USERS', idp: null, name: 'jpsnover', reason: 'no map entry for legacy aad/github name, and not a Google email' },
    ]);
  });

  it('with a github IDENTITY_MAP entry, the same bare legacy name is not flagged', () => {
    process.env.IDENTITY_MAP = 'github:1234=jpsnover';
    _resetPrincipalNameForTest();
    const unreachable = findUnreachableAllowlistEntries(['jpsnover'], new Set());
    expect(unreachable).toEqual([]);
  });

  it('with an aad IDENTITY_MAP entry, the same bare legacy name is not flagged', () => {
    process.env.IDENTITY_MAP = 'aad:t-o=jpsnover';
    _resetPrincipalNameForTest();
    const unreachable = findUnreachableAllowlistEntries(['jpsnover'], new Set());
    expect(unreachable).toEqual([]);
  });

  it('a github-<id>-shaped ADMIN_USERS entry is always reachable', () => {
    const unreachable = findUnreachableAllowlistEntries(['github-999'], new Set());
    expect(unreachable).toEqual([]);
  });

  it('a whitespace-only entry is skipped, not flagged', () => {
    const unreachable = findUnreachableAllowlistEntries(['  '], new Set());
    expect(unreachable).toEqual([]);
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
    process.env.IDENTITY_MAP = 'github:1=jpsnover';
    _resetPrincipalNameForTest();
    const count = logUnreachableAllowlistEntriesAtBoot(['jpsnover'], new Set());
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

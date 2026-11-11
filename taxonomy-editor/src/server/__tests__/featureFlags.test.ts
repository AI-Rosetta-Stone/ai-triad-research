// @vitest-environment node

/**
 * t/899 — feature-flag engine: scope evaluation, fail-closed, admin CRUD,
 * audit logging, stale detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runWithUser, type UserContext } from '../security/userContext.js';
import {
  evaluateScope, getFlag, getAllFlags, getFlagMetadata, listFlags,
  setFlag, deleteFlag, getStaleFlags, _resetFlagCache, type FlagUserContext,
} from '../featureFlags.js';

let dataRoot: string;
const SAVED_ENV: Record<string, string | undefined> = {};
const flagsFile = () => path.join(dataRoot, 'admin', 'feature-flags.json');
const auditFile = () => path.join(dataRoot, 'admin', 'feature-flags-audit.ndjson');

function ctx(p: Partial<FlagUserContext>): FlagUserContext {
  return { storageUserId: '_local', principalName: '', isAdmin: false, env: 'web', ...p };
}
function asUser<T>(storageUserId: string, fn: () => T): T {
  // t/4328: admin keys on the idp-qualified stableId, so each test user gets one.
  const c: UserContext = { principalName: storageUserId, idp: 'github', storageUserId, isAnonymous: false, stableId: `github:${storageUserId}` };
  return runWithUser(c, fn);
}

describe('evaluateScope (t/899 AC#3)', () => {
  it('global matches everyone', () => {
    expect(evaluateScope('global', ctx({}))).toBe(true);
    expect(evaluateScope('', ctx({}))).toBe(true);
  });
  it('role:admin matches only admins', () => {
    expect(evaluateScope('role:admin', ctx({ isAdmin: true }))).toBe(true);
    expect(evaluateScope('role:admin', ctx({ isAdmin: false }))).toBe(false);
  });
  it('user:list matches by principal or storage id (case-insensitive)', () => {
    expect(evaluateScope('user:jpsnover,alice', ctx({ storageUserId: 'alice' }))).toBe(true);
    expect(evaluateScope('user:jpsnover,alice', ctx({ principalName: 'JPSnover' }))).toBe(true);
    expect(evaluateScope('user:jpsnover', ctx({ storageUserId: 'bob' }))).toBe(false);
  });
  it('env matches the running environment', () => {
    expect(evaluateScope('env:web', ctx({ env: 'web' }))).toBe(true);
    expect(evaluateScope('env:electron', ctx({ env: 'web' }))).toBe(false);
  });
  it('compound (+) requires ALL parts', () => {
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: true, env: 'web' }))).toBe(true);
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: true, env: 'electron' }))).toBe(false);
    expect(evaluateScope('role:admin+env:web', ctx({ isAdmin: false, env: 'web' }))).toBe(false);
  });
  it('unknown scope type fails closed', () => {
    expect(evaluateScope('frobnicate:yes', ctx({}))).toBe(false);
  });
});

describe('feature flag CRUD + resolution (t/899)', () => {
  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flags-'));
    for (const k of ['AI_TRIAD_DATA_ROOT', 'ADMIN_USERS', 'FEATURE_FLAG_ENV']) SAVED_ENV[k] = process.env[k];
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
    process.env.ADMIN_USERS = 'github:jpsnover'; // t/4328: idp-qualified; bare entries never match
    _resetFlagCache();
  });
  afterEach(() => {
    for (const k of ['AI_TRIAD_DATA_ROOT', 'ADMIN_USERS', 'FEATURE_FLAG_ENV']) {
      if (SAVED_ENV[k] === undefined) delete process.env[k]; else process.env[k] = SAVED_ENV[k];
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
    _resetFlagCache();
  });

  it('unknown flags are fail-closed (AC#1)', () => {
    expect(getFlag('does-not-exist')).toBe(false);
  });

  it('the seed flag (release-qbaf-analysis) resolves true with no file present', () => {
    expect(getFlag('release-qbaf-analysis')).toBe(true);
  });

  it('seed flags remain accessible when feature-flags.json exists without them', () => {
    setFlag('custom-only', { enabled: true, scope: 'global' });
    _resetFlagCache();
    expect(getFlag('release-qbaf-analysis')).toBe(true);
    expect(asUser('jpsnover', () => getFlag('permission-admin-features'))).toBe(true);
    expect(getFlag('custom-only')).toBe(true);
  });

  it('useSyntheticStatementGrounding is seeded OFF, global, for every user (t/413)', () => {
    expect(getFlag('useSyntheticStatementGrounding')).toBe(false);
    expect(asUser('jpsnover', () => getFlag('useSyntheticStatementGrounding'))).toBe(false);
  });

  it('env-web-opeds is seeded OFF with env:web scope; reveal = admin flip (t/2632)', () => {
    // AC1: present in SEED, scope env:web, default disabled.
    expect(getFlagMetadata('env-web-opeds')).toMatchObject({ enabled: false, scope: 'env:web' });
    // AC2: resolves false by default (disabled short-circuits before scope).
    expect(getFlag('env-web-opeds')).toBe(false);
    expect(getFlag('release-qbaf-analysis')).toBe(true); // no regression to a sibling seed
    // AC3: an admin flip → true, delivered on web only (env:web scope).
    setFlag('env-web-opeds', { enabled: true, scope: 'env:web' }, 'jpsnover');
    _resetFlagCache();
    expect(getFlagMetadata('env-web-opeds')?.enabled).toBe(true);
    expect(evaluateScope('env:web', ctx({ env: 'web' }))).toBe(true);
    expect(evaluateScope('env:web', ctx({ env: 'electron' }))).toBe(false);
  });

  it('file flags take precedence over seed flags with the same name', () => {
    setFlag('release-qbaf-analysis', { enabled: false, scope: 'global' });
    _resetFlagCache();
    expect(getFlag('release-qbaf-analysis')).toBe(false);
  });

  it('setFlag persists to feature-flags.json and appends an audit entry (AC#5)', () => {
    setFlag('my-flag', { enabled: true, scope: 'global', description: 'x' }, 'jpsnover');
    expect(fs.existsSync(flagsFile())).toBe(true);
    const stored = JSON.parse(fs.readFileSync(flagsFile(), 'utf-8'));
    expect(stored.flags['my-flag'].enabled).toBe(true);
    const audit = fs.readFileSync(auditFile(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({ action: 'set', flag: 'my-flag', by: 'jpsnover' });
    expect(getFlagMetadata('my-flag')?.enabled).toBe(true);
  });

  it('disabled and expired flags resolve false', () => {
    setFlag('off', { enabled: false, scope: 'global' });
    setFlag('expired', { enabled: true, scope: 'global', expires_at: '2000-01-01T00:00:00.000Z' });
    expect(getFlag('off')).toBe(false);
    expect(getFlag('expired')).toBe(false);
  });

  it('role:admin flag resolves per the current user (AC#2)', () => {
    setFlag('admin-only', { enabled: true, scope: 'role:admin' });
    expect(asUser('jpsnover', () => getFlag('admin-only'))).toBe(true);  // admin
    expect(asUser('alice', () => getFlag('admin-only'))).toBe(false);    // non-admin
  });

  it('getAllFlags returns resolved booleans (AC#4)', () => {
    setFlag('a', { enabled: true, scope: 'global' });
    setFlag('b', { enabled: false, scope: 'global' });
    const all = asUser('alice', () => getAllFlags());
    expect(all.a).toBe(true);
    expect(all.b).toBe(false);
  });

  it('deleteFlag removes and audits', () => {
    setFlag('temp', { enabled: true });
    expect(deleteFlag('temp', 'jpsnover')).toBe(true);
    expect(getFlagMetadata('temp')).toBeNull();
    expect(deleteFlag('temp')).toBe(false); // idempotent
    const audit = fs.readFileSync(auditFile(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(audit.some(e => e.action === 'delete' && e.flag === 'temp')).toBe(true);
  });

  it('getStaleFlags finds old flags with no expiry', () => {
    setFlag('fresh', { enabled: true });
    // Backdate one flag directly in the file, then bust the cache.
    const cfg = JSON.parse(fs.readFileSync(flagsFile(), 'utf-8'));
    cfg.flags['ancient'] = { name: 'ancient', enabled: true, scope: 'global', created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' };
    fs.writeFileSync(flagsFile(), JSON.stringify(cfg));
    _resetFlagCache();
    const stale = getStaleFlags(30).map(f => f.name);
    expect(stale).toContain('ancient');
    expect(stale).not.toContain('fresh');
  });
});

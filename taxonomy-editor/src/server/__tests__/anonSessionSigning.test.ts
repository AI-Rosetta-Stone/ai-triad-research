// @vitest-environment node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/664 (t/500 part A; Security t/500#10.4): the signed anon_session_id cookie.
 *   - a forged signature gives _local
 *   - a cookie signed with the staging secret is rejected under the prod secret
 *   - a bare uuid (the pre-t/664 cookie) gives _local
 *   - a cookie signed with a rotated-out secret is rejected
 *   - an old cookie silently gets a fresh signed session (no error)
 *   - hosted with no secret fails closed (no unsigned mint); the secret never reaches a log or an event
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const frRecord = vi.fn();
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: () => ({ record: frRecord }) }));

import { setAnonSessionSecret, clearAnonSessionSecret, signAnonSessionId, verifyAnonSessionCookie } from '../security/anonSessionSigning.js';
import { loadAnonSessionSecret, ANON_SESSION_SECRET_NAME } from '../security/anonSessionSecret.js';
import { resolveAnonSessionId } from '../security/accessControl.js';
import { anonymousStorageUserId } from '../security/userContext.js';

const PROD = crypto.randomBytes(32);
const STAGING = crypto.randomBytes(32);
const UUID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

beforeEach(() => { frRecord.mockClear(); setAnonSessionSecret(PROD); });
afterEach(() => { clearAnonSessionSecret(); });

describe('t/664: signed anon_session_id', () => {
  it('a validly signed cookie verifies to its uuid and selects anon-<uuid>', () => {
    const cookie = signAnonSessionId(UUID);
    expect(cookie).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyAnonSessionCookie(cookie)).toBe(UUID);
    expect(anonymousStorageUserId(cookie)).toBe(`anon-${UUID}`);
  });

  it('a forged signature gives _local', () => {
    const cookie = signAnonSessionId(UUID);
    const sig = cookie.split('.')[1];
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(anonymousStorageUserId(`${UUID}.${flipped}`)).toBe('_local');
    // the signature of a DIFFERENT uuid does not carry over
    const other = signAnonSessionId('11111111-2222-4333-8444-555555555555').split('.')[1];
    expect(anonymousStorageUserId(`${UUID}.${other}`)).toBe('_local');
  });

  it('a cookie signed with the staging secret is rejected under the prod secret', () => {
    setAnonSessionSecret(STAGING);
    const stagingCookie = signAnonSessionId(UUID);
    setAnonSessionSecret(PROD);
    expect(verifyAnonSessionCookie(stagingCookie)).toBeUndefined();
    expect(anonymousStorageUserId(stagingCookie)).toBe('_local');
  });

  it('a bare uuid (the pre-t/664 cookie) gives _local', () => {
    expect(anonymousStorageUserId(UUID)).toBe('_local');
    expect(anonymousStorageUserId(undefined)).toBe('_local');
    expect(anonymousStorageUserId(`${UUID}.`)).toBe('_local');
    expect(anonymousStorageUserId(`${UUID}.short`)).toBe('_local');
  });

  it('a cookie signed with a rotated-out secret is rejected', () => {
    const before = signAnonSessionId(UUID);
    setAnonSessionSecret(crypto.randomBytes(32)); // rotation
    expect(verifyAnonSessionCookie(before)).toBeUndefined();
  });

  it('an old (bare uuid) cookie silently gets a fresh signed session; a valid one is reused', () => {
    const fresh = resolveAnonSessionId(UUID); // no throw: the hard cutover is silent
    expect(fresh).not.toBe(UUID);
    expect(verifyAnonSessionCookie(fresh)).toBeDefined();
    expect(resolveAnonSessionId(fresh)).toBe(fresh); // reuse-not-rotate
    expect(verifyAnonSessionCookie(resolveAnonSessionId(undefined))).toBeDefined();
  });

  it('with no secret loaded: nothing verifies and no unsigned cookie is minted (fail closed, 503)', () => {
    const cookie = signAnonSessionId(UUID);
    clearAnonSessionSecret();
    expect(verifyAnonSessionCookie(cookie)).toBeUndefined();
    expect(() => signAnonSessionId(UUID)).toThrow();
    let status: number | undefined;
    try { resolveAnonSessionId(undefined); } catch (err) { status = (err as { statusCode?: number }).statusCode; }
    expect(status).toBe(503);
  });

  it('rejects a secret shorter than 32 bytes', () => {
    expect(() => setAnonSessionSecret(crypto.randomBytes(16))).toThrow();
  });
});

describe('t/664: loading anon-session-hmac', () => {
  it('hosted: reads the secret by name from Key Vault and installs it', async () => {
    clearAnonSessionSecret();
    const value = crypto.randomBytes(32).toString('base64');
    const reader = vi.fn(async () => value);
    const ok = await loadAnonSessionSecret({ CONTAINER_APP_NAME: 'taxonomy-editor', AZURE_KEYVAULT_URL: 'https://kv.example/' }, reader);
    expect(ok).toBe(true);
    expect(reader).toHaveBeenCalledWith('https://kv.example/', ANON_SESSION_SECRET_NAME);
    expect(verifyAnonSessionCookie(signAnonSessionId(UUID))).toBe(UUID);
  });

  it('hosted: a missing secret, missing vault URL or read failure fails closed, never a local fallback', async () => {
    for (const [env, reader] of [
      [{ CONTAINER_APP_NAME: 'taxonomy-editor', AZURE_KEYVAULT_URL: 'https://kv.example/' }, async () => null],
      [{ CONTAINER_APP_NAME: 'taxonomy-editor' }, async () => 'unused'],
      [{ CONTAINER_APP_NAME: 'taxonomy-editor-staging', AZURE_KEYVAULT_URL: 'https://kv.example/' }, async () => { throw new Error('403'); }],
      [{ CONTAINER_APP_NAME: 'taxonomy-editor', AZURE_KEYVAULT_URL: 'https://kv.example/' }, async () => 'too-short'],
    ] as const) {
      clearAnonSessionSecret();
      expect(await loadAnonSessionSecret(env as NodeJS.ProcessEnv, reader as never)).toBe(false);
      expect(() => signAnonSessionId(UUID)).toThrow();
    }
    expect(frRecord.mock.calls.every((c) => (c[0] as { level: string }).level === 'error')).toBe(true);
  });

  it('the secret value never appears in a flight-recorder event or a refusal', async () => {
    clearAnonSessionSecret();
    const value = crypto.randomBytes(32).toString('base64');
    await loadAnonSessionSecret({ CONTAINER_APP_NAME: 'taxonomy-editor', AZURE_KEYVAULT_URL: 'https://kv.example/' }, async () => value);
    clearAnonSessionSecret();
    try { resolveAnonSessionId(undefined); } catch (err) { expect(JSON.stringify(err) + String(err)).not.toContain(value); }
    expect(JSON.stringify(frRecord.mock.calls)).not.toContain(value);
  });

  it('local (not hosted): creates a 32-byte secret file once and reuses it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonhmac-'));
    const saved = process.env.AI_TRIAD_STATE_ROOT;
    process.env.AI_TRIAD_STATE_ROOT = dir;
    try {
      clearAnonSessionSecret();
      expect(await loadAnonSessionSecret({})).toBe(true);
      const cookie = signAnonSessionId(UUID);
      clearAnonSessionSecret();
      expect(await loadAnonSessionSecret({})).toBe(true);
      expect(verifyAnonSessionCookie(cookie)).toBe(UUID); // same secret after a restart
      expect(fs.readFileSync(path.join(dir, '.aitriad-anon-session-hmac')).length).toBe(32);
    } finally {
      if (saved === undefined) delete process.env.AI_TRIAD_STATE_ROOT; else process.env.AI_TRIAD_STATE_ROOT = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
it('local: when another process creates the file first (EEXIST), its secret is used, not overwritten', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonhmac-race-'));
    const saved = process.env.AI_TRIAD_STATE_ROOT;
    process.env.AI_TRIAD_STATE_ROOT = dir;
    const file = path.join(dir, '.aitriad-anon-session-hmac');
    const theirs = crypto.randomBytes(32);
    const realRead = fs.readFileSync;
    let reads = 0;
    // First read: the file is absent. Then the other process writes it before our exclusive create.
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (p === file && reads++ === 0) {
        fs.writeFileSync(file, theirs, { mode: 0o600 });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return (realRead as (a: unknown, b?: unknown) => Buffer)(p, o);
    }) as typeof fs.readFileSync);
    try {
      clearAnonSessionSecret();
      expect(await loadAnonSessionSecret({})).toBe(true);
      expect(realRead(file).equals(theirs)).toBe(true); // not overwritten
      const cookie = signAnonSessionId(UUID);
      setAnonSessionSecret(theirs);
      expect(verifyAnonSessionCookie(cookie)).toBe(UUID); // we signed with THEIR secret
    } finally {
      spy.mockRestore();
      if (saved === undefined) delete process.env.AI_TRIAD_STATE_ROOT; else process.env.AI_TRIAD_STATE_ROOT = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local: a short secret file is refused (fail closed), not silently replaced', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anonhmac-short-'));
    const saved = process.env.AI_TRIAD_STATE_ROOT;
    process.env.AI_TRIAD_STATE_ROOT = dir;
    const file = path.join(dir, '.aitriad-anon-session-hmac');
    fs.writeFileSync(file, Buffer.alloc(8));
    try {
      clearAnonSessionSecret();
      expect(await loadAnonSessionSecret({})).toBe(false);
      expect(fs.readFileSync(file).length).toBe(8);
    } finally {
      if (saved === undefined) delete process.env.AI_TRIAD_STATE_ROOT; else process.env.AI_TRIAD_STATE_ROOT = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('providerBinding', () => {
  let tmpDir: string;
  let adminDir: string;
  let checkProviderBinding: typeof import('../ai/providerBinding.js')['checkProviderBinding'];
  let _resetBindingsCache: typeof import('../ai/providerBinding.js')['_resetBindingsCache'];

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-binding-test-'));
    adminDir = path.join(tmpDir, 'admin');
    fs.mkdirSync(adminDir, { recursive: true });

    vi.stubEnv('AI_TRIAD_DATA_ROOT', tmpDir);
    vi.resetModules();

    const mod = await import('../ai/providerBinding.js');
    checkProviderBinding = mod.checkProviderBinding;
    _resetBindingsCache = mod._resetBindingsCache;
    _resetBindingsCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows _local without creating a binding', () => {
    const result = checkProviderBinding('_local', 'github');
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(path.join(adminDir, 'provider_bindings.json'))).toBe(false);
  });

  it('allows empty storageUserId without creating a binding', () => {
    const result = checkProviderBinding('', 'github');
    expect(result).toEqual({ ok: true });
  });

  it('creates a binding on first login', () => {
    const result = checkProviderBinding('jpsnover', 'github');
    expect(result).toEqual({ ok: true });

    const bindings = JSON.parse(fs.readFileSync(path.join(adminDir, 'provider_bindings.json'), 'utf-8'));
    expect(bindings['jpsnover']).toBe('github');
  });

  it('allows same idp on subsequent login', () => {
    checkProviderBinding('jpsnover', 'github');
    const result = checkProviderBinding('jpsnover', 'github');
    expect(result).toEqual({ ok: true });
  });

  it('rejects a different idp for the same storageUserId', () => {
    checkProviderBinding('jpsnover', 'github');

    _resetBindingsCache();
    const result = checkProviderBinding('jpsnover', 'google');
    expect(result).toEqual({ ok: false, boundTo: 'github' });
  });

  it('tracks multiple users independently', () => {
    checkProviderBinding('jpsnover', 'github');
    checkProviderBinding('jsnover13-at-gmail-com', 'google');

    _resetBindingsCache();
    expect(checkProviderBinding('jpsnover', 'github')).toEqual({ ok: true });
    expect(checkProviderBinding('jsnover13-at-gmail-com', 'google')).toEqual({ ok: true });
    expect(checkProviderBinding('jpsnover', 'aad')).toEqual({ ok: false, boundTo: 'github' });
    expect(checkProviderBinding('jsnover13-at-gmail-com', 'aad')).toEqual({ ok: false, boundTo: 'google' });
  });

  it('persists bindings to disk and reloads after cache reset', () => {
    checkProviderBinding('alice', 'github');
    _resetBindingsCache();

    const result = checkProviderBinding('alice', 'github');
    expect(result).toEqual({ ok: true });
  });

  it('creates admin directory if it does not exist', () => {
    fs.rmSync(adminDir, { recursive: true, force: true });
    _resetBindingsCache();

    const result = checkProviderBinding('newuser', 'google');
    expect(result).toEqual({ ok: true });
    expect(fs.existsSync(path.join(adminDir, 'provider_bindings.json'))).toBe(true);
  });

  it('handles pre-existing bindings file with extra entries', () => {
    fs.writeFileSync(
      path.join(adminDir, 'provider_bindings.json'),
      JSON.stringify({ existing: 'aad', jpsnover: 'github' }),
      'utf-8',
    );
    _resetBindingsCache();

    expect(checkProviderBinding('existing', 'aad')).toEqual({ ok: true });
    expect(checkProviderBinding('existing', 'google')).toEqual({ ok: false, boundTo: 'aad' });
    expect(checkProviderBinding('jpsnover', 'github')).toEqual({ ok: true });
  });

  // The scenario this entire module prevents: two providers produce the same
  // normalized storageUserId for different real users.
  it('prevents cross-provider account collision', () => {
    // Google user "bob@example.com" → storageUserId "bob-at-example-com"
    checkProviderBinding('bob-at-example-com', 'google');

    // AAD user "bob@example.com" → same storageUserId "bob-at-example-com"
    _resetBindingsCache();
    const result = checkProviderBinding('bob-at-example-com', 'aad');
    expect(result.ok).toBe(false);
    expect(result.boundTo).toBe('google');
  });

  // ── t/2021 security regression: prototype-pollution / property-injection ──
  // storageUserId is user-derived (normalized OAuth id). CodeQL flagged the
  // dynamic write `bindings[storageUserId] = idp` (js/remote-property-injection).

  it('rejects __proto__ as a storageUserId and writes no binding', () => {
    const result = checkProviderBinding('__proto__', 'github');
    expect(result).toEqual({ ok: false });
    expect(fs.existsSync(path.join(adminDir, 'provider_bindings.json'))).toBe(false);
  });

  it('rejects constructor and prototype as storageUserIds', () => {
    expect(checkProviderBinding('constructor', 'github')).toEqual({ ok: false });
    expect(checkProviderBinding('prototype', 'github')).toEqual({ ok: false });
  });

  it('does not treat an Object.prototype member name as an existing binding', () => {
    // With a normal-prototype map, bindings['toString'] resolved to
    // Object.prototype.toString (truthy) and mis-flagged a first-time login as
    // an idp mismatch. The null-prototype map makes a fresh id bind cleanly.
    expect(checkProviderBinding('toString', 'github')).toEqual({ ok: true });

    _resetBindingsCache();
    expect(checkProviderBinding('toString', 'github')).toEqual({ ok: true });
    expect(checkProviderBinding('toString', 'google')).toEqual({ ok: false, boundTo: 'github' });
  });

  it('drops a forbidden key from a pre-existing file without polluting Object.prototype', () => {
    fs.writeFileSync(
      path.join(adminDir, 'provider_bindings.json'),
      '{"__proto__":"evil","alice":"github"}',
      'utf-8',
    );
    _resetBindingsCache();

    expect(checkProviderBinding('alice', 'github')).toEqual({ ok: true });
    // The forbidden entry was dropped on load; Object.prototype is untouched.
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'evil')).toBe(false);
  });

  // ── t/4540: IDENTITY_MAP-asserted cross-provider sign-ins override the binding ──

  it('AC1: a mismatched idp with an identityMapKey is accepted', () => {
    checkProviderBinding('jpsnover', 'github');
    _resetBindingsCache();
    const result = checkProviderBinding('jpsnover', 'aad', 'aad:tenant-1-obj-1');
    expect(result).toEqual({ ok: true });
  });

  it('AC2 (regression): a mismatched idp with NO identityMapKey is still rejected', () => {
    checkProviderBinding('jpsnover', 'github');
    _resetBindingsCache();
    const result = checkProviderBinding('jpsnover', 'aad');
    expect(result).toEqual({ ok: false, boundTo: 'github' });
  });

  // AC3 ("a map entry for a different stable id doesn't unlock this one") is NOT this
  // function's job to enforce — it has no concept of "the whole map," only the one key its
  // caller hands it. That guarantee lives entirely in principalName.ts's WeakMap, which only
  // ever holds THIS request's own lookup result (covered in principalName.test.ts, t/4540).
  // Documenting the trust boundary here: this function trusts its caller's key verbatim.
  it('trusts the caller\'s identityMapKey verbatim — the per-request scoping lives upstream', () => {
    checkProviderBinding('jpsnover', 'github');
    _resetBindingsCache();
    const result = checkProviderBinding('jpsnover', 'aad', 'aad:some-other-tenant-obj');
    expect(result).toEqual({ ok: true });
  });

  it('C3: an accepted mapped cross-provider sign-in leaves provider_bindings.json byte-identical (no rebind)', () => {
    checkProviderBinding('jpsnover', 'github');
    _resetBindingsCache();
    const before = fs.readFileSync(path.join(adminDir, 'provider_bindings.json'), 'utf-8');
    const beforeMtime = fs.statSync(path.join(adminDir, 'provider_bindings.json')).mtimeMs;

    checkProviderBinding('jpsnover', 'aad', 'aad:tenant-1-obj-1');

    const after = fs.readFileSync(path.join(adminDir, 'provider_bindings.json'), 'utf-8');
    const afterMtime = fs.statSync(path.join(adminDir, 'provider_bindings.json')).mtimeMs;
    expect(after).toBe(before);
    expect(afterMtime).toBe(beforeMtime);
    expect(JSON.parse(after)['jpsnover']).toBe('github'); // still bound to the original idp
  });
});

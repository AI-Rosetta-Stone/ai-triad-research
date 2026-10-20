// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4350 (t/4334#11 condition 3 fast-follow): the persisted snapshot-hash
 * cache that lets nodeSourceIndex.ts's computeSnapshotHash skip re-hashing a
 * doc whose blob SHA hasn't changed since the last build.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('snapshotHashCache', () => {
  let tmpDir: string;
  let mod: typeof import('../storage/snapshotHashCache.js');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't4350-snapshot-hash-cache-'));
    vi.stubEnv('AI_TRIAD_DATA_ROOT', tmpDir);
    vi.resetModules();
    mod = await import('../storage/snapshotHashCache.js');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a fresh (missing) cache file loads as empty, not an error', () => {
    const cache = mod.loadSnapshotHashCache();
    expect(cache).toEqual({});
  });

  it('a recorded hash round-trips through save and a fresh load', () => {
    const cache = mod.loadSnapshotHashCache();
    mod.recordHash(cache, 'doc-a', 'blob-sha-1', 'content-hash-1');
    mod.pruneAndSaveSnapshotHashCache(cache, ['doc-a']);

    vi.resetModules();
    const reloaded = mod.loadSnapshotHashCache();
    expect(mod.lookupCachedHash(reloaded, 'doc-a', 'blob-sha-1')).toBe('content-hash-1');
  });

  it('a cached "no hash" result (null) is a hit, not a miss', () => {
    const cache = mod.loadSnapshotHashCache();
    mod.recordHash(cache, 'doc-placeholder', 'blob-sha-2', null);
    expect(mod.lookupCachedHash(cache, 'doc-placeholder', 'blob-sha-2')).toBeNull();
  });

  it('a changed blob SHA is a cache miss (undefined), even for a previously cached doc', () => {
    const cache = mod.loadSnapshotHashCache();
    mod.recordHash(cache, 'doc-a', 'blob-sha-old', 'content-hash-old');
    expect(mod.lookupCachedHash(cache, 'doc-a', 'blob-sha-new')).toBeUndefined();
  });

  it('an unknown docId is a cache miss (undefined)', () => {
    const cache = mod.loadSnapshotHashCache();
    expect(mod.lookupCachedHash(cache, 'never-seen', 'any-sha')).toBeUndefined();
  });

  it('pruneAndSaveSnapshotHashCache drops entries for docs no longer present', () => {
    const cache = mod.loadSnapshotHashCache();
    mod.recordHash(cache, 'doc-a', 'sha-a', 'hash-a');
    mod.recordHash(cache, 'doc-removed', 'sha-removed', 'hash-removed');
    mod.pruneAndSaveSnapshotHashCache(cache, ['doc-a']); // doc-removed is gone from this build

    vi.resetModules();
    const reloaded = mod.loadSnapshotHashCache();
    expect(mod.lookupCachedHash(reloaded, 'doc-a', 'sha-a')).toBe('hash-a');
    expect(mod.lookupCachedHash(reloaded, 'doc-removed', 'sha-removed')).toBeUndefined();
  });

  it('gitBlobSha matches the known git blob SHA for an empty file', () => {
    // git hash-object for an empty blob is a well-known constant.
    expect(mod.gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

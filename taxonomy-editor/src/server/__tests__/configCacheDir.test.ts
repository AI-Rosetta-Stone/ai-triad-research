// @vitest-environment node
//
// t/2061 — CACHE_DIR fallback chain in FILESYSTEM mode. Root cause of the
// empty-data prod bug: the container image sets AI_TRIAD_DATA_ROOT
// (=/tmp/taxonomy-cache) but NOT TAXONOMY_CACHE_DIR, so CACHE_DIR fell straight
// through to the ~/.cache/taxonomy homedir default and diverged from where the
// data actually lived — toRepoPath() then couldn't strip the prefix,
// listDirectory returned empty, isDataAvailable was always false. The fix
// inserts AI_TRIAD_DATA_ROOT as the middle fallback so the cache dir tracks the
// same data root getDataRoot() resolves.
//
// t/4299/t/4300 — that AI_TRIAD_DATA_ROOT fallback is WRONG for GITHUB-API mode: it put
// the disk cache on the shared data root, so a direct writer to that root (the
// reconcile script, PS cmdlets) silently became what prod served, with no check
// against GitHub (t/4298). github-api mode's own unset-TAXONOMY_CACHE_DIR default is
// now a dedicated homedir subdir, never the data root — filesystem mode (Electron)
// keeps the t/2061 behavior unchanged.
//
// CACHE_DIR is a module-level const resolved from process.env/STORAGE_MODE at import
// time, so each case resets the module registry and re-imports under a fresh env.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';

describe('CACHE_DIR fallback chain (t/2061, t/4299/t/4300)', () => {
  const orig = {
    cache: process.env.TAXONOMY_CACHE_DIR,
    dataRoot: process.env.AI_TRIAD_DATA_ROOT,
    storageMode: process.env.STORAGE_MODE,
  };

  beforeEach(() => { vi.resetModules(); });

  afterEach(() => {
    restore('TAXONOMY_CACHE_DIR', orig.cache);
    restore('AI_TRIAD_DATA_ROOT', orig.dataRoot);
    restore('STORAGE_MODE', orig.storageMode);
  });

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  async function loadCacheDir(): Promise<string> {
    return (await import('../config.js')).CACHE_DIR;
  }

  it('prefers TAXONOMY_CACHE_DIR when it is set, in either mode', async () => {
    process.env.TAXONOMY_CACHE_DIR = '/explicit/cache';
    process.env.AI_TRIAD_DATA_ROOT = '/data/root';
    process.env.STORAGE_MODE = 'github-api';
    expect(await loadCacheDir()).toBe('/explicit/cache');
  });

  describe('filesystem mode (t/2061 behavior, unchanged)', () => {
    it('falls back to AI_TRIAD_DATA_ROOT when TAXONOMY_CACHE_DIR is unset', async () => {
      delete process.env.TAXONOMY_CACHE_DIR;
      process.env.AI_TRIAD_DATA_ROOT = '/tmp/taxonomy-cache';
      process.env.STORAGE_MODE = 'filesystem';
      expect(await loadCacheDir()).toBe('/tmp/taxonomy-cache');
    });

    it('falls back to the user-private homedir cache when neither env var is set', async () => {
      delete process.env.TAXONOMY_CACHE_DIR;
      delete process.env.AI_TRIAD_DATA_ROOT;
      process.env.STORAGE_MODE = 'filesystem';
      // The security-relevant default (not world-writable /tmp) is preserved.
      expect(await loadCacheDir()).toBe(path.join(os.homedir(), '.cache', 'taxonomy'));
    });
  });

  describe('github-api mode (t/4299/t/4300 fix)', () => {
    it('does NOT fall back to AI_TRIAD_DATA_ROOT — the exact corruption vector this closes', async () => {
      delete process.env.TAXONOMY_CACHE_DIR;
      process.env.AI_TRIAD_DATA_ROOT = '/mnt/shared';
      process.env.STORAGE_MODE = 'github-api';
      const dir = await loadCacheDir();
      // Pre-fix this returned '/mnt/shared' — the shared, externally-writable data root.
      expect(dir).not.toBe('/mnt/shared');
      expect(dir).toBe(path.join(os.homedir(), '.cache', 'taxonomy-github-api'));
    });

    it('falls back to a github-api-specific homedir cache when neither env var is set', async () => {
      delete process.env.TAXONOMY_CACHE_DIR;
      delete process.env.AI_TRIAD_DATA_ROOT;
      process.env.STORAGE_MODE = 'github-api';
      expect(await loadCacheDir()).toBe(path.join(os.homedir(), '.cache', 'taxonomy-github-api'));
    });
  });
});

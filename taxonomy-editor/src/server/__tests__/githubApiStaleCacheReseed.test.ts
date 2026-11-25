// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/463 (PI decision, option 1): when the cached commit is not in repo history, initialize() must re-seed
 * from the current commit, with no delete. The stuck case: the manifest write fails (the cache share is
 * read-only), and the old path threw out of initialize() before polling started, so the stale manifest
 * persisted and every boot repeated the failure. Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';


vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';

type Resp = { ok: boolean; status?: number; data?: unknown };
type Internals = {
  manifest: { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> } | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  initialize: () => Promise<void>;
  shutdown: () => void;
  _dataLoadStatus: string;
  isCommitInHistory: (sha: string) => Promise<boolean>;
  fetchRepoTree: (sha: string) => Promise<boolean>;
  repoTree: Map<string, unknown>;
  treeSha: string | null;
};

let tmp: string;
let cacheDir: string;
let inHistory: boolean;
let writeFails: boolean;
let treeFails: boolean;
let treeZero: boolean;
let writeSpy: ReturnType<typeof vi.spyOn> | null;

/** A GitHub that answers for the current commit; OLD is in history only when `inHistory`. */
function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo/commits/main') return Promise.resolve({ ok: true, data: { sha: NEW } });
  if (p === `/repos/testowner/testrepo/commits/${OLD}`) {
    return Promise.resolve(inHistory ? { ok: true, data: { sha: OLD } } : { ok: false, status: 404, data: {} });
  }
  if (p === `/repos/testowner/testrepo/compare/${OLD}...${NEW}`) {
    // t/555: a moved commit whose compare lists no file counts as "changed paths unknown" and drops every
    // entry, so the in-history control lists a change to a different file.
    return Promise.resolve(inHistory ? { ok: true, data: { files: [{ filename: 'taxonomy/other.json' }] } } : { ok: false, status: 404, data: {} });
  }
  if (p === `/repos/testowner/testrepo/git/commits/${NEW}`) {
    return Promise.resolve(treeFails ? { ok: false, status: 503, data: {} } : { ok: true, data: { tree: { sha: TREE } } });
  }
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) {
    const tree = treeZero ? [] : [{ path: 'taxonomy/a.json', type: 'blob', mode: '100644', sha: 'NEWBLOB' }];
    return Promise.resolve({ ok: true, data: { tree, truncated: false } });
  }
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

// t/555: pay the backend module's cold import here, not inside the first test's 5 s timeout (it flaked
// on the first run after a source change, under the pre-push load).
beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-reseed-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(path.join(cacheDir, 'taxonomy'), { recursive: true });
  // A manifest from the stale commit, with a file entry and its on-disk content.
  await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    version: 1, generation: 3, lastCommitSha: OLD, lastUpdated: '2026-11-01T00:00:00Z',
    files: { 'taxonomy/a.json': { sha: 'OLDBLOB', etag: '', cachedAt: '2026-11-01T00:00:00Z' } },
  }));
  await fsp.writeFile(path.join(cacheDir, 'taxonomy', 'a.json'), 'STALE-CONTENT');
  inHistory = false;
  writeFails = false;
  treeFails = false;
  treeZero = false;
  writeSpy = null;
});

afterEach(async () => {
  writeSpy?.mockRestore();
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function makeBackend(): Promise<Internals> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rest = { isTripped: () => false, request: router };
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  return b;
}

/** Make the manifest write fail, the way a read-only cache share does. */
function failManifestWrites(): void {
  writeFails = true;
  const real = fsp.writeFile.bind(fsp);
  writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation((async (file: unknown, data: unknown, opts: unknown) => {
    if (writeFails && String(file).includes('manifest.json.tmp.')) {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    }
    return real(file as string, data as string, opts as never);
  }) as unknown as typeof fsp.writeFile);
}

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend re-seeds a cache whose commit left history (t/463)', () => {
  it('re-seeds from the current commit: the stale file entry is dropped and the backend is ready', async () => {
    const b = await makeBackend();
    await b.initialize();
    try {
      expect(b.manifest?.lastCommitSha).toBe(NEW);
      expect(b.manifest?.files['taxonomy/a.json']).toBeUndefined();
      expect(b._dataLoadStatus).toBe('ready');
    } finally {
      b.shutdown();
    }
  });

  it('re-seeds even when the manifest cannot be written (read-only cache share); initialize does not throw', async () => {
    failManifestWrites();
    const b = await makeBackend();
    // Before the fix this rejected: the 404 path wrote the manifest inside the lock, the write threw,
    // and initialize() exited before polling started, leaving the stale manifest in place.
    await expect(b.initialize()).resolves.toBeUndefined();
    try {
      expect(b.manifest?.lastCommitSha).toBe(NEW);
      expect(b.manifest?.files['taxonomy/a.json']).toBeUndefined();
      expect(b._dataLoadStatus).toBe('ready');
    } finally {
      b.shutdown();
    }
  });

  it('control: a cached commit still in history keeps its cache (no re-seed)', async () => {
    inHistory = true;
    const b = await makeBackend();
    await b.initialize();
    try {
      expect(b.manifest?.files['taxonomy/a.json']).toBeDefined();
      expect(b.manifest?.lastCommitSha).toBe(NEW);
    } finally {
      b.shutdown();
    }
  });

  describe('a transient failure never applies or persists the re-seed (t/463 Second Opinion)', () => {
    it('a failed tree load leaves memory and disk as they were, and reports failed', async () => {
      treeFails = true;
      const b = await makeBackend();
      await expect(b.initialize()).resolves.toBeUndefined();
      try {
        expect(b._dataLoadStatus).toBe('failed');
        // Nothing applied in memory: the stale commit and its entry are still there.
        expect(b.manifest?.lastCommitSha).toBe(OLD);
        expect(b.manifest?.files['taxonomy/a.json']).toBeDefined();
      } finally {
        b.shutdown();
      }
      // Nothing persisted: the commit on disk is still the stale one.
      const onDisk = JSON.parse(await fsp.readFile(path.join(cacheDir, 'manifest.json'), 'utf-8'));
      expect(onDisk.lastCommitSha).toBe(OLD);
    });

    it('the next start with a healthy GitHub re-seeds and reports ready', async () => {
      treeFails = true;
      const first = await makeBackend();
      await first.initialize();
      first.shutdown();

      treeFails = false;
      const second = await makeBackend();
      await second.initialize();
      try {
        expect(second._dataLoadStatus).toBe('ready');
        expect(second.manifest?.lastCommitSha).toBe(NEW);
        expect(second.manifest?.files['taxonomy/a.json']).toBeUndefined();
      } finally {
        second.shutdown();
      }
    });

    it('the commit check is safe: a throwing credentials call keeps the cache (no throw, no wipe)', async () => {
      const b = await makeBackend();
      b.getCredsCached = async () => { throw new Error('credentials unavailable'); };
      await expect(b.isCommitInHistory(OLD)).resolves.toBe(true);
    });
  });

  describe('a zero-blob load never empties the live tree (t/463 Second Opinion)', () => {
    it('fetchRepoTree on a zero-blob response returns false and leaves the live tree and treeSha untouched', async () => {
      const b = await makeBackend();
      b.repoTree.set('keep/live.json', { path: 'keep/live.json', mode: '100644', type: 'blob', sha: 'LIVE' });
      b.treeSha = 'PREV-TREE';
      treeZero = true;
      await expect(b.fetchRepoTree(NEW)).resolves.toBe(false);
      expect(b.repoTree.has('keep/live.json')).toBe(true);
      expect(b.repoTree.size).toBe(1);
      expect(b.treeSha).toBe('PREV-TREE');
    });

    it('a successful load replaces the live tree and sets treeSha', async () => {
      const b = await makeBackend();
      b.repoTree.set('stale/gone.json', { path: 'stale/gone.json', mode: '100644', type: 'blob', sha: 'OLD' });
      b.treeSha = 'PREV-TREE';
      await expect(b.fetchRepoTree(NEW)).resolves.toBe(true);
      expect(b.repoTree.has('stale/gone.json')).toBe(false);
      expect(b.repoTree.has('taxonomy/a.json')).toBe(true);
      expect(b.treeSha).toBe(TREE);
    });

    it('initialize on a zero-blob response reports failed and persists nothing', async () => {
      treeZero = true;
      const b = await makeBackend();
      await expect(b.initialize()).resolves.toBeUndefined();
      try {
        expect(b._dataLoadStatus).toBe('failed');
        expect(b.manifest?.lastCommitSha).toBe(OLD);
      } finally {
        b.shutdown();
      }
      const onDisk = JSON.parse(await fsp.readFile(path.join(cacheDir, 'manifest.json'), 'utf-8'));
      expect(onDisk.lastCommitSha).toBe(OLD);
    });
  });
});

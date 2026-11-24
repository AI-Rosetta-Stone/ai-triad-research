// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/482 (TL p/50#129, design review t/482#2): a replica whose initial load failed for a known reason
 * becomes ready when a later poll tick completes the same full load a clean start runs. Before, the
 * status was only assigned in initialize(), so a short GitHub outage at boot left the replica at 503
 * until a restart. An unknown throw (t/480) never recovers. Less than the full load never sets ready.
 * Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { log } from '../logger.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';
const STALE = 'taxonomy/a.json';

type Resp = { ok: boolean; status?: number; data?: unknown };
type Manifest = { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> };
type Internals = {
  manifest: Manifest | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  initialize: () => Promise<void>;
  shutdown: () => void;
  pollTick: () => Promise<void>;
  pollDirect: () => Promise<void>;
  pollAsHolder: () => Promise<void>;
  pollAsNonHolder: () => Promise<void>;
  loadManifest: () => Promise<void>;
  getDataLoadStatus: () => { status: 'loading' | 'ready' | 'failed'; error?: string };
  blobLease: { isHolder: () => boolean } | null;
  repoTree: Map<string, unknown>;
};

type TreeMode = 'ok' | 'commit-fails' | 'zero-blobs' | 'no-body';
let treeMode: TreeMode;
let oldInHistory: boolean;
let headCalls: number;
let treeGate: Promise<void> | null;
let tmp: string;
let cacheDir: string;

async function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo/commits/main') { headCalls++; return { ok: true, data: { sha: NEW } }; }
  if (p === `/repos/testowner/testrepo/commits/${OLD}`) {
    return oldInHistory ? { ok: true, data: { sha: OLD } } : { ok: false, status: 404, data: {} };
  }
  if (p === `/repos/testowner/testrepo/compare/${OLD}...${NEW}`) {
    return oldInHistory ? { ok: true, data: { files: [] } } : { ok: false, status: 404, data: {} };
  }
  if (p === `/repos/testowner/testrepo/git/commits/${NEW}`) {
    return treeMode === 'commit-fails' ? { ok: false, status: 503, data: {} } : { ok: true, data: { tree: { sha: TREE } } };
  }
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) {
    if (treeGate) await treeGate;
    if (treeMode === 'no-body') return { ok: true, status: 200 };
    const tree = treeMode === 'zero-blobs' ? [] : [{ path: STALE, type: 'blob', mode: '100644', sha: 'NEWBLOB' }];
    return { ok: true, data: { tree, truncated: false } };
  }
  return { ok: false, status: 404, data: {} };
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-recover-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  // A cache from an older commit, with one file entry: the start is not a cache hit.
  await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    version: 1, generation: 3, lastCommitSha: OLD, lastUpdated: '2026-11-01T00:00:00Z',
    files: { [STALE]: { sha: 'OLDBLOB', etag: '', cachedAt: '2026-11-01T00:00:00Z' } },
  }));
  treeMode = 'ok';
  oldInHistory = true;
  headCalls = 0;
  treeGate = null;
});

afterEach(async () => {
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

/** A replica that started while GitHub could not serve the tree: failed for a known reason. */
async function failedKnown(): Promise<Internals> {
  treeMode = 'commit-fails';
  const b = await makeBackend();
  await b.initialize();
  expect(b.getDataLoadStatus().status).toBe('failed');
  expect(b.manifest?.lastCommitSha).toBe(OLD);
  return b;
}

async function manifestOnDisk(): Promise<Manifest> {
  return JSON.parse(await fsp.readFile(path.join(cacheDir, 'manifest.json'), 'utf-8')) as Manifest;
}

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('a known failed load recovers on a later poll tick (t/482)', () => {
  it('GitHub healthy again: one poll tick makes the replica ready, clears the error, and logs the failed duration', async () => {
    const warn = vi.spyOn(log.storage, 'warn');
    const b = await failedKnown();
    try {
      treeMode = 'ok';
      await b.pollTick();
      expect(b.getDataLoadStatus()).toEqual({ status: 'ready' });
      expect(b.manifest?.lastCommitSha).toBe(NEW);
      expect((await manifestOnDisk()).lastCommitSha).toBe(NEW);
      expect(b.repoTree.has(STALE)).toBe(true);
      const line = warn.mock.calls.find(c => String(c[1]).includes('storage.init.recovered'));
      expect(line?.[0]).toMatchObject({ sha: NEW, treeSize: 1 });
      expect(typeof (line?.[0] as { failedForMs: unknown }).failedForMs).toBe('number');
    } finally {
      b.shutdown();
    }
  });

  const STILL_BAD: Array<[string, TreeMode]> = [
    ['GitHub still cannot serve the commit', 'commit-fails'],
    ['the tree has zero blobs', 'zero-blobs'],
    ['the tree response has no body (wrong shape)', 'no-body'],
  ];

  it.each(STILL_BAD)('never ready on less than the full load: when %s, the status stays failed and nothing is persisted', async (_name, mode) => {
    const b = await failedKnown();
    try {
      treeMode = mode;
      await b.pollTick();
      expect(b.getDataLoadStatus().status).toBe('failed');
      expect(b.manifest?.lastCommitSha).toBe(OLD);
      expect(b.manifest?.files[STALE]).toBeDefined();
      expect((await manifestOnDisk()).lastCommitSha).toBe(OLD);

      // And it still recovers afterwards.
      treeMode = 'ok';
      await b.pollTick();
      expect(b.getDataLoadStatus().status).toBe('ready');
    } finally {
      b.shutdown();
    }
  });

  it('a cached commit that left history: recovery re-seeds, as a clean start does (the stale entry is dropped)', async () => {
    oldInHistory = false;
    const b = await failedKnown();
    try {
      expect(b.manifest?.files[STALE]).toBeDefined();
      treeMode = 'ok';
      await b.pollTick();
      expect(b.getDataLoadStatus().status).toBe('ready');
      expect(b.manifest?.lastCommitSha).toBe(NEW);
      expect(b.manifest?.files[STALE]).toBeUndefined();
    } finally {
      b.shutdown();
    }
  });

  describe('every failed replica recovers, whatever its poll role (TL point 1)', () => {
    it.each([['a non-holder', false], ['the holder', true]])('%s that is failed-known runs the recovery step, not its role\'s poll body', async (_name, isHolder) => {
      const b = await failedKnown();
      try {
        b.blobLease = { isHolder: () => isHolder };
        const nonHolder = vi.fn().mockResolvedValue(undefined);
        const holder = vi.fn().mockResolvedValue(undefined);
        b.pollAsNonHolder = nonHolder;
        b.pollAsHolder = holder;
        treeMode = 'ok';
        await b.pollTick();
        expect(b.getDataLoadStatus().status).toBe('ready');
        expect(nonHolder).not.toHaveBeenCalled();
        expect(holder).not.toHaveBeenCalled();

        // Once ready, the next tick goes back to the role's own poll body.
        await b.pollTick();
        expect(isHolder ? holder : nonHolder).toHaveBeenCalledTimes(1);
      } finally {
        b.blobLease = null;
        b.shutdown();
      }
    });
  });

  it('no overlap (TL point 2): a recovery load that outlasts the poll interval does not start a second one', async () => {
    const b = await failedKnown();
    try {
      treeMode = 'ok';
      let release!: () => void;
      treeGate = new Promise<void>(r => { release = r; });
      const before = headCalls;

      const first = b.pollTick();
      await new Promise(r => setTimeout(r, 20)); // the first attempt is now waiting on the tree
      await b.pollTick(); // the next interval fires while it is still in flight
      await b.pollTick();
      expect(headCalls - before).toBe(1);
      expect(b.getDataLoadStatus().status).toBe('failed');

      release();
      await first;
      expect(b.getDataLoadStatus().status).toBe('ready');
    } finally {
      treeGate = null;
      b.shutdown();
    }
  });

  it('an unknown throw does not recover: no ready, and no GitHub call from a poll tick', async () => {
    const b = await makeBackend();
    b.loadManifest = async () => { throw new TypeError('boom'); };
    await expect(b.initialize()).rejects.toThrow('boom');
    try {
      expect(b.getDataLoadStatus().status).toBe('failed');
      const before = headCalls;
      await b.pollTick();
      await b.pollTick();
      expect(b.getDataLoadStatus().status).toBe('failed');
      expect(headCalls).toBe(before);
    } finally {
      b.shutdown();
    }
  });

  it('control: a ready replica\'s poll tick is the ordinary poll, with no recovery step', async () => {
    const warn = vi.spyOn(log.storage, 'warn');
    const b = await makeBackend();
    await b.initialize();
    try {
      expect(b.getDataLoadStatus()).toEqual({ status: 'ready' });
      const direct = vi.fn().mockResolvedValue(undefined);
      b.pollDirect = direct;
      await b.pollTick();
      expect(direct).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some(c => String(c[1]).includes('storage.init.recover'))).toBe(false);
    } finally {
      b.shutdown();
    }
  });
});

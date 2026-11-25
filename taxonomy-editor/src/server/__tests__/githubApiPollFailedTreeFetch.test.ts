// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/483: a poll that sees a new head commit must apply nothing unless the tree for that commit loads.
 * The poll bodies ignored fetchRepoTree's result: a failed tree fetch still dropped the changed entries
 * from the manifest and advanced the manifest commit, so the next poll saw "nothing changed" and the
 * old tree was served under the new commit. #5309 (t/463) fixed the same thing in initialize(); these
 * tests mirror that file. Every filesystem target is inside an fs.mkdtemp directory.
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
const CHANGED = 'taxonomy/a.json';

type Resp = { ok: boolean; status?: number; data?: unknown };
type Manifest = { version: number; generation: number; lastCommitSha: string; lastUpdated: string; files: Record<string, { sha: string; etag: string; cachedAt: string }> };
type Internals = {
  manifest: Manifest | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  loadManifest: () => Promise<void>;
  pollDirect: () => Promise<void>;
  pollAsHolder: () => Promise<void>;
  publishPollState: (sha: string, changed: string[]) => Promise<void>;
  repoTree: Map<string, unknown>;
  treeSha: string | null;
};

type TreeMode = 'ok' | 'commit-fails' | 'zero-blobs' | 'no-body';
let treeMode: TreeMode;
let tmp: string;
let cacheDir: string;

function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo/commits/main') return Promise.resolve({ ok: true, data: { sha: NEW } });
  if (p === `/repos/testowner/testrepo/compare/${OLD}...${NEW}`) {
    return Promise.resolve({ ok: true, data: { files: [{ filename: CHANGED }] } });
  }
  if (p === `/repos/testowner/testrepo/git/commits/${NEW}`) {
    return Promise.resolve(treeMode === 'commit-fails' ? { ok: false, status: 503, data: {} } : { ok: true, data: { tree: { sha: TREE } } });
  }
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) {
    if (treeMode === 'no-body') return Promise.resolve({ ok: true, status: 200 });
    const tree = treeMode === 'zero-blobs' ? [] : [
      { path: CHANGED, type: 'blob', mode: '100644', sha: 'NEWBLOB' },
      { path: 'taxonomy/added.json', type: 'blob', mode: '100644', sha: 'ADDED' },
    ];
    return Promise.resolve({ ok: true, data: { tree, truncated: false } });
  }
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-poll-tree-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  // A running replica: its manifest is at the old commit and holds an entry for the file that changes.
  await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    version: 1, generation: 3, lastCommitSha: OLD, lastUpdated: '2026-11-01T00:00:00Z',
    files: { [CHANGED]: { sha: 'OLDBLOB', etag: '', cachedAt: '2026-11-01T00:00:00Z' } },
  }));
  treeMode = 'ok';
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
  await b.loadManifest();
  // The live tree from the old commit.
  b.repoTree.set(CHANGED, { path: CHANGED, mode: '100644', type: 'blob', sha: 'OLDBLOB' });
  b.treeSha = 'OLD-TREE';
  return b;
}

async function manifestOnDisk(): Promise<Manifest> {
  return JSON.parse(await fsp.readFile(path.join(cacheDir, 'manifest.json'), 'utf-8')) as Manifest;
}

/** Nothing moved: the manifest commit and entry, the live tree, and the manifest on disk. */
async function expectUntouched(b: Internals): Promise<void> {
  expect(b.manifest?.lastCommitSha).toBe(OLD);
  expect(b.manifest?.files[CHANGED]).toBeDefined();
  expect([...b.repoTree.keys()]).toEqual([CHANGED]);
  expect(b.treeSha).toBe('OLD-TREE');
  expect((await manifestOnDisk()).lastCommitSha).toBe(OLD);
}

function expectApplied(b: Internals): void {
  expect(b.manifest?.lastCommitSha).toBe(NEW);
  expect(b.manifest?.files[CHANGED]).toBeUndefined();
  expect(b.repoTree.has('taxonomy/added.json')).toBe(true);
  expect(b.treeSha).toBe(TREE);
}

const FAILED_LOADS: Array<[string, TreeMode]> = [
  ['the commit lookup fails (503)', 'commit-fails'],
  ['the tree has zero blobs', 'zero-blobs'],
  ['the tree response has no body', 'no-body'],
];

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('a poll applies a new commit only when its tree loads (t/483)', () => {
  describe('pollDirect', () => {
    it.each(FAILED_LOADS)('when %s, the manifest commit and the live tree are left untouched', async (_name, mode) => {
      treeMode = mode;
      const b = await makeBackend();
      await b.pollDirect();
      expect(b.manifest?.lastCommitSha).toBe(OLD);
      await expectUntouched(b);
    });

    it('the next healthy poll applies the change that the failed one left alone', async () => {
      treeMode = 'commit-fails';
      const b = await makeBackend();
      await b.pollDirect();
      await expectUntouched(b);

      treeMode = 'ok';
      await b.pollDirect();
      expectApplied(b);
      expect((await manifestOnDisk()).lastCommitSha).toBe(NEW);
    });

    it('control: a healthy poll loads the tree, drops the changed entry and advances the commit', async () => {
      const b = await makeBackend();
      await b.pollDirect();
      expectApplied(b);
    });
  });

  describe('pollAsHolder', () => {
    it.each(FAILED_LOADS)('when %s, nothing is applied and nothing is published to non-holders', async (_name, mode) => {
      treeMode = mode;
      const b = await makeBackend();
      const publish = vi.fn().mockResolvedValue(undefined);
      b.publishPollState = publish;
      await b.pollAsHolder();
      await expectUntouched(b);
      expect(publish).not.toHaveBeenCalled();
    });

    it('control: a healthy poll applies the commit and publishes it with the changed paths', async () => {
      const b = await makeBackend();
      const publish = vi.fn().mockResolvedValue(undefined);
      b.publishPollState = publish;
      await b.pollAsHolder();
      expectApplied(b);
      expect(publish).toHaveBeenCalledWith(NEW, [CHANGED]);
    });
  });
});

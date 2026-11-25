// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/555: the startup diff (loadFromHead -> invalidateChangedFiles) when the cached manifest is behind the
 * head. A failed compare, a force-push 404, a list at GitHub's 300-file cap, or an empty list for a moved
 * commit used to read as "nothing changed", so changed files kept serving their old blob after a restart;
 * the 404 branch also emptied the tree that had just loaded. Every filesystem target is inside fs.mkdtemp.
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
const UNCHANGED = 'taxonomy/b.json';

type Resp = { ok: boolean; status?: number; data?: unknown };
type Manifest = { lastCommitSha: string; files: Record<string, { sha: string }> };
type Internals = {
  manifest: Manifest | null;
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  loadManifest: () => Promise<void>;
  loadFromHead: (sha: string) => Promise<boolean>;
  repoTree: Map<string, unknown>;
};

type CompareMode = 'ok' | 'fails' | 'force-push' | 'capped' | 'empty';
let compareMode: CompareMode;
let tmp: string;
let cacheDir: string;

function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  // isCommitInHistory(OLD): present, so loadFromHead does not re-seed; the compare alone decides.
  if (p === `/repos/testowner/testrepo/commits/${OLD}`) return Promise.resolve({ ok: true, data: { sha: OLD } });
  if (p === `/repos/testowner/testrepo/compare/${OLD}...${NEW}`) {
    if (compareMode === 'fails') return Promise.resolve({ ok: false, status: 500, data: {} });
    if (compareMode === 'force-push') return Promise.resolve({ ok: false, status: 404, data: {} });
    const files = compareMode === 'empty' ? []
      : compareMode === 'capped' ? Array.from({ length: 300 }, (_, i) => ({ filename: `taxonomy/f${i}.json` }))
      : [{ filename: CHANGED }];
    return Promise.resolve({ ok: true, data: { files } });
  }
  if (p === `/repos/testowner/testrepo/git/commits/${NEW}`) return Promise.resolve({ ok: true, data: { tree: { sha: TREE } } });
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) {
    return Promise.resolve({ ok: true, data: { truncated: false, tree: [
      { path: CHANGED, type: 'blob', mode: '100644', sha: 'NEWBLOB' },
      { path: UNCHANGED, type: 'blob', mode: '100644', sha: 'SAMEBLOB' },
    ] } });
  }
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-startup-diff-')));
  cacheDir = path.join(tmp, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  const at = '2026-11-01T00:00:00Z';
  await fsp.writeFile(path.join(cacheDir, 'manifest.json'), JSON.stringify({
    version: 1, generation: 3, lastCommitSha: OLD, lastUpdated: at,
    files: { [CHANGED]: { sha: 'OLDBLOB', etag: '', cachedAt: at }, [UNCHANGED]: { sha: 'SAMEBLOB', etag: '', cachedAt: at } },
  }));
  compareMode = 'ok';
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
  return b;
}

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('startup diff when the cached manifest is behind the head (t/555)', () => {
  it.each([
    ['the compare fails (500)', 'fails'],
    ['the compare answers 404 (force-push)', 'force-push'],
    ['the compare list is at the 300-file cap', 'capped'],
    ['the commit moved but the compare lists no file', 'empty'],
  ] as const)('when %s, every cached entry is dropped and the loaded tree is kept', async (_name, mode) => {
    compareMode = mode;
    const b = await makeBackend();
    expect(await b.loadFromHead(NEW)).toBe(true);
    expect(b.manifest?.lastCommitSha).toBe(NEW);
    expect(b.manifest?.files).toEqual({});
    expect(b.repoTree.has(CHANGED)).toBe(true);
    expect(b.repoTree.has(UNCHANGED)).toBe(true);
  });

  it('control: a complete compare drops only the changed path', async () => {
    const b = await makeBackend();
    expect(await b.loadFromHead(NEW)).toBe(true);
    expect(b.manifest?.files[CHANGED]).toBeUndefined();
    expect(b.manifest?.files[UNCHANGED]).toBeDefined();
    expect(b.repoTree.size).toBe(2);
  });
});

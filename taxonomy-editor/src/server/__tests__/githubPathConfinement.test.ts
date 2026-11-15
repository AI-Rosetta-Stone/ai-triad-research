// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * GitHubAPIBackend path confinement (t/223, t/372). A caller-supplied path must be refused with
 * PATH_OUTSIDE_ROOT before any GitHub API call, and nothing may be written outside the disk
 * cache. Every directory here is an fs.mkdtemp root: `<tmp>/a/b/cache` is the cache dir, so even
 * a regressed guard writes only inside `<tmp>`, never to the machine or the repo.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue(null),
  FlightRecorder: vi.fn(),
}));

let tmp: string;
let cacheDir: string;
let fetchUrls: string[];
const originalFetch = globalThis.fetch;

async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(path.relative(tmp, full));
    if (e.isDirectory()) out.push(...(await listAll(full)));
  }
  return out.sort();
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (e: unknown) => (e as { code?: string }).code);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gh-confine-')));
  cacheDir = path.join(tmp, 'a', 'b', 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  vi.stubEnv('AI_TRIAD_DATA_ROOT', cacheDir);
  fetchUrls = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    fetchUrls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify({ message: 'not mocked' }), { status: 500 });
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend path confinement (t/223)', () => {
  async function backend() {
    const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
    const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
    await b.initialize();
    fetchUrls.length = 0;
    return b;
  }

  const escapes: Array<[string, () => string]> = [
    ['.. segments after the data root', () => `${cacheDir}/taxonomy/../../escape.txt`],
    ['bare .. at the start', () => '../../escape.txt'],
    ['backslash .. segments', () => `${cacheDir}\\taxonomy\\..\\..\\escape.txt`],
    ['absolute path outside the data root', () => path.join(tmp, 'escape.txt')],
    ['sibling sharing the data-root name prefix', () => `${cacheDir}-evil/escape.txt`],
    ['NUL byte', () => `${cacheDir}/taxonomy/x\0.json`],
  ];

  for (const [label, target] of escapes) {
    it(`refuses ${label} before any API call and creates nothing`, async () => {
      const b = await backend();
      const before = await listAll(tmp);
      const t = target();
      const codes = await Promise.all([
        codeOf(b.readFile(t)),
        codeOf(b.readBinaryFile(t)),
        codeOf(b.writeFile(t, 'attack', { baseSha: 'x' })),
        codeOf(b.writeBinaryFile(t, Buffer.from('attack'))),
        codeOf(b.deleteFile(t)),
        codeOf(b.fileExists(t)),
        codeOf(b.listDirectoryStrict(t)),
      ]);
      expect(codes).toEqual(Array(7).fill('PATH_OUTSIDE_ROOT'));
      expect(fetchUrls).toEqual([]);
      expect(await listAll(tmp)).toEqual(before);
    });
  }

  it('still accepts clean repo paths, including names containing ".."', async () => {
    const b = await backend();
    // No cached copy and a failing API: the call must get past path validation, not throw PATH_OUTSIDE_ROOT.
    for (const p of [`${cacheDir}/taxonomy/foo..json`, 'taxonomy/nodes.json', `${cacheDir}/taxonomy/./nodes.json`]) {
      expect(await codeOf(b.readFile(p))).not.toBe('PATH_OUTSIDE_ROOT');
    }
  });
});

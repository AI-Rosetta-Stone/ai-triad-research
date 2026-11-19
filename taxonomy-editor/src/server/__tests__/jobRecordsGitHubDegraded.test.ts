// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/268 item 5 (gates t/182): on the GitHub backend, a degraded directory listing returns [] from
 * listDirectory. A job-cap count that reads that [] as "no records" fails open. listUserJobRecords must
 * fail closed (JOB_RECORD_LIST_FAILED) on a degraded listing, and treat a genuine 404 as no records.
 *
 * Every filesystem target is inside an fs.mkdtemp directory (AI_TRIAD_DATA_ROOT). The GitHub backend's
 * network and tree are stubbed, so no test reaches GitHub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

import { GitHubAPIBackend } from '../storage/githubAPIBackend.js';
import { setUserContentBackend, getUserContentBackend } from '../storage/fileIO.js';
import type { StorageBackend } from '../storage/storageBackend.js';
import { listUserJobRecords } from '../storage/jobRecords.js';
import { runWithUser, type UserContext } from '../security/userContext.js';

const OWNER: UserContext = { principalName: 'owner-1', idp: 'github', storageUserId: 'owner-1', isAnonymous: false };

type Stubs = {
  rest: { isTripped: () => boolean; request: ReturnType<typeof vi.fn> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  ensureRepoTreeFilled: () => Promise<void>;
  blobLease: { isHolder: () => boolean } | undefined;
};

let tmp: string;
let savedDataRoot: string | undefined;
let savedUserContent: StorageBackend;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jobrec-degraded-')));
  savedDataRoot = process.env.AI_TRIAD_DATA_ROOT;
  process.env.AI_TRIAD_DATA_ROOT = path.join(tmp, 'root');
  savedUserContent = getUserContentBackend();
});

afterEach(async () => {
  setUserContentBackend(savedUserContent);
  if (savedDataRoot === undefined) delete process.env.AI_TRIAD_DATA_ROOT;
  else process.env.AI_TRIAD_DATA_ROOT = savedDataRoot;
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A GitHub backend whose tree is empty and whose REST answer is set per test. */
function makeGitHub(opts: { holder: boolean; tripped?: boolean; response?: unknown }): StorageBackend {
  const backend = new GitHubAPIBackend({
    cacheDir: path.join(tmp, 'cache'), pollIntervalMs: 999_999_999, coherencyProbeRate: 0,
  });
  const s = backend as unknown as Stubs;
  s.rest = {
    isTripped: () => opts.tripped ?? false,
    request: vi.fn().mockResolvedValue(opts.response ?? { ok: true, data: [] }),
  };
  s.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  s.ensureRepoTreeFilled = async () => {};
  s.blobLease = { isHolder: () => opts.holder };
  return backend as unknown as StorageBackend;
}

describe('listUserJobRecords on the GitHub backend fails closed on a degraded listing (t/268 item 5)', () => {
  it('a non-holder with an empty tree is degraded: the job count is refused, not read as []', async () => {
    setUserContentBackend(makeGitHub({ holder: false }));
    await expect(runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry')))
      .rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED' });
  });

  it('an open circuit breaker is degraded: the job count is refused', async () => {
    setUserContentBackend(makeGitHub({ holder: true, tripped: true }));
    await expect(runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry')))
      .rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED' });
  });

  it('a 500 from the Contents API is degraded: the job count is refused', async () => {
    setUserContentBackend(makeGitHub({ holder: true, response: { ok: false, status: 500, error: 'boom' } }));
    await expect(runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry')))
      .rejects.toMatchObject({ code: 'JOB_RECORD_LIST_FAILED' });
  });

  it('a 404 is a genuine answer (no job directory yet): [] is correct', async () => {
    setUserContentBackend(makeGitHub({ holder: true, response: { ok: false, status: 404, error: 'Not Found' } }));
    expect(await runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry'))).toEqual([]);
  });

  it('a genuine empty listing from the Contents API is [] (not degraded)', async () => {
    setUserContentBackend(makeGitHub({ holder: true, response: { ok: true, data: [] } }));
    expect(await runWithUser(OWNER, () => listUserJobRecords('owner-1', 'inquiry'))).toEqual([]);
  });
});

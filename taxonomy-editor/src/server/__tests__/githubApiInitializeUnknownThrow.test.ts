// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/480 (Second Opinion t/470#4, TL t/470#5): an unknown throw in GitHubAPIBackend.initialize() is
 * recorded as a failed data load with its cause, then re-thrown. Before, the status stayed 'loading',
 * which readiness reports as a warm-up and then as a timeout with no cause. Never 'ready' on this path,
 * no polling, and the event is not github.api.error (that one feeds the GitHub-outage alert).
 * Every filesystem target is inside an fs.mkdtemp directory.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { classifyDataUnavailable } from '../routes/readiness.js';
import type { ServerCtx } from '../routes/context.js';
import { log } from '../logger.js';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getDefaultBranch: vi.fn().mockReturnValue('main'),
  invalidateCredentials: vi.fn(),
}));

const HEAD = '2222222222222222222222222222222222222222';
const TREE = '3333333333333333333333333333333333333333';

type Resp = { ok: boolean; status?: number; data?: unknown };
type RecordedEvent = { type: string; level?: string; message?: string };
type Internals = {
  rest: { isTripped: () => boolean; request: (creds: unknown, method: string, p: string) => Promise<Resp> };
  getCredsCached: () => Promise<{ repo: string; token: string; mode: 'pat' } | null>;
  initialize: () => Promise<void>;
  shutdown: () => void;
  loadManifest: () => Promise<void>;
  getLatestCommitSha: () => Promise<string>;
  fetchRepoTree: (sha: string) => Promise<boolean>;
  startPolling: () => void;
  getDataLoadStatus: () => { status: 'loading' | 'ready' | 'failed'; error?: string };
  getCircuitState: () => string;
  recordEvent: (e: RecordedEvent) => void;
  pollTimer: unknown;
  leaseRenewTimer: unknown;
};

function router(_creds: unknown, _method: string, p: string): Promise<Resp> {
  if (p === '/repos/testowner/testrepo/commits/main') return Promise.resolve({ ok: true, data: { sha: HEAD } });
  if (p === `/repos/testowner/testrepo/git/commits/${HEAD}`) return Promise.resolve({ ok: true, data: { tree: { sha: TREE } } });
  if (p.startsWith(`/repos/testowner/testrepo/git/trees/${TREE}`)) {
    return Promise.resolve({ ok: true, data: { tree: [{ path: 'taxonomy/a.json', type: 'blob', mode: '100644', sha: 'BLOB' }] } });
  }
  return Promise.resolve({ ok: false, status: 404, data: {} });
}

let tmp: string;
let cacheDir: string;
let events: RecordedEvent[];

beforeAll(async () => {
  await import('../storage/githubAPIBackend');
}, 60_000);

beforeEach(async () => {
  tmp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'gh-init-throw-')));
  cacheDir = path.join(tmp, 'cache');
  events = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmp, { recursive: true, force: true });
});

async function makeBackend(): Promise<{ b: Internals; startPolling: ReturnType<typeof vi.fn> }> {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({ cacheDir, pollIntervalMs: 999_999_999, coherencyProbeRate: 0 }) as unknown as Internals;
  b.rest = { isTripped: () => false, request: router };
  b.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
  const realRecord = b.recordEvent.bind(b);
  b.recordEvent = (e: RecordedEvent) => { events.push(e); realRecord(e); };
  const realStart = b.startPolling.bind(b);
  const startPolling = vi.fn(() => realStart());
  b.startPolling = startPolling;
  return { b, startPolling };
}

/** What /readyz would say for this backend, well past the warm-up grace window. */
function readiness(b: Internals): { state: string; reason: string } {
  const ctx = { getGithubBackend: () => b } as unknown as ServerCtx;
  return classifyDataUnavailable(ctx, 100_000) as { state: string; reason: string };
}

/** Each message holds a server path, as an fs error's does. It must never reach the public reason. */
const SECRET_PATH = '/mnt/shared/.cache/manifest.json';
const THROW_SITES: Array<[string, string, (b: Internals) => void]> = [
  ['loadManifest', 'TypeError', b => { b.loadManifest = async () => { throw new TypeError(`boom in loadManifest at ${SECRET_PATH}`); }; }],
  ['getLatestCommitSha', 'RangeError', b => { b.getLatestCommitSha = async () => { throw new RangeError(`boom in getLatestCommitSha at ${SECRET_PATH}`); }; }],
  ['fetchRepoTree', 'Error (EIO)', b => { b.fetchRepoTree = async () => { throw Object.assign(new Error(`boom in fetchRepoTree at ${SECRET_PATH}`), { code: 'EIO' }); }; }],
];

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend.initialize records an unknown throw as a failed load (t/480)', () => {
  it.each(THROW_SITES)('a throw from %s: failed with the error name and code in the readiness reason, re-thrown, no polling', async (site, named, arrange) => {
    const { b, startPolling } = await makeBackend();
    arrange(b);
    try {
      await expect(b.initialize()).rejects.toThrow(`boom in ${site}`);

      const status = b.getDataLoadStatus();
      expect(status.status).toBe('failed');
      expect(status.error).toContain(`initialize threw ${named}`);

      // /readyz is anonymous and returns this reason: the name and code, never the message or a path.
      const ready = readiness(b);
      expect(ready.state).toBe('failed');
      expect(ready.reason).toContain(`initialize threw ${named}`);
      expect(ready.reason).not.toContain('boom');
      expect(ready.reason).not.toContain(SECRET_PATH);

      expect(startPolling).not.toHaveBeenCalled();
      expect(b.pollTimer).toBeNull();
    } finally {
      b.shutdown();
    }
  });

  it('the event is system.error with the storage.init.error marker, never github.api.error; the message goes to the log', async () => {
    const errorLog = vi.spyOn(log.storage, 'error');
    const { b } = await makeBackend();
    b.loadManifest = async () => { throw new TypeError(`boom in loadManifest at ${SECRET_PATH}`); };
    try {
      await expect(b.initialize()).rejects.toThrow();
      const line = errorLog.mock.calls.find(c => String(c[1]).includes('storage.init.error'));
      expect(line?.[0]).toMatchObject({ errName: 'TypeError', errMessage: `boom in loadManifest at ${SECRET_PATH}` });
      const ours = events.filter(e => (e.message ?? '').includes('storage.init.error'));
      expect(ours).toHaveLength(1);
      expect(ours[0]).toMatchObject({ type: 'system.error', level: 'error' });
      expect(events.some(e => e.type === 'github.api.error')).toBe(false);
    } finally {
      b.shutdown();
    }
  });

  it('a throw after the load reported ready still ends as failed, and stops the timers it started', async () => {
    const { b } = await makeBackend();
    const realStart = b.startPolling.bind(b);
    b.startPolling = () => { realStart(); throw new Error('boom in startPolling'); };
    try {
      await expect(b.initialize()).rejects.toThrow('boom in startPolling');
      expect(b.getDataLoadStatus().status).toBe('failed');
      expect(b.pollTimer).toBeNull();
      expect(b.leaseRenewTimer).toBeNull();
    } finally {
      b.shutdown();
    }
  });

  it('control: a clean start reports ready and starts polling', async () => {
    const { b, startPolling } = await makeBackend();
    try {
      await expect(b.initialize()).resolves.toBeUndefined();
      expect(b.getDataLoadStatus()).toEqual({ status: 'ready' });
      expect(startPolling).toHaveBeenCalledTimes(1);
      expect(events.some(e => (e.message ?? '').includes('storage.init.error'))).toBe(false);
    } finally {
      b.shutdown();
    }
  });
});

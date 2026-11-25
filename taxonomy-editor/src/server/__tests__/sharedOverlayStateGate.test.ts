// @vitest-environment node

/**
 * t/503 (the flip): OVERLAY_SHARED_STATE_COMMIT_READY is now true, so shared overlay state is on exactly when the
 * deployment sets OVERLAY_SHARED_STATE_ENABLED=1 and server.ts passes a store. Without the env var it stays off, which
 * is what makes the feature PR safe to merge before Azure's Bicep (t/554). The store is never touched in that case.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';

vi.mock('fs/promises', () => ({
  default: {
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  },
}));
vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 't', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({ getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }), FlightRecorder: vi.fn() }));

const originalFetch = globalThis.fetch;

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9999999999' }) });
}

async function makeBackendWithSpyStore() {
  vi.resetModules();
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const store = {
    stage: vi.fn(), getEntryWithEtag: vi.fn(), listEntries: vi.fn(async () => []), getGeneration: vi.fn(async () => null),
    unstage: vi.fn(), rebaseEntry: vi.fn(), countStagedEntriesByUser: vi.fn(async () => new Map()),
    readCommitStatus: vi.fn(), writeCommitStatus: vi.fn(),
  };
  const b = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${Math.random()}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999, coherencyProbeRate: 0,
    sharedOverlayState: { store: store as never, commitLock: { accountUrl: 'http://127.0.0.1:1/x', container: 'overlay-state' } },
  });
  await b.initialize();
  b.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
  return { b, store };
}

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('shared overlay state is gated by OVERLAY_SHARED_STATE_ENABLED (t/503 flip)', () => {
  beforeEach(() => {
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/git/refs/heads/')) return respond(200, { object: { sha: 'a'.repeat(40) } });
      if (url.includes('/git/trees/')) return respond(200, { sha: 't', truncated: false, tree: [] });
      return respond(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('env unset: a save stays local and the store is never staged (inert after merge, before t/554)', async () => {
    vi.stubEnv('OVERLAY_SHARED_STATE_ENABLED', '');
    const { b, store } = await makeBackendWithSpyStore();
    await b.writeFile('/conflicts/a.json', '{}');
    expect(store.stage).not.toHaveBeenCalled();
    expect(await b.getSharedOverlayDrainStatus()).toBeNull();
  });

  it('env OVERLAY_SHARED_STATE_ENABLED=1: shared state is on, and a save goes to the store', async () => {
    vi.stubEnv('OVERLAY_SHARED_STATE_ENABLED', '1');
    const { b, store } = await makeBackendWithSpyStore();
    store.getEntryWithEtag.mockResolvedValue(null);
    store.stage.mockResolvedValue({ ok: true, etag: 'e1', gen: 'g1', genBumped: true });
    await b.writeFile('/conflicts/a.json', '{}');
    expect(store.stage).toHaveBeenCalledTimes(1);
    expect(await b.getSharedOverlayDrainStatus()).toMatchObject({ draining: false, stagedEntries: 0 });
  });
});

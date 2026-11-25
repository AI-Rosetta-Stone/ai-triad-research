// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/638 (incident t/629): GitHubAPIBackend commits only allowlisted data-repo paths. Anything else throws
 * DATA_REPO_PATH_REFUSED, with a WARN naming the path class, before any GitHub API call. Covers the predicate, every
 * write entry point (writeFile direct and overlay, writeFileIfAbsent, writeBinaryFile, deleteFile, writeToOverlay,
 * commitOverlay, createCommitFromTree), and each known-bad class from t/638#1.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { isUndiciMajorAlignedWithRuntime } from '../storage/undiciInvariant.js';
import { isCommittableDataRepoPath, dataRepoPathClass } from '../storage/dataRepoWriteAllowlist.js';

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
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token-abc123', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));
vi.mock('../../../../lib/flight-recorder/index.js', () => ({
  getGlobalRecorder: vi.fn().mockReturnValue({ record: vi.fn() }),
  FlightRecorder: vi.fn(),
}));

/** The known-bad classes named in t/638#1, each as a path a leak would write. */
const KNOWN_BAD: Array<[string, string]> = [
  ['flight-recorder/', 'flight-recorder/server-0b7c.jsonl'],
  ['admin/', 'admin/flight-recorder-dumps/client-1.jsonl'],
  ['users/', 'users/u-123/debates/_index.json'],
  ['anon*', 'anon-sessions/s-1.json'],
  ['oped-runs/', 'oped-runs/r-1.json'],
  ['analytics/', 'analytics/2026-11-25.json'],
  ['feedback/', 'feedback/f-1.json'],
  ['key files', 'keys/gemini.json'],
  ['key files (.env)', '.env'],
  ['*.jsonl dump at the root', 'data-writes.jsonl'],
  ['preferences/ (per-user; belongs in user content)', 'preferences/u-123.json'],
  ['community/ (user content)', 'community/_submissions/sub-1.json'],
];

describe('isCommittableDataRepoPath (t/638)', () => {
  it.each([
    'taxonomy/Origin/accelerationist.json', 'taxonomy/Origin/situations.json', 'taxonomy/Origin/cross-cutting.json',
    'taxonomy/Origin/edges.json', 'taxonomy/Origin/aggregated-cruxes.json', 'taxonomy/Origin/policy_actions.json',
    'taxonomy/Origin/pov-tag-proposals.json', 'conflicts/conflicts.json', 'conflicts/claim-42.json',
    'taxonomy-proposal-2026-11-25.json',
    // Security cleared (p/228#34): calibration as-is (identity fields stripped at promote), harvests field-filtered.
    'calibration/integration-log.jsonl', 'calibration/core/calibration-log.jsonl', 'calibration/core/extraction-metrics.jsonl',
    'calibration/core/lineage-enrichments.json', 'harvests/concept-1795580000000.json', 'harvests/manifest-1795580000000.json',
  ])('allows the legitimate data-repo file %s', (p) => {
    expect(isCommittableDataRepoPath(p)).toBe(true);
  });

  it.each(KNOWN_BAD)('refuses the known-bad class %s', (_cls, p) => {
    expect(isCommittableDataRepoPath(p)).toBe(false);
  });

  it.each([
    'taxonomy/Origin/../../users/u/x.json', 'taxonomy/../users.json', '/taxonomy/Origin/edges.json', 'taxonomy\\Origin\\edges.json',
    'taxonomy/Origin/sub/edges.json', 'taxonomy/Origin/notes.json', 'conflicts/a/b.json', 'calibration/users/u-1/log.jsonl',
    'harvests/concept-abc.json', 'summaries/doc.json', 'sources/doc/metadata.json', 'TAXONOMY_VERSION',
  ])('refuses %s (traversal, nesting, or not a writer\'s path)', (p) => {
    expect(isCommittableDataRepoPath(p)).toBe(false);
  });

  it('the logged class never carries a user id', () => {
    expect(dataRepoPathClass('users/u-123/debates/_index.json')).toBe('users/');
    expect(dataRepoPathClass('anon-sessions/s-1.json')).toBe('anon*');
  });
});

describe('harvest and calibration content guards (t/638; Security p/228#34, TL p/50#185)', () => {
  it('a harvest record keeps only debate_id, harvested_at and items[type, action, id, status]', async () => {
    const { filterHarvestRecord } = await import('../storage/harvestStore.js');
    const out = filterHarvestRecord({
      debate_id: 'd-1', harvested_at: '2026-11-25T00:00:00Z', debate_title: 'My own words about AI',
      email: 'someone@example.com', notes: 'free text', extra: { nested: true },
      items: [{ type: 'concept', action: 'add', id: 'c-1', status: 'pending', text: 'user text', owner: 'someone@example.com', meta: { a: 1 } }],
    });
    expect(out).toEqual({ debate_id: 'd-1', harvested_at: '2026-11-25T00:00:00Z', items: [{ type: 'concept', action: 'add', id: 'c-1', status: 'pending' }] });
    expect(JSON.stringify(out)).not.toMatch(/@|My own words|user text/);
  });

  it('calibration identity fields are dropped at any depth before promotion', async () => {
    const { stripIdentityFields } = await import('../storage/calibrationStore.js');
    const out = stripIdentityFields({ debate_id: 'd-1', score: 0.8, user_id: 'u-1', email: 'a@b.c', meta: { by: 'admin', author: 'x', ok: 1 }, list: [{ userId: 'u', v: 2 }] });
    expect(out).toEqual({ debate_id: 'd-1', score: 0.8, meta: { ok: 1 }, list: [{ v: 2 }] });
  });
});

let githubCalls: string[];
const originalFetch = globalThis.fetch;
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: new Headers({ 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '9999999999' }) });
}

async function makeBackend() {
  const { GitHubAPIBackend } = await import('../storage/githubAPIBackend');
  const b = new GitHubAPIBackend({
    cacheDir: `/var/cache/taxonomy-test-${Math.random()}`,
    recorder: { record: vi.fn(), flush: vi.fn(), toJSON: vi.fn().mockReturnValue([]), intern: vi.fn() } as never,
    pollIntervalMs: 999_999_999, coherencyProbeRate: 0,
  });
  await b.initialize();
  githubCalls = [];
  return b;
}

// Pay the backend's cold import here, not inside the first test's 5 s timeout.
beforeAll(async () => { await import('../storage/githubAPIBackend'); }, 60_000);

describe.skipIf(!isUndiciMajorAlignedWithRuntime())('GitHubAPIBackend write paths refuse non-allowlisted paths before any GitHub call (t/638)', () => {
  beforeEach(() => {
    vi.stubEnv('AI_TRIAD_DATA_ROOT', '/var/cache/taxonomy-test');
    githubCalls = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      githubCalls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/git/refs/heads/')) return respond(200, { object: { sha: 'a'.repeat(40) } });
      if (url.includes('/git/trees')) return respond(init?.method === 'POST' ? 201 : 200, { sha: 'tree-1', truncated: false, tree: [] });
      if (url.includes('/git/commits')) return respond(201, { sha: 'commit-1' });
      if (url.includes('/contents/')) return init?.method === 'PUT' ? respond(201, { content: { sha: 'blob-1' } }) : respond(404, { message: 'Not Found' });
      return respond(404, { message: 'Not Found' });
    }) as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(KNOWN_BAD)('direct writeFile of %s is refused with zero GitHub calls', async (_cls, p) => {
    const b = await makeBackend();
    await expect(b.writeFile(`/${p}`, 'secret', { ref: 'main' })).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED', httpStatus: 403 });
    expect(githubCalls).toEqual([]);
  });

  it('every other write entry point refuses a users/ path with zero GitHub calls', async () => {
    const b = await makeBackend();
    const bad = '/users/u-123/debates/_index.json';
    await expect(b.writeFileIfAbsent(bad, '{}', { ref: 'main' })).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    await expect(b.writeBinaryFile('/users/u-123/a.bin', Buffer.from('x'), { ref: 'main' })).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    await expect(b.deleteFile(bad)).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    await expect(b.createCommitFromTree('main', [{ path: 'taxonomy/Origin/edges.json', content: '{}' }, { path: 'users/u-123/x.json', content: '{}' }], 'm'))
      .rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    b.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    expect(() => b.writeToOverlay(bad, '{}')).toThrow(expect.objectContaining({ code: 'DATA_REPO_PATH_REFUSED' }));
    await expect(b.writeFile(bad, '{}')).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' }); // the overlay path too
    expect(githubCalls).toEqual([]);
  });

  it('a taxonomy write is still allowed (direct commit reaches GitHub)', async () => {
    const b = await makeBackend();
    await expect(b.writeFile('/taxonomy/Origin/edges.json', '{"edges":[]}', { ref: 'main' })).resolves.toMatchObject({ version: expect.any(String) });
    expect(githubCalls.some(c => c.startsWith('PUT ') && c.includes('/contents/taxonomy/Origin/edges.json'))).toBe(true);
  });

  it('an overlay commit holding one refused path is refused whole, with zero GitHub calls', async () => {
    const b = await makeBackend();
    b.setSessionContext({ userId: 'alice', branchName: 'api-session/alice' });
    b.writeToOverlay('/taxonomy/Origin/edges.json', '{"edges":[]}');
    // A refused entry can't get in through the write paths any more; simulate one left from before this fix.
    b.getSessionOverlay('alice')!.set('users/alice/debates/_index.json', '{}');
    await expect(b.commitOverlay('alice', undefined, { branchName: 'api-session/alice' })).rejects.toMatchObject({ code: 'DATA_REPO_PATH_REFUSED' });
    expect(githubCalls).toEqual([]);
  });
});

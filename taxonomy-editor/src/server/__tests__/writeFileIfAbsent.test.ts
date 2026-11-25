// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4216 (t/181): StorageBackend.writeFileIfAbsent, the atomic create-only write behind cross-replica
 * job idempotency (t/182) and draft claims (t/185). Per backend:
 *  - FilesystemBackend: real disk I/O in a temp dir (temp file + link()).
 *  - AzureBlobBackend: a fake BlobServiceClient — asserts the `If-None-Match: *` condition and the
 *    412 / 409 BlobAlreadyExists → 'exists' mapping. The live-service check is in the Azurite suite.
 *  - GitHubAPIBackend: transport and overlay internals stubbed — direct-commit PUT without sha, and
 *    the session-overlay path.
 * Plus the guard Tech Lead asked for (p/50#12): every production backend implements the method, so
 * writeFileIfAbsentStrict can only fail closed against a test double.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RestError, type BlobServiceClient } from '@azure/storage-blob';

vi.mock('../security/githubAppAuth', () => ({
  getCredentials: vi.fn().mockResolvedValue({ repo: 'testowner/testrepo', token: 'test-token', mode: 'pat' as const }),
  getRepoSlug: vi.fn().mockReturnValue('testowner/testrepo'),
  getTokenExpiryMs: vi.fn().mockReturnValue(0),
}));

import { FilesystemBackend } from '../storage/filesystemBackend.js';
import { AzureBlobBackend } from '../storage/azureBlobBackend.js';
import { GitHubAPIBackend } from '../storage/githubAPIBackend.js';
import { writeFileIfAbsentStrict } from '../storage/fileIO.js';
import type { StorageBackend } from '../storage/storageBackend.js';

// ── conformance + the strict call site ──────────────────────────────────────

describe('writeFileIfAbsent — every production backend implements it (t/181, TL p/50#12)', () => {
  it.each([
    ['FilesystemBackend', FilesystemBackend],
    ['AzureBlobBackend', AzureBlobBackend],
    ['GitHubAPIBackend', GitHubAPIBackend],
  ] as const)('%s.prototype.writeFileIfAbsent is a function', (_name, cls) => {
    expect(typeof (cls.prototype as Partial<StorageBackend>).writeFileIfAbsent).toBe('function');
  });
});

describe('writeFileIfAbsentStrict (t/181)', () => {
  it('fails CLOSED for a backend without writeFileIfAbsent — never a non-atomic fallback', () => {
    const writeFile = vi.fn();
    const double = { backendName: 'double', writeFile } as unknown as StorageBackend;
    expect(() => writeFileIfAbsentStrict(double, '/x/job-1.json', '{}'))
      .toThrow(expect.objectContaining({ code: 'CREATE_ONLY_UNSUPPORTED', httpStatus: 500 }));
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('delegates to the backend when present', async () => {
    const writeFileIfAbsent = vi.fn().mockResolvedValue('exists');
    const double = { backendName: 'double', writeFileIfAbsent } as unknown as StorageBackend;
    expect(await writeFileIfAbsentStrict(double, '/x/job-1.json', '{}', { ref: 'main' })).toBe('exists');
    expect(writeFileIfAbsent).toHaveBeenCalledWith('/x/job-1.json', '{}', { ref: 'main' });
  });
});

// ── FilesystemBackend (real disk) ───────────────────────────────────────────

describe('FilesystemBackend.writeFileIfAbsent (t/181)', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-if-absent-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('first create → created with the content; second → exists and the file is untouched', async () => {
    const backend = new FilesystemBackend({ root: dir });
    const file = path.join(dir, 'sub', 'job-a.json');
    expect(await backend.writeFileIfAbsent(file, '{"v":1}')).toBe('created');
    expect(await backend.writeFileIfAbsent(file, '{"v":2}')).toBe('exists');
    expect(await fs.readFile(file, 'utf-8')).toBe('{"v":1}');
  });

  it('a file created out-of-band (another process) reads as exists', async () => {
    const file = path.join(dir, 'job-b.json');
    await fs.writeFile(file, 'theirs');
    expect(await new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, 'mine')).toBe('exists');
    expect(await fs.readFile(file, 'utf-8')).toBe('theirs');
  });

  it('concurrent creates across instances: exactly one created, and the file holds the winner\'s content', async () => {
    const file = path.join(dir, 'job-c.json');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, `writer-${i}`)),
    );
    expect(results.filter(r => r === 'created')).toHaveLength(1);
    expect(await fs.readFile(file, 'utf-8')).toBe(`writer-${results.indexOf('created')}`);
  });

  it('leaves no temp files behind, on either outcome', async () => {
    const backend = new FilesystemBackend({ root: dir });
    const file = path.join(dir, 'job-d.json');
    await backend.writeFileIfAbsent(file, '1');
    await backend.writeFileIfAbsent(file, '2');
    expect(await fs.readdir(dir)).toEqual(['job-d.json']);
  });

  it('a real failure throws — it is never reported as exists', async () => {
    const blocker = path.join(dir, 'not-a-dir');
    await fs.writeFile(blocker, 'x');
    await expect(new FilesystemBackend({ root: dir }).writeFileIfAbsent(path.join(blocker, 'job-e.json'), '{}')).rejects.toThrow();
  });
});

// ── AzureBlobBackend (fake service client) ──────────────────────────────────

describe('AzureBlobBackend.writeFileIfAbsent (t/181)', () => {
  function backendWith(upload: ReturnType<typeof vi.fn>): AzureBlobBackend {
    const container = { getBlockBlobClient: () => ({ upload }) };
    const serviceClient = { getContainerClient: () => container } as unknown as BlobServiceClient;
    return new AzureBlobBackend({ accountUrl: 'http://fake', userContentContainer: 'uc', communityContainer: 'cc', serviceClient });
  }

  it('uploads once with If-None-Match: * and reports created', async () => {
    const upload = vi.fn().mockResolvedValue({});
    expect(await backendWith(upload).writeFileIfAbsent('conflicts/job-1.json', '{"v":1}')).toBe('created');
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][2]).toMatchObject({ conditions: { ifNoneMatch: '*' } });
  });

  it.each([
    ['412 ConditionNotMet', 412, 'ConditionNotMet'],
    ['409 BlobAlreadyExists', 409, 'BlobAlreadyExists'],
  ])('%s → exists', async (_label, statusCode, code) => {
    const upload = vi.fn().mockRejectedValue(new RestError('exists', { statusCode, code }));
    expect(await backendWith(upload).writeFileIfAbsent('conflicts/job-1.json', '{}')).toBe('exists');
  });

  it.each([
    ['500 InternalError', 500, 'InternalError'],
    ['409 LeaseIdMissing (a conflict that is not "exists")', 409, 'LeaseIdMissing'],
  ])('%s throws — never reported as exists', async (_label, statusCode, code) => {
    const upload = vi.fn().mockRejectedValue(new RestError('boom', { statusCode, code }));
    await expect(backendWith(upload).writeFileIfAbsent('conflicts/job-1.json', '{}')).rejects.toThrow();
  });
});

// ── GitHubAPIBackend (stubbed transport / overlay) ──────────────────────────

describe('GitHubAPIBackend.writeFileIfAbsent (t/181)', () => {
  type Internals = Record<string, unknown>;
  const REPO_PATH = 'conflicts/job-1.json';

  function makeBackend(opts: { session: boolean }): { backend: GitHubAPIBackend; internals: Internals; request: ReturnType<typeof vi.fn> } {
    const backend = new GitHubAPIBackend({ cacheDir: path.join(os.tmpdir(), 'gh-wia-cache'), pollIntervalMs: 999_999_999, coherencyProbeRate: 0 });
    const internals = backend as unknown as Internals;
    const request = vi.fn();
    internals.rest = { isTripped: () => false, request };
    internals.toRepoPath = () => REPO_PATH;
    internals.getCredsCached = async () => ({ repo: 'testowner/testrepo', token: 't', mode: 'pat' });
    internals.writeToDiskCache = vi.fn().mockResolvedValue(undefined);
    internals.hasSessionContext = () => opts.session;
    internals.getEffectiveRef = () => (opts.session ? 'session/u1' : 'main');
    internals.getEffectiveUserId = () => 'u1';
    return { backend, internals, request };
  }

  describe('direct-commit path', () => {
    it('PUT without sha → created, and the body carries no sha', async () => {
      const { backend, request } = makeBackend({ session: false });
      request.mockResolvedValue({ ok: true, status: 201, data: { content: { sha: 'new' } } });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{"v":1}')).toBe('created');
      const body = request.mock.calls[0][3] as Record<string, unknown>;
      expect(body).not.toHaveProperty('sha');
      expect(request.mock.calls[0][1]).toBe('PUT');
    });

    const SHA_422 = { ok: false, status: 422, data: null, error: 'Invalid request.\n\n"sha" wasn\'t supplied.' };

    it('422 "sha wasn\'t supplied", and a read confirms the file is there → exists (t/268 item 3)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce(SHA_422);
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'present', content: '{}', sha: 's1' });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('exists');
      expect(internals.getSessionBranchFileStatus).toHaveBeenCalledWith(REPO_PATH, 'main');
    });

    it('422 that mentions sha but the file is absent → a validation failure that throws, never exists (t/268 item 3)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 422, data: null, error: 'sha is not a valid blob reference for this tree' });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'absent' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(/422/);
    });

    it('422 that mentions sha but the file cannot be read → throws GITHUB_EXISTS_UNVERIFIED (503), never exists (t/268 item 3)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce(SHA_422);
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'unavailable' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_EXISTS_UNVERIFIED', httpStatus: 503 }));
    });

    it('409, absent, then the retry gets the sha 422: confirmed by a second read → exists (t/268 item 3)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      request.mockResolvedValueOnce(SHA_422);
      internals.getSessionBranchFileStatus = vi.fn()
        .mockResolvedValueOnce({ kind: 'absent' })
        .mockResolvedValueOnce({ kind: 'present', content: '{}', sha: 's1' });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('exists');
      expect(internals.getSessionBranchFileStatus).toHaveBeenCalledTimes(2);
    });

    it('the confirming read is unconditional, so a cached ETag cannot turn it into a 304 and a spurious 503 (t/268 item 4)', async () => {
      const { backend, request } = makeBackend({ session: false });
      // A GitHub that answers 304 to a conditional GET, as it does when the manifest's ETag is sent.
      request.mockImplementation(async (_creds: unknown, method: string, _p: string, _body: unknown, _callId: unknown, opts?: { unconditional?: boolean }) => {
        if (method === 'PUT') return SHA_422;
        if (!opts?.unconditional) return { ok: true, status: 304, data: null };
        return { ok: true, status: 200, data: { type: 'file', encoding: 'base64', sha: 's1', size: 2, content: Buffer.from('{}').toString('base64') } };
      });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('exists');
      const get = request.mock.calls.find(c => c[1] === 'GET');
      expect(get?.[5]).toMatchObject({ optional: true, unconditional: true });
    });

    it('getSessionBranchFileStatus on the base branch reads the file even when GitHub would 304 a conditional GET (t/268 item 4)', async () => {
      const { internals, request } = makeBackend({ session: false });
      request.mockImplementation(async (_creds: unknown, _method: string, _p: string, _body: unknown, _callId: unknown, opts?: { unconditional?: boolean }) => {
        if (!opts?.unconditional) return { ok: true, status: 304, data: null };
        return { ok: true, status: 200, data: { type: 'file', encoding: 'base64', sha: 's1', size: 2, content: Buffer.from('{}').toString('base64') } };
      });
      const status = await (internals.getSessionBranchFileStatus as (p: string, ref: string) => Promise<{ kind: string }>).call(internals, REPO_PATH, 'main');
      // Before the fix this was 'unavailable', which the 409 path turns into a 503.
      expect(status.kind).toBe('present');
    });

    it('any other 422 is a real validation failure and throws — never exists', async () => {
      const { backend, request } = makeBackend({ session: false });
      request.mockResolvedValue({ ok: false, status: 422, data: null, error: 'path contains a malformed segment' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(/422/);
    });

    it('a 5xx throws', async () => {
      const { backend, request } = makeBackend({ session: false });
      request.mockResolvedValue({ ok: false, status: 502, data: null, error: 'Bad gateway' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(/502/);
    });

    it('409 (concurrent modification) with file now present → exists (t/181)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'present', content: '{}', sha: 's1' });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{"new":true}')).toBe('exists');
      expect(internals.getSessionBranchFileStatus).toHaveBeenCalledWith(REPO_PATH, 'main');
    });

    it('409 with file absent → retry; if retry succeeds, return created (t/181)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'absent' });
      request.mockResolvedValueOnce({ ok: true, status: 201, data: { content: { sha: 'new' } } });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{"v":1}')).toBe('created');
      // Verify retry was called (2 REST requests total: initial + retry)
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('409 with file absent → retry; if retry also fails with 409, throw (t/181)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'absent' });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONCURRENT_WRITE' }));
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('409 with file unavailable status → throws (cannot verify, fail closed)', async () => {
      const { backend, internals, request } = makeBackend({ session: false });
      request.mockResolvedValueOnce({ ok: false, status: 409, data: null, error: 'Conflict' });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValueOnce({ kind: 'unavailable' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow(expect.objectContaining({ code: 'GITHUB_CONFLICT_UNRESOLVED' }));
    });
  });

  describe('session-overlay path', () => {
    it('absent on overlay and branch → staged, created; a second create → exists without a re-stage', async () => {
      const { backend, internals } = makeBackend({ session: true });
      const overlay = new Map<string, string>();
      internals.checkSessionOverlay = (p: string) => overlay.get(p);
      internals.writeToOverlay = vi.fn((_f: string, c: string) => { overlay.set(REPO_PATH, c); });
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValue({ kind: 'absent' });
      internals.recordOverlayBaseShaOnce = vi.fn();

      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{"v":1}')).toBe('created');
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{"v":2}')).toBe('exists');
      expect(internals.writeToOverlay).toHaveBeenCalledTimes(1);
      expect(overlay.get(REPO_PATH)).toBe('{"v":1}');
    });

    it('present on the session branch → exists, nothing staged', async () => {
      const { backend, internals } = makeBackend({ session: true });
      internals.checkSessionOverlay = () => undefined;
      internals.writeToOverlay = vi.fn();
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValue({ kind: 'present', content: '{}', sha: 's1' });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('exists');
      expect(internals.writeToOverlay).not.toHaveBeenCalled();
    });

    it('a same-process create that lands during the branch lookup wins; this call → exists (t/4187 re-check)', async () => {
      const { backend, internals } = makeBackend({ session: true });
      let staged: string | undefined;
      internals.checkSessionOverlay = () => staged;
      internals.writeToOverlay = vi.fn();
      internals.getSessionBranchFileStatus = vi.fn(async () => { staged = '{"other":true}'; return { kind: 'absent' }; });
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('exists');
      expect(internals.writeToOverlay).not.toHaveBeenCalled();
    });

    it('a tombstone (deleted this session) counts as absent → created', async () => {
      const { backend, internals } = makeBackend({ session: true });
      internals.checkSessionOverlay = () => GitHubAPIBackend.TOMBSTONE;
      internals.writeToOverlay = vi.fn();
      internals.getSessionBranchFileStatus = vi.fn();
      expect(await backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).toBe('created');
      expect(internals.getSessionBranchFileStatus).not.toHaveBeenCalled();
    });

    it('branch status unavailable → throws (unknown is not absent)', async () => {
      const { backend, internals } = makeBackend({ session: true });
      internals.checkSessionOverlay = () => undefined;
      internals.writeToOverlay = vi.fn();
      internals.getSessionBranchFileStatus = vi.fn().mockResolvedValue({ kind: 'unavailable' });
      await expect(backend.writeFileIfAbsent('/abs/conflicts/job-1.json', '{}')).rejects.toThrow();
      expect(internals.writeToOverlay).not.toHaveBeenCalled();
    });
  });
});

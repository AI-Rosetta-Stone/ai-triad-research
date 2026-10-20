// @vitest-environment node

/**
 * t/697 — AzureBlobBackend integration tests against Azurite (the Azure Storage
 * emulator). Spawns azurite-blob on the default dev port, connects with the SDK's
 * `UseDevelopmentStorage=true` shorthand (no hardcoded key), and injects that
 * client so the backend exercises the real Blob SDK paths.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { BlobServiceClient, RestError } from '@azure/storage-blob';
import { AzureBlobBackend } from '../storage/azureBlobBackend.js';
import { gitBlobSha } from '../storage/gitBlobSha.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AZURITE_MAIN = path.resolve(here, '../../../node_modules/azurite/dist/src/blob/main.js');
const CONN = 'UseDevelopmentStorage=true'; // SDK maps to 127.0.0.1:10000 + well-known dev key
const USER_CONTENT = 'user-content';
const COMMUNITY = 'community';

let proc: ChildProcess;
let service: BlobServiceClient;
let backend: AzureBlobBackend;
let azuriteDir: string;

async function waitForAzurite(svc: BlobServiceClient, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try { await svc.getProperties(); return; }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error(`Azurite did not become ready: ${String(lastErr)}`);
}

describe('AzureBlobBackend (Azurite)', () => {
  beforeAll(async () => {
    azuriteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azurite-test-'));
    proc = spawn(
      process.execPath,
      // --skipApiVersionCheck: the @azure/storage-blob SDK negotiates a newer
      // API version than this Azurite build whitelists; the flag lets it through.
      [AZURITE_MAIN, '--silent', '--skipApiVersionCheck', '--location', azuriteDir, '--blobHost', '127.0.0.1', '--blobPort', '10000'],
      { stdio: 'ignore' },
    );
    service = BlobServiceClient.fromConnectionString(CONN);
    await waitForAzurite(service);
    await service.getContainerClient(USER_CONTENT).createIfNotExists();
    await service.getContainerClient(COMMUNITY).createIfNotExists();
    backend = new AzureBlobBackend({
      accountUrl: 'http://127.0.0.1:10000/devstoreaccount1',
      userContentContainer: USER_CONTENT,
      communityContainer: COMMUNITY,
      serviceClient: service,
    });
  }, 30000);

  afterAll(async () => {
    if (proc) proc.kill();
    try { fs.rmSync(azuriteDir, { recursive: true, force: true }); } catch { /* emulator may still hold a handle */ }
  });

  it('writeFile + readFile round-trips (user-content)', async () => {
    await backend.writeFile('taxonomy/nodes.json', '{"v":1}');
    expect(await backend.readFile('taxonomy/nodes.json')).toBe('{"v":1}');
  });

  it('readFile returns null for a missing blob (404)', async () => {
    expect(await backend.readFile('taxonomy/missing.json')).toBeNull();
  });

  it('writeFile overwrites an existing blob', async () => {
    await backend.writeFile('taxonomy/ow.json', 'a');
    await backend.writeFile('taxonomy/ow.json', 'b');
    expect(await backend.readFile('taxonomy/ow.json')).toBe('b');
  });

  it('routes community/ paths to the community container, others to user-content', async () => {
    await backend.writeFile('community/_submissions/sub-1.json', '{"id":"1"}');
    await backend.writeFile('taxonomy/t.json', '{"t":1}');

    expect(await service.getContainerClient(COMMUNITY)
      .getBlobClient('community/_submissions/sub-1.json').exists()).toBe(true);
    expect(await service.getContainerClient(USER_CONTENT)
      .getBlobClient('community/_submissions/sub-1.json').exists()).toBe(false);
    expect(await service.getContainerClient(USER_CONTENT)
      .getBlobClient('taxonomy/t.json').exists()).toBe(true);
  });

  it('fileExists reflects presence', async () => {
    await backend.writeFile('taxonomy/exists.json', '{}');
    expect(await backend.fileExists('taxonomy/exists.json')).toBe(true);
    expect(await backend.fileExists('taxonomy/nope.json')).toBe(false);
  });

  it('deleteFile removes a blob and is a no-op on a missing blob', async () => {
    await backend.writeFile('taxonomy/del.json', '{}');
    await backend.deleteFile('taxonomy/del.json');
    expect(await backend.readFile('taxonomy/del.json')).toBeNull();
    await expect(backend.deleteFile('taxonomy/del.json')).resolves.toBeUndefined();
  });

  it('readBinaryFile round-trips bytes (and null on missing)', async () => {
    await backend.writeFile('taxonomy/bin.json', 'héllo wörld');
    const buf = await backend.readBinaryFile('taxonomy/bin.json');
    expect(buf?.toString('utf-8')).toBe('héllo wörld');
    expect(await backend.readBinaryFile('taxonomy/none.json')).toBeNull();
  });

  it('listDirectory returns immediate children (files + subdir segments)', async () => {
    await backend.writeFile('listing/a.json', '1');
    await backend.writeFile('listing/b.json', '2');
    await backend.writeFile('listing/sub/c.json', '3');
    const entries = await backend.listDirectory('listing');
    expect(entries.sort()).toEqual(['a.json', 'b.json', 'sub']);
  });

  it('listDirectory returns [] for an empty/missing prefix', async () => {
    expect(await backend.listDirectory('does/not/exist')).toEqual([]);
  });

  it('listDirectory routes to the community container', async () => {
    await backend.writeFile('community/chats/chat-1.json', '{}');
    expect(await backend.listDirectory('community/chats')).toContain('chat-1.json');
  });

  it('ignores opts.ref (no branches in Blob Storage)', async () => {
    await backend.writeFile('taxonomy/ref.json', 'x', { ref: 'main' });
    expect(await backend.readFile('taxonomy/ref.json', { ref: 'some-branch' })).toBe('x');
  });

  it('rejects path traversal, including sequences that only escape after normalization', async () => {
    await expect(backend.readFile('a/../../etc/passwd')).rejects.toThrow(/unsafe path/i);
    await expect(backend.writeFile('foo/../../bar.json', 'x')).rejects.toThrow(/unsafe path/i);
    await expect(backend.readFile('.git/config')).rejects.toThrow(/unsafe path/i);
  });

  // t/4201 (p/775#31)/t/4191: writeFile's baseSha precondition is now atomic —
  // one download() supplies both the hash check and the If-Match ETag.
  it('writeFile with a matching baseSha (If-Match) succeeds', async () => {
    const v1 = await backend.writeFile('taxonomy/conflict.json', '{"v":1}');
    const v2 = await backend.writeFile('taxonomy/conflict.json', '{"v":2}', { baseSha: v1.version });

    expect(v2.version).toBeTruthy();
    expect(v2.version).not.toBe(v1.version);
    expect(await backend.readFile('taxonomy/conflict.json')).toBe('{"v":2}');
  });

  it('writeFile with a stale baseSha (If-Match) throws WRITE_CONFLICT (409)', async () => {
    const v1 = await backend.writeFile('taxonomy/conflict2.json', '{"v":1}');
    await backend.writeFile('taxonomy/conflict2.json', '{"v":2}', { baseSha: v1.version });

    const err = await backend.writeFile('taxonomy/conflict2.json', '{"lost-update":true}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(await backend.readFile('taxonomy/conflict2.json')).toBe('{"v":2}'); // the stale write never landed
  });

  it('readFileWithVersion returns the same version writeFile just wrote', async () => {
    const written = await backend.writeFile('taxonomy/rfv.json', '{"v":1}');
    const got = await backend.readFileWithVersion!('taxonomy/rfv.json');

    expect(got?.content).toBe('{"v":1}');
    expect(got?.version).toBe(written.version);
  });

  // t/4191 condition 2 (decision site: missing blob while baseSha is supplied).
  it('writeFile with a non-empty baseSha against a missing blob throws WRITE_CONFLICT, never a silent create', async () => {
    const err = await backend.writeFile('taxonomy/never-existed.json', '{"v":1}', { baseSha: 'deadbeef' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(await backend.fileExists('taxonomy/never-existed.json')).toBe(false);
  });

  // t/4191 condition 2 (decision site: baseSha === '' is "I expect no file yet" —
  // enforced via If-None-Match: '*', not an existence check-then-create).
  it('writeFile with baseSha "" creates atomically when the blob is absent', async () => {
    const result = await backend.writeFile('taxonomy/fresh.json', '{"v":1}', { baseSha: '' });
    expect(await backend.readFile('taxonomy/fresh.json')).toBe('{"v":1}');
    expect(result.version).toBeTruthy();
  });

  it('writeFile with baseSha "" throws WRITE_CONFLICT when the blob already exists', async () => {
    await backend.writeFile('taxonomy/already-there.json', '{"v":1}');
    const err = await backend.writeFile('taxonomy/already-there.json', '{"v":2}', { baseSha: '' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(await backend.readFile('taxonomy/already-there.json')).toBe('{"v":1}');
  });

  // t/4191 condition 2's core case: a write that lands strictly BETWEEN this
  // backend's download() and its own upload() — the race a sequencing-only
  // (two parallel promises) test can't reliably force on Azurite, and the race
  // the old check-then-write design (separate read, then unconditional upload)
  // could not detect at all. Instruments the blob client so the first download()
  // of the target path injects a concurrent write before returning, simulating
  // a second tab/replica that commits in the gap. Fails on pre-t/4191 code
  // (which read, hashed, matched, then uploaded unconditionally — silently
  // clobbering the injected write); passes once If-Match is drawn from that
  // same download() response, because the ETag it captured is already stale
  // by the time the real upload reaches the service.
  it('writeFile detects a write injected between its own read and its own upload (t/4191)', async () => {
    const blobPath = 'taxonomy/injected-race.json';
    const v1 = await backend.writeFile(blobPath, '{"v":1}');

    const realContainer = service.getContainerClient(USER_CONTENT);
    let injectedOnce = false;
    const instrumentedService = {
      getContainerClient: (name: string) => {
        if (name !== USER_CONTENT) return service.getContainerClient(name);
        return {
          getBlobClient: (p: string) => {
            const real = realContainer.getBlobClient(p);
            if (p !== blobPath) return real;
            return {
              ...real,
              download: async (...args: unknown[]) => {
                if (!injectedOnce) {
                  injectedOnce = true;
                  // The "other actor": lands a real, unconditional write to the
                  // same blob before this backend's own download() resolves.
                  const data = Buffer.from('{"v":2,"from":"other-actor"}', 'utf-8');
                  await realContainer.getBlockBlobClient(blobPath).upload(data, data.byteLength);
                }
                return real.download(...args);
              },
            };
          },
          getBlockBlobClient: (p: string) => realContainer.getBlockBlobClient(p),
          listBlobsByHierarchy: realContainer.listBlobsByHierarchy.bind(realContainer),
        };
      },
    } as unknown as BlobServiceClient;

    const racing = new AzureBlobBackend({
      accountUrl: 'http://127.0.0.1:10000/devstoreaccount1',
      userContentContainer: USER_CONTENT,
      communityContainer: COMMUNITY,
      serviceClient: instrumentedService,
    });

    const err = await racing.writeFile(blobPath, '{"stale-tab-write":true}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(await backend.readFile(blobPath)).toBe('{"v":2,"from":"other-actor"}'); // the injected write survived
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD TIMEOUT (t/1469) — mocked client, no Azurite required
// ═══════════════════════════════════════════════════════════════════════════

describe('AzureBlobBackend — upload timeout (t/1469)', () => {
  function stalledBackend(uploadTimeoutMs: number): AzureBlobBackend {
    const neverResolve = () => new Promise<void>(() => {});
    const mockBlockBlob = {
      upload: (_data: unknown, _len: unknown, opts?: { abortSignal?: AbortSignal }) =>
        new Promise<void>((_, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };
    const mockContainer = {
      getBlockBlobClient: () => mockBlockBlob,
      getBlobClient: () => ({ download: neverResolve, exists: neverResolve, delete: neverResolve }),
      listBlobsByHierarchy: () => (async function* () {})(),
    };
    const mockService = {
      getContainerClient: () => mockContainer,
    } as unknown as BlobServiceClient;

    return new AzureBlobBackend({
      accountUrl: 'http://localhost:10000/devstoreaccount1',
      userContentContainer: 'user-content',
      communityContainer: 'community',
      serviceClient: mockService,
      uploadTimeoutMs,
    });
  }

  it('writeFile rejects with 503 ActionableError on upload timeout', async () => {
    const be = stalledBackend(50);
    const err: Error & { statusCode?: number } = await be.writeFile('debates/test.json', '{}')
      .then(() => { throw new Error('should have rejected'); })
      .catch((e: Error) => e);

    expect(err.name).toBe('ActionableError');
    expect((err as { statusCode?: number }).statusCode).toBe(503);
    expect(err.message).toMatch(/timed out/i);
  }, 5000);

  it('writeBinaryFile rejects with 503 ActionableError on upload timeout', async () => {
    const be = stalledBackend(50);
    const err: Error & { statusCode?: number } = await be.writeBinaryFile('debates/test.bin', Buffer.from('data'))
      .then(() => { throw new Error('should have rejected'); })
      .catch((e: Error) => e);

    expect(err.name).toBe('ActionableError');
    expect((err as { statusCode?: number }).statusCode).toBe(503);
    expect(err.message).toMatch(/timed out/i);
  }, 5000);
});

// ═══════════════════════════════════════════════════════════════════════════
// WRITE PRECONDITIONS (t/4191) — non-412 passthrough, mocked client
// ═══════════════════════════════════════════════════════════════════════════

describe('AzureBlobBackend — writeFile precondition error mapping (t/4191)', () => {
  // t/4191 condition 2 (decision site: non-412 error is rethrown unmapped, not
  // folded into WRITE_CONFLICT). A download() returning real content (so the
  // baseSha check passes and the upload is attempted) followed by an upload
  // rejecting with an unrelated 503 must surface as the ordinary wrapped error,
  // not a 409.
  it('a non-412 RestError from upload is rethrown, not mapped to WRITE_CONFLICT', async () => {
    const content = '{"v":1}';
    const serverErr = Object.assign(new RestError('service unavailable'), { statusCode: 503, code: 'ServerBusy' });
    const mockBlockBlob = {
      upload: () => Promise.reject(serverErr),
    };
    const mockBlobClient = {
      download: () => Promise.resolve({
        readableStreamBody: undefined, // streamToBuffer(undefined) -> empty; content below is irrelevant to this test
        etag: '"mock-etag"',
      }),
    };
    const mockContainer = {
      getBlockBlobClient: () => mockBlockBlob,
      getBlobClient: () => mockBlobClient,
    };
    const mockService = { getContainerClient: () => mockContainer } as unknown as BlobServiceClient;
    const be = new AzureBlobBackend({
      accountUrl: 'http://localhost:10000/devstoreaccount1',
      userContentContainer: 'user-content',
      communityContainer: 'community',
      serviceClient: mockService,
    });

    // The mocked download() returns no body, so its hashed content is ''
    // (streamToBuffer(undefined) -> empty). Passing that as baseSha makes the
    // pre-upload hash check pass, so the upload is actually attempted — what's
    // under test is the upload-time error mapping below, not the hash check.
    const err = await be.writeFile('taxonomy/x.json', content, { baseSha: gitBlobSha('') })
      .then(() => null, (e: unknown) => e) as { name?: string; code?: string; httpStatus?: number } | null;

    expect(err?.code).not.toBe('WRITE_CONFLICT');
    expect(err?.httpStatus).not.toBe(409);
    expect(err?.name).toBe('ActionableError');
  });

  // TL p/538#111: an empty/missing ETag on a successful download must never
  // fall through to an unconditional upload (the SDK may drop an empty
  // If-Match, silently reopening the overwrite this PR exists to close).
  // Fail closed instead — 409, and the upload is never attempted at all.
  it('a download with a matching baseSha but no ETag fails closed (409), never uploads unconditionally', async () => {
    const content = '{"v":1}';
    let uploadCalled = false;
    const mockBlockBlob = {
      upload: () => { uploadCalled = true; return Promise.resolve(); },
    };
    const mockBlobClient = {
      download: () => Promise.resolve({
        readableStreamBody: undefined, // hashes to gitBlobSha('')
        etag: undefined, // the anomalous case under test
      }),
    };
    const mockContainer = {
      getBlockBlobClient: () => mockBlockBlob,
      getBlobClient: () => mockBlobClient,
    };
    const mockService = { getContainerClient: () => mockContainer } as unknown as BlobServiceClient;
    const be = new AzureBlobBackend({
      accountUrl: 'http://localhost:10000/devstoreaccount1',
      userContentContainer: 'user-content',
      communityContainer: 'community',
      serviceClient: mockService,
    });

    const err = await be.writeFile('taxonomy/no-etag.json', content, { baseSha: gitBlobSha('') })
      .then(() => null, (e: unknown) => e) as { code?: string; httpStatus?: number } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(uploadCalled).toBe(false);
  });
});

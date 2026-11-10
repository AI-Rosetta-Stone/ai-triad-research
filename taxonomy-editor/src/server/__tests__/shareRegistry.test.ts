// @vitest-environment node
//
// t/117 (t/4937 follow-up) — updateShareRegistry: compare-and-swap with bounded retry on
// WRITE_CONFLICT. The fake backend enforces `baseSha` the way FilesystemBackend/AzureBlobBackend
// do (git blob SHA, '' = absent), and `beforeWrite` lets a test land a concurrent write between
// the helper's read and its write.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { serverWarn } = vi.hoisted(() => ({ serverWarn: vi.fn() }));
vi.mock('../logger.js', () => ({
  log: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    server: { info: vi.fn(), warn: serverWarn, error: vi.fn(), debug: vi.fn() },
  },
  getRequestId: () => 'req-test',
  LOG_MAX_LINE_BYTES: 65536,
  writeFramedNdjson: vi.fn(),
}));

import { gitBlobSha } from '../storage/gitBlobSha.js';
import { updateShareRegistry, REGISTRY_CAS_MAX_ATTEMPTS } from '../storage/shareRegistry.js';
import type { StorageBackend } from '../storage/storageBackend.js';

const REG = '/data/users/owner-1/inquiry-shares.json';
const files = new Map<string, string>();
const hooks: { beforeWrite?: (p: string) => Promise<void> } = {};
const writes: { path: string; baseSha?: string }[] = [];

function versionOf(p: string): string {
  return files.has(p) ? gitBlobSha(files.get(p)!) : '';
}
const backend = {
  backendName: 'fake',
  async readFile(p: string) { return files.get(p) ?? null; },
  async readFileWithVersion(p: string) { return files.has(p) ? { content: files.get(p)!, version: versionOf(p) } : null; },
  async writeFile(p: string, content: string, opts?: { baseSha?: string }) {
    writes.push({ path: p, baseSha: opts?.baseSha });
    await hooks.beforeWrite?.(p);
    if (opts?.baseSha !== undefined && versionOf(p) !== opts.baseSha) {
      throw Object.assign(new Error('conflict'), { code: 'WRITE_CONFLICT' });
    }
    files.set(p, content);
    return { version: gitBlobSha(content) };
  },
  async deleteFile(p: string) { files.delete(p); },
  async listDirectory() { return []; },
  async fileExists(p: string) { return files.has(p); },
  async readBinaryFile() { return null; },
  async writeBinaryFile() { /* unused */ },
} as unknown as StorageBackend;

const conflictWarns = () => serverWarn.mock.calls.filter(c => c[0]?.cause === 'share-registry-write-conflict');
const addB = (r: Record<string, string>) => { r.B = 's2'; return { changed: true, result: 'added' }; };

describe('updateShareRegistry (t/117)', () => {
  beforeEach(() => {
    files.clear();
    writes.length = 0;
    delete hooks.beforeWrite;
    serverWarn.mockClear();
  });

  it('no conflict: one conditional write carrying the read version, no WARN', async () => {
    files.set(REG, JSON.stringify({ A: 's1' }));
    const v = versionOf(REG);
    expect(await updateShareRegistry(backend, REG, 'inquiry', addB)).toBe('added');
    expect(JSON.parse(files.get(REG)!)).toEqual({ A: 's1', B: 's2' });
    expect(writes).toEqual([{ path: REG, baseSha: v }]);
    expect(conflictWarns()).toHaveLength(0);
  });

  it('absent registry: creates it with baseSha \'\' (create only if still absent)', async () => {
    await updateShareRegistry(backend, REG, 'inquiry', addB);
    expect(writes).toEqual([{ path: REG, baseSha: '' }]);
    expect(JSON.parse(files.get(REG)!)).toEqual({ B: 's2' });
  });

  it('conflict: a concurrent unpublish(A) lands mid-update — retried on a fresh read, A is NOT re-added', async () => {
    files.set(REG, JSON.stringify({ A: 's1' }));
    hooks.beforeWrite = async () => {
      delete hooks.beforeWrite;
      files.set(REG, JSON.stringify({})); // unpublish(A) wins the race
    };
    await updateShareRegistry(backend, REG, 'inquiry', addB);
    expect(JSON.parse(files.get(REG)!)).toEqual({ B: 's2' });
    expect(writes).toHaveLength(2);
    expect(conflictWarns()).toHaveLength(1);
  });

  it('unchanged mutation writes nothing', async () => {
    files.set(REG, JSON.stringify({ A: 's1' }));
    expect(await updateShareRegistry(backend, REG, 'inquiry', () => ({ changed: false, result: 'noop' }))).toBe('noop');
    expect(writes).toHaveLength(0);
  });

  it(`gives up after ${REGISTRY_CAS_MAX_ATTEMPTS} conflicts with an ActionableError (409 WRITE_CONFLICT), registry untouched`, async () => {
    files.set(REG, JSON.stringify({ A: 's1' }));
    let n = 0;
    hooks.beforeWrite = async () => { files.set(REG, JSON.stringify({ A: 's1', other: String(++n) })); };
    const err = await updateShareRegistry(backend, REG, 'inquiry', addB).catch(e => e);
    expect(err).toMatchObject({ code: 'WRITE_CONFLICT', httpStatus: 409 });
    expect(String(err.message)).toContain(`${REGISTRY_CAS_MAX_ATTEMPTS}`);
    expect(writes).toHaveLength(REGISTRY_CAS_MAX_ATTEMPTS);
    expect(JSON.parse(files.get(REG)!).B).toBeUndefined();
    expect(conflictWarns()).toHaveLength(REGISTRY_CAS_MAX_ATTEMPTS);
  });

  it('a non-conflict write error is rethrown at once, not retried', async () => {
    hooks.beforeWrite = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
    await expect(updateShareRegistry(backend, REG, 'inquiry', addB)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(writes).toHaveLength(1);
    expect(conflictWarns()).toHaveLength(0);
  });
});

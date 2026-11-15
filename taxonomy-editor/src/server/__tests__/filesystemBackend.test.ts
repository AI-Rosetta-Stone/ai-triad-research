// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * FilesystemBackend write-precondition tests (t/4201, p/775#31). Versions local
 * content by its git blob SHA (gitBlobSha) and enforces `opts.baseSha` on writeFile
 * as a check-then-write precondition — not atomic, but sufficient for this
 * backend's single-node local-web path (Electron/dev). Real disk I/O against a
 * temp directory; no mocking needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';

let dir: string;
let backend: FilesystemBackend;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-backend-test-'));
  backend = new FilesystemBackend({ root: dir });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('FilesystemBackend — write-precondition (t/4201)', () => {
  it('writeFile with a matching baseSha (If-Match) succeeds', async () => {
    const file = path.join(dir, 'conflict.json');
    const v1 = await backend.writeFile(file, '{"v":1}');
    const v2 = await backend.writeFile(file, '{"v":2}', { baseSha: v1.version });

    expect(v2.version).toBeTruthy();
    expect(v2.version).not.toBe(v1.version);
    expect(await backend.readFile(file)).toBe('{"v":2}');
  });

  it('writeFile with a stale baseSha (If-Match) throws WRITE_CONFLICT (409)', async () => {
    const file = path.join(dir, 'conflict2.json');
    const v1 = await backend.writeFile(file, '{"v":1}');
    await backend.writeFile(file, '{"v":2}', { baseSha: v1.version });

    const err = await backend.writeFile(file, '{"lost-update":true}', { baseSha: v1.version })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
    expect(await backend.readFile(file)).toBe('{"v":2}'); // the stale write never landed
  });

  it('writeFile with no baseSha skips the precondition entirely', async () => {
    const file = path.join(dir, 'nobase.json');
    await backend.writeFile(file, '{"v":1}');
    const result = await backend.writeFile(file, '{"v":2}'); // no opts — direct fileIO caller
    expect(result.version).toBeTruthy();
    expect(await backend.readFile(file)).toBe('{"v":2}');
  });

  it('readFileWithVersion returns the same version writeFile just wrote', async () => {
    const file = path.join(dir, 'rfv.json');
    const written = await backend.writeFile(file, '{"v":1}');
    const got = await backend.readFileWithVersion(file);

    expect(got?.content).toBe('{"v":1}');
    expect(got?.version).toBe(written.version);
  });

  it('baseSha against a nonexistent file is a conflict (empty current hash never matches)', async () => {
    const file = path.join(dir, 'missing.json');
    const err = await backend.writeFile(file, '{"v":1}', { baseSha: 'deadbeef' })
      .then(() => null, (e: unknown) => e) as { httpStatus?: number; code?: string } | null;

    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe('WRITE_CONFLICT');
  });
});

describe('FilesystemBackend — concurrent conditional writes are serialized (t/117)', () => {
  it('two same-process writers with the same baseSha: exactly one lands, the other gets WRITE_CONFLICT', async () => {
    const file = path.join(dir, 'registry.json');
    const v1 = await backend.writeFile(file, '{"A":"s1"}');

    const results = await Promise.allSettled([
      backend.writeFile(file, '{}', { baseSha: v1.version }),
      new FilesystemBackend({ root: dir }).writeFile(file, '{"A":"s1","B":"s2"}', { baseSha: v1.version }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBe('WRITE_CONFLICT');
    // The winner is whichever write acquired the lock first (order is not guaranteed now that
    // both writers confine their path first); the loser must not have overwritten it.
    const winner = results.findIndex(r => r.status === 'fulfilled');
    expect(await backend.readFile(file)).toBe(winner === 0 ? '{}' : '{"A":"s1","B":"s2"}');
  });

  it('two same-process "create only if absent" writers (baseSha \'\'): exactly one creates the file', async () => {
    const file = path.join(dir, 'fresh.json');
    const results = await Promise.allSettled([
      backend.writeFile(file, '{"A":"s1"}', { baseSha: '' }),
      backend.writeFile(file, '{"B":"s2"}', { baseSha: '' }),
    ]);
    // Exactly one creates the file; which one is not guaranteed now that each confines its path first.
    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const winner = results.findIndex(r => r.status === 'fulfilled');
    expect(await backend.readFile(file)).toBe(winner === 0 ? '{"A":"s1"}' : '{"B":"s2"}');
  });

  it('chained writers that each carry the previous version all land (no false conflict)', async () => {
    const file = path.join(dir, 'chain.json');
    let version = '';
    for (let i = 1; i <= 3; i++) {
      version = (await backend.writeFile(file, `{"v":${i}}`, { baseSha: version })).version;
    }
    expect(await backend.readFile(file)).toBe('{"v":3}');
  });

  it('a rejected conditional write does not block later writes to the same path', async () => {
    const file = path.join(dir, 'after-reject.json');
    await expect(backend.writeFile(file, '{"v":1}', { baseSha: 'stale' })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
    await expect(backend.writeFile(file, '{"v":1}', { baseSha: '' })).resolves.toMatchObject({ version: expect.any(String) });
  });
});

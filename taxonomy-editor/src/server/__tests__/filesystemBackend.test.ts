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
  backend = new FilesystemBackend();
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

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/268 items 1 and 2 (TL review of #4898): FilesystemBackend.writeFileIfAbsent failure paths.
 * 1. The 'wx' fallback (no hard links) must not leave a truncated file when the write fails partway:
 *    every later call would report 'exists' for it.
 * 2. A failed mkdir or temp-file write must surface as an ActionableError, with a recorder event,
 *    not as a raw errno error.
 * Real files in an fs.mkdtemp directory; single fs calls are made to fail with vi.spyOn.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';
import { ActionableError } from '../../../../lib/debate/errors.js';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated`), { code });

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fs-create-errors-')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Make hard links unsupported, so createExclusive takes the 'wx' fallback. */
function noHardLinks(): void {
  vi.spyOn(fs, 'link').mockRejectedValue(errno('EPERM'));
}

/** The 'wx' open succeeds (the file now exists), then the write fails partway, as ENOSPC does.
 *  Both forms of the exclusive create are covered, so the same cases run against the code before the fix
 *  (one fs.writeFile with flag 'wx') and after it (fs.open 'wx', then a write on the handle). */
function failWriteAfterOpen(): void {
  const realWriteFile = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation((async (p: unknown, data: unknown, opts: unknown) => {
    if ((opts as { flag?: string } | undefined)?.flag === 'wx') {
      await realWriteFile(p as string, '{"trunc', { encoding: 'utf-8', flag: 'wx' });
      throw errno('ENOSPC');
    }
    return realWriteFile(p as string, data as string, opts as never);
  }) as unknown as typeof fs.writeFile);
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation((async (p: unknown, flags: unknown, mode: unknown) => {
    const handle = await realOpen(p as string, flags as string, mode as number | undefined);
    if (flags === 'wx') {
      handle.writeFile = (async () => {
        await handle.write('{"trunc'); // a partial write reaches the disk before the failure
        throw errno('ENOSPC');
      }) as typeof handle.writeFile;
    }
    return handle;
  }) as unknown as typeof fs.open);
}

describe("FilesystemBackend.writeFileIfAbsent: the 'wx' fallback removes a partial file (t/268 item 1)", () => {
  it('a write that fails after the exclusive open throws, and leaves no file behind', async () => {
    noHardLinks();
    failWriteAfterOpen();
    const file = path.join(dir, 'job-a.json');
    await expect(new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, '{"ok":true}')).rejects.toBeInstanceOf(ActionableError);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("the next call creates the file; it is not told 'exists' for a truncated one", async () => {
    noHardLinks();
    failWriteAfterOpen();
    const backend = new FilesystemBackend({ root: dir });
    const file = path.join(dir, 'job-b.json');
    await expect(backend.writeFileIfAbsent(file, '{"ok":true}')).rejects.toThrow();

    vi.restoreAllMocks();
    noHardLinks();
    await expect(backend.writeFileIfAbsent(file, '{"ok":true}')).resolves.toBe('created');
    expect(await fs.readFile(file, 'utf-8')).toBe('{"ok":true}');
  });

  it("an existing file is reported as 'exists' and is never removed", async () => {
    noHardLinks();
    const file = path.join(dir, 'job-c.json');
    await fs.writeFile(file, 'ORIGINAL');
    await expect(new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, 'NEW')).resolves.toBe('exists');
    expect(await fs.readFile(file, 'utf-8')).toBe('ORIGINAL');
  });

  it('when the exclusive open itself fails, nothing is removed: a file another writer made stays', async () => {
    noHardLinks();
    const file = path.join(dir, 'job-d.json');
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation((async (p: unknown, flags: unknown, mode: unknown) => {
      if (flags === 'wx') {
        // Another process creates the file, and our open fails for an unrelated reason.
        await fs.writeFile(file, 'THEIRS');
        throw errno('EACCES');
      }
      return realOpen(p as string, flags as string, mode as number | undefined);
    }) as unknown as typeof fs.open);
    await expect(new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, 'OURS')).rejects.toBeInstanceOf(ActionableError);
    expect(await fs.readFile(file, 'utf-8')).toBe('THEIRS');
  });

  it("control: the 'wx' fallback creates the file with its content", async () => {
    noHardLinks();
    const file = path.join(dir, 'job-e.json');
    await expect(new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, '{"ok":true}')).resolves.toBe('created');
    expect(await fs.readFile(file, 'utf-8')).toBe('{"ok":true}');
    expect(await fs.readdir(dir)).toEqual(['job-e.json']);
  });
});

describe('FilesystemBackend.writeFileIfAbsent: mkdir and temp-write failures are ActionableErrors (t/268 item 2)', () => {
  it('a failed mkdir throws an ActionableError that names the step and the errno', async () => {
    vi.spyOn(fs, 'mkdir').mockRejectedValue(errno('EACCES'));
    const file = path.join(dir, 'sub', 'job-f.json');
    const err = await new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, '{}').catch(e => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(String((err as Error).message)).toContain('mkdir failed with EACCES');
  });

  it('a failed temp-file write throws an ActionableError, and leaves neither the temp file nor the target', async () => {
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation((async (p: unknown, data: unknown, opts: unknown) => {
      if (String(p).endsWith('.create-tmp')) {
        await realWrite(p as string, 'partial', 'utf-8'); // the temp file exists, half-written
        throw errno('ENOSPC');
      }
      return realWrite(p as string, data as string, opts as never);
    }) as unknown as typeof fs.writeFile);
    const file = path.join(dir, 'job-g.json');
    const err = await new FilesystemBackend({ root: dir }).writeFileIfAbsent(file, '{}').catch(e => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(String((err as Error).message)).toContain('temp-file write failed with ENOSPC');
    expect(await fs.readdir(dir)).toEqual([]);
  });
});

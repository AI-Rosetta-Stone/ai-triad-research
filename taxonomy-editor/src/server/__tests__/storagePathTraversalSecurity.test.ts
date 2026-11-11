// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Path confinement tests for FilesystemBackend (t/223). Every target is inside an
 * fs.mkdtemp directory: the backend root is `<tmp>/a/b/root`, so even `../../..` escapes land
 * in `<tmp>` and a regressed guard writes only there, never to the machine or the repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';

let tmp: string;
let root: string;
let backend: FilesystemBackend;

const exists = (p: string) => fs.lstat(p).then(() => true, () => false);

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  return p.then(() => undefined, (e: unknown) => (e as { code?: string }).code);
}

/** Every file under `dir`, relative, so a test can assert nothing new appeared. */
async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(path.relative(tmp, full));
    if (e.isDirectory()) out.push(...(await listAll(full)));
  }
  return out.sort();
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'path-confine-')));
  root = path.join(tmp, 'a', 'b', 'root');
  await fs.mkdir(root, { recursive: true });
  backend = new FilesystemBackend({ root });
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('FilesystemBackend root confinement (t/223)', () => {
  it('allows absolute and relative paths inside the root', async () => {
    const abs = path.join(root, 'sub', 'safe.txt');
    await backend.writeFile(abs, 'one');
    expect(await backend.readFile(abs)).toBe('one');

    // Relative paths resolve against the root, never the cwd.
    await backend.writeFile('rel.txt', 'two');
    expect(await fs.readFile(path.join(root, 'rel.txt'), 'utf-8')).toBe('two');
    expect(await backend.fileExists('rel.txt')).toBe(true);
    expect(await backend.listDirectory('.')).toContain('rel.txt');
  });

  it('allows a name containing ".." that is not a traversal segment', async () => {
    await backend.writeFile(path.join(root, 'foo..json'), 'ok');
    expect(await backend.readFile(path.join(root, 'foo..json'))).toBe('ok');
  });

  it('allows the root itself', async () => {
    expect(await backend.listDirectory(root)).toEqual([]);
  });

  const escapes: Array<[string, () => string]> = [
    ['relative ..', () => '../escape.txt'],
    ['join(root, .., ..) form', () => path.join(root, '..', '..', 'escape.txt')],
    ['nested .. that normalises out', () => path.join('data', '..', '..', '..', 'escape.txt')],
    ['absolute outside root', () => path.join(tmp, 'escape.txt')],
    ['sibling sharing the root name prefix', () => path.join(`${root}-evil`, 'escape.txt')],
  ];

  for (const [label, target] of escapes) {
    describe(label, () => {
      it('is refused by every method and creates nothing', async () => {
        const before = await listAll(tmp);
        const t = target();
        const results = await Promise.all([
          codeOf(backend.writeFile(t, 'attack')),
          codeOf(backend.writeFile(t, 'attack', { baseSha: '' })),
          codeOf(backend.writeFileIfAbsent(t, 'attack')),
          codeOf(backend.writeBinaryFile(t, Buffer.from('attack'))),
          codeOf(backend.readFile(t)),
          codeOf(backend.readBinaryFile(t)),
          codeOf(backend.readFileWithVersion(t)),
          codeOf(backend.deleteFile(t)),
          codeOf(backend.listDirectory(t)),
          codeOf(backend.fileExists(t)),
        ]);
        expect(results).toEqual(Array(10).fill('PATH_OUTSIDE_ROOT'));
        expect(await listAll(tmp)).toEqual(before);
        expect(await exists(path.join(tmp, 'escape.txt'))).toBe(false);
        expect(await exists(path.join(tmp, 'a', 'escape.txt'))).toBe(false);
      });
    });
  }

  it('does not delete an existing file outside the root', async () => {
    const victim = path.join(tmp, 'victim.txt');
    await fs.writeFile(victim, 'keep');
    expect(await codeOf(backend.deleteFile(victim))).toBe('PATH_OUTSIDE_ROOT');
    expect(await fs.readFile(victim, 'utf-8')).toBe('keep');
  });

  it('refuses a symlink/junction inside the root that points outside', async () => {
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await codeOf(backend.writeFile(path.join(root, 'link', 'escape.txt'), 'attack'))).toBe('PATH_OUTSIDE_ROOT');
    expect(await codeOf(backend.writeBinaryFile('link/escape.bin', Buffer.from('attack')))).toBe('PATH_OUTSIDE_ROOT');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('matches the root case-insensitively on win32 only', async () => {
    const swapped = root.replace(/root$/, 'ROOT');
    const code = await codeOf(backend.writeFile(path.join(swapped, 'case.txt'), 'x'));
    if (process.platform === 'win32') expect(code).toBeUndefined();
    else expect(code).toBe('PATH_OUTSIDE_ROOT');
  });
});

describe('FilesystemBackend without a root (existing callers)', () => {
  it('does not confine paths', async () => {
    const unrooted = new FilesystemBackend();
    const file = path.join(tmp, 'unrooted.txt');
    await unrooted.writeFile(file, 'content');
    expect(await unrooted.readFile(file)).toBe('content');
  });
});

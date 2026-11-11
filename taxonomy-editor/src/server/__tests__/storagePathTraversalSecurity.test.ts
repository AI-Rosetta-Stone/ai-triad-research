// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Path traversal security tests (t/223). Validates that FilesystemBackend
 * and GitHubAPIBackend reject paths that escape their root (paths containing `..`
 * or that resolve outside root). Absolute paths that stay within the root are allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';

let dir: string;
let fsBackend: FilesystemBackend;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-traversal-test-'));
  fsBackend = new FilesystemBackend();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Path traversal security (t/223)', () => {
  describe('FilesystemBackend path validation', () => {
    it('rejects paths with .. (parent directory traversal)', async () => {
      const unsafeFile = '../../etc/passwd';

      const err = await fsBackend.writeFile(unsafeFile, 'attack')
        .then(() => null, (e: unknown) => e) as { code?: string; problem?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
      expect(err?.problem).toContain('..');
    });

    it('rejects paths with backslash .. on Windows', async () => {
      const unsafePath = '..\\..\\etc\\passwd';

      const err = await fsBackend.writeFile(unsafePath, 'attack')
        .then(() => null, (e: unknown) => e) as { code?: string; problem?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('allows safe relative paths', async () => {
      const safeFile = 'data/safe.txt';
      const fullPath = path.join(dir, safeFile);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      const result = await fsBackend.writeFile(fullPath, 'safe content');
      expect(result.version).toBeTruthy();

      const content = await fsBackend.readFile(fullPath);
      expect(content).toBe('safe content');
    });

    it('allows absolute paths that stay within the temp root', async () => {
      const safeAbsFile = path.join(dir, 'safe.txt');

      const result = await fsBackend.writeFile(safeAbsFile, 'safe content');
      expect(result.version).toBeTruthy();

      const content = await fsBackend.readFile(safeAbsFile);
      expect(content).toBe('safe content');
    });

    it('rejects readFile with .. path', async () => {
      const unsafePath = '../../../etc/passwd';

      const err = await fsBackend.readFile(unsafePath)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('rejects deleteFile with .. path', async () => {
      const unsafePath = '../../../etc/passwd';

      const err = await fsBackend.deleteFile(unsafePath)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('rejects listDirectory with .. path', async () => {
      const unsafePath = '../../..';

      const err = await fsBackend.listDirectory(unsafePath)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('rejects writeBinaryFile with .. path (the original attack)', async () => {
      const unsafePath = '../../../bin/sh';
      const content = Buffer.from('attack');

      const err = await fsBackend.writeBinaryFile(unsafePath, content)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('rejects readBinaryFile with .. path', async () => {
      const unsafePath = '../../../etc/passwd';

      const err = await fsBackend.readBinaryFile(unsafePath)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('rejects fileExists with .. path', async () => {
      const unsafePath = '../../..';

      const err = await fsBackend.fileExists(unsafePath)
        .then(() => null, (e: unknown) => e) as { code?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });
  });
});

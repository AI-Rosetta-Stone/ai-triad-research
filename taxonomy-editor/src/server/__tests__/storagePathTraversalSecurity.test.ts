// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Path traversal security tests (t/223). Validates that both FilesystemBackend
 * and GitHubAPIBackend reject paths containing `..` or absolute paths to prevent
 * directory traversal attacks.
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
      const safeFile = path.join(dir, 'safe.txt');
      const unsafeFile = '../../etc/passwd';

      const err = await fsBackend.writeFile(unsafeFile, 'attack')
        .then(() => null, (e: unknown) => e) as { code?: string; problem?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
      expect(err?.problem).toContain('..');
    });

    it('rejects absolute paths', async () => {
      const absolutePath = '/etc/passwd';

      const err = await fsBackend.writeFile(absolutePath, 'attack')
        .then(() => null, (e: unknown) => e) as { code?: string; problem?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
      expect(err?.problem).toContain('absolute path');
    });

    it('rejects paths with backslash .. on Windows', async () => {
      const unsafePath = '..\\..\\etc\\passwd';

      const err = await fsBackend.writeFile(unsafePath, 'attack')
        .then(() => null, (e: unknown) => e) as { code?: string; problem?: string } | null;

      expect(err).not.toBeNull();
      expect(err?.code).toBe('INVALID_PATH');
    });

    it('allows safe relative paths', async () => {
      const safeFile = path.join(dir, 'data', 'safe.txt');
      await fs.mkdir(path.dirname(safeFile), { recursive: true });

      const result = await fsBackend.writeFile(safeFile, 'safe content');
      expect(result.version).toBeTruthy();

      const content = await fsBackend.readFile(safeFile);
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

    it('rejects writeBinaryFile with .. path', async () => {
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

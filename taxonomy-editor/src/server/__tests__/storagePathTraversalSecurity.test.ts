// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * Path traversal security tests (t/223). Validates that FilesystemBackend
 * rejects paths that escape the backend root. Tests anchor to mkdtemp roots
 * and verify that no files are created outside the root on escape attempts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { FilesystemBackend } from '../storage/filesystemBackend.js';

let dir: string;
let fsBackend: FilesystemBackend;
let parent: string;

beforeEach(async () => {
  // Create temp root and parent directory for escape-attempt detection
  parent = await fs.mkdtemp(path.join(os.tmpdir(), 'path-security-parent-'));
  dir = path.join(parent, 'backend-root');
  await fs.mkdir(dir);
  fsBackend = new FilesystemBackend({ root: dir });
});

afterEach(async () => {
  // Clean up both root and parent
  if (parent) await fs.rm(parent, { recursive: true, force: true });
});

describe('Path traversal security (t/223)', () => {
  describe('FilesystemBackend with root confinement', () => {
    it('allows safe absolute paths within root', async () => {
      const safeFile = path.join(dir, 'safe.txt');
      const result = await fsBackend.writeFile(safeFile, 'safe content');
      expect(result.version).toBeTruthy();

      const content = await fsBackend.readFile(safeFile);
      expect(content).toBe('safe content');

      // Verify file is actually under root
      const fsContent = await fs.readFile(safeFile, 'utf-8');
      expect(fsContent).toBe('safe content');
    });

    it('allows absolute paths inside root', async () => {
      const absPath = path.join(dir, 'safe.txt');
      const result = await fsBackend.writeFile(absPath, 'safe content');
      expect(result.version).toBeTruthy();

      const content = await fsBackend.readFile(absPath);
      expect(content).toBe('safe content');

      // Verify file exists at expected location
      const fsContent = await fs.readFile(absPath, 'utf-8');
      expect(fsContent).toBe('safe content');
    });

    it('rejects paths with .. that escape root', async () => {
      const escapePath = '../escape.txt';
      
      const err = await fsBackend.writeFile(escapePath, 'attack')
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
      
      // Verify no file was created outside root
      const outsidePath = path.join(parent, 'escape.txt');
      const exists = await fs.stat(outsidePath).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    it('rejects multiple .. segments that escape root', async () => {
      const escapePath = '../../escape.txt';
      
      const err = await fsBackend.writeFile(escapePath, 'attack')
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');

      // Verify nothing escaped
      const outside = path.join(parent, 'escape.txt');
      const exists = await fs.stat(outside).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    it('rejects normalized paths with .. that would escape', async () => {
      // Test: path.join(root, 'data', '..', '..', 'escape.txt') should be rejected
      // even though the intermediate join normalizes it
      const escapePath = path.join('data', '..', '..', 'escape.txt');
      
      const err = await fsBackend.writeFile(escapePath, 'attack')
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');

      // Verify nothing escaped
      const outside = path.join(parent, 'escape.txt');
      const exists = await fs.stat(outside).then(() => true, () => false);
      expect(exists).toBe(false);
    });

    it('rejects absolute paths outside root', async () => {
      // On all platforms, reject absolute paths that don't start with root
      const winPath = 'C:\\Windows\\System32\\win.ini';
      const unixPath = '/etc/passwd';
      const testPath = process.platform === 'win32' ? winPath : unixPath;
      
      const err = await fsBackend.writeFile(testPath, 'attack')
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects readFile with .. escape', async () => {
      const escapePath = '../../../etc/passwd';

      const err = await fsBackend.readFile(escapePath)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects deleteFile with .. escape', async () => {
      const escapePath = '../../../etc/passwd';

      const err = await fsBackend.deleteFile(escapePath)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects listDirectory with .. escape', async () => {
      const escapePath = '../../..';

      const err = await fsBackend.listDirectory(escapePath)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects writeBinaryFile with .. escape', async () => {
      const escapePath = '../../../bin/sh';
      const content = Buffer.from('attack');

      const err = await fsBackend.writeBinaryFile(escapePath, content)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');

      // Verify no file was created at machine root /bin/sh or similar
      const binPath = '/bin/sh';
      const exists = await fs.stat(binPath).then(() => true, () => false);
      if (exists) {
        // Check that it wasn't modified by our test (stat and compare mtime)
        const stat = await fs.stat(binPath);
        const mtime = stat.mtimeMs;
        const now = Date.now();
        expect(now - mtime).toBeGreaterThan(1000); // Not modified in last second
      }
    });

    it('rejects readBinaryFile with .. escape', async () => {
      const escapePath = '../../../etc/passwd';

      const err = await fsBackend.readBinaryFile(escapePath)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects fileExists with .. escape', async () => {
      const escapePath = '../../..';

      const err = await fsBackend.fileExists(escapePath)
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });

    it('rejects writeFileIfAbsent with .. escape', async () => {
      const escapePath = '../../../etc/passwd';

      const err = await fsBackend.writeFileIfAbsent(escapePath, 'attack')
        .then(() => null, (e: unknown) => e) as any;

      expect(err).not.toBeNull();
      expect(err.code).toBe('PATH_OUTSIDE_ROOT');
    });
  });

  describe('FilesystemBackend without root (backward compatibility)', () => {
    it('allows any path when no root is configured', async () => {
      const noRootBackend = new FilesystemBackend(); // No root
      const tempFile = path.join(dir, 'test.txt');

      // This should work even with unsafe-looking path
      await noRootBackend.writeFile(tempFile, 'content');
      const content = await noRootBackend.readFile(tempFile);
      expect(content).toBe('content');
    });
  });
});


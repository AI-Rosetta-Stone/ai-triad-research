// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs/promises';
import path from 'path';
import type { StorageBackend } from './storageBackend.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';

/**
 * FilesystemBackend — local disk implementation of StorageBackend.
 *
 * Used by default (Electron + local dev) and in the Azure container when
 * the data volume is mounted.  All methods handle missing files/dirs
 * gracefully (no throws for ENOENT).
 */
export class FilesystemBackend implements StorageBackend {
  readonly backendName = 'filesystem';

  private async renameWithRetry(oldPath: string, newPath: string): Promise<void> {
    const maxRetries = 5;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        await fs.rename(oldPath, newPath);
        return;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code === 'EPERM' || code === 'EACCES') && i < maxRetries) {
          const delayMs = 50 * Math.pow(2, i);
          getGlobalRecorder()?.record({
            type: 'io.retry', component: 'filesystem-backend', level: 'warn',
            message: `rename failed (${code}), retry ${i + 1}/${maxRetries} after ${delayMs}ms`,
            data: { oldPath, newPath, attempt: i + 1, code, delayMs },
          });
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
  }

  async readFile(filePath: string, _opts?: { ref?: string; optional?: boolean }): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'filesystem-backend',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    await this.renameWithRetry(tmpPath, filePath);
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'filesystem-backend',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      // ENOTDIR: path exists but is a file, not a directory
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
      throw err;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'filesystem-backend',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'filesystem-backend', level: 'warn',
          message: 'fileExists: unexpected error from fs.access, treating file as absent',
          data: { filePath, error: String(err) },
        });
      }
      return false;
    }
  }

  async writeBinaryFile(filePath: string, content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content);
    await this.renameWithRetry(tmpPath, filePath);
  }

  /** t/4187: no write-precondition support on local disk — single-user Electron/dev,
   *  no concurrent-editor scenario this fixes. Always a real (not stale) empty version;
   *  writeFile's `opts.baseSha` is ignored. */
  async readFileWithVersion(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null> {
    const content = await this.readFile(filePath, opts);
    return content === null ? null : { content, version: '' };
  }

  async readBinaryFile(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (err: unknown) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'filesystem-backend',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

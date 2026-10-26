// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs/promises';
import path from 'path';
import type { StorageBackend } from './storageBackend.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { gitBlobSha } from './gitBlobSha.js';

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

  /**
   * t/4201 (p/775#31): versions local content by its git blob SHA
   * (gitBlobSha) instead of the empty string this backend used to return —
   * returning `''` meant no `ETag`, so no `If-Match`, so every save on a
   * local web server hit the route's mandatory-428 rule. When `opts.baseSha`
   * is supplied, this is a check-then-write precondition: read the current
   * on-disk content, hash it, and compare before writing. It is NOT atomic
   * (another write can land between the read and the rename below) — that's
   * an accepted gap for a single-node local server (Electron/dev), not the
   * concurrent-replica scenario t/4184 closes for GitHubAPIBackend. Direct
   * fileIO callers that omit `baseSha` skip the check entirely, same as
   * GitHubAPIBackend's no-baseSha fallback.
   */
  async writeFile(filePath: string, content: string, opts?: { ref?: string; baseSha?: string }): Promise<{ version: string }> {
    if (opts?.baseSha !== undefined) {
      const current = await this.readFile(filePath);
      const currentSha = current === null ? '' : gitBlobSha(current);
      if (currentSha !== opts.baseSha) {
        throw new ActionableError({
          goal: `Save ${filePath}`,
          problem: 'The file changed since you loaded it (someone else saved a conflicting change).',
          location: `FilesystemBackend.writeFile(${filePath})`,
          nextSteps: ['Reload the file to see the latest version', 'Re-apply your change and save again'],
          httpStatus: 409,
          code: 'WRITE_CONFLICT',
        });
      }
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    await this.renameWithRetry(tmpPath, filePath);
    return { version: gitBlobSha(content) };
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

  async fileExists(filePath: string, _opts?: { ref?: string }): Promise<boolean> {
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

  /** t/4201 (p/775#31): version is the content's git blob SHA (gitBlobSha), the
   *  same hash writeFile's baseSha precondition checks against. */
  async readFileWithVersion(filePath: string, opts?: { ref?: string }): Promise<{ content: string; version: string } | null> {
    const content = await this.readFile(filePath, opts);
    return content === null ? null : { content, version: gitBlobSha(content) };
  }

  async readBinaryFile(filePath: string, _opts?: { ref?: string }): Promise<Buffer | null> {
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

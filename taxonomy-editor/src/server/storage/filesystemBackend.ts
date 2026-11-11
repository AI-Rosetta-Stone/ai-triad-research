// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StorageBackend, WriteIfAbsentResult } from './storageBackend.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { gitBlobSha } from './gitBlobSha.js';

/** t/223: Validate that a path is relative and does not attempt directory traversal.
 *  Rejects absolute paths and any path containing `..` (forward or backslash).
 *  This prevents both file reads/writes/deletes and directory listing from escaping
 *  the data root. */
function validatePathSafety(filePath: string): void {
  // Reject absolute paths
  if (path.isAbsolute(filePath)) {
    throw new ActionableError({
      goal: 'Validate storage path',
      problem: `Path is absolute, which could escape the data root: ${filePath}`,
      location: 'FilesystemBackend.validatePathSafety',
      nextSteps: ['Use only relative paths within the data root'],
      code: 'INVALID_PATH',
      httpStatus: 400,
    });
  }

  // Reject paths containing `..` (forward and backslash)
  if (filePath.includes('..') || filePath.includes('..\\')) {
    throw new ActionableError({
      goal: 'Validate storage path',
      problem: `Path contains .. (parent directory traversal): ${filePath}`,
      location: 'FilesystemBackend.validatePathSafety',
      nextSteps: ['Use only relative paths within the data root'],
      code: 'INVALID_PATH',
      httpStatus: 400,
    });
  }
}

/** t/223: tail of the in-flight conditional-write chain per absolute path. Module-level so
 *  every FilesystemBackend instance in this process shares it. */
const conditionalWriteTails = new Map<string, Promise<unknown>>();

/** t/117: run `fn` after every earlier conditional write to the same path has settled, so a
 *  `baseSha` check and its rename can't interleave with another conditional write in this
 *  process. Does not cover a second process writing the same directory. */
async function serializeConditionalWrite<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath);
  const run = (conditionalWriteTails.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  conditionalWriteTails.set(key, tail);
  try {
    return await run;
  } finally {
    if (conditionalWriteTails.get(key) === tail) conditionalWriteTails.delete(key);
  }
}

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

  async readFile(filePath: string, _opts?: { ref?: string; optional?: boolean; consultOverlayOnPin?: boolean }): Promise<string | null> {
    validatePathSafety(filePath);
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
   *
   * t/117: conditional writes to one path are serialized in-process, so two
   * concurrent same-process writers (the share registry's compare-and-swap,
   * two tabs on one local server) can't both pass the check — the second sees
   * the first's content and gets WRITE_CONFLICT. A second process writing the
   * same directory is still unguarded.
   */
  async writeFile(filePath: string, content: string, opts?: { ref?: string; baseSha?: string }): Promise<{ version: string }> {
    validatePathSafety(filePath);
    if (opts?.baseSha !== undefined) {
      const baseSha = opts.baseSha;
      return serializeConditionalWrite(filePath, () => this.checkedWrite(filePath, content, baseSha));
    }
    return this.writeUnchecked(filePath, content);
  }

  private async checkedWrite(filePath: string, content: string, baseSha: string): Promise<{ version: string }> {
    const current = await this.readFile(filePath);
    const currentSha = current === null ? '' : gitBlobSha(current);
    if (currentSha !== baseSha) {
      throw new ActionableError({
        goal: `Save ${filePath}`,
        problem: 'The file changed since you loaded it (someone else saved a conflicting change).',
        location: `FilesystemBackend.writeFile(${filePath})`,
        nextSteps: ['Reload the file to see the latest version', 'Re-apply your change and save again'],
        httpStatus: 409,
        code: 'WRITE_CONFLICT',
      });
    }
    return this.writeUnchecked(filePath, content);
  }

  /**
   * t/4216 (t/181): atomic create-only write. The content goes to a unique temp file, which is then
   * hard-linked into place: `link()` fails with EEXIST if the path exists, so creation is atomic
   * across processes (the same O_EXCL guarantee as an `open(..., 'wx')`), and a reader never sees a
   * half-written file. Also joins the t/117 per-path chain, so it serializes with this process's
   * `baseSha` writes. On a filesystem without hard links it falls back to a `'wx'` write (WARN).
   */
  async writeFileIfAbsent(filePath: string, content: string): Promise<WriteIfAbsentResult> {
    validatePathSafety(filePath);
    return serializeConditionalWrite(filePath, () => this.createExclusive(filePath, content));
  }

  private async createExclusive(filePath: string, content: string): Promise<WriteIfAbsentResult> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${randomUUID()}.create-tmp`;
    await fs.writeFile(tmpPath, content, 'utf-8');
    try {
      await fs.link(tmpPath, filePath);
      return 'created';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return 'exists';
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'filesystem-backend', level: 'warn',
          message: `writeFileIfAbsent: hard links unsupported (${code}), falling back to an exclusive 'wx' write: ${filePath}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        return this.createWithExclusiveFlag(filePath, content);
      }
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'filesystem-backend', level: 'error',
        message: `writeFileIfAbsent failed: ${filePath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: `Create ${filePath} only if absent`,
        problem: `link() failed with ${code ?? 'an unknown error'}: ${String(err)}`,
        location: `FilesystemBackend.writeFileIfAbsent(${filePath})`,
        nextSteps: ['Check the data directory is writable', 'Retry the operation'],
        innerError: err,
      });
    } finally {
      await fs.unlink(tmpPath).catch((err) => {
        getGlobalRecorder()?.record({
          type: 'system.error', component: 'filesystem-backend', level: 'warn',
          message: `writeFileIfAbsent: temp file cleanup failed (harmless leftover): ${tmpPath}`,
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      });
    }
  }

  private async createWithExclusiveFlag(filePath: string, content: string): Promise<WriteIfAbsentResult> {
    try {
      await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });
      return 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'filesystem-backend', level: 'error',
        message: `writeFileIfAbsent ('wx' fallback) failed: ${filePath}`,
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      throw new ActionableError({
        goal: `Create ${filePath} only if absent`,
        problem: `Exclusive write failed: ${String(err)}`,
        location: `FilesystemBackend.writeFileIfAbsent(${filePath})`,
        nextSteps: ['Check the data directory is writable', 'Retry the operation'],
        innerError: err,
      });
    }
  }

  private async writeUnchecked(filePath: string, content: string): Promise<{ version: string }> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, content, 'utf-8');
    await this.renameWithRetry(tmpPath, filePath);
    return { version: gitBlobSha(content) };
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    validatePathSafety(dirPath);
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
    validatePathSafety(filePath);
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
    validatePathSafety(filePath);
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
    validatePathSafety(filePath);
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
    validatePathSafety(filePath);
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

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Filesystem backend adapter for archive/restore/replace operations.
 * Implements atomic writes via temp-file + rename pattern.
 *
 * For production remote-backed storage (GitHub API, Azure), Community will
 * integrate the actual StorageBackend from the server.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export class FilesystemBackendAdapter {
  readonly backendName = 'filesystem';

  async readFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write file atomically using temp-file + rename pattern.
   * Creates parent directories as needed.
   */
  async writeFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);

    // Create parent directory
    await fs.mkdir(dir, { recursive: true });

    // Write to temp file in the same directory (atomic rename)
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    const tempFile = path.join(dir, `.${path.basename(filePath)}.tmp.${randomSuffix}`);

    try {
      // Write to temp file first
      await fs.writeFile(tempFile, content, 'utf-8');
      // Atomic rename
      await fs.rename(tempFile, filePath);
    } catch (err) {
      // Clean up temp file on error
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      // No-op if file doesn't exist
    }
  }

  async listDir(dirPath: string): Promise<string[]> {
    try {
      return await fs.readdir(dirPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }
}

/**
 * Create a filesystem backend adapter.
 * This is the default for local development and Electron.
 * Production remote backend integration is a separate task (Community review).
 */
export function createFilesystemBackend(): FilesystemBackendAdapter {
  return new FilesystemBackendAdapter();
}

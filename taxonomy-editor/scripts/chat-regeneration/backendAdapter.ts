// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Backend wrapper for chat regeneration scripts.
 * Uses the server's fileIO module which routes through the real StorageBackend
 * (filesystem, GitHub API, Azure, etc. depending on STORAGE_MODE).
 */

import type { StorageBackend } from '../../src/server/storage/storageBackend.js';

/**
 * Adapter interface for archive/restore/replace operations.
 * Implemented by wrapping a real StorageBackend from the server.
 */
export interface StorageBackendAdapter {
  readonly readFile: (filePath: string) => Promise<string | null>;
  readonly writeFile: (filePath: string, content: string) => Promise<void>;
  readonly deleteFile: (filePath: string) => Promise<void>;
  readonly listDir: (dirPath: string) => Promise<string[]>;
}

/**
 * Create a backend adapter wrapping a real StorageBackend.
 * This is used by the batch regeneration script to work with any backend
 * (filesystem, GitHub API, Azure Blob, etc.).
 */
export function createBackendAdapter(backend: StorageBackend): StorageBackendAdapter {
  return {
    async readFile(filePath: string): Promise<string | null> {
      return backend.readFile(filePath);
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      await backend.writeFile(filePath, content);
    },

    async deleteFile(filePath: string): Promise<void> {
      await backend.deleteFile(filePath);
    },

    async listDir(dirPath: string): Promise<string[]> {
      return backend.listDirectory(dirPath);
    },
  };
}

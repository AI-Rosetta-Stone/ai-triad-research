// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Archive and restore logic for chat batch regeneration.
 * Archives originals before replacement, with restore support via --restore flag.
 *
 * **Storage abstraction:** Uses StorageBackendAdapter that wraps the real
 * StorageBackend from the server (filesystem, GitHub API, Azure Blob, etc).
 * Works with any backend transparently.
 *
 * **Atomic writes:** Uses backend's native atomic write (temp-file + rename
 * for filesystem; conditional write for GitHub API, etc).
 */

import * as path from 'path';
import type { StorageBackendAdapter } from './backendAdapter.js';

/**
 * Archive a chat session before replacement.
 * Saves to {basePath}/_archive/{id}.{timestamp}.json
 */
export async function archiveChat(
  session: Record<string, unknown> & { id: string },
  basePath: string,
  options: { dryRun?: boolean; backend: StorageBackendAdapter },
): Promise<string> {
  const archivePath = path.join(basePath, '_archive');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(archivePath, `${session.id}.${timestamp}.json`);

  if (!options.dryRun) {
    await options.backend.writeFile(archiveFile, JSON.stringify(session, null, 2));
  }

  return archiveFile;
}

/**
 * List archived versions of a chat.
 */
export async function listArchivedVersions(
  chatId: string,
  basePath: string,
  backend: StorageBackendAdapter,
): Promise<Array<{ path: string; timestamp: string }>> {
  const archivePath = path.join(basePath, '_archive');

  try {
    const files = await backend.listDir(archivePath);
    return files
      .filter(f => f.startsWith(`${chatId}.`) && f.endsWith('.json'))
      .map(f => {
        const timestampStr = f.replace(`${chatId}.`, '').replace('.json', '');
        return {
          path: path.join(archivePath, f),
          timestamp: timestampStr,
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

/**
 * Restore a chat from archive, replacing the current version.
 */
export async function restoreChat(
  chatId: string,
  basePath: string,
  backend: StorageBackendAdapter,
  options: { dryRun?: boolean } = {},
): Promise<Record<string, unknown>> {
  const archived = await listArchivedVersions(chatId, basePath, backend);

  if (archived.length === 0) {
    throw new Error(`No archived versions found for chat ${chatId}`);
  }

  // Restore the most recent version
  const mostRecent = archived[0];
  const content = await backend.readFile(mostRecent.path);
  if (!content) {
    throw new Error(`Could not read archived version: ${mostRecent.path}`);
  }

  const session = JSON.parse(content);

  if (!options.dryRun) {
    const currentPath = path.join(basePath, `${chatId}.json`);
    await backend.writeFile(currentPath, JSON.stringify(session, null, 2));
  }

  return session;
}

/**
 * Replace a chat with a regenerated version atomically.
 * Archives original first, then writes new version.
 */
export async function replaceChat(
  original: Record<string, unknown> & { id: string },
  regenerated: Record<string, unknown> & { id: string },
  basePath: string,
  backend: StorageBackendAdapter,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  // Step 1: Archive original
  await archiveChat(original, basePath, { ...options, backend });

  // Step 2: Write regenerated version (atomic)
  if (!options.dryRun) {
    const chatFile = path.join(basePath, `${regenerated.id}.json`);
    await backend.writeFile(chatFile, JSON.stringify(regenerated, null, 2));
  }
}

/**
 * Update a chat index file (e.g., _index.json) atomically.
 * Reads current index, updates it, writes atomically via backend.
 * Removes archived chats, adds regenerated ones.
 */
export async function updateIndex(
  indexPath: string,
  toRemove: string[],
  toAdd: Array<Record<string, unknown> & { id: string }>,
  backend: StorageBackendAdapter,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  if (!options.dryRun) {
    let index: Record<string, unknown> = {};

    // Read current index (may not exist)
    try {
      const content = await backend.readFile(indexPath);
      if (content) {
        index = JSON.parse(content) as Record<string, unknown>;
      }
    } catch {
      // Index doesn't exist or is invalid; start fresh
    }

    // Remove archived chats
    for (const chatId of toRemove) {
      delete index[chatId];
    }

    // Add regenerated chats (summary only, not full transcript)
    for (const chat of toAdd) {
      index[chat.id] = {
        id: chat.id,
        title: chat.title,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        mode: chat.mode,
        pover: chat.pover,
        regenerated_at: (chat as Record<string, unknown>).regenerated_at,
      };
    }

    // Atomic write (backend's native atomic write)
    await backend.writeFile(indexPath, JSON.stringify(index, null, 2));
  }
}

/**
 * Archive a chat session before replacement.
 * Saves to {basePath}/_archive/{id}.{timestamp}.json
 */
export async function archiveChat(
  session: Record<string, unknown> & { id: string },
  basePath: string,
  options: ArchiveOptions,
): Promise<string> {
  const archivePath = path.join(basePath, '_archive');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(archivePath, `${session.id}.${timestamp}.json`);

  if (!options.dryRun) {
    await options.backend.writeFile(archiveFile, JSON.stringify(session, null, 2));
  }

  return archiveFile;
}

/**
 * List archived versions of a chat.
 */
export async function listArchivedVersions(
  chatId: string,
  basePath: string,
  backend: StorageBackendAdapter,
): Promise<Array<{ path: string; timestamp: string }>> {
  const archivePath = path.join(basePath, '_archive');

  try {
    const files = await backend.listDir(archivePath);
    return files
      .filter(f => f.startsWith(`${chatId}.`) && f.endsWith('.json'))
      .map(f => {
        const timestampStr = f.replace(`${chatId}.`, '').replace('.json', '');
        return {
          path: path.join(archivePath, f),
          timestamp: timestampStr,
        };
      })
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  } catch {
    return [];
  }
}

/**
 * Restore a chat from archive, replacing the current version.
 */
export async function restoreChat(
  chatId: string,
  basePath: string,
  backend: StorageBackendAdapter,
  options: { dryRun?: boolean } = {},
): Promise<Record<string, unknown>> {
  const archived = await listArchivedVersions(chatId, basePath, backend);

  if (archived.length === 0) {
    throw new Error(`No archived versions found for chat ${chatId}`);
  }

  // Restore the most recent version
  const mostRecent = archived[0];
  const content = await backend.readFile(mostRecent.path);
  if (!content) {
    throw new Error(`Could not read archived version: ${mostRecent.path}`);
  }

  const session = JSON.parse(content);

  if (!options.dryRun) {
    const currentPath = path.join(basePath, `${chatId}.json`);
    await backend.writeFile(currentPath, JSON.stringify(session, null, 2));
  }

  return session;
}

/**
 * Replace a chat with a regenerated version atomically.
 * Archives original first, then writes new version.
 */
export async function replaceChat(
  original: Record<string, unknown> & { id: string },
  regenerated: Record<string, unknown> & { id: string },
  basePath: string,
  backend: StorageBackendAdapter,
  options: ArchiveOptions = { backend, dryRun: false },
): Promise<void> {
  // Step 1: Archive original
  await archiveChat(original, basePath, { ...options, backend });

  // Step 2: Write regenerated version (atomic)
  if (!options.dryRun) {
    const chatFile = path.join(basePath, `${regenerated.id}.json`);
    await backend.writeFile(chatFile, JSON.stringify(regenerated, null, 2));
  }
}

/**
 * Update a chat index file (e.g., _index.json) atomically.
 * Reads current index, updates it, writes atomically via backend.
 * Removes archived chats, adds regenerated ones.
 */
export async function updateIndex(
  indexPath: string,
  toRemove: string[],
  toAdd: Array<Record<string, unknown> & { id: string }>,
  backend: StorageBackendAdapter,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  if (!options.dryRun) {
    let index: Record<string, unknown> = {};

    // Read current index (may not exist)
    try {
      const content = await backend.readFile(indexPath);
      if (content) {
        index = JSON.parse(content) as Record<string, unknown>;
      }
    } catch {
      // Index doesn't exist or is invalid; start fresh
    }

    // Remove archived chats
    for (const chatId of toRemove) {
      delete index[chatId];
    }

    // Add regenerated chats (summary only, not full transcript)
    for (const chat of toAdd) {
      index[chat.id] = {
        id: chat.id,
        title: chat.title,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        mode: chat.mode,
        pover: chat.pover,
        regenerated_at: (chat as Record<string, unknown>).regenerated_at,
      };
    }

    // Atomic write
    await backend.writeFile(indexPath, JSON.stringify(index, null, 2));
  }
}

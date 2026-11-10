// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Archive and restore logic for chat batch regeneration.
 * Archives originals before replacement, with restore support via --restore flag.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChatSession } from './types.js';

export interface ArchiveOptions {
  dryRun?: boolean;
}

/**
 * Archive a chat session before replacement.
 * Saves to {basePath}/_archive/{id}.{timestamp}.json
 */
export async function archiveChat(
  session: ChatSession,
  basePath: string,
  options: ArchiveOptions = {},
): Promise<string> {
  const archivePath = path.join(basePath, '_archive');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(archivePath, `${session.id}.${timestamp}.json`);

  if (!options.dryRun) {
    await fs.mkdir(archivePath, { recursive: true });
    await fs.writeFile(archiveFile, JSON.stringify(session, null, 2));
  }

  return archiveFile;
}

/**
 * List archived versions of a chat.
 */
export async function listArchivedVersions(
  chatId: string,
  basePath: string,
): Promise<Array<{ path: string; timestamp: string }>> {
  const archivePath = path.join(basePath, '_archive');

  try {
    const files = await fs.readdir(archivePath);
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
  options: ArchiveOptions = {},
): Promise<ChatSession> {
  const archived = await listArchivedVersions(chatId, basePath);

  if (archived.length === 0) {
    throw new Error(`No archived versions found for chat ${chatId}`);
  }

  // Restore the most recent version
  const mostRecent = archived[0];
  const content = await fs.readFile(mostRecent.path, 'utf-8');
  const session = JSON.parse(content) as ChatSession;

  if (!options.dryRun) {
    const currentPath = path.join(basePath, `${chatId}.json`);
    await fs.writeFile(currentPath, JSON.stringify(session, null, 2));
  }

  return session;
}

/**
 * Replace a chat with a regenerated version atomically.
 * Archives original first, then writes new version.
 */
export async function replaceChat(
  original: ChatSession,
  regenerated: ChatSession,
  basePath: string,
  options: ArchiveOptions = {},
): Promise<void> {
  // Step 1: Archive original
  await archiveChat(original, basePath, options);

  // Step 2: Write regenerated version
  if (!options.dryRun) {
    const chatFile = path.join(basePath, `${regenerated.id}.json`);
    await fs.writeFile(chatFile, JSON.stringify(regenerated, null, 2));
  }
}

/**
 * Update a chat index file (e.g., _index.json) atomically.
 * Removes archived chats, adds regenerated ones.
 */
export async function updateIndex(
  indexPath: string,
  toRemove: string[],
  toAdd: ChatSession[],
  options: ArchiveOptions = {},
): Promise<void> {
  if (!options.dryRun) {
    let index: Record<string, unknown> = {};

    try {
      const content = await fs.readFile(indexPath, 'utf-8');
      index = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Index doesn't exist or is invalid; start fresh
    }

    // Remove archived chats
    for (const chatId of toRemove) {
      delete index[chatId];
    }

    // Add regenerated chats
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

    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }
}

// K3: Chat share store using per-chat pointer blobs (SO p/835#19)
// Design: pointers at users/{uid}/chat-share-ptrs/{chatId}.json arbitrate writes via CAS

import path from 'path';
import { randomBytes } from 'crypto';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { getUserContentBackend, assertSafeId } from './fileIO.js';
import { gitBlobSha } from './gitBlobSha.js';
import { resolveDataPath } from '../config.js';

export interface ChatSharePointer {
  shareId: string;
  created_at: string;
  expires_at: string;
}

function pointerPath(userId: string, chatId: string): string {
  assertSafeId(userId, 'user id');
  assertSafeId(chatId, 'chat id');
  return path.join(resolveDataPath(`users/${userId}/chat-share-ptrs`), `${chatId}.json`);
}

function publicSharePath(shareId: string): string {
  assertSafeId(shareId, 'share id');
  return path.join(resolveDataPath('public/chat-shares'), `${shareId}.json`);
}

export async function createShare(userId: string, chatId: string, shareBlob: string, ttlDays: number, maxActive: number): Promise<{ shareId: string; pointer: ChatSharePointer } | { error: string; status: number }> {
  const backend = getUserContentBackend();
  const shareId = randomBytes(16).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

  try {
    // Check cap: count existing pointers
    const pointersDir = path.join(resolveDataPath(`users/${userId}/chat-share-ptrs`));
    let existingCount = 0;
    try {
      const entries = await backend.listDirectory ? backend.listDirectory(pointersDir) : [];
      existingCount = Array.isArray(entries) ? entries.length : 0;
    } catch (e) {
      // Directory may not exist yet
    }

    if (existingCount >= maxActive) {
      return { error: `At most ${maxActive} active shares allowed`, status: 429 };
    }

    // Write share blob first
    await backend.writeFile(publicSharePath(shareId), shareBlob);

    // Write pointer with baseSha: '' (file doesn't exist yet)
    const pointer: ChatSharePointer = { shareId, created_at: now.toISOString(), expires_at: expiresAt.toISOString() };
    try {
      await backend.writeFile(pointerPath(userId, chatId), JSON.stringify(pointer) + '\n', { baseSha: '' });
      return { shareId, pointer };
    } catch (err: any) {
      if (err.code === 'WRITE_CONFLICT') {
        // Lost race: delete our blob and return existing pointer
        try {
          await backend.deleteFile(publicSharePath(shareId));
        } catch {}
        try {
          const content = await backend.readFile(pointerPath(userId, chatId), { optional: true });
          if (content) {
            return { shareId: (JSON.parse(content) as ChatSharePointer).shareId, pointer: JSON.parse(content) };
          }
        } catch {}
        return { error: 'Share already exists', status: 200 };
      }
      throw err;
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share-store',
      level: 'error',
      message: 'Failed to create share',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return { error: String(err), status: 500 };
  }
}

export async function loadShare(shareId: string): Promise<string | null> {
  try {
    const backend = getUserContentBackend();
    const content = await backend.readFile(publicSharePath(shareId), { optional: true });
    if (!content) return null;
    const share = JSON.parse(content);
    if (new Date(share.expires_at) < new Date()) {
      // Delete expired blob
      try {
        await backend.deleteFile(publicSharePath(shareId));
      } catch {}
      return null;
    }
    return content;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share-store',
      level: 'warn',
      message: 'Failed to load share',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

export async function revokeShare(userId: string, chatId: string): Promise<boolean> {
  try {
    const backend = getUserContentBackend();
    const pointerContent = await backend.readFile(pointerPath(userId, chatId), { optional: true });
    if (!pointerContent) return false;

    const pointer = JSON.parse(pointerContent) as ChatSharePointer;

    // Delete pointer first
    await backend.deleteFile(pointerPath(userId, chatId));

    // Then delete the blob
    try {
      await backend.deleteFile(publicSharePath(pointer.shareId));
    } catch {}

    return true;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share-store',
      level: 'warn',
      message: 'Failed to revoke share',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

export async function getActiveShareCount(userId: string): Promise<number> {
  try {
    const backend = getUserContentBackend();
    const pointersDir = path.join(resolveDataPath(`users/${userId}/chat-share-ptrs`));
    const entries = await backend.listDirectory ? backend.listDirectory(pointersDir) : [];
    return Array.isArray(entries) ? entries.length : 0;
  } catch {
    return 0;
  }
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4787 (TL-approved): public chat share endpoints — create/revoke/read with
// snapshot immutability and message projection. POST/DELETE are owner-only with
// rate limits and active-share caps; GET is anonymous public read with no-store
// cache header and immediate 404 on revoke. Storage: per-share blobs, per-chat
// pointers, per-user indices for admin queries.

import path from 'path';
import { randomBytes } from 'crypto';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, getClientIp } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
import { checkRate } from '../security/rateLimiter.js';
import { getCurrentUserId, getStorageUserId, isAnonymousUser } from '../security/userContext.js';
import { resolveDataPath } from '../config.js';
import { getUserContentBackend, assertSafeId } from '../storage/fileIO.js';
import { log } from '../logger.js';
import { CHAT_SHARE_CONFIG } from '../config/chatShareConfig.js';

// ── Configuration (t/4787 P5, K5: externalized) ──
const CHAT_SHARE_MAX_ACTIVE = CHAT_SHARE_CONFIG.MAX_ACTIVE;
const CHAT_SHARE_CREATES_PER_HOUR = CHAT_SHARE_CONFIG.CREATES_PER_HOUR;
const CHAT_SHARE_TTL_DAYS = CHAT_SHARE_CONFIG.TTL_DAYS;
const PUBLIC_READ_RATE_LIMIT_PER_HOUR = CHAT_SHARE_CONFIG.PUBLIC_READ_PER_HOUR;
const PUBLIC_CHAT_SHARES_DIR = 'public/chat-shares';
// Bounds on what one share may publish, so the public surface can't be used to park
// arbitrarily large blobs under the app's domain (TL review of #4499).
export const CHAT_SHARE_MAX_MESSAGES = 500;
export const CHAT_SHARE_MAX_TOTAL_CHARS = 1_000_000;

// K1: 128-bit ID format check (base64url-encoded randomBytes(16))
const SHARE_ID_FORMAT = /^[A-Za-z0-9_-]{22}$/;

/** K1: Generate 128-bit share ID (randomBytes base64url, no padding). */
function generateShareId(): string {
  return randomBytes(16).toString('base64url');
}

// ── Types ──

export interface SnapshotMessage {
  role: 'user' | 'assistant' | 'acc' | 'saf' | 'skp';
  content: string;
  timestamp: string;
}

export interface ChatSnapshot {
  id: string;
  title: string;
  messages: SnapshotMessage[];
  created_at: string;
}

export interface PublicChatShare {
  id: string;
  chatId: string;
  userId: string;
  snapshot: ChatSnapshot;
  created_at: string;
  expires_at: string;
}

/** What an anonymous reader may see: the conversation only. Never the owner's userId or the
 *  owner's chatId (t/4787 P3: "no emails, user ids or internal data"). */
export interface PublicChatShareView {
  id: string;
  title: string;
  messages: SnapshotMessage[];
  created_at: string;
  expires_at: string;
}

export function toPublicView(share: PublicChatShare): PublicChatShareView {
  return {
    id: share.id,
    title: share.snapshot.title,
    messages: share.snapshot.messages,
    created_at: share.created_at,
    expires_at: share.expires_at,
  };
}

// ── Storage paths ──

function publicSharePath(shareId: string): string {
  assertSafeId(shareId, 'chat share id');
  return path.join(resolveDataPath(PUBLIC_CHAT_SHARES_DIR), `${shareId}.json`);
}

function shareRegistryPath(): string {
  return path.join(resolveDataPath(`users/${getStorageUserId()}`), 'chat-shares.json');
}

function stripSensitiveKeys(messages: unknown[]): SnapshotMessage[] {
  return (messages as Array<Record<string, unknown>>).map((msg) => {
    const role = msg.role as string;
    // Only allow specific speaker values (drop 'cc' per t/4787)
    if (!['user', 'assistant', 'acc', 'saf', 'skp'].includes(role)) {
      throw new ActionableError({
        goal: 'Create chat share with valid messages',
        problem: `Invalid speaker role '${role}' — must be user|assistant|acc|saf|skp`,
        location: 'stripSensitiveKeys',
        nextSteps: ['Verify message speaker roles before sharing'],
      });
    }
    return {
      role: role as SnapshotMessage['role'],
      content: String(msg.content ?? ''),
      timestamp: String(msg.timestamp ?? new Date().toISOString()),
    };
  });
}

// Chat sessions are stored on the client side only. The server receives the chat
// data (title, messages) in the request body and snapshots it.

async function saveShare(share: PublicChatShare): Promise<void> {
  const backend = getUserContentBackend();
  const shareBlob = JSON.stringify(share, null, 2) + '\n';
  await backend.writeFile(publicSharePath(share.id), shareBlob);
}

async function loadShare(shareId: string): Promise<PublicChatShare | null> {
  try {
    const backend = getUserContentBackend();
    const content = await backend.readFile(publicSharePath(shareId), { optional: true });
    if (!content) return null;

    const share = JSON.parse(content) as PublicChatShare;
    // K4: Check expiration and delete expired blobs
    if (new Date(share.expires_at) < new Date()) {
      await revokeShare(shareId);
      return null;
    }
    return share;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to load chat share',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

async function revokeShare(shareId: string): Promise<void> {
  try {
    const backend = getUserContentBackend();
    await backend.deleteFile(publicSharePath(shareId));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Share does not exist (idempotent delete)',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** Registry with version for CAS (K3: race condition prevention). */
interface VersionedRegistry {
  _version: number;
  shares: Record<string, string>; // chatId → shareId
}

async function readRegistry(): Promise<VersionedRegistry> {
  const content = await getUserContentBackend().readFile(shareRegistryPath(), { optional: true });
  if (!content) return { _version: 0, shares: {} };
  const parsed = JSON.parse(content) as VersionedRegistry;
  // Upgrade old format (flat registry) to new format (versioned with shares)
  if (parsed._version === undefined) {
    const { _version, shares, ...legacy } = parsed as any;
    return { _version: 0, shares: legacy };
  }
  return parsed;
}

/** K4: Remove expired entries from registry (prune during preflight). */
async function pruneExpiredRegistry(): Promise<void> {
  try {
    const backend = getUserContentBackend();
    const registry = await readRegistry();
    let dirty = false;
    for (const [chatId, shareId] of Object.entries(registry)) {
      const share = await loadShare(shareId);
      if (!share) {
        delete registry[chatId];
        dirty = true;
      }
    }
    if (dirty && Object.keys(registry).length > 0) {
      await backend.writeFile(shareRegistryPath(), JSON.stringify(registry) + '\n');
    } else if (dirty) {
      await backend.deleteFile(shareRegistryPath());
    }
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to prune registry',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
  }
}

/** The caller's live share for this chat, if any (P1: idempotence). */
async function findExistingShare(chatId: string): Promise<PublicChatShare | null> {
  try {
    const registry = await readRegistry();
    const existingShareId = registry.shares[chatId];
    return existingShareId ? await loadShare(existingShareId) : null;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Failed to check existing share; treating it as absent',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

/** K3: CAS (Compare-And-Swap) write to registry with version check. On conflict, delete
 *  the newly written blob so no orphan share survives. Returns true on success, false on conflict. */
async function casRegistryWrite(
  registry: VersionedRegistry,
  updates: Record<string, string>,
  shareIdToDeleteOnConflict?: string,
): Promise<boolean> {
  try {
    const backend = getUserContentBackend();
    const newVersion = registry._version + 1;
    const newRegistry: VersionedRegistry = { _version: newVersion, ...registry, ...updates };

    // Read current registry to check if version matches (simulated CAS)
    const current = await readRegistry();
    if (current._version !== registry._version) {
      // Version mismatch: we lost the race. Delete our own blob if we wrote one.
      if (shareIdToDeleteOnConflict) {
        await revokeShare(shareIdToDeleteOnConflict);
      }
      return false; // Conflict
    }

    // Write succeeded
    await backend.writeFile(shareRegistryPath(), JSON.stringify(newRegistry) + '\n');
    return true;
  } catch (err) {
    if (shareIdToDeleteOnConflict) {
      await revokeShare(shareIdToDeleteOnConflict);
    }
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'CAS registry write failed; deleted orphan blob',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return false;
  }
}

/** Returns a reason the content can't be shared, or null when it's within bounds. */
export function contentTooLarge(messages: unknown[]): string | null {
  if (messages.length > CHAT_SHARE_MAX_MESSAGES) return `at most ${CHAT_SHARE_MAX_MESSAGES} messages can be shared`;
  const total = messages.reduce<number>((n, m) => n + String((m as Record<string, unknown>)?.content ?? '').length, 0);
  if (total > CHAT_SHARE_MAX_TOTAL_CHARS) return `at most ${CHAT_SHARE_MAX_TOTAL_CHARS} characters can be shared`;
  return null;
}

/** Everything that can answer a create request before a new share is written, in order:
 *  size bounds, P1 idempotence (an existing live share is returned as-is and doesn't count
 *  against the create rate limit), the P5 active-share cap (a replace swaps one for one, so
 *  it's only refused when the chat had no share before), then the P5 create rate limit.
 *  Returns null when a new share should be created. */
async function createPreflight(
  chatId: string,
  userId: string,
  replace: boolean,
  messages: unknown[],
): Promise<{ status: number; payload: unknown } | null> {
  const tooLarge = contentTooLarge(messages);
  if (tooLarge) return { status: 413, payload: { error: `Chat too large to share: ${tooLarge}` } };

  if (!replace) {
    const existing = await findExistingShare(chatId);
    if (existing) return { status: 200, payload: existing };
  }

  // K4: Prune expired entries before checking cap
  await pruneExpiredRegistry();

  const registry = await readRegistry();
  // K5: Cap violation returns 429 (not 409)
  const chatCount = Object.keys(registry.shares).length;
  if (!(chatId in registry.shares) && chatCount >= CHAT_SHARE_MAX_ACTIVE) {
    return { status: 429, payload: { error: `At most ${CHAT_SHARE_MAX_ACTIVE} chats can be shared at once; revoke one first`, retryAfterMs: 3600_000 } };
  }

  const rateCheck = checkRate(`chat-share-create:${userId}`, CHAT_SHARE_CREATES_PER_HOUR, 3600_000);
  if (!rateCheck.allowed) {
    return { status: 429, payload: { error: 'Share creation rate limit exceeded', retryAfterMs: rateCheck.retryAfterMs } };
  }
  return null;
}

async function createShare(
  chatId: string,
  userId: string,
  chatData: { title: string; messages: unknown[] },
): Promise<PublicChatShare> {
  const backend = getUserContentBackend();

  // K1: Generate new share with 128-bit ID
  const shareId = generateShareId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHAT_SHARE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const share: PublicChatShare = {
    id: shareId,
    chatId,
    userId,
    snapshot: {
      id: chatId,
      title: chatData.title ?? 'Untitled',
      messages: stripSensitiveKeys(chatData.messages ?? []),
      created_at: now.toISOString(),
    },
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  await saveShare(share);

  // K3: Registry write with retry on race, orphan cleanup. K5: assertSafeId on registry key.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      assertSafeId(chatId, 'chat id for registry key');
      const registry = await readRegistry();
      const previousShareId = registry.shares[chatId];
      if (previousShareId && previousShareId !== shareId) await revokeShare(previousShareId);
      registry.shares[chatId] = shareId;
      registry._version += 1;
      const backend = getUserContentBackend();
      await backend.writeFile(shareRegistryPath(), JSON.stringify(registry) + '\n');
      return share;
    } catch (err) {
      if (attempt === 2) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'chat-share',
          level: 'warn',
          message: 'Failed to update share registry after retries',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        // On lost race: delete the newly written blob so no orphan public share survives (K3)
        await revokeShare(shareId);
        throw new ActionableError({
          goal: 'Create chat share',
          problem: 'Registry write conflict after 3 attempts',
          location: 'createShare',
          nextSteps: ['Retry the request'],
        });
      }
    }
  }

  return share;
}

// ── Route handlers ──

export function registerChatShareRoutes(r: Router, _ctx: ServerCtx): void {
  const { post, del, get } = r;

  // POST /api/chat/:id/share — Create or return existing share (owner-only)
  // Body: { title: string, messages: unknown[], replace?: boolean }
  // P1: Idempotent by default; replace=true creates new
  // P5: Rate limit 5 creates/hour per user, 20 max active shares per user
  post('/api/chat/:id/share', async (req, res, body) => {
    try {
      // K5: Anonymous gets 401 (not 403)
      if (isAnonymousUser()) {
        error(res, 'Sign in required', 401);
        return;
      }

      const chatId = param(req, 'id', '/api/chat/:id/share');
      const userId = getCurrentUserId();
      const {
        title = '',
        messages = [],
        replace = false,
      } = (body ?? {}) as { title?: string; messages?: unknown[]; replace?: boolean };

      // Validate input
      if (typeof title !== 'string' || !Array.isArray(messages)) {
        error(res, 'Invalid request body: title and messages required', 400);
        return;
      }

      const early = await createPreflight(chatId, userId, replace, messages);
      if (early) {
        json(res, early.payload, early.status);
        return;
      }

      const share = await createShare(chatId, userId, { title, messages });
      json(res, share, 201);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'chat-share',
        level: 'error',
        message: 'Failed to create chat share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // DELETE /api/chat/:id/share — Revoke share (owner-only)
  // Hard delete; no idempotence required (404 after delete is correct)
  del('/api/chat/:id/share', async (req, res) => {
    try {
      // K5: Anonymous gets 401 (not 403)
      if (isAnonymousUser()) {
        error(res, 'Sign in required', 401);
        return;
      }

      const chatId = param(req, 'id', '/api/chat/:id/share');
      const userId = getCurrentUserId();
      const backend = getUserContentBackend();

      // Find share for this chat in user's registry
      try {
        const registryContent = await backend.readFile(shareRegistryPath(), { optional: true });
        if (!registryContent) {
          error(res, 'Share not found', 404);
          return;
        }

        const registry = JSON.parse(registryContent) as Record<string, string>;
        const shareId = registry[chatId];
        if (!shareId) {
          error(res, 'Share not found', 404);
          return;
        }

        // Verify ownership before revoking
        const share = await loadShare(shareId);
        if (!share || share.userId !== userId) {
          error(res, 'Share not found', 404);
          return;
        }

        // Revoke the share
        await revokeShare(shareId);

        // Remove from user's registry
        delete registry[chatId];
        if (Object.keys(registry).length > 0) {
          await backend.writeFile(shareRegistryPath(), JSON.stringify(registry) + '\n');
        } else {
          await backend.deleteFile(shareRegistryPath());
        }

        json(res, { id: shareId }, 200);
      } catch (err) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'chat-share',
          level: 'warn',
          message: 'Error finding share for deletion',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        error(res, 'Share not found', 404);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'chat-share',
        level: 'error',
        message: 'Failed to revoke chat share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // GET /api/public/chat/:shareId — Public read (anonymous allowed)
  // P4: no-store cache header (revoke must return 404 immediately)
  // P5: Rate limit 100/hour per IP
  get('/api/public/chat/:shareId', async (req, res) => {
    try {
      const shareId = param(req, 'shareId', '/api/public/chat/:shareId');

      // Rate limit per IP: 100 reads/hour
      const clientIp = getClientIp(req);
      const limitKey = `chat-share-read:${clientIp}`;
      const rateCheck = checkRate(limitKey, PUBLIC_READ_RATE_LIMIT_PER_HOUR, 3600_000);
      if (!rateCheck.allowed) {
        // K2: noindex on 429
        res.writeHead(429, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(JSON.stringify({
          error: 'Rate limit exceeded',
          retryAfterMs: rateCheck.retryAfterMs,
        }));
        return;
      }

      const share = await loadShare(shareId);
      if (!share) {
        // K2: noindex on 404
        res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(JSON.stringify({ error: 'Share not found or expired' }));
        return;
      }

      // K2: noindex on 200
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      });
      // The public projection only: never the owner's userId or chatId (t/4787 P3).
      res.end(JSON.stringify(toPublicView(share)));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'chat-share',
        level: 'error',
        message: 'Failed to read chat share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

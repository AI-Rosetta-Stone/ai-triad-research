/* eslint-disable local/complexity-budget */
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
import { gitBlobSha } from '../storage/gitBlobSha.js';
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

/** Registry shares mapping. */
interface Registry {
  shares: Record<string, string>; // chatId → shareId
}

/** Registry read with baseSha for CAS (K3: race condition prevention). */
interface RegistryRead {
  registry: Registry;
  baseSha: string; // gitBlobSha of the content read (for CAS precondition)
}

async function readRegistry(): Promise<RegistryRead> {
  const backend = getUserContentBackend();
  const content = await backend.readFile(shareRegistryPath(), { optional: true });
  // K3: baseSha '' is the CAS precondition for "file does not exist" (matches
  // FilesystemBackend.writeFile: currentSha = current === null ? '' : gitBlobSha(current)).
  // Using gitBlobSha('') here instead made every first write on an absent registry
  // conflict against the real on-disk '' sentinel, forcing it through the retry loop
  // until it exhausted — the root cause of the K1-K7 PR's 500s (verified via CI logs).
  if (!content) return { registry: { shares: {} }, baseSha: '' };

  try {
    const parsed = JSON.parse(content) as any;
    const registry: Registry = { shares: parsed.shares || parsed };
    const baseSha = gitBlobSha(content);
    return { registry, baseSha };
  } catch (err) {
    // R-D (SO p/835#21): a corrupt registry must fail closed, not be silently treated as
    // empty — the old behavior returned {shares:{}} here, so the next create/revoke/prune
    // would cheerfully overwrite the corrupt file with fresh data, destroying whatever of
    // the original was still recoverable and masking the corruption as a normal write.
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'error',
      message: 'Chat share registry is corrupt — refusing to overwrite',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    throw new ActionableError({
      goal: 'Read the chat share registry',
      problem: 'The registry file is corrupt (invalid JSON) and cannot be safely read or overwritten.',
      location: 'readRegistry',
      nextSteps: ['Inspect and manually repair or restore the registry file from backup', 'Do not retry until the file is valid JSON'],
      innerError: err,
    });
  }
}

/** R-B (SO p/835#21): write the registry with CAS even when the result is empty — never
 *  `deleteFile` unconditionally. An unconditional delete has no baseSha precondition, so a
 *  concurrent create that landed between our read and this delete gets silently wiped. An
 *  empty registry is represented as `{"shares":{}}`, not file-absence. */
async function writeRegistryCas(registry: Registry, baseSha: string): Promise<void> {
  const backend = getUserContentBackend();
  const newContent = JSON.stringify(registry) + '\n';
  await backend.writeFile(shareRegistryPath(), newContent, { baseSha });
}

/** K4: Remove expired entries from registry (prune during preflight). */
async function pruneExpiredRegistry(): Promise<void> {
  try {
    const { registry, baseSha } = await readRegistry();
    let dirty = false;
    for (const [chatId, shareId] of Object.entries(registry.shares)) {
      const share = await loadShare(shareId);
      if (!share) {
        delete registry.shares[chatId];
        dirty = true;
      }
    }
    if (dirty) {
      try {
        await writeRegistryCas(registry, baseSha);
      } catch (err: unknown) {
        const writeErr = err as any;
        if (!(writeErr.code === 'WRITE_CONFLICT' || writeErr.message?.includes('412'))) {
          getGlobalRecorder()?.record({
            type: 'system.error',
            component: 'chat-share',
            level: 'warn',
            message: 'Prune registry write failed',
            error: { name: (writeErr as Error).name ?? 'Error', message: String(writeErr), stack: (writeErr as Error).stack },
          });
          throw writeErr;
        }
        // K3: Conflict on prune is non-critical; skip
      }
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
    const { registry } = await readRegistry();
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

  const { registry } = await readRegistry();
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

  // K3: Registry write with CAS (version check) + retry, orphan cleanup. K5: assertSafeId on registry key.
  assertSafeId(chatId, 'chat id for registry key');
  const backend = getUserContentBackend();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { registry, baseSha } = await readRegistry();
      const previousShareId = registry.shares[chatId];

      // K3: CAS with baseSha (gitBlobSha of content read, per SO p/835#16)
      registry.shares[chatId] = shareId;
      const newContent = JSON.stringify(registry) + '\n';

      try {
        await backend.writeFile(shareRegistryPath(), newContent, { baseSha });
        // R-C (SO p/835#21): only revoke the previous share AFTER the registry commit
        // succeeds. Revoking it first meant a failed/conflicting CAS write could leave
        // the registry still pointing at an already-deleted blob.
        if (previousShareId && previousShareId !== shareId) await revokeShare(previousShareId);
        return share;
      } catch (writeErr: unknown) {
        // K3: On WRITE_CONFLICT (409), re-read and check if another writer won
        const err = writeErr as any;
        if (err.code === 'WRITE_CONFLICT' || err.message?.includes('412') || err.message?.includes('WRITE_CONFLICT')) {
          // Conflict: another POST succeeded. Check if they created a share for this chat.
          const { registry: current } = await readRegistry();
          const otherShareId = current.shares[chatId];
          if (otherShareId && otherShareId !== shareId) {
            const otherShare = await loadShare(otherShareId);
            if (otherShare) {
              // Winner's share is live: only now is it safe to abandon ours.
              await revokeShare(shareId);
              return otherShare;
            }
            // Winner's entry was stale/expired — fall through and retry with our
            // own blob still intact (see R-A note below).
          }
          // R-A (SO p/835#21): do NOT revoke our own blob here. The next attempt reuses
          // the same shareId/blob — deleting it now and then succeeding on retry would
          // point the registry at an already-deleted blob, a permanently dead 404 link.
          continue;
        }
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'chat-share',
          level: 'warn',
          message: 'Registry write error (not conflict)',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        throw writeErr;
      }
    } catch (err) {
      if (attempt === 2) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'chat-share',
          level: 'warn',
          message: 'Failed to update share registry after retries',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
        await revokeShare(shareId);
        throw err;
      }
    }
  }

  // R-E (SO p/835#23): reaching here means every attempt hit a conflict with no live
  // winner to hand off to (the `continue` path above never throws, so the attempt===2
  // branch in the catch block above never ran). Our own blob is still on disk and
  // unreferenced by any registry entry — an orphaned, unrevocable public share unless
  // we clean it up here before giving up.
  getGlobalRecorder()?.record({
    type: 'system.error',
    component: 'chat-share',
    level: 'warn',
    message: 'Failed to update share registry after retries (no live winner); revoking orphaned blob',
    error: { name: 'Error', message: 'Registry write exceeded max retries', stack: new Error().stack },
  });
  await revokeShare(shareId);
  throw new ActionableError({
    goal: 'Create chat share',
    problem: 'Registry write exceeded max retries',
    location: 'createShare',
    nextSteps: ['Retry the request'],
  });
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

      // K1–K5: size bounds, idempotence, cap, rate limit, CAS
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

      // Find share for this chat in user's registry
      try {
        const { registry, baseSha } = await readRegistry();
        const shareId = registry.shares[chatId];
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

        delete registry.shares[chatId];

        try {
          // R-B (SO p/835#21): CAS-write the registry even when it ends up empty —
          // never an unconditional deleteFile, which has no baseSha precondition and
          // can wipe a concurrent create's entry landed between our read and this write.
          await writeRegistryCas(registry, baseSha);
        } catch (writeErr: unknown) {
          const err = writeErr as any;
          if (err.code === 'WRITE_CONFLICT' || err.message?.includes('412')) {
            // K3: Conflict on DELETE is non-critical; the blob is revoked below
            // regardless, and a stale registry key self-heals (findExistingShare
            // treats a shareId with no backing blob as "no live share").
            getGlobalRecorder()?.record({
              type: 'system.error',
              component: 'chat-share',
              level: 'warn',
              message: 'Registry write conflict during DELETE (blob already revoked, ignoring)',
              error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
            });
          } else {
            throw writeErr;
          }
        }

        // R-C (SO p/835#21): revoke the blob only after the registry commit (or its
        // accepted conflict fallback) completes, not before.
        await revokeShare(shareId);

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

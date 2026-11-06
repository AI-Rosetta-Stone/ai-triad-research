// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4787 (TL-approved): public chat share endpoints — create/revoke/read with
// snapshot immutability and message projection. POST/DELETE are owner-only with
// rate limits and active-share caps; GET is anonymous public read with no-store
// cache header and immediate 404 on revoke. Storage/registry logic lives in
// ../chatShareStore.ts (SO p/835#25) — this file is route wiring only.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, getClientIp } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { checkRate } from '../security/rateLimiter.js';
import { getCurrentUserId, isAnonymousUser } from '../security/userContext.js';
import {
  createPreflight, createShare, loadShare, revokeShare, readRegistry, writeRegistryCas,
  toPublicView, CHAT_SHARE_MAX_MESSAGES,
} from '../chatShareStore.js';
import { CHAT_SHARE_CONFIG } from '../config/chatShareConfig.js';

export { CHAT_SHARE_MAX_MESSAGES, CHAT_SHARE_MAX_TOTAL_CHARS, contentTooLarge, toPublicView } from '../chatShareStore.js';
export type { SnapshotMessage, ChatSnapshot, PublicChatShare, PublicChatShareView } from '../chatShareStore.js';

const PUBLIC_READ_RATE_LIMIT_PER_HOUR = CHAT_SHARE_CONFIG.PUBLIC_READ_PER_HOUR;

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
      const shareId = await revokeOwnedShare(chatId, userId);
      if (!shareId) {
        error(res, 'Share not found', 404);
        return;
      }
      json(res, { id: shareId }, 200);
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

/** Find, verify ownership of, and revoke the chat's live share. Returns the revoked
 *  share's id, or null if there was no live share owned by this caller. */
async function revokeOwnedShare(chatId: string, userId: string): Promise<string | null> {
  try {
    const { registry, baseSha } = await readRegistry();
    const shareId = registry.shares[chatId];
    if (!shareId) return null;

    // Verify ownership before revoking
    const share = await loadShare(shareId);
    if (!share || share.userId !== userId) return null;

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
    return shareId;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'chat-share',
      level: 'warn',
      message: 'Error finding share for deletion',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

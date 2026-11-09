// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4788 (SO-approved, D1-D4): public debate share endpoints — create/revoke/read.
// POST/DELETE are owner-only; GET is anonymous public read with no-store cache header
// and immediate 404 on revoke. Unlike chat (t/4787), POST takes NO body — D1 requires
// the snapshot to come only from the server-loaded debate session, never the request.
// Storage/registry logic lives in ../debateShareStore.ts — this file is route wiring only.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param, getClientIp } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { checkRate } from '../security/rateLimiter.js';
import { getCurrentUserId, isAnonymousUser } from '../security/userContext.js';
import {
  createPreflight, createShare, loadShare, revokeShare, readRegistry, writeRegistryCas,
  toPublicView,
} from '../debateShareStore.js';
import { DEBATE_SHARE_CONFIG } from '../config/debateShareConfig.js';

export { toPublicView } from '../debateShareStore.js';
export type { DebateSnapshot, PublicDebateShare, PublicDebateShareView } from '../debateShareStore.js';

const PUBLIC_READ_RATE_LIMIT_PER_HOUR = DEBATE_SHARE_CONFIG.PUBLIC_READ_PER_HOUR;

export function registerDebateShareRoutes(r: Router, _ctx: ServerCtx): void {
  const { post, del, get } = r;

  // POST /api/debate/:id/share — Create or return existing share (owner-only)
  // Body: { replace?: boolean } only — D1: the snapshot is loaded server-side,
  // never taken from the request.
  post('/api/debate/:id/share', async (req, res, body) => {
    try {
      if (isAnonymousUser()) {
        error(res, 'Sign in required', 401);
        return;
      }

      const debateId = param(req, 'id', '/api/debate/:id/share');
      const userId = getCurrentUserId();
      const { replace = false } = (body ?? {}) as { replace?: boolean };

      const early = await createPreflight(debateId, userId, replace);
      if (early) {
        json(res, early.payload, early.status);
        return;
      }
      const share = await createShare(debateId, userId);
      json(res, share, 201);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-share',
        level: 'error',
        message: 'Failed to create debate share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // DELETE /api/debate/:id/share — Revoke share (owner-only)
  del('/api/debate/:id/share', async (req, res) => {
    try {
      if (isAnonymousUser()) {
        error(res, 'Sign in required', 401);
        return;
      }

      const debateId = param(req, 'id', '/api/debate/:id/share');
      const userId = getCurrentUserId();
      const shareId = await revokeOwnedShare(debateId, userId);
      if (!shareId) {
        error(res, 'Share not found', 404);
        return;
      }
      json(res, { id: shareId }, 200);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-share',
        level: 'error',
        message: 'Failed to revoke debate share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // GET /api/public/debate/:shareId — Public read (anonymous allowed)
  get('/api/public/debate/:shareId', async (req, res) => {
    try {
      const shareId = param(req, 'shareId', '/api/public/debate/:shareId');

      const clientIp = getClientIp(req);
      const limitKey = `debate-share-read:${clientIp}`;
      const rateCheck = checkRate(limitKey, PUBLIC_READ_RATE_LIMIT_PER_HOUR, 3600_000);
      if (!rateCheck.allowed) {
        res.writeHead(429, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(JSON.stringify({
          error: 'Rate limit exceeded',
          retryAfterMs: rateCheck.retryAfterMs,
        }));
        return;
      }

      const share = await loadShare(shareId);
      if (!share) {
        res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
        res.end(JSON.stringify({ error: 'Share not found or expired' }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      });
      // The public projection only: never the owner's userId or debateId.
      res.end(JSON.stringify(toPublicView(share)));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'debate-share',
        level: 'error',
        message: 'Failed to read debate share',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });
}

/** Find, verify ownership of, and revoke the debate's live share. Returns the revoked
 *  share's id, or null if there was no live share owned by this caller. */
async function revokeOwnedShare(debateId: string, userId: string): Promise<string | null> {
  try {
    const { registry, baseSha } = await readRegistry();
    const shareId = registry.shares[debateId];
    if (!shareId) return null;

    const share = await loadShare(shareId);
    if (!share || share.userId !== userId) return null;

    delete registry.shares[debateId];

    try {
      await writeRegistryCas(registry, baseSha);
    } catch (writeErr: unknown) {
      const err = writeErr as any;
      if (err.code === 'WRITE_CONFLICT' || err.message?.includes('412')) {
        getGlobalRecorder()?.record({
          type: 'system.error',
          component: 'debate-share',
          level: 'warn',
          message: 'Registry write conflict during DELETE (blob already revoked, ignoring)',
          error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
        });
      } else {
        throw writeErr;
      }
    }

    await revokeShare(shareId);
    return shareId;
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error',
      component: 'debate-share',
      level: 'warn',
      message: 'Error finding share for deletion',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    return null;
  }
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/185: Community draft submission flow. Drafts allow users to save an inquiry
// in progress before finalizing and submitting to community moderation.
// Per-client rate limiting uses IP address + session ID to prevent exhaustion.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, param } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getStorageUserId } from '../security/userContext.js';
import type { InquiryPayload } from '../../../../lib/inquiry/index.js';

export function registerDraftsRoutes(r: Router, ctx: ServerCtx): void {
  const { post, get } = r;

  /**
   * Derive clientId from request for per-client rate limiting.
   * Per t/185: IP address (simple, immediate) + session ID (if logged in).
   */
  function getClientId(req: any): string {
    const ip = req.ip || '0.0.0.0';
    const sessionId = getStorageUserId();
    return sessionId ? `${ip}|${sessionId}` : ip;
  }

  post('/api/drafts', async (req, res, body) => {
    try {
      const { payload, note } = body as { payload?: InquiryPayload; note?: string };
      if (!payload) {
        error(res, 'payload is required', 400);
        return;
      }

      const draftStore = ctx.getDraftStore();
      const clientId = getClientId(req);

      // Derive nodesById from taxonomy (TODO: integrate with taxonomy backend)
      // For now, pass empty map; node refs unknown to taxonomy will be dropped
      const nodesById = new Map();

      const result = await draftStore.createDraft(payload, {
        nodesById,
        clientId,
      });

      if (!result.ok) {
        if (result.reason === 'cap_reached') {
          res.setHeader('Retry-After', '3600'); // Suggest retry in 1 hour
          json(res, { error: 'cap_reached', message: 'Draft creation limit reached; please try again later.' }, 429);
          return;
        }
        // Invalid payload
        json(res, { error: result.reason, detail: result.detail }, 400);
        return;
      }

      json(res, {
        ok: true,
        draftId: result.draftId,
        expiresAt: result.expiresAt,
        url: `/draft/${result.draftId}`,
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to create draft',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  get('/api/drafts/:draftId', async (req, res) => {
    try {
      const draftId = param(req, 'draftId', '/api/drafts/:draftId');
      const draftStore = ctx.getDraftStore();

      const result = await draftStore.getDraft(draftId);
      if (!result.ok) {
        if (result.reason === 'expired') {
          json(res, { error: 'expired', message: 'This draft has expired.' }, 410);
          return;
        }
        if (result.reason === 'already_claimed') {
          json(res, { error: 'already_claimed', message: 'This draft has already been submitted.' }, 409);
          return;
        }
        error(res, 'Draft not found', 404);
        return;
      }

      json(res, {
        ok: true,
        draftId: result.draft.draftId,
        projection: result.draft.projection,
        note: result.draft.note,
        droppedRefs: result.draft.droppedRefs,
        droppedAuthFields: result.draft.droppedAuthFields,
        expiresAt: result.draft.expiresAt,
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to load draft',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });

  post('/api/drafts/:draftId/submit', async (req, res) => {
    try {
      const draftId = param(req, 'draftId', '/api/drafts/:draftId/submit');
      const draftStore = ctx.getDraftStore();

      const userId = getStorageUserId();
      if (!userId || userId.startsWith('_')) {
        error(res, 'Authentication required', 401);
        return;
      }

      const result = await draftStore.finalizeDraft(draftId, {
        storageUserId: userId,
        displayName: '', // TODO: integrate with user context for display name
      });

      if (!result.ok) {
        if (result.reason === 'expired') {
          json(res, { error: 'expired', message: 'This draft has expired.' }, 410);
          return;
        }
        if (result.reason === 'already_claimed') {
          json(res, { error: 'already_claimed', message: 'This draft has already been submitted.' }, 409);
          return;
        }
        if (result.reason === 'user_cap_reached' || result.reason === 'queue_full') {
          res.setHeader('Retry-After', '3600');
          json(res, { error: result.reason, message: 'Submission queue full; please try again later.' }, 429);
          return;
        }
        error(res, `Failed to submit draft: ${result.reason}`, 400);
        return;
      }

      json(res, {
        ok: true,
        submissionId: result.submissionId,
        message: 'Draft submitted to community review.',
      });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Failed to finalize draft',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), (err as { statusCode?: number }).statusCode ?? 500);
    }
  });
}

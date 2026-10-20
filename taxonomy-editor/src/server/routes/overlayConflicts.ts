// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4312/t/4315 — resolution routes for a conflicted overlay (SO condition F1, TL rulings
// p/538#94/#95/#97, Rosetta Stone's whole-batch catch p/641#10/#11). Both act on the caller's
// ENTIRE staged overlay, never a per-path subset — a per-path resolution could leave a kept
// file referencing one that was discarded (or vice versa), the exact cross-file inconsistency
// SO condition F2 exists to prevent. Neither route takes a `paths` body field.
//
// Both are idempotent-safe but not true no-ops on a second call: see each backend method's
// own doc comment (githubAPIBackend.ts) for the precise semantics. Neither 404s — an empty
// result (nothing was staged/conflicted) is success, not an error, per the PR #3467 contract.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUserId } from '../security/userContext.js';

export function registerOverlayConflictsRoutes(r: Router, ctx: ServerCtx): void {
  const { post } = r;

  post('/api/sync/overlay-conflicts/use-theirs', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    try {
      if (!githubBackend) {
        json(res, { discarded: [] }); // filesystem mode — no overlay semantics
        return;
      }
      const discarded = githubBackend.discardConflictedOverlayEntries(getCurrentUserId());
      json(res, { discarded });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'sync', level: 'error', message: 'overlay-conflicts/use-theirs failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  post('/api/sync/overlay-conflicts/keep-mine', async (_req, res) => {
    const githubBackend = ctx.getGithubBackend();
    const sessionManager = ctx.getSessionManager();
    try {
      if (!githubBackend || !sessionManager) {
        json(res, { committed: false, stillConflicted: [] }); // filesystem mode — no overlay semantics
        return;
      }
      const userId = getCurrentUserId();
      const branch = sessionManager.getActiveBranch(userId);
      if (!branch) {
        json(res, { committed: false, stillConflicted: [] }); // nothing staged — no session branch at all
        return;
      }
      // Captured before the rebase+commit clears the overlay — same pattern as POST
      // /api/sync/commit (routes/sync.ts) — so the broadcast below carries real content.
      const pending = githubBackend.getOverlayEntries(userId);
      const result = await githubBackend.rebaseAndRecommitConflictedOverlayEntries(userId, branch);
      json(res, result);
      if (result.committed) {
        // Best-effort; response already sent, never throws (t/652).
        await ctx.broadcastTaxonomyUpdate(githubBackend, pending, userId);
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'sync', level: 'error', message: 'overlay-conflicts/keep-mine failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}

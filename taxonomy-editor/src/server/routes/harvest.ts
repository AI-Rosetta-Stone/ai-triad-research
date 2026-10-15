// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/1347 (route extraction, t/1295 follow-up): the /api/harvest route cluster,
// moved verbatim out of server.ts behind the registration seam. Handlers are
// byte-identical except two ctx substitutions: the session-branch ensure and the
// conflicts-cache invalidation (harvest/conflict) now come through ServerCtx —
// `ensureSessionBranch()` and `invalidateConflictsCache()` — instead of the
// server.ts closures. All POST, distinct literals → no collision pairs.

import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import * as fileIO from '../storage/fileIO.js';

export function registerHarvestRoutes(r: Router, ctx: ServerCtx): void {
  const { post } = r;
  const { ensureSessionBranch, invalidateConflictsCache } = ctx;

  post('/api/harvest/conflict', async (_req, res, body) => {
    try {
      await ensureSessionBranch();
      const created = await fileIO.harvestCreateConflict(body as Record<string, unknown>);
      if (created) invalidateConflictsCache();
      json(res, { created });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to create harvested conflict', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  post('/api/harvest/debate-ref', async (_req, res, body) => {
    try {
      await ensureSessionBranch();
      const { nodeId, debateId } = body as { nodeId: string; debateId: string };
      json(res, { updated: await fileIO.harvestAddDebateRef(nodeId, debateId) });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to add debate reference during harvest', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  post('/api/harvest/steelman', async (_req, res, body) => {
    try {
      await ensureSessionBranch();
      const { nodeId, attackerPov, newText } = body as { nodeId: string; attackerPov: string; newText: string };
      json(res, { updated: await fileIO.harvestUpdateSteelman(nodeId, attackerPov, newText) });
    } catch (err) { getGlobalRecorder()?.record({ type: 'system.error', component: 'server', level: 'error', message: 'Failed to update steelman during harvest', error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack } }); error(res, String(err), statusForError(err), err, codeForError(err)); }
  });

  post('/api/harvest/verdict', async (_req, res, body) => {
    const { conflictId, verdict } = body as { conflictId: string; verdict: Record<string, unknown> };
    try {
      json(res, { updated: await fileIO.harvestAddVerdict(conflictId, verdict) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'harvest', level: 'error',
        message: 'Failed to add harvest verdict', data: { conflictId },
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), statusForError(err), err, codeForError(err));
    }
  });

  post('/api/harvest/concept', async (_req, res, body) => {
    try {
      json(res, { queued: await fileIO.harvestQueueConcept(body as Record<string, unknown>) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'harvest', level: 'error',
        message: 'Failed to queue harvest concept',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), statusForError(err), err, codeForError(err));
    }
  });

  post('/api/harvest/manifest', async (_req, res, body) => {
    try {
      json(res, { saved: await fileIO.harvestSaveManifest(body as Record<string, unknown>) });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'harvest', level: 'error',
        message: 'Failed to save harvest manifest',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), statusForError(err), err, codeForError(err));
    }
  });
}

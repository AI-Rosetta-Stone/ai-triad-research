// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4055 (t/4052 step 3): REST endpoints for the pov-tag-proposals.json review queue.
// GET  /api/pov-tag-proposals        → file object | null (absent → 200 null; parse failure → 500)
// POST /api/pov-tag-proposals/review → 200 { file, item } | 409 { refused, problems } | 405 on hosted
//
// POST is Electron-only (option ii, e/269#5/#7): the GitHub/hosted storage backend
// writes to a session branch with no verified path back to data main for this side file.
// Reviews must be submitted via the Electron desktop app, which writes directly to the
// local ai-triad-data checkout so the step-4 frozen list can be built from it.
// reviewed_by is sourced from getCurrentUserId(), never the request body.

import path from 'path';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error, statusForError, codeForError } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { getCurrentUserId } from '../security/userContext.js';
import { getBackend, getTaxonomyDir, readFileWithVersionOrFallback } from '../storage/fileIO.js';
import {
  parsePovTagProposals,
  applyProposalDecision,
  serializePovTagProposals,
  type ProposalDecision,
  type ProposalStatus,
  type ApplyProposalDecisionResult,
} from '../../../../lib/schema/povTagProposals.js';

const COMPONENT = 'pov-tag-proposals';

function proposalsFilePath(): string {
  return path.join(getTaxonomyDir(), 'pov-tag-proposals.json');
}

export function registerPovTagProposalsRoutes(router: Router, ctx: ServerCtx): void {
  const { get, post } = router;

  get('/api/pov-tag-proposals', async (_req, res) => {
    try {
      const raw = await getBackend().readFile(proposalsFilePath(), { optional: true });
      if (raw === null) { json(res, null); return; }
      const result = parsePovTagProposals(JSON.parse(raw));
      if (!result.ok) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: COMPONENT, level: 'error',
          message: 'pov-tag-proposals.json failed shape check',
          data: { problems: result.problems },
        });
        error(res, `pov-tag-proposals.json is malformed: ${result.problems.join('; ')}`, 500);
        return;
      }
      json(res, result.file);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: COMPONENT, level: 'error',
        message: 'Failed to read pov-tag-proposals.json',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // POST is Electron-only: the GitHub backend writes to a session branch with no
  // verified path back to data main for this side file (t/4055 design, e/269#5).
  post('/api/pov-tag-proposals/review', async (_req, res, body) => {
    if (ctx.getGithubBackend() !== null) {
      error(res, 'Reviews must be submitted via the Electron desktop app.', 405);
      return;
    }

    const b = (body ?? {}) as Record<string, unknown>;
    const nodeId = b.nodeId;
    const decision = b.decision as ProposalDecision | undefined;
    const expectedStatus = b.expectedStatus as ProposalStatus | undefined;
    if (typeof nodeId !== 'string' || !nodeId) { error(res, 'nodeId is required', 400); return; }
    if (!decision || typeof decision !== 'object') { error(res, 'decision is required', 400); return; }
    if (typeof expectedStatus !== 'string') { error(res, 'expectedStatus is required', 400); return; }

    try {
      const p = proposalsFilePath();
      const read = await readFileWithVersionOrFallback(p);
      if (read === null) { error(res, 'pov-tag-proposals.json not found', 404); return; }
      const parsed = parsePovTagProposals(JSON.parse(read.content));
      if (!parsed.ok) {
        getGlobalRecorder()?.record({
          type: 'system.error', component: COMPONENT, level: 'error',
          message: 'pov-tag-proposals.json failed shape check on review',
          data: { problems: parsed.problems },
        });
        error(res, `pov-tag-proposals.json is malformed: ${parsed.problems.join('; ')}`, 500);
        return;
      }
      const reviewedBy = getCurrentUserId();
      const result: ApplyProposalDecisionResult = applyProposalDecision(
        parsed.file, nodeId, decision, reviewedBy, new Date().toISOString(), expectedStatus,
      );
      if ('refused' in result) { json(res, result, 409); return; }
      // t/4332: baseSha from the read above — a concurrent writer that lands between this
      // read and this write now gets a storage-level WRITE_CONFLICT instead of silently
      // losing the other's update. Distinct from the `expectedStatus`/'refused' check above,
      // which only catches staleness the application layer can see (the decided item's
      // status), not a same-expectedStatus race between two requests.
      await getBackend().writeFile(p, serializePovTagProposals(result.file), { baseSha: read.version });
      json(res, { file: result.file, item: result.item });
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: COMPONENT, level: 'error',
        message: 'Failed to apply pov-tag-proposal review decision',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, (err as Error).message, statusForError(err), err, codeForError(err));
    }
  });
}

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2119: web-build transport for user preferences. GET returns the stored
// UserPreferences object or null (client falls back to default 'simple').
// PUT validates the body with Zod (400 on bad schema) and persists to a
// per-user JSON file; returns 204. Shape matches UserPreferences in bridge/types.ts.

import path from 'path';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { resolveDataPath } from '../config.js';
import { getStorageUserId, getCurrentUserId } from '../security/userContext.js';
import { getBackend } from '../storage/fileIO.js';
import { scheduleOverlayCommit } from '../storage/overlayCommitScheduler.js';
// t/3537 (t/3534): the single shared UserPreferences schema (t/3535) — both read
// boundaries (this route + ElectronMain's get-preferences IPC) validate against
// the same source so Electron and web can't silently diverge. Replaces the local
// inline copy this route used to declare.
import { UserPreferencesSchema, validateUserPreferencesOrDefault } from '../../../../lib/userPreferencesSchema.js';

export function registerPreferencesRoutes(r: Router, ctx: ServerCtx): void {
  const { get, put } = r;

  // GET /api/preferences — null when no file yet (client defaults to 'simple').
  // NB: path is a string literal (not a const) so extractRoutes.ts can see it.
  get('/api/preferences', async (_req, res) => {
    try {
      // t/4375: getBackend().readFile(), NOT readDataFile() — readDataFile's non-largeFile path
      // calls readBinaryFile(), which (unlike readFile()/readFileWithVersion()) never checks the
      // session overlay, so it would miss a just-written-this-session preference until the
      // debounced overlay commit lands. readFile() checks the overlay first (see PUT below for
      // why that overlay write exists), so a GET right after a PUT sees it immediately.
      const filePath = resolveDataPath(path.join('preferences', `${getStorageUserId()}.json`));
      const raw = await getBackend().readFile(filePath, { optional: true });
      if (raw === null || raw.length === 0) { json(res, null); return; } // no prefs yet
      // t/3537: validate the stored (untrusted) file against the shared schema. A
      // present-but-invalid file (stale schema, hand-edit) degrades to defaults +
      // an FR WARN naming the offending field, never a throw.
      const parsed = JSON.parse(raw) as unknown;
      json(res, validateUserPreferencesOrDefault(parsed, 'server'));
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to read preferences',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });

  // PUT /api/preferences — Zod-validated; 400 on bad schema, 204 on success.
  put('/api/preferences', async (_req, res, body) => {
    try {
      const parsed = UserPreferencesSchema.safeParse(body);
      if (!parsed.success) {
        error(res, 'Invalid preferences: ' + parsed.error.message, 400);
        return;
      }
      // t/4375 (t/4372 finding): write through the same storage backend GET uses above,
      // instead of a raw fs write. ensureSessionBranch() is required FIRST —
      // without it, an anonymous/no-session caller's effective ref is main itself and the
      // GitHub backend would attempt a DIRECT COMMIT TO MAIN instead of the safe per-user
      // overlay path (GitHubAPIBackend.assertDirectWriteAllowed only guards the inverse case:
      // hasSessionContext()===true while ref still resolves to main). On the GitHub backend
      // the write then takes the overlay fast-path onto the caller's own session branch, so
      // scheduleOverlayCommit() below is required too, matching
      // policyRegistry.ts/povTagProposals.ts's identical overlay+schedule pattern, or the write
      // is lost on restart/scale-to-zero before ever committing (t/4258). No-op on filesystem
      // mode (ensureSessionBranch, writeFile, scheduleOverlayCommit all no-op/trivial there).
      await ctx.ensureSessionBranch();
      const filePath = resolveDataPath(path.join('preferences', `${getStorageUserId()}.json`));
      await getBackend().writeFile(filePath, JSON.stringify(parsed.data));
      scheduleOverlayCommit(getCurrentUserId());
      json(res, null, 204);
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error', component: 'server', level: 'error',
        message: 'Failed to write preferences',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      error(res, String(err), 500, err);
    }
  });
}

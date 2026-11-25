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
import { getStorageUserId } from '../security/userContext.js';
import { getBackend, getUserContentBackend } from '../storage/fileIO.js';
import { log } from '../logger.js';
// t/3537 (t/3534): the single shared UserPreferences schema (t/3535) — both read
// boundaries (this route + ElectronMain's get-preferences IPC) validate against
// the same source so Electron and web can't silently diverge. Replaces the local
// inline copy this route used to declare.
import { UserPreferencesSchema, validateUserPreferencesOrDefault } from '../../../../lib/userPreferencesSchema.js';

// t/629 (t/638, Security p/93#85): preferences are per-user data, so they live in the USER-CONTENT backend (Azure Blob
// when hosted, the local filesystem otherwise), never in the data repo. Before this, PUT wrote through getBackend(),
// i.e. the caller's session-branch overlay of the PUBLIC ai-triad-data repo, committed by the overlay scheduler. The
// data-repo allowlist (t/638) now refuses that path. In filesystem mode both backends are the same, so nothing moves.
function prefsPath(): string {
  return resolveDataPath(path.join('preferences', `${getStorageUserId()}.json`));
}

/** A preference file written before t/629 sits in the data repo. Read it once, read-only, so a user's setting isn't
 *  lost when they next load; the next PUT writes it to the user-content backend. Logged when taken. */
async function readLegacyPrefs(filePath: string): Promise<string | null> {
  if (getBackend() === getUserContentBackend()) return null; // filesystem mode: same store, nothing legacy
  try {
    const raw = await getBackend().readFile(filePath, { optional: true });
    if (raw) log.server.warn({ component: 'preferences' }, 'preferences: read the pre-t/629 copy from the data repo (read-only); the next save moves it to user content');
    return raw;
  } catch (err) {
    log.server.warn({ component: 'preferences', err: String(err) }, 'preferences: legacy data-repo read failed; using defaults (t/629)');
    return null;
  }
}

export function registerPreferencesRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, put } = r;

  // GET /api/preferences — null when no file yet (client defaults to 'simple').
  // NB: path is a string literal (not a const) so extractRoutes.ts can see it.
  get('/api/preferences', async (_req, res) => {
    try {
      const filePath = prefsPath();
      const raw = (await getUserContentBackend().readFile(filePath, { optional: true })) ?? (await readLegacyPrefs(filePath));
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
      // t/629: the user-content backend, never the data repo. No session branch and no overlay commit: those exist
      // only for data-repo writes (the reason t/4375 added them here).
      await getUserContentBackend().writeFile(prefsPath(), JSON.stringify(parsed.data));
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

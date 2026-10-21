// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/2119: web-build transport for user preferences. GET returns the stored
// UserPreferences object or null (client falls back to default 'simple').
// PUT validates the body with Zod (400 on bad schema) and persists to a
// per-user JSON file; returns 204. Shape matches UserPreferences in bridge/types.ts.

import fs from 'fs';
import path from 'path';
import type { Router } from '../httpKit.js';
import type { ServerCtx } from './context.js';
import { json, error } from '../httpKit.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { resolveDataPath } from '../config.js';
import { getStorageUserId } from '../security/userContext.js';
import { readDataFile } from '../storage/readDataFile.js';
import { ActionableError } from '../../../../lib/debate/errors.js';
// t/3537 (t/3534): the single shared UserPreferences schema (t/3535) — both read
// boundaries (this route + ElectronMain's get-preferences IPC) validate against
// the same source so Electron and web can't silently diverge. Replaces the local
// inline copy this route used to declare.
import { UserPreferencesSchema, validateUserPreferencesOrDefault } from '../../../../lib/userPreferencesSchema.js';

export function registerPreferencesRoutes(r: Router, _ctx: ServerCtx): void {
  const { get, put } = r;

  // GET /api/preferences — null when no file yet (client defaults to 'simple').
  // NB: path is a string literal (not a const) so extractRoutes.ts can see it.
  get('/api/preferences', async (_req, res) => {
    try {
      const relPath = path.join('preferences', `${getStorageUserId()}.json`);
      const buf = await readDataFile(relPath);
      // t/3537: validate the stored (untrusted) file against the shared schema. A
      // present-but-invalid file (stale schema, hand-edit) degrades to defaults +
      // an FR WARN naming the offending field, never a throw — missing/empty file
      // is a distinct case handled by the ActionableError catch below (→ null).
      const parsed = JSON.parse(buf.toString('utf8')) as unknown;
      json(res, validateUserPreferencesOrDefault(parsed, 'server'));
    } catch (err) {
      // readDataFile throws ActionableError for missing/empty file — no prefs yet.
      if (err instanceof ActionableError) { json(res, null); return; }
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
      const filePath = resolveDataPath(path.join('preferences', `${getStorageUserId()}.json`));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // t/4372 finding, NOT fixed here: this write bypasses the storage backend GET already uses
      // (readDataFile → getBackend()), so a naive getStateRoot() swap would desync the read/write
      // pair on staging. Needs investigation of whether getBackend() even serves preferences
      // correctly on hosted mode first — tracked in t/4375, remove this disable when that lands.
      // eslint-disable-next-line local/no-data-root-write -- see comment above
      fs.writeFileSync(filePath, JSON.stringify(parsed.data), 'utf8');
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

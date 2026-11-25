// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// The file-based user allowlist (authorized-users.json), MOVED VERBATIM out of server.ts (t/625) so its source can be
// tested. One change: it reads from the STATE root, not the data root (t/617 B). On prod the state root is the data
// root (AI_TRIAD_STATE_ROOT is unset there), so prod reads the same file as before. On staging it is staging's own
// share, so staging never reads an allowlist from prod's grounding data.

import fs from 'fs';
import path from 'path';
import { getStateRoot } from './config.js';
import { log } from './logger.js';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';

export interface AuthorizedUser {
  name: string;
  emails?: string[];
  github?: string;
}

export interface AuthorizedUsersFile {
  users: AuthorizedUser[];
}

export function loadAuthorizedUsers(): AuthorizedUsersFile | null {
  // Only load from the data volume — auth is opt-in per deployment.
  // Drop authorized-users.json into /data/ (Azure Files) to enable the gate.
  const candidates = [
    // t/625 (t/617 B): the allowlist is per-deployment config, so it comes from the state root. On prod that IS the
    // data root (no change); on staging it is staging's own share, never prod's.
    path.join(getStateRoot(), 'authorized-users.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        // The allowlist is mount-sourced BY DESIGN: routing it through readDataFile would flip the trust source from the
        // mount to the data-repo-via-API (auth surface — t/3093#3, ServerAPI route-b). t/625: the mount is the state root.
        const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as AuthorizedUsersFile;
        log.auth.info({ count: data.users.length, path: p }, 'Loaded authorized users');
        return data;
      }
    } catch (err) {
      getGlobalRecorder()?.record({
        type: 'system.error',
        component: 'server',
        level: 'error',
        message: 'Operation failed',
        error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      });
      log.auth.error({ path: p, err }, 'Failed to parse authorized users file');
    }
  }
  return null; // No file found = no restriction
}

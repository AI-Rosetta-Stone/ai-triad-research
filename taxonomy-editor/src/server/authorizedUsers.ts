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
import { ActionableError } from '../../../lib/debate/errors.js';

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

/** True when this deployment needs the allowlist to gate sign-in: neither AUTH_DISABLED nor AUTH_OPTIONAL is set. */
export function requiredAuthMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_DISABLED !== '1' && env.AUTH_OPTIONAL !== '1';
}

/**
 * t/625 (Security p/93#80): a hosted deployment in required-auth mode with no readable allowlist must fail CLOSED.
 * loadAuthorizedUsers() returns null for a missing or unreadable file, and the gate reads null as "no restriction",
 * so without this a missing file (for example a state root that was never seeded) would open the deployment to any
 * signed-in user. Called once at boot, before the server listens; it throws and the process refuses to start.
 * Hosted means Azure Container Apps (CONTAINER_APP_NAME is injected by the platform). Local, Electron and
 * filesystem-mode runs, and any deployment in optional or disabled auth mode, are unaffected.
 */
export function assertAllowlistForRequiredAuth(
  env: NodeJS.ProcessEnv = process.env,
  load: () => AuthorizedUsersFile | null = loadAuthorizedUsers,
): void {
  if (!env.CONTAINER_APP_NAME || !requiredAuthMode(env)) return;
  if (load() !== null) return;
  throw new ActionableError({
    goal: 'Start a hosted deployment that requires sign-in',
    problem: `Required-auth mode (neither AUTH_DISABLED nor AUTH_OPTIONAL is set) but ${path.join(getStateRoot(), 'authorized-users.json')} is missing or unreadable, which would let any signed-in user in.`,
    location: 'authorizedUsers.assertAllowlistForRequiredAuth',
    nextSteps: [
      "Seed authorized-users.json in this deployment's state root (AI_TRIAD_STATE_ROOT, or the data root when unset)",
      'Or deploy with auth_mode optional or disabled if sign-in is not meant to be required',
    ],
    code: 'ALLOWLIST_MISSING_REQUIRED_AUTH',
    httpStatus: 500,
  });
}

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

/** A hosted deployment (Azure Container Apps injects CONTAINER_APP_NAME) that requires sign-in. */
function hostedRequiredAuth(env: NodeJS.ProcessEnv): boolean {
  return !!env.CONTAINER_APP_NAME && requiredAuthMode(env);
}

/**
 * t/625 (Security p/93#80, p/93#100): a hosted, required-auth deployment with no readable allowlist fails CLOSED at the
 * gate. loadAuthorizedUsers() returns null for a missing or unreadable file, and the gate reads null as "no restriction",
 * so a state root that wasn't seeded (or a mount that hasn't settled yet) would let any signed-in user in. Here null is
 * replaced by an EMPTY allowlist: the required-auth gate then runs and denies every sign-in (403 user_not_in_allowlist).
 * The caller's cache re-reads every 30 s, so a late mount recovers without a restart. No boot throw: a slow mount must
 * not crash-loop the process (t/2683, t/3309). /readyz reports it (allowlistRequiredButMissing). Unchanged: local,
 * Electron and filesystem-mode runs; optional or disabled auth mode (null still means "not consulted" there); and
 * AUTH_ALLOW_ALL_SIGNED_IN, which by design admits any signed-in user whatever the list holds.
 */
export function resolveAllowlist(
  env: NodeJS.ProcessEnv = process.env,
  load: () => AuthorizedUsersFile | null = loadAuthorizedUsers,
): AuthorizedUsersFile | null {
  const loaded = load();
  if (loaded !== null || !hostedRequiredAuth(env)) return loaded;
  const err = new ActionableError({
    goal: 'Gate sign-in on a hosted deployment that requires it',
    problem: `Required-auth mode but ${path.join(getStateRoot(), 'authorized-users.json')} is missing or unreadable; denying every sign-in until it is present.`,
    location: 'authorizedUsers.resolveAllowlist',
    nextSteps: [
      "Seed authorized-users.json in this deployment's state root (AI_TRIAD_STATE_ROOT, or the data root when unset)",
      'Or deploy with auth_mode optional or disabled if sign-in is not meant to be required',
    ],
    code: 'ALLOWLIST_MISSING_REQUIRED_AUTH',
    httpStatus: 403,
  });
  log.auth.warn({ component: 'auth', code: 'ALLOWLIST_MISSING_REQUIRED_AUTH' }, err.message);
  return { users: [] };
}

/** For /readyz: true while a hosted, required-auth deployment has no readable allowlist (sign-in is being denied). */
export function allowlistRequiredButMissing(
  env: NodeJS.ProcessEnv = process.env,
  load: () => AuthorizedUsersFile | null = loadAuthorizedUsers,
): boolean {
  return hostedRequiredAuth(env) && load() === null;
}

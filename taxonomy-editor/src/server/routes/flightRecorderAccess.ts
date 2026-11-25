// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/579 (incident): access rules for the flight-recorder dump routes in diagnostics.ts.
//
// Server dumps hold the unfiltered server event buffer and drained server log lines, so list, download, view and
// server-dump are admin-only on a hosted server. Single-operator local mode (AUTH_DISABLED=1 outside production) keeps
// access, as with the key gate: there the operator is the owner. Filenames are confined to the dump directory: one
// path segment from a strict character set, an allowlisted prefix, and a resolved path that stays inside the dir.

import path from 'path';
import type http from 'http';
import { requireAdmin } from '../community/admin/reviewRegistry.js';
import { isAuthDisabledMode } from '../security/userContext.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import { log } from '../logger.js';

/** Admin on a hosted server; the operator in AUTH_DISABLED local mode. Writes 403 and returns false otherwise. */
export function requireFlightRecorderAccess(res: http.ServerResponse): boolean {
  if (isAuthDisabledMode()) return true;
  return requireAdmin(res);
}

/** The only names a dump file can have: client and server dumps written by the dump routes. One segment, no '%'. */
const DUMP_NAME = /^(server-)?flight-recorder-[A-Za-z0-9._-]+\.jsonl$/;

/** The absolute path of a dump file inside `dumpDir`, or null when the name is not a plain dump filename.
 *  `name` is the route parameter as param() returns it (already URL-decoded once); it is not decoded again. */
export function resolveDumpFile(dumpDir: string, name: string): string | null {
  const reject = (reason: string): null => {
    log.server.warn({ component: 'flight-recorder', reason, nameLength: name.length }, `flight-recorder filename refused: ${reason} (t/579)`);
    getGlobalRecorder()?.record({ type: 'system.error', component: 'flight-recorder', level: 'warn', message: `flight-recorder filename refused: ${reason} (t/579)` });
    return null;
  };
  if (!name || name.length > 200) return reject('empty or too long');
  if (name.includes('..') || /[/\\\0%]/.test(name)) return reject('path characters');
  if (!DUMP_NAME.test(name)) return reject('not a dump filename');
  if (path.basename(name) !== name) return reject('not a single segment');
  const root = path.resolve(dumpDir);
  const resolved = path.resolve(root, name);
  if (path.dirname(resolved) !== root) return reject('resolves outside the dump directory');
  return resolved;
}

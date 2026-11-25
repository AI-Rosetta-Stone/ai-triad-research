// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/613 (incident t/579 follow-up): the server writes a flight-recorder dump on every shutdown and every uncaught crash,
// and nothing ever removed them; prod and staging held about 4,000. Each write now prunes the oldest: a dump is kept
// only while it is among the newest MAX_COUNT AND younger than MAX_AGE_MS (whichever is smaller wins). Synchronous,
// because both callers run on paths that may exit right after (SIGTERM shutdown, uncaughtException). Never throws:
// a failed write or prune is logged as a WARN and the caller carries on.

import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export const LIFECYCLE_DUMP_MAX_COUNT = 200;
export const LIFECYCLE_DUMP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** t/613 (TL p/16#368): the prune never touches a dump written before this cutoff, so the ~4,000-file backlog stays
 *  until the PI decides on it (after Security's scan). One config value: env LIFECYCLE_DUMP_PRUNE_SINCE, an ISO date or
 *  epoch ms, default 2026-11-25T00:00:00Z. Set it to 'none' to remove the floor: then the cap also clears the backlog. */
export const LIFECYCLE_DUMP_PRUNE_SINCE_DEFAULT = Date.UTC(2026, 10, 25);

/** The prune floor in epoch ms, or null for none. An unparsable value falls back to the default with a WARN. */
export function lifecycleDumpPruneSince(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LIFECYCLE_DUMP_PRUNE_SINCE?.trim();
  if (!raw) return LIFECYCLE_DUMP_PRUNE_SINCE_DEFAULT;
  if (raw.toLowerCase() === 'none') return null;
  const n = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (Number.isFinite(n)) return n;
  log.server.warn({ component: 'flight-recorder', value: raw }, 'LIFECYCLE_DUMP_PRUNE_SINCE unparsable; using the default floor (t/613)');
  return LIFECYCLE_DUMP_PRUNE_SINCE_DEFAULT;
}

/** The only files this module writes and prunes. Other dumps in the folder are left alone. */
const LIFECYCLE_DUMP = /^server-(shutdown|crash)-(\d+)\.jsonl$/;

export interface LifecycleDumpOptions {
  now?: number;
  maxCount?: number;
  maxAgeMs?: number;
  /** Prune floor in epoch ms (null for none); defaults to lifecycleDumpPruneSince(). */
  pruneSince?: number | null;
  /** Test seam for the delete; defaults to fs.unlinkSync. */
  unlink?: (file: string) => void;
}

export interface LifecycleDumpResult { written: string | null; pruned: number; pruneFailures: number }

/** Write `server-<kind>-<now>.jsonl` into dumpDir, then prune old lifecycle dumps. Never throws. */
export function writeLifecycleDump(dumpDir: string, kind: 'shutdown' | 'crash', ndjson: string, opts: LifecycleDumpOptions = {}): LifecycleDumpResult {
  const now = opts.now ?? Date.now();
  let written: string | null = null;
  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    written = path.join(dumpDir, `server-${kind}-${now}.jsonl`);
    fs.writeFileSync(written, ndjson);
  } catch (err) {
    written = null;
    log.server.warn({ component: 'flight-recorder', kind, err: String(err) }, `lifecycle dump write failed (t/613)`);
  }
  return { written, ...pruneLifecycleDumps(dumpDir, { ...opts, now }) };
}

/** Delete lifecycle dumps beyond the newest maxCount or older than maxAgeMs. Never throws; failures are counted and WARN-logged. */
export function pruneLifecycleDumps(dumpDir: string, opts: LifecycleDumpOptions = {}): { pruned: number; pruneFailures: number } {
  const now = opts.now ?? Date.now();
  const maxCount = opts.maxCount ?? LIFECYCLE_DUMP_MAX_COUNT;
  const maxAgeMs = opts.maxAgeMs ?? LIFECYCLE_DUMP_MAX_AGE_MS;
  const unlink = opts.unlink ?? ((f: string) => fs.unlinkSync(f));
  const since = opts.pruneSince !== undefined ? opts.pruneSince : lifecycleDumpPruneSince();
  let names: string[];
  try {
    names = fs.readdirSync(dumpDir);
  } catch (err) {
    log.server.warn({ component: 'flight-recorder', err: String(err) }, 'lifecycle dump prune skipped: dump directory unreadable (t/613)');
    return { pruned: 0, pruneFailures: 1 };
  }
  const dumps = names
    .map(name => ({ name, ts: Number(LIFECYCLE_DUMP.exec(name)?.[2]) }))
    .filter(d => Number.isFinite(d.ts))
    .sort((a, b) => b.ts - a.ts); // newest first
  // The cap counts every lifecycle dump, but only dumps at or after the floor are ever deleted (the backlog stays).
  const doomed = dumps.filter((d, i) => (i >= maxCount || now - d.ts > maxAgeMs) && (since === null || d.ts >= since));
  let pruned = 0;
  let pruneFailures = 0;
  for (const d of doomed) {
    try { unlink(path.join(dumpDir, d.name)); pruned++; } catch (err) {
      pruneFailures++;
      if (pruneFailures === 1) log.server.warn({ component: 'flight-recorder', file: d.name, err: String(err) }, 'lifecycle dump prune failed (t/613)');
    }
  }
  if (pruneFailures > 1) log.server.warn({ component: 'flight-recorder', pruneFailures, pruned }, 'lifecycle dump prune: further deletes failed (t/613)');
  return { pruned, pruneFailures };
}

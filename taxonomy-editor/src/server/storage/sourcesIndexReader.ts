// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Reads `sources-index.json` (t/4334#18, `lib/sourceIndex/sourcesIndexSchema.ts`)
 * — the precomputed index of `ai-triad-sources` that `nodeSourceIndex.ts` uses
 * in place of a direct per-doc scan of `getSourcesDir()`. Hosted (github-api
 * mode) has no access to that separate repo at all (the t/4334 AC1 incident:
 * `listDirectory` on a sibling-repo path silently returned `[]`, so every
 * doc's title/url/hash/authors was unavailable with zero WARN anywhere).
 *
 * **Never return `[]`/empty silently.** Any failure to produce a usable
 * index — missing file, malformed JSON, unrecognized `schema_version` — is
 * WARN-logged here, and the caller falls back to the direct-sourcesDir-scan
 * path (which itself now WARNs on an empty configured directory, t/4334#18
 * point 4). This module only verifies the index parses as the schema it
 * expects; whether its *content* is actually current relative to the live
 * `ai-triad-sources` HEAD is the generator workflow's job (DevOps wiring it
 * to run on push plus nightly), not something a reader with no access to
 * that repo can independently check.
 */

import path from 'path';
import { loadDataConfig, resolveDataPath } from '../config.js';
import { log } from '../logger.js';
import { getGlobalRecorder } from '../../../../lib/flight-recorder/index.js';
import {
  SOURCES_INDEX_SCHEMA_VERSION, SOURCES_INDEX_FILENAME, type SourcesIndexFile,
} from '../../../../lib/sourceIndex/sourcesIndexSchema.js';
import { getBackend } from './fileIO.js';

function sourcesIndexPath(): string {
  return resolveDataPath(path.join(loadDataConfig().taxonomy_dir, SOURCES_INDEX_FILENAME));
}

function warnSourcesIndexUnusable(reason: string, detail: Record<string, unknown>): void {
  log.server.warn({ reason, ...detail }, `sources-index.json unusable, falling back to direct source reads: ${reason}`);
  getGlobalRecorder()?.record({
    type: 'system.error', component: 'node-source-index', level: 'warn',
    message: `sources-index.json unusable, falling back to direct source reads: ${reason}`,
    data: { reason, ...detail },
  });
}

/** Loose shape check before trusting the parsed JSON as `SourcesIndexFile` —
 *  catches a hand-edited or wrong-schema file, not just a parse error. */
function looksLikeSourcesIndexFile(value: unknown): value is { schema_version: unknown; docs: unknown } {
  return typeof value === 'object' && value !== null && 'schema_version' in value && 'docs' in value;
}

/** Returns the parsed index, or `null` (WARN-logged) when it's missing,
 *  unreadable, malformed, or built from a `schema_version` this reader
 *  doesn't recognize. Never throws. */
export async function loadSourcesIndex(): Promise<SourcesIndexFile | null> {
  const indexPath = sourcesIndexPath();
  let raw: string | null;
  try {
    raw = await getBackend().readFile(indexPath, { optional: true });
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: 'sources-index.json unusable, falling back to direct source reads: read failed',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { reason: 'read failed', indexPath },
    });
    log.server.warn({ reason: 'read failed', indexPath, err }, 'sources-index.json unusable, falling back to direct source reads: read failed');
    return null;
  }
  if (raw === null) {
    warnSourcesIndexUnusable('missing', { indexPath });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'node-source-index', level: 'warn',
      message: 'sources-index.json unusable, falling back to direct source reads: malformed JSON',
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
      data: { reason: 'malformed JSON', indexPath },
    });
    log.server.warn({ reason: 'malformed JSON', indexPath, err }, 'sources-index.json unusable, falling back to direct source reads: malformed JSON');
    return null;
  }

  if (!looksLikeSourcesIndexFile(parsed) || !Array.isArray(parsed.docs) || typeof parsed.schema_version !== 'number') {
    warnSourcesIndexUnusable('unexpected shape', { indexPath });
    return null;
  }
  if (parsed.schema_version !== SOURCES_INDEX_SCHEMA_VERSION) {
    warnSourcesIndexUnusable('schema_version mismatch (stale)', {
      indexPath, found: parsed.schema_version, expected: SOURCES_INDEX_SCHEMA_VERSION,
    });
    return null;
  }

  return parsed as SourcesIndexFile;
}

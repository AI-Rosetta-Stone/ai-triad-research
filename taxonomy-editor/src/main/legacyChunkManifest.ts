// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/585 (t/572, spec 6.2): reads the legacy-chunk manifest for the desktop node-source index.
 * The manifest is one shared file, `docs/specs/source-identity-legacy-chunks.json`, that the
 * PowerShell, Python, server and lib readers all load. Its shape is checked by the lib's
 * `loadLegacyChunkManifest`.
 *
 * Kept out of fileIO.ts so tests can swap in a per-case manifest (`vi.mock` this module), and
 * so a missing or malformed file degrades to "no chunks folded" with a WARN instead of failing
 * the whole index build. Without the manifest, every chunk is still its own source, which is
 * how the index behaved before t/572.
 */

import fs from 'fs';
import path from 'path';
import { getGlobalRecorder } from '../../../lib/flight-recorder/index.js';
import { loadLegacyChunkManifest, type LegacyChunkManifest } from '../../../lib/sourceIndex/evidenceUnion.js';

export const LEGACY_CHUNK_MANIFEST_REL_PATH = path.join('docs', 'specs', 'source-identity-legacy-chunks.json');

export function readLegacyChunkManifest(projectRoot: string): LegacyChunkManifest {
  const file = path.join(projectRoot, LEGACY_CHUNK_MANIFEST_REL_PATH);
  try {
    return loadLegacyChunkManifest(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (err) {
    getGlobalRecorder()?.record({
      type: 'system.error', component: 'file-io', level: 'warn',
      message: `legacy-chunk manifest unreadable at ${file}; no chunks folded (each stays its own source)`,
      error: { name: (err as Error).name ?? 'Error', message: String(err), stack: (err as Error).stack },
    });
    console.warn(`[fileIO] WARN legacy-chunk manifest unreadable at ${file}; no chunks folded: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

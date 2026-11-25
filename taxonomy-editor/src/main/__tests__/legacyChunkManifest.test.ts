// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * t/585: the desktop reads the one shared legacy-chunk manifest
 * (docs/specs/source-identity-legacy-chunks.json), the same file the lib, server and
 * PowerShell readers load. A missing file folds nothing and WARNs instead of throwing.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { readLegacyChunkManifest, LEGACY_CHUNK_MANIFEST_REL_PATH } from '../legacyChunkManifest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('readLegacyChunkManifest (t/585)', () => {
  it('loads exactly the chunks map of the shared file', () => {
    const file = JSON.parse(fs.readFileSync(path.join(repoRoot, LEGACY_CHUNK_MANIFEST_REL_PATH), 'utf-8'));
    const manifest = readLegacyChunkManifest(repoRoot);
    expect(manifest).toEqual(file.chunks);
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
  });

  it('a missing file folds nothing and WARNs', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 't585-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(readLegacyChunkManifest(empty)).toEqual({});
      expect(warn.mock.calls.some(a => String(a[0]).includes('WARN legacy-chunk manifest unreadable'))).toBe(true);
    } finally {
      warn.mockRestore();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

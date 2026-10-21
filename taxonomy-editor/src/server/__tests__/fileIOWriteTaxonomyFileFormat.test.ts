// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4353 (Shared Lib, p/692#13): writeTaxonomyFile omitted the trailing
 * newline the canonical POV-file format requires (JSON.stringify(o, null, 2)
 * + "\n", matching the desktop writer and every file on disk today) — the
 * first hosted save would have forked the format and tripped t/4353's drift
 * check on every subsequent one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataRoot: string;

describe('writeTaxonomyFile: on-disk format (t/4353)', () => {
  beforeAll(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 't4353-write-format-'));
    fs.mkdirSync(path.join(dataRoot, 'taxonomy', 'Origin'), { recursive: true });
    process.env.AI_TRIAD_DATA_ROOT = dataRoot;
  });

  afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    delete process.env.AI_TRIAD_DATA_ROOT;
  });

  it('writes a trailing newline, matching the desktop writer\'s canonical format', async () => {
    const fileIO = await import('../storage/fileIO.js');
    await fileIO.writeTaxonomyFile('accelerationist', { nodes: [] });

    const raw = fs.readFileSync(path.join(dataRoot, 'taxonomy', 'Origin', 'accelerationist.json'), 'utf-8');
    expect(raw).toBe(JSON.stringify({ nodes: [] }, null, 2) + '\n');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.endsWith('\n\n')).toBe(false);
  });
});

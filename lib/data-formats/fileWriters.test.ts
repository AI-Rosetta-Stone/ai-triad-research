// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/4353: lib/data-formats/file-writers.json is the single file-to-writer map that the t/4353 drift check and
// t/4356's json-canonical.mjs both read. This keeps it well-formed and keeps every writer reference pointing at a
// file that exists, so a rename or deletion can't leave the map silently stale.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const registry = JSON.parse(readFileSync(path.join(REPO_ROOT, 'lib/data-formats/file-writers.json'), 'utf-8')) as {
  schema: number;
  files: Record<string, { format: string; definition: string; writers: string[]; retired_writers?: string[]; known_mismatches?: string[]; measured: Record<string, string> }>;
};

/** `<lang>:<repo path> <rest>` → the repo path. */
const pathOf = (ref: string): string => {
  const m = /^(ts|ps|py):(\S+)/.exec(ref);
  if (!m) throw new Error(`writer ref without a <lang>:<path> prefix: ${ref}`);
  return m[2];
};

describe('lib/data-formats/file-writers.json (t/4353)', () => {
  it('is schema 1 and covers the five corpus files the CL measured, plus situations.json (t/4356)', () => {
    expect(registry.schema).toBe(1);
    expect(Object.keys(registry.files).sort()).toEqual([
      'taxonomy/Origin/accelerationist.json',
      'taxonomy/Origin/edges.json',
      'taxonomy/Origin/embeddings.json',
      'taxonomy/Origin/safetyist.json',
      'taxonomy/Origin/situations.json',
      'taxonomy/Origin/skeptic.json',
    ]);
  });

  it('every entry names a format, a definition, at least one writer and a measurement', () => {
    for (const [file, e] of Object.entries(registry.files)) {
      expect(e.format, file).toMatch(/\S/);
      expect(e.definition, file).toMatch(/\S/);
      expect(e.writers.length, file).toBeGreaterThan(0);
      expect(Object.keys(e.measured).length, file).toBeGreaterThan(0);
    }
  });

  it('every writer, retired writer and mismatch reference points at a file that exists', () => {
    const refs = Object.values(registry.files).flatMap((e) => [...e.writers, ...(e.retired_writers ?? []), ...(e.known_mismatches ?? [])]);
    for (const ref of refs) expect(existsSync(path.join(REPO_ROOT, pathOf(ref))), ref).toBe(true);
  });

  it('a known mismatch names one of that file\'s own writers', () => {
    for (const [file, e] of Object.entries(registry.files)) {
      const writerPaths = new Set(e.writers.map(pathOf));
      for (const m of e.known_mismatches ?? []) expect(writerPaths.has(pathOf(m)), `${file}: ${m}`).toBe(true);
    }
  });
});

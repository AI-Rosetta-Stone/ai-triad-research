// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/4510 (TL condition, t/4510#3): `opts.consultOverlayOnPin: true` opts a
 * caller back into the pre-t/4510 "overlay regardless of the pin" behavior —
 * the one documented exception is `calibrationStore.ts`'s append-within-
 * request flows. The opt-out shouldn't spread silently; any new user has to
 * show up in review. This guard fails the build if the literal appears
 * anywhere else in production source.
 *
 * Text-scan, not AST (unlike routeEntitlement.test.ts's semantic gate) — the
 * thing being guarded is a literal call-site opt-in, not a structural pattern,
 * so a substring match is the right-sized check. Test files are excluded:
 * `githubApiReadFileOverlayPin.test.ts` legitimately exercises the flag
 * itself as a test fixture, not a production caller.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_FILE = 'storage/calibrationStore.ts';
const NEEDLE = /consultOverlayOnPin\s*:\s*true/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips `/* ... *\/` block comments and `// ...` line comments so a doc
 *  comment MENTIONING the flag (as this file's own docstrings do, to explain
 *  the exception) doesn't false-positive as a real call site setting it. Not
 *  a full parser — good enough for a literal guard, same "right-sized check"
 *  reasoning as the module doc comment above. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('opts.consultOverlayOnPin is confined to calibrationStore.ts (t/4510 TL condition)', () => {
  it('no other production source file sets consultOverlayOnPin: true', () => {
    const offenders: Array<{ file: string; line: number }> = [];
    for (const file of walk(SERVER_DIR)) {
      const relPath = relative(SERVER_DIR, file).replace(/\\/g, '/');
      if (relPath === ALLOWED_FILE) continue;
      const lines = stripComments(readFileSync(file, 'utf-8')).split('\n');
      lines.forEach((line, i) => {
        if (NEEDLE.test(line)) offenders.push({ file: relPath, line: i + 1 });
      });
    }
    expect(offenders).toEqual([]);
  });

  it('calibrationStore.ts itself still sets it at least once (the guard isn\'t vacuous)', () => {
    const content = readFileSync(join(SERVER_DIR, ALLOWED_FILE), 'utf-8');
    expect(NEEDLE.test(content)).toBe(true);
  });
});

// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// @vitest-environment node

/**
 * t/517: base-pinned reads say `{ ref: BASE_BRANCH_REF }`, never the literal `{ ref: 'main' }`. The literal is
 * not a branch name (t/505 maps it to the deployment's base branch), and writing it at call sites is how
 * staging ended up reading the wrong branch. This guard covers storage/; TaxonomyServer's routes/ sites are
 * added to SCANNED_DIRS when their half of t/517 lands.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCANNED_DIRS = [path.resolve(here, '../storage')];
const LITERAL = /\bref\s*:\s*['"]main['"]/;

function codeLines(file: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let inBlockComment = false;
  fs.readFileSync(file, 'utf-8').split('\n').forEach((raw, i) => {
    const t = raw.trim();
    if (inBlockComment) { if (t.includes('*/')) inBlockComment = false; return; }
    if (t.startsWith('/*')) { inBlockComment = !t.includes('*/'); return; }
    if (t.startsWith('//') || t.startsWith('*')) return;
    out.push({ line: i + 1, text: raw.replace(/\/\/.*$/, '') });
  });
  return out;
}

describe('no literal { ref: \'main\' } in server storage code (t/517)', () => {
  it('every base-pinned read uses BASE_BRANCH_REF', () => {
    const hits: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        const file = path.join(dir, name);
        for (const { line, text } of codeLines(file)) if (LITERAL.test(text)) hits.push(`${path.relative(here, file)}:${line}: ${text.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

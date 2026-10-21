// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Structural guard: every lib/debate source file that reads snapshot.md must
 * import stripDataUris before the read reaches a model (t/4388).
 * Fails if a new reader is added without the helper.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBATE_DIR = __dirname;

function collectTsFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts')).map(f => path.join(dir, f));
}

describe('stripDataUris guard — snapshot.md readers (t/4388)', () => {
  it('every lib/debate file that reads snapshot.md also imports stripDataUris', () => {
    const files = collectTsFiles(DEBATE_DIR);
    const violations: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      if (!src.includes('snapshot.md')) continue;
      if (!src.includes('stripDataUris')) {
        violations.push(path.relative(DEBATE_DIR, file));
      }
    }
    expect(violations, `Files read snapshot.md but do not import stripDataUris:\n${violations.join('\n')}`).toEqual([]);
  });
});
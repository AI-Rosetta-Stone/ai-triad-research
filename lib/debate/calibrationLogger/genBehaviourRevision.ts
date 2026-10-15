// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Build-time generator: compute behaviour_revision and write behaviourRevision.generated.ts.
 *
 * Run via:  npm run gen:behaviour-revision
 *
 * behaviour_revision = first 12 hex chars of SHA-256 over all declared behaviour-bearing
 * source files (see behaviourRevisionFiles.ts), after normalizing each file by stripping
 * comments and collapsing whitespace runs to a single space, then sorting paths and
 * concatenating. This produces a stable hash that changes exactly when behaviour changes.
 *
 * The generated constant is imported at runtime by io.ts — no file I/O at log time, which
 * means it works identically in the hosted server/Azure build where source files are absent.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { getBehaviourFiles } from './behaviourRevisionFiles.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(thisDir, 'behaviourRevision.generated.ts');

/**
 * Normalize TypeScript source for stable hashing: strip comments, collapse whitespace.
 * Uses the TypeScript scanner so that `//` inside string or template literals is preserved
 * as code, not stripped as a comment (t/4205).
 */
export function normalizeSource(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  let result = '';
  let tok = scanner.scan();
  while (tok !== ts.SyntaxKind.EndOfFileToken) {
    if (
      tok === ts.SyntaxKind.SingleLineCommentTrivia ||
      tok === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      result += ' ';
    } else {
      result += scanner.getTokenText();
    }
    tok = scanner.scan();
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function computeBehaviourRevision(files: string[]): string {
  const sorted = [...files].sort();
  const normalized = sorted.map(f => normalizeSource(readFileSync(f, 'utf-8'))).join('\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// Guard: only run the generator when invoked as a script, not when imported by tests.
// Without this, `import { computeBehaviourRevision } from './genBehaviourRevision.js'`
// in the staleness test would regenerate the constant, making the test always pass.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = getBehaviourFiles();
  const revision = computeBehaviourRevision(files);

  const banner = [
    '// AUTO-GENERATED — do not edit by hand.',
    '// Run `npm run gen:behaviour-revision` to regenerate.',
    '// Source: lib/debate/calibrationLogger/genBehaviourRevision.ts',
    '',
    `// Files hashed: ${files.length} (see behaviourRevisionFiles.ts)`,
    `export const BEHAVIOUR_REVISION = '${revision}';`,
    '',
  ].join('\n');

  writeFileSync(outPath, banner, 'utf-8');
  console.log(`behaviour_revision: ${revision} → ${outPath}`);
}

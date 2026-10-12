// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Declared set of behaviour-bearing source files for behaviour_revision hashing.
 *
 * This list is DATA, reviewed by the Computational Linguist (t/4166). Edit it to
 * include or exclude files from the behaviour_revision key segment.
 *
 * Directories (prompts/, turnPipeline/) are enumerated at call time — *.test.ts
 * and *.generated.ts are excluded. Explicit individual files are listed below.
 *
 * KNOWN LIMITATION: The normalization in genBehaviourRevision.ts strips
 * // line comments and /* block comments *\/ textually, including occurrences
 * inside string literals (e.g. `const msg = "// old"` → `"// new"` hashes
 * identically). This is an acceptable approximation: behaviour-bearing source
 * files do not carry load-bearing logic in string literals that look like comments.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const debateDir = path.resolve(thisDir, '..');

/** Enumerate *.ts (no tests, no generated) from a directory, sorted. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      e =>
        e.isFile() &&
        e.name.endsWith('.ts') &&
        !e.name.endsWith('.test.ts') &&
        !e.name.endsWith('.generated.ts'),
    )
    .map(e => path.join(dir, e.name))
    .sort();
}

/**
 * Returns the sorted list of absolute paths that make up the behaviour_revision hash.
 * Called by genBehaviourRevision.ts at build time and by behaviourRevision.test.ts in CI.
 */
export function getBehaviourFiles(): string[] {
  return [
    ...tsFiles(path.join(debateDir, 'prompts')),
    ...tsFiles(path.join(debateDir, 'turnPipeline')),
    path.join(debateDir, 'convergenceSignals.ts'),
    path.join(debateDir, 'phaseTransitions.ts'),
    path.join(debateDir, 'cruxResolution.ts'),
    path.join(debateDir, 'debateEngine', 'modelResolution.ts'),
    // Cross-package: taxonomy-editor model config (debate engine reads this at runtime).
    // NOTE: CI must include this path in the debate: paths filter so the staleness test
    // runs when only modelConfig.ts changes (see ci.yml debate: paths).
    path.resolve(
      debateDir,
      '../../taxonomy-editor/src/renderer/hooks/useDebateStore/shared/modelConfig.ts',
    ),
  ].sort();
}

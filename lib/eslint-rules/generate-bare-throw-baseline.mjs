// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// Regenerates lib/eslint-rules/bare-throw-baseline.json for local/no-bare-throw (t/4153).
// Counts bare throws per non-test .ts/.tsx file in the rule's scope, using the rule's own isBareThrow(),
// so the baseline and the rule cannot disagree. Run from lib/:  node eslint-rules/generate-bare-throw-baseline.mjs
// Pass --check to print the counts without writing.

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import tseslint from 'typescript-eslint';
import { isBareThrow, baselineKey, REPO_ROOT } from './no-bare-throw.js';

// Must match the files: globs the rule is enabled on in lib/eslint.config.mjs and taxonomy-editor/eslint.config.mjs.
export const SCAN_ROOTS = ['lib', 'taxonomy-editor/src/server'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__']);
const isSource = (f) => /\.tsx?$/.test(f) && !/\.d\.ts$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name)); }
    else if (isSource(e.name)) yield join(dir, e.name);
  }
}

/** Count bare throws in source text. */
export function countBareThrows(source, fileName = 'file.ts') {
  const { ast } = tseslint.parser.parseForESLint(source, { ecmaFeatures: { jsx: fileName.endsWith('.tsx') }, sourceType: 'module' });
  let n = 0;
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ThrowStatement' && isBareThrow(node.argument)) n++;
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  };
  visit(ast);
  return n;
}

export function scanTree() {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(REPO_ROOT, root))) {
      const n = countBareThrows(readFileSync(file, 'utf-8'), file);
      if (n > 0) counts[baselineKey(file)] = n;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && process.argv[1].endsWith('generate-bare-throw-baseline.mjs')) {
  const files = scanTree();
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  const out = { __meta__: { rule: 'local/no-bare-throw', scan: SCAN_ROOTS, total, files: Object.keys(files).length }, ...files };
  if (process.argv.includes('--check')) console.log(JSON.stringify(out.__meta__));
  else {
    writeFileSync(join(REPO_ROOT, 'lib/eslint-rules/bare-throw-baseline.json'), JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote bare-throw-baseline.json: ${total} bare throws in ${Object.keys(files).length} files`);
  }
}

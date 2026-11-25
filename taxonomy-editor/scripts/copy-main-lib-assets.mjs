// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

// t/631: tsc (tsconfig.main.json) emits .js from .ts only, so the isolated document parser's plain .mjs files
// (lib/extraction/isolated/child.mjs and the modules it imports) never reached dist/main. The desktop main
// process forks child.mjs, so without them every document pick failed in the desktop build. This copies them
// next to the compiled extractor and fails the build if any is missing.
// Usage: node scripts/copy-main-lib-assets.mjs   (run by build:main after tsc)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const teDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(teDir, '..');
const ASSETS = [
  'lib/extraction/isolated/child.mjs',
  'lib/extraction/isolated/parseCore.mjs',
  'lib/extraction/isolated/textCore.mjs',
];

const missing = [];
for (const rel of ASSETS) {
  const from = join(repoRoot, rel);
  const to = join(teDir, 'dist', 'main', rel);
  if (!existsSync(from)) { missing.push(rel); continue; }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
if (missing.length) {
  console.error(`copy-main-lib-assets: missing source file(s): ${missing.join(', ')}. The desktop document parser can't run without them (t/631).`);
  process.exit(1);
}
console.log(`copy-main-lib-assets: copied ${ASSETS.length} isolated-parser file(s) into dist/main (t/631).`);

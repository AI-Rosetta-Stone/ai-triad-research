#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/3897: close the "new app, no check" vector. The test-electron `matrix.app` list is
// hand-maintained. An app added to the repo but never added to that list gets NEITHER the
// "Required scripts present" check NOR the renderer tsc check -- silently uncovered.
//
// Asserts TWO independent things, both against the real checked-out ci.yml (never a
// hardcoded second copy -- that would just be a third hand-maintained list, the exact class
// this job exists to close):
//   (a) the matrix `app:` list is EXACTLY the set of top-level directories whose
//       package.json has a `build` script (t/3847's authoritative enumeration);
//   (b) SO condition C1 (t/3897, p/682#17): every matrix app also has an entry in the
//       `changes` job's `electron:` path filter. Without this, an app correctly listed in
//       the matrix but missing from the filter never triggers `test-electron` at all on a
//       PR that only touches that app -- `ci-gate` then "passes" a job that never ran.
//
// SO condition C2: the matrix regex used to match the FIRST `app: [...]` array anywhere in
// ci.yml, not scoped to the test-electron job -- any other job's matrix defined earlier in
// the file would have silently been read instead. This extracts the test-electron job's own
// text block (bounded by the next top-level job key) and requires exactly one match inside
// it, failing closed otherwise.

import fs from 'node:fs';
import path from 'node:path';

function fail(msg) {
  console.log(`::error::test-electron-matrix-membership: ${msg} (t/3897)`);
  process.exitCode = 1;
}

const buildScriptDirs = fs.readdirSync('.', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => {
    const pkgPath = path.join(name, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return !!(pkg.scripts && pkg.scripts.build);
    } catch {
      return false;
    }
  })
  .sort();

const ciYml = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const lines = ciYml.split('\n');

// ── C2: scope the app: [...] match to the test-electron job's own text block ──
const jobStartIdx = lines.findIndex((l) => /^ {2}test-electron:\s*$/.test(l));
if (jobStartIdx === -1) {
  fail('could not find the "  test-electron:" job header in ci.yml');
  process.exit(1);
}
let jobEndIdx = lines.length;
for (let i = jobStartIdx + 1; i < lines.length; i++) {
  if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
    jobEndIdx = i;
    break;
  }
}
const jobBlock = lines.slice(jobStartIdx, jobEndIdx).join('\n');
const appMatches = [...jobBlock.matchAll(/^\s*app:\s*\[([^\]]+)\]/gm)];
if (appMatches.length !== 1) {
  fail(
    `expected exactly one inline app: [...] matrix array inside the test-electron job block, found ${appMatches.length}`,
  );
  process.exit(1);
}
const matrix = appMatches[0][1].split(',').map((s) => s.trim()).filter(Boolean).sort();

// ── (a) matrix == package.json apps with a build script ──
const missingFromMatrix = buildScriptDirs.filter((d) => !matrix.includes(d));
const extraInMatrix = matrix.filter((d) => !buildScriptDirs.includes(d));
if (missingFromMatrix.length) {
  fail(`${missingFromMatrix.join(', ')} has a build script but is NOT in the test-electron matrix app: list`);
}
if (extraInMatrix.length) {
  fail(`${extraInMatrix.join(', ')} is in the test-electron matrix app: list but has no build script`);
}

// ── C1: every matrix app must also be in the `changes` job's electron: path filter ──
const filterStartIdx = lines.findIndex((l) => /^\s*electron:\s*$/.test(l));
if (filterStartIdx === -1) {
  fail('could not find the "electron:" path filter list in the changes job');
  process.exit(1);
}
const filterPaths = [];
for (let i = filterStartIdx + 1; i < lines.length; i++) {
  const m = lines[i].match(/^\s*-\s*'([^']+)'/);
  if (!m) break; // first non-list-item line ends the block (dedented sibling key)
  filterPaths.push(m[1]);
}
if (filterPaths.length === 0) {
  fail('the electron: path filter list parsed as empty');
  process.exit(1);
}
const missingFromFilter = matrix.filter(
  (app) => !filterPaths.some((p) => p === `${app}/**` || p === app),
);
if (missingFromFilter.length) {
  fail(
    `${missingFromFilter.join(', ')} is in the test-electron matrix but has no corresponding entry in the changes job's electron: path filter -- a PR touching only that app would never trigger test-electron at all`,
  );
}

if (process.exitCode === 1) process.exit(1);
console.log(
  `test-electron matrix [${matrix.join(', ')}] matches package.json apps with a build script, and every matrix app has an electron: path filter entry`,
);

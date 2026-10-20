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
//
// t/4236: split into a pure checkMatrixMembership(ciYmlContent, buildScriptDirs) and a thin
// impure CLI wrapper, so the decision logic is testable (test-electron-matrix-membership.test.mjs)
// without needing a real checkout -- the first draft of this script read a hard-coded
// duplicate matrix list and always passed (t/3897#6); nothing committed caught that
// regression, which is exactly what the test file now does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure. No fs, no process. Returns {exitCode, messages, matrix}. */
export function checkMatrixMembership(ciYmlContent, buildScriptDirs) {
  const messages = [];
  let exitCode = 0;
  const fail = (msg) => {
    messages.push(msg);
    exitCode = 1;
  };

  const lines = ciYmlContent.split('\n');

  // ── C2: scope the app: [...] match to the test-electron job's own text block ──
  const jobStartIdx = lines.findIndex((l) => /^ {2}test-electron:\s*$/.test(l));
  if (jobStartIdx === -1) {
    fail('could not find the "  test-electron:" job header in ci.yml');
    return { exitCode, messages, matrix: null };
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
    return { exitCode, messages, matrix: null };
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
    return { exitCode, messages, matrix };
  }
  const filterPaths = [];
  for (let i = filterStartIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*'([^']+)'/);
    if (!m) break; // first non-list-item line ends the block (dedented sibling key)
    filterPaths.push(m[1]);
  }
  if (filterPaths.length === 0) {
    fail('the electron: path filter list parsed as empty');
    return { exitCode, messages, matrix };
  }
  const missingFromFilter = matrix.filter(
    (app) => !filterPaths.some((p) => p === `${app}/**` || p === app),
  );
  if (missingFromFilter.length) {
    fail(
      `${missingFromFilter.join(', ')} is in the test-electron matrix but has no corresponding entry in the changes job's electron: path filter -- a PR touching only that app would never trigger test-electron at all`,
    );
  }

  return { exitCode, messages, matrix };
}

/** Impure: scans repoRoot for top-level dirs whose package.json has a build script. */
export function findBuildScriptDirs(repoRoot) {
  return fs.readdirSync(repoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const pkgPath = path.join(repoRoot, name, 'package.json');
      if (!fs.existsSync(pkgPath)) return false;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return !!(pkg.scripts && pkg.scripts.build);
      } catch {
        return false;
      }
    })
    .sort();
}

function parseArgs(argv) {
  const args = { repoRoot: '.', ciYml: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo-root') args.repoRoot = argv[++i];
    else if (argv[i] === '--ci-yml') args.ciYml = argv[++i];
  }
  if (!args.ciYml) args.ciYml = path.join(args.repoRoot, '.github/workflows/ci.yml');
  return args;
}

function main() {
  const { repoRoot, ciYml } = parseArgs(process.argv.slice(2));
  const buildScriptDirs = findBuildScriptDirs(repoRoot);
  const ciYmlContent = fs.readFileSync(ciYml, 'utf8');
  const { exitCode, messages, matrix } = checkMatrixMembership(ciYmlContent, buildScriptDirs);

  for (const msg of messages) {
    console.log(`::error::test-electron-matrix-membership: ${msg} (t/3897)`);
  }
  if (exitCode === 0) {
    console.log(
      `test-electron matrix [${matrix.join(', ')}] matches package.json apps with a build script, and every matrix app has an electron: path filter entry`,
    );
  }
  process.exit(exitCode);
}

// Only run the CLI when this file is executed directly, not when imported by the test file.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

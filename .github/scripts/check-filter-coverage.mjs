#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.
//
// t/4140 (third occurrence of the class: t/2025, t/3189, t/4029 -- see t/4140#1 for why t/2025
// doesn't replay through THIS mechanism specifically): a test that reads files outside its CI
// job's paths-filter silently skips when only those files change. ci-gate treats a skipped
// required job as satisfied, so the PR merges green and main goes silently untested.
//
// .github/ci/test-read-sets.json declares, per changes-job filter name, the input roots that
// job's tests actually read -- a SEPARATE declaration from the filter itself, so a future test
// addition that forgets to touch the filter (but does update, or should have updated, the
// read-set) gets caught here instead of silently trusted. This checks filter coverage of the
// declared read-sets; it does NOT re-derive the read-sets from the filter (that would be
// circular) and does NOT (yet) derive every language's real read-set from source (see the
// python-only derivation pass below, and the surviving vector in the header of this file's
// companion job in ci.yml).
//
// SURVIVING VECTOR: a test whose read-set is neither declared in test-read-sets.json nor
// derivable by the python heuristic below (vitest fixture-dir derivation isn't built). A new
// test reading a new path, where the author updates neither the filter nor the declaration,
// is invisible to this check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pure. Parses the inline `filters: |` block of the dorny/paths-filter step into {job: [globs]}. */
export function parseFiltersBlock(ciYmlContent) {
  const lines = ciYmlContent.split('\n');
  const blockStart = lines.findIndex((l) => /^\s*filters:\s*\|\s*$/.test(l));
  if (blockStart === -1) return {};

  // The block is indented under `filters: |`; it ends at the first line whose indentation is
  // <= the `filters:` line's own indentation (a sibling/dedented key, e.g. the next step).
  const baseIndent = lines[blockStart].match(/^(\s*)/)[1].length;
  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const indent = lines[i].match(/^(\s*)/)[1].length;
    if (indent <= baseIndent) { blockEnd = i; break; }
  }
  const block = lines.slice(blockStart + 1, blockEnd);

  const filters = {};
  let currentJob = null;
  for (const line of block) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const jobMatch = line.match(/^\s{12}([A-Za-z0-9_-]+):\s*$/);
    const entryMatch = line.match(/^\s*-\s*'([^']+)'/);
    if (jobMatch) {
      currentJob = jobMatch[1];
      filters[currentJob] = [];
    } else if (entryMatch && currentJob) {
      filters[currentJob].push(entryMatch[1]);
    }
  }
  return filters;
}

/** Pure. True if a declared read-root is covered by at least one filter glob. */
function isCovered(root, globs) {
  for (const g of globs) {
    if (g === root) return true;
    if (g.endsWith('/**')) {
      const prefix = g.slice(0, -2); // keep trailing '/'
      if (root.startsWith(prefix) || prefix.startsWith(root.replace(/\*+$/, ''))) return true;
    }
    if (root.endsWith('/**')) {
      const rootPrefix = root.slice(0, -2);
      if (g.startsWith(rootPrefix)) return true;
    }
  }
  return false;
}

/** Pure. filtersByJob: {job: [glob,...]}. readSets: {job: [root,...]}. */
export function checkCoverage(filtersByJob, readSets) {
  const violations = [];
  for (const [job, roots] of Object.entries(readSets)) {
    if (job === '_comment') continue;
    const globs = filtersByJob[job];
    if (!globs) {
      violations.push(`job '${job}' has a declared read-set but no paths-filter entry at all`);
      continue;
    }
    for (const root of roots) {
      if (!isCovered(root, globs)) {
        violations.push(`job '${job}' reads '${root}' but its filter misses it`);
      }
    }
  }
  return { exitCode: violations.length ? 1 : 0, violations };
}

/** Best-effort derivation (python only, t/4140 "where cheap"): os.path.join(...) literal chains. */
export function deriveePythonRoots(pyFileContents) {
  const roots = new Set();
  const callRe = /os\.path\.join\(([^)]*)\)/g;
  for (const content of pyFileContents) {
    let m;
    while ((m = callRe.exec(content))) {
      const args = m[1].split(',').map((a) => a.trim());
      const literals = [];
      for (const a of args) {
        const strMatch = a.match(/^["']([^"']*)["']$/);
        if (!strMatch) continue; // skip variables (e.g. _HERE) -- can't resolve statically
        if (strMatch[1] === '..' || strMatch[1] === '.') continue;
        literals.push(strMatch[1]);
      }
      // Require a genuine multi-segment path -- a single surviving literal (the rest of the
      // join was unresolved variables, e.g. os.path.join(_SOUL_DIR, "*.soul.json")) is a
      // filename/glob fragment relative to an unresolved base, not an actionable root.
      if (literals.length >= 2) roots.add(literals.join('/'));
    }
  }
  return [...roots].sort();
}

function parseArgs(argv) {
  const args = { repoRoot: '.', ciYml: null, readSets: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo-root') args.repoRoot = argv[++i];
    else if (argv[i] === '--ci-yml') args.ciYml = argv[++i];
    else if (argv[i] === '--read-sets') args.readSets = argv[++i];
  }
  if (!args.ciYml) args.ciYml = path.join(args.repoRoot, '.github/workflows/ci.yml');
  if (!args.readSets) args.readSets = path.join(args.repoRoot, '.github/ci/test-read-sets.json');
  return args;
}

const PYTHON_TEST_FILES = [
  'scripts', // test_*.py discovered by pytest from here
  'research/comp-linguist/tools/test_render_soul_md.py',
];

function findPythonTestFiles(repoRoot) {
  const files = [];
  const scriptsDir = path.join(repoRoot, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    for (const name of fs.readdirSync(scriptsDir)) {
      if (/^test_.*\.py$/.test(name)) files.push(path.join(scriptsDir, name));
    }
  }
  const soulTest = path.join(repoRoot, 'research/comp-linguist/tools/test_render_soul_md.py');
  if (fs.existsSync(soulTest)) files.push(soulTest);
  return files;
}

function main() {
  const { repoRoot, ciYml, readSets } = parseArgs(process.argv.slice(2));
  const ciYmlContent = fs.readFileSync(ciYml, 'utf8');
  const readSetsJson = JSON.parse(fs.readFileSync(readSets, 'utf8'));
  const filters = parseFiltersBlock(ciYmlContent);

  const { exitCode, violations } = checkCoverage(filters, readSetsJson);
  for (const v of violations) {
    console.log(`::error::check-filter-coverage: ${v} (t/4140)`);
  }

  // Best-effort derivation, python only (t/4140 "where cheap, derive").
  const pyFiles = findPythonTestFiles(repoRoot);
  const pyContents = pyFiles.map((f) => fs.readFileSync(f, 'utf8'));
  const derived = deriveePythonRoots(pyContents);
  const declaredPython = readSetsJson.python ?? [];
  const undeclared = derived.filter((root) => !isCovered(root, declaredPython) && !declaredPython.includes(root));
  for (const root of undeclared) {
    console.log(`::warning::check-filter-coverage: python tests appear to read '${root}', not in test-read-sets.json['python'] (t/4140, best-effort derivation)`);
  }

  if (exitCode === 0 && violations.length === 0) {
    console.log('check-filter-coverage: every declared read-set is covered by its filter (t/4140)');
  }
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

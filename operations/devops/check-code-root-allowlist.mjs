#!/usr/bin/env node
// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * Impure CI runner for the advisory code-root-allowlist check (t/4665). See
 * code-root-allowlist-predicate.mjs for the pure logic and rationale.
 *
 * Pure git, no GitHub API dependency: works identically on pull_request, push, merge_group and
 * workflow_dispatch. Warn-only — this script never exits non-zero (same convention as
 * Test-EnvBicepWiring.ps1, t/4506): a violation surfaces as a `::warning::` annotation inside a
 * green job, never a failed one.
 *
 * Base-ref resolution, in priority order:
 *   1. BASE_SHA env var, if the caller already resolved one (e.g. a PR's base SHA).
 *   2. `origin/main`, fetched fresh — the anti-self-narrowing posture used by every other
 *      advisory check in this repo (tier-check, cl-path-check, ci-shared-input-coverage): a PR
 *      must not be able to narrow the allowlist to exempt its own stray root by editing a file
 *      that this check would otherwise read from its own head.
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  evaluateRootAllowlist, evaluateVitestIncludeCoverage, extractIncludeGlobs,
  extractRootOption, resolveIncludeGlobs,
} from './code-root-allowlist-predicate.mjs';

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

function resolveBaseSha() {
  if (process.env.BASE_SHA) return process.env.BASE_SHA;
  execSync('git fetch origin main', { cwd: repoRoot, stdio: 'pipe' });
  return execSync('git rev-parse origin/main', { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const baseSha = resolveBaseSha();

const allowlistRoots = execSync(`git ls-tree -d --name-only ${baseSha}`, { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').map((l) => l.trim()).filter(Boolean);

const changedPaths = execSync(`git diff --name-only --diff-filter=ACMR ${baseSha}...HEAD`, { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').map((l) => l.trim()).filter(Boolean);

// ── Arm 1: root allowlist ──
const { violations } = evaluateRootAllowlist(allowlistRoots, changedPaths);
for (const v of violations) {
  console.log(`::warning file=${v.path}::code-root-allowlist: '${v.path}' sits under top-level root '${v.root}/', which does not exist on main — nothing currently builds or tests it (t/4665). If this is a deliberate new root, confirm something actually exercises it before merging; if a mistake, move the file under the correct existing root.`);
}

// ── Arm 2 (optional): vitest include coverage, for test files under RECOGNIZED roots only ──
// (a stray-root file already reported above; re-reporting it here would be noise, not a
// second finding.)
const violationPaths = new Set(violations.map((v) => v.path));
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx)$/i;
const testFilePaths = changedPaths.filter((p) => TEST_FILE_RE.test(p) && !violationPaths.has(p));

const CONFIG_CANDIDATES = ['vitest.config.ts', 'vitest.config.mts', 'vite.config.ts'];
let resolvedIncludeGlobs = [];
for (const root of allowlistRoots) {
  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = join(repoRoot, root, candidate);
    if (!existsSync(configPath)) continue;
    const configText = readFileSync(configPath, 'utf8');
    const includeGlobs = extractIncludeGlobs(configText);
    if (includeGlobs) {
      const rootOption = extractRootOption(configText);
      resolvedIncludeGlobs = resolvedIncludeGlobs.concat(resolveIncludeGlobs(root, rootOption, includeGlobs));
    }
    break; // first candidate found wins for this root — don't double-count a root.
  }
}

if (resolvedIncludeGlobs.length === 0) {
  console.log('::warning::code-root-allowlist arm 2 (vitest include coverage): no app vitest/vite config with a text-extractable `include` array was found — arm 2 skipped this run (not a violation; see t/4665 for the known text-extraction limitation).');
} else {
  const { uncovered } = evaluateVitestIncludeCoverage(testFilePaths, resolvedIncludeGlobs);
  for (const p of uncovered) {
    console.log(`::warning file=${p}::code-root-allowlist arm 2: test file '${p}' matches no app's vitest 'include' glob — it will never run (t/4665). Confirm the owning app's vitest/vite config covers it.`);
  }
}

console.log(`code-root-allowlist: ${violations.length} root violation(s), checked against ${allowlistRoots.length} roots on main's tip (${baseSha.slice(0, 8)}).`);
process.exit(0); // warn-only — never fails the job, per t/4665's own tier note.

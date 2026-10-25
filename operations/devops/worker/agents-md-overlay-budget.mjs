// Copyright (c) 2026 Jeffrey Snover. All rights reserved.
// Licensed under the MIT License. See LICENSE file in the project root.

/**
 * operations/devops/worker/agents-md-overlay-budget.mjs — overlay-tracked AGENTS.md size
 * ratchet (t/4329, t/4094 remainder).
 *
 * The main-repo ratchet (scripts/check-agents-md-budget.mjs, t/4323) only covers AGENTS.md and
 * operations/devops/azure/AGENTS.md -- the only two AGENTS.md files the main repo itself tracks.
 * Every role/sub-role AGENTS.md lives in the separate Orca overlay repo (`.orca-git`), which a
 * GitHub Actions checkout never sees. This closes that vector by running the SAME
 * `checkBudgets()` predicate (imported, not duplicated) against the overlay instead, driven by
 * an Orca reminder rather than CI (overlay files aren't checked out by CI either).
 *
 * Enumeration is LIVE (`ogit ls-files '*AGENTS.md'`), not a hardcoded list, so a new role's file
 * is covered automatically -- and a file present in that enumeration but missing from the budget
 * JSON is itself flagged (`unlisted`), never silently skipped.
 *
 * PURE core (`checkOverlayBudgets`) takes already-enumerated file names and injected
 * readFile/listFiles functions -- no real `ogit` calls in tests. Impure default export
 * (`runOverlayBudgetCheck`) wires those to real `ogit` commands for the reminder to call.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudgets } from '../../../scripts/check-agents-md-budget.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BUDGET_FILE = resolve(ROOT, '.orca', 'agent-instruction-budgets.json');

/**
 * PURE: given the live overlay file list and the declared budget entries, returns the same
 * {violations, missing} shape as checkBudgets() plus `unlisted` -- files the live enumeration
 * found that the budget JSON doesn't list at all (distinct from `missing`, which is a listed
 * file absent from the checkout -- that case can't happen here since the list IS the checkout's
 * own enumeration, but kept for parity with checkBudgets()'s existing contract).
 * @param {string[]} liveFiles - overlay paths from `ogit ls-files '*AGENTS.md'`, e.g. 'operations/devops/AGENTS.md'
 * @param {Array<{path:string, max_lines:number, max_words:number}>} budgetEntries
 * @param {(path: string) => string} readFile - called with the REPO-RELATIVE overlay path
 *   (e.g. 'operations/devops/AGENTS.md'), returning the file's content at overlay HEAD.
 */
export function checkOverlayBudgets(liveFiles, budgetEntries, readFile) {
  const declaredPaths = new Set(budgetEntries.map((e) => e.path));
  const unlisted = liveFiles.filter((f) => !declaredPaths.has(f));
  // Only check budget entries that are ALSO live today (a removed role's file should not
  // report as a phantom violation once it's gone).
  const liveSet = new Set(liveFiles);
  const entriesToCheck = budgetEntries.filter((e) => liveSet.has(e.path));
  const fileExists = () => true; // every entry we pass IS live, by construction above
  // checkBudgets() resolves entry.path to an ABSOLUTE filesystem path before calling
  // readFile/fileExists (correct for the main-repo arm, which reads real files) -- convert
  // back to the repo-relative overlay path our own readFile contract expects, so `readFile`
  // can keep calling `git show HEAD:<relative-path>` (an absolute path there is a `git`
  // revision-syntax error, caught while verifying this module end-to-end before committing).
  const relativeReadFile = (absPath) => readFile(relative(ROOT, absPath).replace(/\\/g, '/'));
  const { violations, missing } = checkBudgets(entriesToCheck, relativeReadFile, fileExists);
  return { violations, missing, unlisted };
}

/** IMPURE: real `ogit` calls, for the reminder to invoke directly.
 * Uses execFileSync with an argument ARRAY, never a shell-interpolated command string: on
 * Windows, execSync's default shell is cmd.exe, which does NOT strip single quotes the way
 * bash does -- `ls-files '*AGENTS.md'` as a shell string passed the quote characters straight
 * through to git as part of the pathspec, matching nothing, and the check silently passed
 * against zero files (found while verifying this module end-to-end before committing it). */
export function runOverlayBudgetCheck() {
  const liveFiles = execFileSync('git', ['--git-dir=.orca-git', '--work-tree=.', 'ls-files', '*AGENTS.md'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\n').map((l) => l.trim()).filter(Boolean);
  const { files: budgetEntries } = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  const readFile = (path) => execFileSync('git', ['--git-dir=.orca-git', '--work-tree=.', 'show', `HEAD:${path}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return checkOverlayBudgets(liveFiles, budgetEntries, readFile);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const { violations, missing, unlisted } = runOverlayBudgetCheck();
  for (const v of violations) {
    console.log(`::warning::${v.path}: ${v.lines}/${v.maxLines} lines (+${v.deltaLines}), ${v.words}/${v.maxWords} words (+${v.deltaWords}) over budget`);
  }
  for (const u of unlisted) {
    console.log(`::warning::${u}: tracked by the overlay but not in ${BUDGET_FILE} -- add it to the budget file`);
  }
  if (missing.length) {
    console.log(`::warning::${missing.length} budget entr${missing.length === 1 ? 'y' : 'ies'} not found in the live overlay enumeration (stale budget entries?): ${missing.map((m) => m.path).join(', ')}`);
  }
  if (!violations.length && !unlisted.length) {
    console.log(`agents-md-overlay-budget: all ${BUDGET_FILE ? 'declared' : ''} overlay AGENTS.md files within budget.`);
  }
  process.exit(violations.length || unlisted.length ? 1 : 0);
}
